import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { desdeShopify } from "../utils/model.js";
import { prepararParaRappi } from "../rappi/rappi-connector.js";
import { generarXlsxLoteRappi, blobABase64 } from "../rappi/rappi-batch.js";
import { construirZipImagenes } from "../rappi/rappi-images-zip.js";

const require = createRequire(import.meta.url);
const JSZip = require("../vendor/jszip.min.js");
const XLSX = require("../vendor/xlsx.full.min.js");
const originales = { fetch: globalThis.fetch, chrome: globalThis.chrome, window: globalThis.window };

// PNG válidos de 1 × 1, de colores distintos. Cada foto tiene bytes propios;
// intercambiar imágenes entre productos o posiciones debe hacer fallar la prueba.
const PNG_BASE64 = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgYWUGAAA1ABXn+q/kAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQFRIDAACVAEZtW9FjAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQk9cEAAD1AHe8tBW3AAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOw17EBAAFVAKiCA0UoAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIsPQHAAG1ANnlG6bGAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNIdEsCAAIVAQqOmQJXAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMoCi4FAAJ1ATu2opixAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoTugAAALVAWwWkPWUAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYkjsbAAM1AZ35CsuSAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYWrUOAAOVAc5IpsvxAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPY1n4QAAP1Af/EqDirAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4PuUKAARVAjCFcG2UAAAAAElFTkSuQmCC"
];
const fotos = PNG_BASE64.map((base64) => Buffer.from(base64, "base64"));
let urls;
let consultasImagenes;

beforeEach(() => {
  urls = new Map();
  consultasImagenes = [];
  const almacen = {};
  globalThis.window = { JSZip, XLSX };
  globalThis.chrome = {
    runtime: { getURL: (ruta) => "chrome-extension://prueba/" + ruta },
    storage: { local: {
      get: async (clave) => ({ [clave]: almacen[clave] }),
      set: async (valores) => Object.assign(almacen, valores),
    } },
  };
  globalThis.fetch = async (url) => {
    if (url === "chrome-extension://prueba/rappi/plantilla-rappi-base.xlsx") {
      return new Response(await readFile(new URL("../rappi/plantilla-rappi-base.xlsx", import.meta.url)));
    }
    assert.ok(urls.has(url), "Solo se admiten las fotografías simuladas; nunca se consulta la red.");
    consultasImagenes.push(url);
    return new Response(urls.get(url), { headers: { "Content-Type": "image/png" } });
  };
});

afterEach(() => {
  for (const [clave, valor] of Object.entries(originales)) {
    if (valor === undefined) delete globalThis[clave];
    else globalThis[clave] = valor;
  }
});

