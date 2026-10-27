import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { descargarImagenPrincipal, nombreArchivoImagenLocal } from "../images/image-handler.js";
import { construirPaqueteImagenesLocales, construirZipImagenes, ErrorImagenesRappi } from "../rappi/rappi-images-zip.js";

const require = createRequire(import.meta.url);
const JSZip = require("../vendor/jszip.min.js");
const originales = {
  window: globalThis.window, chrome: globalThis.chrome, fetch: globalThis.fetch,
  createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas,
};
let descargas;
let consultas;

beforeEach(() => {
  descargas = [];
  consultas = [];
  globalThis.window = { JSZip };
  globalThis.chrome = { downloads: { download: async (datos) => { descargas.push(datos); return 7; } } };
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, "example.invalid", "No se consultan servicios externos.");
    consultas.push(url);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, url.includes("secundaria") ? 2 : 1]);
    return {
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => bytes.buffer,
    };
  };
});

after(() => {
  for (const [clave, valor] of Object.entries(originales)) {
    if (valor === undefined) delete globalThis[clave];
    else globalThis[clave] = valor;
  }
});

function fila(sku) {
  return { producto: {
    sku,
    imagen_principal: `https://example.invalid/${encodeURIComponent(sku)}.jpg`,
    imagenes: [
      `https://example.invalid/${encodeURIComponent(sku)}.jpg`,
      `https://example.invalid/${encodeURIComponent(sku)}-secundaria.jpg`,
    ],
  } };
}

test("los nombres locales son planos y reversibles, incluidos barras, porcentajes y nombres reservados", () => {
  const skus = ["0009-423", "40593/3", "A/B", "A%2FB", "CON", "con.txt", "LPT1", "A?B:C*D\"E<F>G|H\\I", ".", ".."];
  for (const sku of skus) {
    const archivo = nombreArchivoImagenLocal(sku, ".jpg");
    assert.doesNotMatch(archivo, /[\/\\:*?"<>|]/);
    assert.equal(decodeURIComponent(archivo.slice(0, -4)), sku);
    assert.doesNotMatch(archivo, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i);
  }
  assert.equal(nombreArchivoImagenLocal("0009-423", ".JPG"), "0009-423.jpg");
  assert.notEqual(nombreArchivoImagenLocal("A/B"), nombreArchivoImagenLocal("A%2FB"));
});

test("la descarga individual usa un nombre plano y conserva el SKU original", async () => {
  const producto = fila("0009-423/1").producto;
  const original = structuredClone(producto);
  const ruta = await descargarImagenPrincipal(producto);
  assert.equal(ruta, "Panafargo_Rappi/Imagenes/0009-423%2F1.jpg");
  assert.deepEqual(descargas, [{ url: original.imagen_principal, filename: ruta, saveAs: false }]);
  assert.deepEqual(producto, original);
});

test("la carga masiva no inventa equivalencias para un SKU con separador ni descarga imágenes", async () => {
  for (const sku of ["40593/3", "40593\\3"]) {
    await assert.rejects(construirZipImagenes([fila(sku)]), (error) => {
      assert.ok(error instanceof ErrorImagenesRappi);
      assert.equal(error.code, "SKU_IMAGEN_REQUIERE_ASIGNACION_MANUAL");
      assert.deepEqual(error.skus, [sku]);
      return true;
    });
  }
  assert.equal(consultas.length, 0);
});

test("una secundaria y el SKU de otro producto no pueden sobrescribirse en el ZIP", async () => {
  await assert.rejects(construirZipImagenes([fila("A"), fila("A_1")]), (error) => {
    assert.equal(error.code, "NOMBRE_IMAGEN_DUPLICADO");
    assert.deepEqual(error.skus, ["A", "A_1"]);
    return true;
  });
  assert.equal(consultas.length, 0);
});

test("el ZIP automático conserva las imágenes y los nombres de SKU normales con guiones", async () => {
  const blob = await construirZipImagenes([fila("0009-423")]);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), ["0009-423.jpg", "0009-423_1.jpg"]);
  assert.deepEqual(Array.from(await zip.file("0009-423.jpg").async("uint8array")), [0xff, 0xd8, 0xff, 1]);
  assert.deepEqual(Array.from(await zip.file("0009-423_1.jpg").async("uint8array")), [0xff, 0xd8, 0xff, 2]);
});

