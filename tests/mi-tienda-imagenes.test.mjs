import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const contexto = vm.createContext({ File, atob, setTimeout, Date, Uint8Array });
vm.runInContext(await readFile(new URL("../rappi/mi-tienda-imagenes.js", import.meta.url), "utf8"), contexto);
const { validar } = contexto.PanafargoImagenesPorSku;
const nombreSeguro = (sku) => `imagen_${Buffer.from(sku, "utf8").toString("hex")}.png`;
const imagen = (sku, contenido = "foto de prueba") => ({
  sku, nombre: nombreSeguro(sku), tipoMime: "image/png", base64: btoa(contenido),
});

test("el transporte entrega un File independiente por SKU completo sin usar el sufijo como identidad", async () => {
  const skus = ["34534/hola", "67890/hola", "0009-1/hola", "34534%2Fhola"];
  const entradas = skus.map((sku, indice) => imagen(sku, `foto ${indice}`));
  const original = structuredClone(entradas);
  const paquete = validar(entradas, skus);
  assert.deepEqual(Array.from(paquete.skus), skus);
  assert.equal(paquete.archivos.size, 4);
  for (const [indice, sku] of skus.entries()) {
    const archivo = paquete.archivos.get(sku);
    assert.ok(archivo instanceof File);
    assert.equal(archivo.name, nombreSeguro(sku));
    assert.equal(archivo.type, "image/png");
    assert.equal(await archivo.text(), `foto ${indice}`);
  }
  assert.deepEqual(entradas, original);
});

test("el mapa debe cubrir exactamente los SKU solicitados y no admitir duplicados", () => {
  assert.throws(() => validar([imagen("A/hola")], ["A/hola", "B/hola"]), /Faltan imágenes/);
  assert.throws(() => validar([imagen("A/hola"), imagen("B/hola")], ["A/hola"]), /no corresponde/);
  assert.throws(() => validar([imagen("A/hola"), imagen("A/hola")], ["A/hola", "B/hola"]), /no corresponde/);
  assert.throws(() => validar([imagen("A/hola")], ["A/hola", "A/hola"]), /duplicados/);
});

test("un SKU incompleto o caracteres de control detienen el paquete antes del DOM", () => {
  for (const sku of ["", "/hola", "123/", "123//hola", "123/ /hola", " 123/hola", "123\nhola"]) {
    assert.throws(() => validar([imagen(sku)], [sku]), /SKU vacíos, incompletos o duplicados/);
  }
});

test("la preparación no acepta adjuntos dañados, nombres de ruta ni formatos fuera de JPG/PNG", () => {
  for (const campos of [{ base64: "@imagenrota" }, { base64: "" }, { nombre: "A/hola.png" }, { tipoMime: "image/webp" }]) {
    assert.throws(() => validar([{ ...imagen("A/hola"), ...campos }], ["A/hola"]), /dañada|JPG\/PNG válido/);
  }
});

test("el control remoto rechaza nombres con percent-encoding, separadores y otros caracteres de URL", () => {
  const sku = "11351/MoveForward";
  for (const nombre of [
    "11351%2FMoveForward.png", "11351%252FMoveForward.png", "11351/MoveForward.png",
    "11351\\MoveForward.png", "foto?version=1.png", "foto#detalle.png", "foto con espacios.png",
    "foto_niño.png", `${"a".repeat(181)}.png`, ".png", "foto.webp",
  ]) {
    assert.throws(() => validar([{ ...imagen(sku), nombre }], [sku]), /nombre seguro para Rappi/);
  }
});

test("nombres iguales o que solo cambian de mayúsculas no pueden sobrescribir fotos de otros SKU", () => {
  const skus = ["11351/MoveForward", "11351/YourDream"];
  for (const segundo of ["imagen_unica.png", "IMAGEN_UNICA.PNG"]) {
    assert.throws(() => validar([
      { ...imagen(skus[0]), nombre: "imagen_unica.png" },
      { ...imagen(skus[1]), nombre: segundo },
    ], skus), /mismo nombre de imagen/);
  }
});

test("el límite del adjunto se verifica nuevamente al recibirlo en Mi Tienda", () => {
  const sku = "A/hola";
  assert.equal(validar([imagen(sku, "x".repeat(1_000_000))], [sku]).archivos.get(sku).size, 1_000_000);
  assert.throws(() => validar([imagen(sku, "x".repeat(1_000_001))], [sku]), /no superar 1 MB/);
});
