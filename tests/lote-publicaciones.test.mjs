import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { analizarEntradaLote, consultarLote, resumirLote } from "../utils/lote.js";
import { desdeShopify, ESTADOS } from "../utils/model.js";
import { validarImagenes } from "../images/image-handler.js";
import { validarCamposObligatoriosRappi } from "../rappi/rappi-connector.js";
import { calcularUnidadesDisponiblesAsociacion, generarPlantillaAsociacion } from "../rappi/rappi-association.js";
import { generarXlsxLoteRappi } from "../rappi/rappi-batch.js";

function raw(sku, stock = 3, id = sku) {
  return {
    id, sku, price: "100000", inventoryQuantity: stock,
    inventoryItem: { tracked: true, measurement: { weight: { value: 1, unit: "GRAMS" } } },
    image: { url: `https://example.invalid/${encodeURIComponent(sku)}.png` },
    product: { title: "Producto de prueba", descriptionHtml: "<p>Prueba</p>", featuredImage: { url: "https://example.invalid/base.png" }, images: { edges: [] } },
  };
}
function validar(producto) {
  const imagen = validarImagenes(producto);
  return { ...imagen, estado: validarCamposObligatoriosRappi(imagen).length ? ESTADOS.BLOQUEADO : ESTADOS.VALIDADO };
}
const opciones = (buscar) => ({ buscar, normalizar: desdeShopify, validar });

test("14 códigos completos pueden representar10 bases sin recortar publicaciones", () => {
  const skus = ["11351/A", "11351/B", "11351/C", "10498-1/F", "10498-1/M", "10498-1/U", ...Array.from({ length: 8 }, (_, i) => String(20000 + i))];
  const resultado = analizarEntradaLote(skus.join("\n"));
  assert.equal(resultado.valido, true);
  assert.equal(resultado.bases.length, 10);
  assert.equal(resultado.skus.length, 14);
  assert.ok(resultado.bases.includes("10498-1"));
});

test("más de10 bases se informa sin borrar líneas", () => {
  const resultado = analizarEntradaLote(Array.from({ length: 12 }, (_, i) => String(i + 100)).join("\n"));
  assert.equal(resultado.valido, false);
  assert.equal(resultado.skus.length, 12);
  assert.equal(resultado.bases.length, 12);
  assert.match(resultado.errores[0], /no se eliminó ninguna línea/);
});

test("entrada vacía, SKU incompleto y duplicados se distinguen", () => {
  assert.equal(analizarEntradaLote("\n ").valido, false);
  assert.equal(analizarEntradaLote("11351/\n/MoveForward").valido, false);
  const resultado = analizarEntradaLote(" 11351/A \r\n11351/A\n10498\n10498-1");
  assert.deepEqual(resultado.skus, ["11351/A", "10498", "10498-1"]);
  assert.equal(resultado.bases.length, 3);
});

test("se consulta cada base una vez y se cuentan10 bases/14 publicaciones", async () => {
  const bases = ["11351", "10498-1", ...Array.from({ length: 8 }, (_, i) => String(20000 + i))];
  const llamadas = [];
  const resultado = await consultarLote(bases, opciones(async (base) => {
    llamadas.push(base);
    return { raws: base === "11351" || base === "10498-1" ? [raw(`${base}/A`, 3), raw(`${base}/B`, 6), raw(`${base}/C`, 9)] : [raw(base, 30)] };
  }));
  assert.equal(llamadas.length, 10);
  assert.deepEqual(resumirLote(resultado.productos, bases), { bases: 10, publicaciones: 14, listos: 14, pendientes: 0 });
  assert.equal(resultado.errores.length, 0);
});

test("pedir dos diseños conserva sus stocks propios sin tomar999 de la base", async () => {
  let consultas = 0;
  const resultado = await consultarLote(["11351/A", "11351/B"], opciones(async (base) => {
    assert.equal(base, "11351"); consultas++;
    return { raws: [raw("11351", 999), raw("11351/A", 3), raw("11351/B", 6), raw("11351/C", 12)] };
  }));
  assert.equal(consultas, 1);
  assert.deepEqual(resultado.productos.map((p) => [p.sku, p.inventario, p.inventario_origen]), [
    ["11351/A", 3, "conteo_manual_shopify"], ["11351/B", 6, "conteo_manual_shopify"],
  ]);
  assert.deepEqual(resultado.productos.map((p) => calcularUnidadesDisponiblesAsociacion(p.inventario)), [1, 2]);
});

test("una base y su diseño no duplican la misma publicación", async () => {
  const resultado = await consultarLote(["11351", "11351/A"], opciones(async () => ({ raws: [raw("11351/A"), raw("11351/B")] })));
  assert.deepEqual(resultado.productos.map((p) => p.sku), ["11351/A", "11351/B"]);
  assert.equal(resultado.errores.length, 0);
});

test("el filtro de base no confunde referencias con guiones", async () => {
  const resultado = await consultarLote(["10498-1"], opciones(async () => ({ raws: [raw("10498/A"), raw("10498-1/Femenino"), raw("10498-10/A")] })));
  assert.deepEqual(resultado.productos.map((p) => p.sku), ["10498-1/Femenino"]);
});