test("el paquete manual mantiene dos SKU completos de la misma base y solo sus imágenes principales", async () => {
  const filas = [fila("0009-423/1"), fila("0009-423/2")];
  const antes = structuredClone(filas);
  const blob = await construirPaqueteImagenesLocales(filas);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), [
    "0009-423%2F1.jpg", "0009-423%2F2.jpg", "LEEME.txt", "mapa_imagenes.csv", "mapa_imagenes.json",
  ]);
  assert.deepEqual(JSON.parse(await zip.file("mapa_imagenes.json").async("string")), {
    uso: "asignacion_manual",
    imagenes: [
      { sku: "0009-423/1", archivo: "0009-423%2F1.jpg" },
      { sku: "0009-423/2", archivo: "0009-423%2F2.jpg" },
    ],
  });
  const csv = await zip.file("mapa_imagenes.csv").async("string");
  assert.ok(csv.includes('"0009-423/1","0009-423%2F1.jpg"'));
  assert.match(await zip.file("LEEME.txt").async("string"), /NO es el ZIP de carga masiva/);
  assert.equal(consultas.length, 2);
  assert.ok(consultas.every((url) => !url.includes("secundaria")));
  assert.deepEqual(filas, antes);
});

test("el mapa local distingue una barra literal de una secuencia de escape existente", async () => {
  const blob = await construirPaqueteImagenesLocales([fila("A/B"), fila("A%2FB")]);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.ok(zip.file("A%2FB.jpg"));
  assert.ok(zip.file("A%252FB.jpg"));
});

test("el paquete local no oculta imágenes ausentes o descargas fallidas", async () => {
  const sinImagen = fila("A/B");
  sinImagen.producto.imagen_principal = null;
  await assert.rejects(construirPaqueteImagenesLocales([sinImagen]), /no tiene imagen principal/);
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(construirPaqueteImagenesLocales([fila("A/B")]), /HTTP 403/);
});

test("el CSV evita fórmulas y el JSON conserva el SKU completo sin alterarlo", async () => {
  const sku = '=SUM(1,2)/1';
  const blob = await construirPaqueteImagenesLocales([fila(sku)]);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(JSON.parse(await zip.file("mapa_imagenes.json").async("string")).imagenes[0].sku, sku);
  assert.ok((await zip.file("mapa_imagenes.csv").async("string")).includes('"\'=SUM(1,2)/1"'));
});

test("una imagen que sigue superando 1 MB no produce un ZIP automático ni un paquete local", async () => {
  let compresiones = 0;
  let bitmapsCerrados = 0;
  const bytesGrandes = new Uint8Array(1_000_001);
  bytesGrandes.set([0xff, 0xd8, 0xff]);
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => bytesGrandes.buffer,
  });
  globalThis.createImageBitmap = async () => ({ width: 2000, height: 2000, close: () => { bitmapsCerrados++; } });
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {} }; }
    async convertToBlob() {
      compresiones++;
      return new Blob([bytesGrandes], { type: "image/jpeg" });
    }
  };
  for (const [crear, sku] of [[construirZipImagenes, "0009-423"], [construirPaqueteImagenesLocales, "0009-423/1"]]) {
    await assert.rejects(crear([fila(sku)]), (error) => {
      assert.ok(error instanceof ErrorImagenesRappi);
      assert.equal(error.code, "IMAGEN_SUPERA_LIMITE");
      assert.deepEqual(error.skus, [sku]);
      assert.ok(error.message.includes(sku));
      assert.match(error.message, /1 MB/);
      return true;
    });
  }
  assert.equal(compresiones, 18, "Cada imagen agota ocho intentos y una compresión final.");
  assert.equal(bitmapsCerrados, 2, "También se libera el bitmap cuando falla la compresión.");
});

test("una compresión válida conserva la imagen reducida y libera el bitmap", async () => {
  let bitmapsCerrados = 0;
  const bytesGrandes = new Uint8Array(1_000_001);
  bytesGrandes.set([0xff, 0xd8, 0xff]);
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => bytesGrandes.buffer,
  });
  globalThis.createImageBitmap = async () => ({ width: 2000, height: 2000, close: () => { bitmapsCerrados++; } });
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9])], { type: "image/jpeg" }); }
  };
  const zip = await JSZip.loadAsync(await (await construirPaqueteImagenesLocales([fila("0009-423/1")])).arrayBuffer());
  assert.deepEqual(Array.from(await zip.file("0009-423%2F1.jpg").async("uint8array")), [0xff, 0xd8, 0xff, 9]);
  assert.equal(bitmapsCerrados, 1);
});