function raw(sku, indices) {
  // El nombre remoto no contiene el SKU. El vínculo debe proceder del código
  // del producto, nunca del nombre original de la foto ni del título.
  const galeria = indices.map((indice) => {
    const url = "https://example.invalid/cdn/fotografia-ajena-al-sku-" + indice + ".png";
    urls.set(url, fotos[indice]);
    return { node: { url } };
  });
  return {
    id: "gid://shopify/ProductVariant/" + indices[0],
    sku, price: "350000", compareAtPrice: null, inventoryQuantity: 30,
    availableForSale: true, image: galeria[0].node,
    inventoryItem: { tracked: true, measurement: { weight: { value: 100, unit: "GRAMS" } } },
    product: {
      id: "gid://shopify/Product/" + indices[0],
      title: "Nombre comercial diferente del código",
      descriptionHtml: "<p>Prueba local; no se publica ningún producto.</p>",
      featuredImage: galeria[0].node,
      images: { edges: galeria, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

async function prepararArchivos(entradas) {
  const filas = [];
  for (const entrada of entradas) {
    const producto = desdeShopify(entrada);
    const resultado = await prepararParaRappi(producto);
    assert.equal(resultado.ok, true);
    filas.push({ producto, resultado });
  }
  const xlsx = await generarXlsxLoteRappi(filas.map((fila) => fila.resultado.rappiProduct));
  const imagenes = await construirZipImagenes(filas);
  const libro = XLSX.read(await xlsx.arrayBuffer(), { type: "array" });
  const zip = await JSZip.loadAsync(await imagenes.arrayBuffer());
  return { filas, imagenes, libro, zip };
}

test("el SKU completo del Excel identifica la principal y todas las secundarias, conservando guiones y ceros", async () => {
  const { filas, imagenes, libro, zip } = await prepararArchivos([
    raw(" 4354323-1 ", [0, 1, 2]),
    raw("4354323-2", [3, 4, 5]),
    raw("40105", [6, 7, 8]),
    raw("004354323-1", [9, 10, 11]),
  ]);
  // Expectativas literales, independientes de la lógica de nombrado.
  const esperados = [
    { sku: "4354323-1", celda: "D6", fotos: [["4354323-1.png", 0], ["4354323-1_1.png", 1], ["4354323-1_2.png", 2]] },
    { sku: "4354323-2", celda: "D7", fotos: [["4354323-2.png", 3], ["4354323-2_1.png", 4], ["4354323-2_2.png", 5]] },
    { sku: "40105", celda: "D8", fotos: [["40105.png", 6], ["40105_1.png", 7], ["40105_2.png", 8]] },
    { sku: "004354323-1", celda: "D9", fotos: [["004354323-1.png", 9], ["004354323-1_1.png", 10], ["004354323-1_2.png", 11]] },
  ];
  for (let i = 0; i < esperados.length; i++) {
    const esperado = esperados[i];
    assert.equal(filas[i].producto.sku, esperado.sku);
    assert.equal(filas[i].resultado.sku, esperado.sku);
    assert.equal(filas[i].resultado.rappiProduct.sku, esperado.sku);
    assert.equal(libro.Sheets.Productos[esperado.celda].t, "s");
    assert.equal(libro.Sheets.Productos[esperado.celda].v, esperado.sku);
    for (const [nombre, indice] of esperado.fotos) {
      assert.ok(zip.file(nombre), "Falta la fotografía " + nombre);
      assert.deepEqual(Buffer.from(await zip.file(nombre).async("uint8array")), fotos[indice]);
    }
  }
  assert.deepEqual(Object.keys(zip.files).sort(), esperados.flatMap((e) => e.fotos.map(([nombre]) => nombre)).sort());
  assert.equal(zip.file("4354323.png"), null, "No se recorta el guion del SKU.");
  assert.ok(!Object.keys(zip.files).some((nombre) => nombre.startsWith("PANAFARGOSAS_") || nombre.startsWith("pf_img_") || nombre.includes("/")));
  assert.equal(consultasImagenes.length, 12);

  // El mismo ZIP debe sobrevivir al transporte usado por el mensaje a Mi Tienda.
  const base64 = await blobABase64(imagenes);
  assert.deepEqual(Buffer.from(base64, "base64"), Buffer.from(await imagenes.arrayBuffer()));
  const recibido = await JSZip.loadAsync(Buffer.from(base64, "base64"));
  assert.deepEqual(Object.keys(recibido.files).sort(), Object.keys(zip.files).sort());
});

test("un producto de una sola foto conserva su SKU sin añadir un guion ni inventar una secundaria", async () => {
  const { filas, libro, zip } = await prepararArchivos([raw("40105", [0])]);
  assert.equal(filas[0].producto.imagenes_completas, true);
  assert.equal(libro.Sheets.Productos.D6.t, "s");
  assert.equal(libro.Sheets.Productos.D6.v, "40105");
  assert.deepEqual(Object.keys(zip.files), ["40105.png"]);
  assert.deepEqual(Buffer.from(await zip.file("40105.png").async("uint8array")), fotos[0]);
  assert.equal(zip.file("40105-1.png"), null);
  assert.equal(zip.file("40105_1.png"), null);
  assert.equal(zip.file("PANAFARGOSAS_40105.png"), null);
  assert.equal(consultasImagenes.length, 1);
});

