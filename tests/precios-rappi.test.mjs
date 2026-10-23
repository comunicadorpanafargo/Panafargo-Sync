import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { calcularPrecioRappi, desdeShopify } from "../utils/model.js";
import { prepararParaRappi } from "../rappi/rappi-connector.js";
import { generarPlantillaAsociacion } from "../rappi/rappi-association.js";
import { generarXlsxLoteRappi } from "../rappi/rappi-batch.js";

const require = createRequire(import.meta.url);
const XLSX = require("../vendor/xlsx.full.min.js");
const originalGlobals = { fetch: globalThis.fetch, chrome: globalThis.chrome, window: globalThis.window };

before(() => {
  const local = {};
  globalThis.window = { XLSX };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: local[key] }),
        set: async (values) => Object.assign(local, values),
      },
    },
    runtime: { getURL: (path) => new URL(`../${path}`, import.meta.url).href },
  };
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "file:", "Las pruebas no deben consultar servicios externos.");
    assert.ok(parsed.href.startsWith(new URL("../rappi/", import.meta.url).href));
    const bytes = await readFile(parsed);
    return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
});

after(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

const casos = [
  ["Prismacolor x72", "350000", null, 400000],
  ["Prismacolor x132", "516700", null, 664400],
  ["inmediatamente antes del umbral", "444499", null, 508000],
  ["umbral inclusive con descuento20%", "444500", null, 508000],
  ["inmediatamente después del umbral con descuento10%", "444501", null, 571600],
  ["500000 pertenece al tramo superior", "500000", null, 642900],
  ["antes del antiguo umbral400000", "399999", null, 457200],
  ["400000 ya no cambia de tramo", "400000", null, 457200],
  ["rebaja Shopify no reduce el precio base", "280000.00", "350000.00", 400000],
  ["el tramo se elige con el precio normal", "400000", "516700", 664400],
  ["compareAtPrice menor se ignora", "350000", "280000", 400000],
  ["compareAtPrice igual conserva la base", "350000", "350000", 400000],
  ["precio de comparación disponible sin price", null, "350000", 400000],
  ["no se redondean etapas intermedias", "100001", null, 114300],
  ["1344 sube a1400", "1176", null, 1400],
  ["centena exacta se conserva", "1225", null, 1400],
  ["centena exacta en tramo superior", "448000", null, 576000],
];

for (const [nombre, precio, comparacion, esperado] of casos) {
  test(nombre, () => assert.equal(calcularPrecioRappi(precio, comparacion), esperado));
}

test("los seis precios de referencia quedan dentro de la diferencia aceptada de200COP", () => {
  // Precios normales observados el23/10/2026; son referencias, no objetivos
  // que deban escribirse en Rappi ni precios usados para ajustar la fórmula.
  const referencias = [
    ["10398", 516700, 664300],
    ["40053", 26900, 30800],
    ["10002", 3900, 4500],
    ["20502", 29200, 33300],
    ["20495", 20400, 23300],
    ["10614", 700, 800],
  ];
  for (const [sku, baseShopify, normalRappi] of referencias) {
    const calculado = calcularPrecioRappi(baseShopify, null);
    assert.ok(Math.abs(calculado - normalRappi) <= 200, `Diferencia fuera de rango para SKU ${sku}`);
  }
});

for (const [nombre, precio] of [
  ["precio ausente", null],
  ["precio vacío", ""],
  ["precio no numérico", "no es un precio"],
  ["precio negativo", "-1"],
  ["base con fracción de peso no admitida", "350000.50"],
  ["entero fuera de rango seguro", "9007199254740992"],
]) {
  test(nombre, () => assert.equal(calcularPrecioRappi(precio, null), null));
}

test("el resultado fuera del rango seguro se rechaza", () => {
  assert.throws(() => calcularPrecioRappi(Number.MAX_SAFE_INTEGER, null), RangeError);
});

function productoSimulado(sku = "10085", precio = "280000", comparacion = "350000") {
  return desdeShopify({
    sku,
    price: precio,
    compareAtPrice: comparacion,
    inventoryQuantity: 100,
    availableForSale: true,
    inventoryItem: { tracked: true, measurement: { weight: { value: 1, unit: "GRAMS" } } },
    product: {
      title: "Producto simulado para prueba local",
      descriptionHtml: "<p>Datos de prueba; no se suben a Rappi.</p>",
      featuredImage: { url: "https://example.invalid/prueba.jpg" },
      images: { edges: [{ node: { url: "https://example.invalid/prueba.jpg" } }] },
    },
  });
}

test("normalización y preparación recalculan el precio anterior sin mutar el producto", async () => {
  const normalizado = productoSimulado();
  assert.equal(normalizado.precio, 280000);
  assert.equal(normalizado.precio_comparacion, 350000);
  assert.equal(normalizado.precio_rappi, 400000);

  const almacenado = Object.freeze({ ...normalizado, precio_rappi: 388900 });
  const resultado = await prepararParaRappi(almacenado);
  assert.equal(resultado.ok, true);
  assert.equal(resultado.rappiProduct.precio, 400000);
  assert.equal(almacenado.precio_rappi, 388900);
});

test("un precio calculado anterior no oculta que falta el precio base", async () => {
  const almacenado = { ...productoSimulado(), precio: null, precio_comparacion: null, precio_rappi: 388900 };
  const resultado = await prepararParaRappi(almacenado);
  assert.equal(resultado.ok, false);
  assert.ok(resultado.faltantes.some(({ campo }) => campo === "precio"));
});

test("asociación exporta los precios nuevos como números y conserva las demás columnas seleccionadas", async () => {
  const plantillaUrl = new URL("../rappi/ProductosAsociacion-es.xlsx", import.meta.url);
  const plantilla = await readFile(plantillaUrl);
  const original = XLSX.read(plantilla, { type: "buffer" }).Sheets.Productos;
  const entradas = [
    { ...productoSimulado("10085"), precio_rappi: 388900 },
    { ...productoSimulado("11135", "465030", "516700"), precio_rappi: 645900 },
  ];
  const preparados = await Promise.all(entradas.map(prepararParaRappi));
  assert.ok(preparados.every((r) => r.ok));

  const generado = await generarPlantillaAsociacion(preparados.map(({ rappiProduct }) => ({
    sku: rappiProduct.sku,
    precio: rappiProduct.precio,
    inventario: rappiProduct.inventario,
  })));
  assert.equal(generado.filasEscritas, 2);
  assert.deepEqual(generado.noEncontrados, []);
  const hoja = XLSX.read(await generado.blob.arrayBuffer(), { type: "array" }).Sheets.Productos;
  assert.equal(hoja.K8.v, 400000);
  assert.equal(hoja.K9.v, 664400);
  assert.equal(hoja.K8.t, "n");
  assert.equal(hoja.K9.t, "n");
  for (const fila of [8, 9]) {
    for (const columna of ["B", "C", "D", "E", "F", "G", "H", "I", "J", "L", "M"]) {
      assert.equal(hoja[`${columna}${fila}`]?.v, original[`${columna}${fila}`]?.v, `Conservar ${columna}${fila}`);
    }
  }
  assert.equal(hoja.G6, undefined, "No incluir productos ajenos al lote.");
  assert.equal(hoja.K6, undefined);
  assert.equal(Buffer.compare(await readFile(plantillaUrl), plantilla), 0, "Los bytes de la plantilla original deben permanecer intactos.");
});

test("la creación conserva su formato y no agrega precios a la plantilla", async () => {
  const preparado = await prepararParaRappi(productoSimulado());
  assert.equal(preparado.ok, true);
  const blob = await generarXlsxLoteRappi([preparado.rappiProduct]);
  const hoja = XLSX.read(await blob.arrayBuffer(), { type: "array" }).Sheets.Productos;
  assert.equal(hoja.D6.v, "10085");
  assert.ok(!Object.values(hoja).some((cell) => cell && typeof cell === "object" && cell.v === 400000));
});
