import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extraerSkuCompletoAsociacion, generarPlantillaAsociacion } from "../rappi/rappi-association.js";
import { generarXlsxLoteRappi } from "../rappi/rappi-batch.js";

const require = createRequire(import.meta.url);
const XLSX = require("../vendor/xlsx.full.min.js");
const plantillaUrl = new URL("../rappi/ProductosAsociacion-es.xlsx", import.meta.url);
const bytesOriginales = await readFile(plantillaUrl);
const originales = { fetch: globalThis.fetch, chrome: globalThis.chrome, window: globalThis.window };
let guardado;
let falloAlLeer;
let lecturasLocales;

beforeEach(() => {
  guardado = undefined;
  falloAlLeer = false;
  lecturasLocales = 0;
  globalThis.window = { XLSX };
  globalThis.chrome = {
    storage: { local: { get: async () => {
      if (falloAlLeer) throw new Error("Fallo de almacenamiento simulado");
      return guardado === undefined ? {} : { plantillaAsociacionBase64: guardado };
    } } },
    runtime: { getURL: (path) => new URL(`../${path}`, import.meta.url).href },
  };
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "file:", "Estas pruebas no consultan Shopify ni Rappi.");
    assert.ok(parsed.href.startsWith(new URL("../rappi/", import.meta.url).href));
    lecturasLocales++;
    const bytes = await readFile(parsed);
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
});

