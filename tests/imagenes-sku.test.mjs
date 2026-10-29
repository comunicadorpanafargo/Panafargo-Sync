import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { descargarImagenPrincipal, nombreArchivoImagenLocal, nombreArchivoImagenRappi } from "../images/image-handler.js";
import { construirPaqueteImagenesLocales, construirPaqueteImagenesLocalesDesdePreparadas, construirZipImagenes, prepararImagenesIndividualesPorSku, ErrorImagenesRappi } from "../rappi/rappi-images-zip.js";

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

const nombreRappiEsperado = (sku, extension = ".jpg") => `pf_img_${createHash("sha256").update(sku, "utf8").digest("hex")}${extension}`;

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

test("los adjuntos de Rappi tienen nombres ASCII estables a partir del SKU completo", async () => {
  const skus = [
    "11351/MoveForward", "11351/YourDream", "0001/A", "1/A", "ABC/hola", "abc/hola",
    "A/B", "A%2FB", "A\\B", "A?B#C", "CON", "NUL", "cuaderno/niño🎨", `12345/${"diseño".repeat(1000)}`,
  ];
  const nombres = [];
  for (const sku of skus) {
    const nombre = await nombreArchivoImagenRappi(sku, ".png");
    assert.equal(nombre, nombreRappiEsperado(sku, ".png"), "El hash coincide con SHA-256 UTF-8 calculado con node:crypto.");
    assert.equal(await nombreArchivoImagenRappi(sku, ".png"), nombre);
    assert.match(nombre, /^pf_img_[a-f0-9]{64}\.png$/);
    assert.doesNotMatch(nombre, /[%\/\\?#\s]/);
    assert.ok(nombre.length <= 80, "Un SKU largo no produce una ruta ni un nombre demasiado largo.");
    nombres.push(nombre);
  }
  assert.equal(new Set(nombres).size, skus.length, "Se distinguen diseños, ceros iniciales, mayúsculas y escapes literales.");
  assert.equal(await nombreArchivoImagenRappi(skus[0]), nombreRappiEsperado(skus[0]));
});

test("un nombre remoto inválido se rechaza en lugar de recurrir al nombre local codificado", async () => {
  for (const sku of [null, "", " 11351/A", "11351/A ", "11351\nA"]) {
    await assert.rejects(nombreArchivoImagenRappi(sku), /SKU completo válido/);
  }
  for (const extension of [".webp", ".gif", ".JPG", "png", ".jpg/otra"]) {
    await assert.rejects(nombreArchivoImagenRappi("11351/A", extension), /JPG o PNG/);
  }
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
      assert.equal(error.code, "SKU_IMAGEN_REQUIERE_CARGA_POR_FILA");
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

test("el respaldo local mantiene dos SKU completos de la misma base y solo sus imágenes principales", async () => {
  const filas = [fila("0009-423/1"), fila("0009-423/2")];
  const antes = structuredClone(filas);
  const blob = await construirPaqueteImagenesLocales(filas);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), [
    "0009-423%2F1.jpg", "0009-423%2F2.jpg", "LEEME.txt", "mapa_imagenes.csv", "mapa_imagenes.json",
  ]);
  assert.deepEqual(JSON.parse(await zip.file("mapa_imagenes.json").async("string")), {
    uso: "respaldo_carga_automatica_por_sku",
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

test("una imagen que sigue superando 1 MB no produce un ZIP, un paquete local ni un adjunto individual", async () => {
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
  for (const [crear, sku] of [[construirZipImagenes, "0009-423"], [construirPaqueteImagenesLocales, "0009-423/1"], [prepararImagenesIndividualesPorSku, "0009-423/2"]]) {
    await assert.rejects(crear([fila(sku)]), (error) => {
      assert.ok(error instanceof ErrorImagenesRappi);
      assert.equal(error.code, "IMAGEN_SUPERA_LIMITE");
      assert.deepEqual(error.skus, [sku]);
      assert.ok(error.message.includes(sku));
      assert.match(error.message, /1 MB/);
      return true;
    });
  }
  assert.equal(compresiones, 27, "Cada imagen agota ocho intentos y una compresión final.");
  assert.equal(bitmapsCerrados, 3, "También se libera el bitmap cuando falla la compresión.");
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

test("la preparación individual conserva los SKU completos y la foto principal propia de cada publicación", async () => {
  const filas = [fila("34534/hola"), fila("34534/adios"), fila("10498-1")];
  for (const [indice, { producto }] of filas.entries()) {
    producto.imagen_principal = `https://example.invalid/variante-${indice}.jpg`;
    producto.imagenes = ["https://example.invalid/general-del-producto.jpg", "https://example.invalid/secundaria.jpg"];
  }
  const antes = structuredClone(filas);
  globalThis.fetch = async (url) => {
    consultas.push(url);
    const indice = Number(url.match(/variante-(\d+)/)[1]);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, indice]);
    return { ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => bytes.buffer };
  };
  const imagenes = await prepararImagenesIndividualesPorSku(filas);
  assert.deepEqual(imagenes.map(({ sku }) => sku), ["34534/hola", "34534/adios", "10498-1"]);
  assert.deepEqual(imagenes.map(({ nombre }) => nombre), filas.map(({ producto }) => nombreRappiEsperado(producto.sku)));
  for (const [indice, imagen] of imagenes.entries()) {
    assert.equal(imagen.tipoMime, "image/jpeg");
    assert.deepEqual(Array.from(Buffer.from(imagen.base64, "base64")), [0xff, 0xd8, 0xff, indice]);
  }
  assert.deepEqual(consultas, filas.map(({ producto }) => producto.imagen_principal));
  assert.deepEqual(filas, antes, "Los nombres de archivo seguros no modifican el SKU ni la publicación.");
});

test("el respaldo usa los mismos bytes preparados para Rappi sin descargar otra vez las fotos", async () => {
  const filas = [fila("11351/MoveForward"), fila("11351/YourDream"), fila("10498-1")];
  const imagenes = await prepararImagenesIndividualesPorSku(filas);
  const original = structuredClone(imagenes);
  assert.equal(consultas.length, 3);
  const blob = await construirPaqueteImagenesLocalesDesdePreparadas(imagenes);
  assert.equal(consultas.length, 3, "Crear el respaldo no hace peticiones adicionales.");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const mapa = JSON.parse(await zip.file("mapa_imagenes.json").async("string"));
  assert.equal(mapa.uso, "respaldo_carga_automatica_por_sku");
  assert.deepEqual(mapa.imagenes, imagenes.map(({ sku, nombre }) => ({ sku, archivo: nombre })));
  for (const imagen of imagenes) {
    assert.deepEqual(await zip.file(imagen.nombre).async("uint8array"), Uint8Array.from(Buffer.from(imagen.base64, "base64")));
  }
  assert.ok(zip.file("LEEME.txt"));
  assert.ok(zip.file("mapa_imagenes.csv"));
  const instrucciones = await zip.file("LEEME.txt").async("string");
  assert.match(instrucciones, /carga las fotos automaticamente/);
  assert.doesNotMatch(instrucciones, /asignacion manual|manualmente|asigna cada imagen/i);
  assert.deepEqual(imagenes, original);
});

test("el respaldo preparado rechaza rutas, identidad inválida, base64 dañado y tipos no admitidos", async () => {
  const [imagen] = await prepararImagenesIndividualesPorSku([fila("11351/MoveForward")]);
  for (const datos of [
    [], [null], [{ ...imagen, sku: "" }], [{ ...imagen, sku: "11351/" }],
    [{ ...imagen, nombre: "11351/MoveForward.jpg" }], [{ ...imagen, tipoMime: "image/webp" }],
    [{ ...imagen, base64: "@dañado" }], [{ ...imagen, base64: "" }],
    [{ ...imagen, base64: btoa("x".repeat(1_000_001)) }],
  ]) await assert.rejects(construirPaqueteImagenesLocalesDesdePreparadas(datos));
  assert.equal(consultas.length, 1);
});

test("el respaldo preparado impide SKU repetidos y distingue identidades que solo difieren en mayúsculas", async () => {
  const imagenes = await prepararImagenesIndividualesPorSku([fila("ABC/hola"), fila("abc/hola")]);
  await assert.rejects(construirPaqueteImagenesLocalesDesdePreparadas([imagenes[0], imagenes[0]]), { code: "NOMBRE_IMAGEN_DUPLICADO" });
  const zip = await JSZip.loadAsync(await (await construirPaqueteImagenesLocalesDesdePreparadas(imagenes)).arrayBuffer());
  assert.notEqual(imagenes[0].nombre.toLowerCase(), imagenes[1].nombre.toLowerCase());
  for (const imagen of imagenes) assert.ok(zip.file(imagen.nombre));
});

test("los SKU duplicados o inválidos detienen la preparación individual antes de descargar", async () => {
  for (const filas of [[fila("34534/hola"), fila("34534/hola")], [fila("")], [fila("/hola")], [fila("34534/")], [fila("34534//hola")], [fila(" 34534/hola ")], [null]]) {
    await assert.rejects(prepararImagenesIndividualesPorSku(filas), (error) => {
      assert.ok(error instanceof ErrorImagenesRappi);
      assert.ok(["SKU_IMAGEN_DUPLICADO", "SKU_IMAGEN_INVALIDO"].includes(error.code));
      return true;
    });
  }
  await assert.rejects(prepararImagenesIndividualesPorSku([]), { code: "LOTE_IMAGENES_VACIO" });
  assert.equal(consultas.length, 0);
});

test("una publicación sin foto principal no hereda la imagen general ni inicia una preparación parcial", async () => {
  const filas = [fila("34534/hola"), fila("34534/adios")];
  filas[1].producto.imagen_principal = null;
  await assert.rejects(prepararImagenesIndividualesPorSku(filas), { code: "IMAGEN_PRINCIPAL_AUSENTE" });
  assert.equal(consultas.length, 0);
});

test("un adjunto individual de exactamente 1 MB se codifica completo sin desbordar la pila", async () => {
  const bytes = new Uint8Array(1_000_000);
  bytes.set([0xff, 0xd8, 0xff]);
  bytes[bytes.length - 1] = 73;
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => bytes.buffer });
  const [imagen] = await prepararImagenesIndividualesPorSku([fila("34534/hola")]);
  assert.deepEqual(new Uint8Array(Buffer.from(imagen.base64, "base64")), bytes);
});

test("WebP se recodifica a JPEG solo para el adjunto individual, con nombre y MIME coherentes", async () => {
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 17]);
  const dimensiones = [];
  let bitmapsCerrados = 0;
  const url = "https://example.invalid/foto-propia-variante.webp";
  globalThis.fetch = async (solicitada) => {
    consultas.push(solicitada);
    return { ok: true, headers: { get: () => "image/webp" }, arrayBuffer: async () => webp.buffer };
  };
  globalThis.createImageBitmap = async () => ({ width: 800, height: 700, close: () => { bitmapsCerrados++; } });
  globalThis.OffscreenCanvas = class {
    constructor(ancho, alto) { dimensiones.push([ancho, alto]); }
    getContext() { return { drawImage() {} }; }
    async convertToBlob(opciones) {
      assert.equal(opciones.type, "image/jpeg");
      return new Blob([jpeg], { type: "image/jpeg" });
    }
  };
  const normal = fila("34534");
  normal.producto.imagen_principal = url;
  normal.producto.imagenes = [url];
  const legacyZip = await JSZip.loadAsync(await (await construirZipImagenes([normal])).arrayBuffer());
  assert.deepEqual(Array.from(await legacyZip.file("34534.webp").async("uint8array")), Array.from(webp));
  assert.equal(dimensiones.length, 0, "El comportamiento del ZIP existente no cambia.");

  const diseno = fila("34534/hola");
  diseno.producto.imagen_principal = url;
  const [imagen] = await prepararImagenesIndividualesPorSku([diseno]);
  assert.equal(imagen.sku, "34534/hola");
  assert.equal(imagen.nombre, nombreRappiEsperado(diseno.producto.sku));
  assert.equal(imagen.tipoMime, "image/jpeg");
  assert.deepEqual(Array.from(Buffer.from(imagen.base64, "base64")), Array.from(jpeg));
  assert.deepEqual(consultas, [url, url], "Se usa la URL propia de la variante en ambos modos.");
  assert.deepEqual(dimensiones, [[800, 700]], "No se amplía ni cambia el tamaño de la imagen válida.");
  assert.equal(bitmapsCerrados, 1);
});