test("faltante exacto no se sustituye por otro diseño o por la base", async () => {
  const resultado = await consultarLote(["11351/NoExiste"], opciones(async () => ({ raws: [raw("11351", 999), raw("11351/A", 3)] })));
  assert.equal(resultado.productos.length, 0);
  assert.equal(resultado.errores[0].tipo, "NO_ENCONTRADO");
});

test("un error de consulta no se registra como producto inexistente", async () => {
  const resultado = await consultarLote(["11351"], opciones(async () => { throw new Error("Sin conexión"); }));
  assert.equal(resultado.errores[0].tipo, "CONSULTA");
  assert.equal(resultado.productos.length, 0);
});

test("un mismo SKU en variantes distintas se bloquea sin sumar existencias", async () => {
  const resultado = await consultarLote(["11351"], opciones(async () => ({ raws: [raw("11351/A", 3, "id1"), raw("11351/A", 9, "id2")] })));
  assert.equal(resultado.productos.length, 1);
  assert.equal(resultado.productos[0].conflicto_sku, true);
  assert.equal(resultado.productos[0].estado, ESTADOS.BLOQUEADO);
  assert.equal(resultado.productos[0].inventario, 3);
  assert.match(validarCamposObligatoriosRappi(resultado.productos[0])[0].motivo, /mismo SKU completo/);
});

test("una variante repetida entre páginas no crea un conflicto falso", async () => {
  const variante = raw("11351/A", 3, "id1");
  const resultado = await consultarLote(["11351"], opciones(async () => ({ raws: [variante, { ...variante }] })));
  assert.equal(resultado.productos.length, 1);
  assert.equal(resultado.productos[0].estado, ESTADOS.VALIDADO);
});

test("la imagen propia de variante tiene prioridad y una imagen principal basta", () => {
  const a = desdeShopify(raw("11351/A"));
  const b = desdeShopify(raw("11351/B"));
  assert.notEqual(a.imagen_principal, b.imagen_principal);
  assert.equal(a.sku_base, "11351");
  assert.equal(a.diseno_sku, "A");
  const soloPrincipal = raw("10498-1"); delete soloPrincipal.image;
  const producto = desdeShopify(soloPrincipal);
  assert.equal(validarImagenes(producto).estado, ESTADOS.VALIDADO);
  assert.deepEqual(producto.imagenes, [soloPrincipal.product.featuredImage.url]);
});

test("asociación conserva / y reserva por publicación sin copiar inventario base", async () => {
  const require = createRequire(import.meta.url);
  const XLSX = require("../vendor/xlsx.full.min.js");
  const libro = XLSX.utils.book_new();
  const hoja = { "!ref": "A1:N10" };
  const skus = ["11351/MoveForward", "11351/YourDream", "11351", "10498-1/Femenino", "10498/Masculino"];
  skus.forEach((sku, i) => { hoja[`G${i + 6}`] = { t: "s", v: `PANAFARGOSAS_${sku}` }; hoja[`L${i + 6}`] = { t: "n", v: 0 }; });
  XLSX.utils.book_append_sheet(libro, hoja, "Productos");
  const bytes = XLSX.write(libro, { type: "buffer", bookType: "xlsx" });
  const originales = { window: globalThis.window, chrome: globalThis.chrome, fetch: globalThis.fetch };
  globalThis.window = { XLSX };
  globalThis.chrome = { storage: { local: { get: async () => ({ plantillaAsociacionBase64: Buffer.from(bytes).toString("base64") }) } } };
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).protocol, "file:");
    const { readFile } = await import("node:fs/promises");
    const b = await readFile(new URL(url));
    return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
  try {
    const productos = [
      { sku: skus[0], precio: 400000, inventario: 3 },
      { sku: skus[1], precio: 400000, inventario: 6 },
      { sku: skus[3], precio: 664400, inventario: 15 },
      { sku: "11351/NoExiste", precio: 400000, inventario: 999 },
    ];
    const resultado = await generarPlantillaAsociacion(productos);
    assert.equal(resultado.filasEscritas, 3);
    assert.deepEqual(resultado.noEncontrados, ["11351/NoExiste"]);
    const exportada = XLSX.read(await resultado.blob.arrayBuffer(), { type: "array" }).Sheets.Productos;
    assert.equal(exportada.G6.v, `PANAFARGOSAS_${skus[0]}`);
    assert.equal(exportada.N6.v, 1);
    assert.equal(exportada.N7.v, 2);
    assert.equal(exportada.N9.v, 5);
    assert.equal(exportada.G8, undefined);
    assert.equal(exportada.G10, undefined);
    for (const [stock, reserva] of [[0, 0], [3, 1], [49, 16], [50, 25]]) assert.equal(calcularUnidadesDisponiblesAsociacion(stock), reserva);
    globalThis.chrome.runtime = { getURL: (ruta) => new URL(`../${ruta}`, import.meta.url).href };
    const creacion = await generarXlsxLoteRappi(productos.slice(0, 2).map((p) => ({ ...p, categoria: "Papelería", nombre: "Diseño", es_pesable: "NO", es_preempaquetado: "NO", cantidad: 1, unidad_medida: "Gramo" })));
    const creada = XLSX.read(await creacion.arrayBuffer(), { type: "array" }).Sheets.Productos;
    assert.equal(creada.D6.v, "11351/MoveForward");
    assert.equal(creada.D7.v, "11351/YourDream");
  } finally {
    for (const [k, v] of Object.entries(originales)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});