after(() => {
  for (const [name, value] of Object.entries(originales)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

// Copia real de la plantilla incluida, con filas de respuesta Rappi SIMULADAS.
// Los identificadores ficticios solo comprueban que se conservan sin inventar
// reemplazos. Esto no representa un correo recibido ni una asociación real.
function plantillaConFilas(filas) {
  const libro = XLSX.read(bytesOriginales, { type: "buffer" });
  const hoja = libro.Sheets.Productos;
  for (const direccion of Object.keys(hoja)) {
    const match = /^[A-Z]+([1-9]\d*)$/.exec(direccion);
    if (match && Number(match[1]) >= 6) delete hoja[direccion];
  }
  for (const [i, dato] of filas.entries()) {
    const fila = 6 + i;
    const valores = {
      B: dato.id || `0000${fila}`, C: "000900259843", D: "Tienda de prueba local",
      E: dato.productoId || `producto-ficticio-${fila}`, F: "0000012345678",
      G: dato.celdaSku ?? `PANAFARGOSAS_${dato.sku}`, H: `Publicación ${dato.sku}`,
      I: "Descripción de prueba", J: "1 Und", K: 999999,
      L: 0.2, M: "SI", N: 999,
    };
    for (const [columna, valor] of Object.entries(valores)) {
      hoja[`${columna}${fila}`] = { t: typeof valor === "number" ? "n" : "s", v: valor };
    }
  }
  const bytes = XLSX.write(libro, { type: "buffer", bookType: "xlsx" });
  guardado = Buffer.from(bytes).toString("base64");
  return XLSX.read(bytes, { type: "buffer" }).Sheets.Productos;
}

async function leerResultado(resultado) {
  return XLSX.read(await resultado.blob.arrayBuffer(), { type: "array" }).Sheets.Productos;
}

test("el prefijo solo se retira una vez y conserva el diseño completo", () => {
  assert.equal(extraerSkuCompletoAsociacion("PANAFARGOSAS_11351/MoveForward"), "11351/MoveForward");
  assert.equal(extraerSkuCompletoAsociacion(" \u00a0PANAFARGOSAS_ 00123-1/A/Brillante\u00a0 "), "00123-1/A/Brillante");
  assert.equal(extraerSkuCompletoAsociacion("PANAFARGOSAS_PANAFARGOSAS_11351/A"), "PANAFARGOSAS_11351/A");
  for (const valor of [null, 11351, "", "11351/A", "OTRA_TIENDA_11351/A", "panafargosas_11351/A", "PANAFARGOSAS_", "PANAFARGOSAS_11351/", "PANAFARGOSAS_113\n51/A"]) {
    assert.equal(extraerSkuCompletoAsociacion(valor), null);
  }
});

test("los espacios Excel se ignoran para buscar pero no alteran las celdas ni sus IDs", async () => {
  const original = plantillaConFilas([{ sku: "00123-1/A", celdaSku: " \u00a0PANAFARGOSAS_ 00123-1/A \u00a0 ", id: "000000123", productoId: "000000999" }]);
  const resultado = await generarPlantillaAsociacion([{ sku: " 00123-1/A ", precio: 400000, inventario: 3 }]);
  assert.equal(resultado.filasEscritas, 1);
  assert.deepEqual(resultado.noEncontrados, []);
  const hoja = await leerResultado(resultado);
  assert.equal(hoja.K6.v, 400000);
  assert.equal(hoja.K6.t, "n");
  assert.equal(hoja.N6.v, 1);
  for (const columna of ["B", "C", "D", "E", "F", "G", "H", "I", "J", "L", "M"]) {
    assert.equal(hoja[`${columna}6`]?.v, original[`${columna}6`]?.v, `Conservar el valor original en ${columna}6`);
    assert.equal(hoja[`${columna}6`]?.t, original[`${columna}6`]?.t, `Conservar el tipo original en ${columna}6`);
  }
  assert.equal(lecturasLocales, 0, "Usar el archivo seleccionado, no la plantilla de respaldo.");
});

test("la creación entrega el SKU completo y la asociación usa su fila devuelta, no el orden de entrada", async () => {
  const publicaciones = [
    { sku: "11351/MoveForward", precio: 400000, inventario: 3 },
    { sku: "11351/YourDream", precio: 664400, inventario: 6 },
  ];
  const xlsxCreacion = await generarXlsxLoteRappi(publicaciones.map((p) => ({
    ...p, categoria: "Papelería", nombre: p.sku, descripcion: "Prueba local",
    es_pesable: "NO", es_preempaquetado: "NO", cantidad: 1, unidad_medida: "g (gramos)",
  })));
  const creada = XLSX.read(await xlsxCreacion.arrayBuffer(), { type: "array" }).Sheets.Productos;
  assert.equal(creada.D6.v, publicaciones[0].sku);
  assert.equal(creada.D7.v, publicaciones[1].sku);

  plantillaConFilas([
    { sku: creada.D7.v, productoId: "id-devuelto-diseno-B" },
    { sku: creada.D6.v, productoId: "id-devuelto-diseno-A" },
    { sku: "11351", productoId: "id-base-no-seleccionada" },
  ]);
  const resultado = await generarPlantillaAsociacion(publicaciones);
  const asociada = await leerResultado(resultado);
  assert.equal(resultado.filasEscritas, 2);
  assert.equal(asociada.G6.v, "PANAFARGOSAS_11351/YourDream");
  assert.equal(asociada.E6.v, "id-devuelto-diseno-B");
  assert.equal(asociada.K6.v, 664400);
  assert.equal(asociada.N6.v, 2);
  assert.equal(asociada.E7.v, "id-devuelto-diseno-A");
  assert.equal(asociada.K7.v, 400000);
  assert.equal(asociada.N7.v, 1);
  assert.equal(asociada.G8, undefined);
  assert.equal(asociada.N8, undefined);
});

test("cada diseño conserva su conteo y la reserva vigente, sin sumar la base", async () => {
  const stocks = [0, 3, 6, 49, 50, 51];
  const publicaciones = stocks.map((inventario, i) => ({ sku: `11351/Diseno-${i}`, precio: 100000, inventario }));
  plantillaConFilas([...publicaciones, { sku: "11351" }]);
  const hoja = await leerResultado(await generarPlantillaAsociacion(publicaciones));
  assert.deepEqual(stocks.map((_, i) => hoja[`N${i + 6}`].v), [0, 1, 2, 16, 25, 25]);
  assert.equal(hoja.G12, undefined);
});

test("no confunde guiones, nombres parecidos ni mayúsculas de diseño", async () => {
  plantillaConFilas([{ sku: "10498-1/Femenino" }, { sku: "10498/Femenino" }, { sku: "10498-1/femenino" }]);
  const resultado = await generarPlantillaAsociacion([{ sku: "10498-1/Femenino", precio: 400000, inventario: 3 }]);
  const hoja = await leerResultado(resultado);
  assert.equal(resultado.filasEscritas, 1);
  assert.equal(hoja.G6.v, "PANAFARGOSAS_10498-1/Femenino");
  assert.equal(hoja.G7, undefined);
  assert.equal(hoja.G8, undefined);
});

test("una coincidencia parcial informa los diseños faltantes y no usa su base como reemplazo", async () => {
  plantillaConFilas([{ sku: "11351/A" }, { sku: "11351" }]);
  const resultado = await generarPlantillaAsociacion([
    { sku: "11351/A", precio: 400000, inventario: 3 },
    { sku: "11351/B", precio: 400000, inventario: 900 },
  ]);
  assert.equal(resultado.filasEscritas, 1);
  assert.deepEqual(resultado.noEncontrados, ["11351/B"]);
  const hoja = await leerResultado(resultado);
  assert.equal(hoja.G7, undefined);
  assert.equal(hoja.N6.v, 1);
});

test("cero coincidencias devuelve faltantes completos para que la UI bloquee la exportación", async () => {
  plantillaConFilas([{ sku: "11351" }]);
  const resultado = await generarPlantillaAsociacion([{ sku: "11351/MoveForward", precio: 400000, inventario: 3 }]);
  assert.equal(resultado.filasEscritas, 0);
  assert.deepEqual(resultado.noEncontrados, ["11351/MoveForward"]);
  const hoja = await leerResultado(resultado);
  assert.equal(hoja.G6, undefined);
  assert.equal(hoja.K6, undefined);
  assert.equal(hoja.N6, undefined);
});

test("filas duplicadas incluso con espacios no eligen un ID de Rappi silenciosamente", async () => {
  plantillaConFilas([{ sku: "11351/A" }, { sku: "11351/A", celdaSku: " PANAFARGOSAS_11351/A " }]);
  await assert.rejects(generarPlantillaAsociacion([{ sku: "11351/A", precio: 400000, inventario: 3 }]), /varias filas.*11351\/A/);
});

test("un lote duplicado no sobrescribe precios o conteos con el último diseño", async () => {
  plantillaConFilas([{ sku: "11351/A" }]);
  await assert.rejects(generarPlantillaAsociacion([
    { sku: "11351/A", precio: 400000, inventario: 3 },
    { sku: " 11351/A ", precio: 664400, inventario: 999 },
  ]), /repite el SKU completo/);
});

test("una plantilla guardada corrupta no se reemplaza silenciosamente con los IDs del respaldo", async () => {
  guardado = "base64%%%inválida";
  await assert.rejects(generarPlantillaAsociacion([{ sku: "11351/A", precio: 400000, inventario: 3 }]), /guardada no se pudo leer/);
  assert.equal(lecturasLocales, 0);
});

test("un fallo al leer la selección pide recuperar el archivo en lugar de usar otra plantilla", async () => {
  falloAlLeer = true;
  await assert.rejects(generarPlantillaAsociacion([{ sku: "11351/A", precio: 400000, inventario: 3 }]), /No se pudo leer.*guardada/);
  assert.equal(lecturasLocales, 0);
});

test("la plantilla real incluida sigue funcionando y sus bytes originales no cambian", async () => {
  const original = XLSX.read(bytesOriginales, { type: "buffer" }).Sheets.Productos;
  const resultado = await generarPlantillaAsociacion([{ sku: "10085", precio: 400000, inventario: 3 }]);
  const hoja = await leerResultado(resultado);
  assert.equal(resultado.filasEscritas, 1);
  assert.equal(hoja.K8.v, 400000);
  assert.equal(hoja.N8.v, 1);
  assert.equal(hoja.E8.v, original.E8.v);
  assert.equal(Buffer.compare(await readFile(plantillaUrl), bytesOriginales), 0);
});

test("una hoja Productos vacía produce un error de plantilla comprensible", async () => {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, {}, "Productos");
  guardado = Buffer.from(XLSX.write(libro, { type: "buffer", bookType: "xlsx" })).toString("base64");
  await assert.rejects(generarPlantillaAsociacion([{ sku: "11351/A", precio: 400000, inventario: 3 }]), /rango de asociación válido/);
});
