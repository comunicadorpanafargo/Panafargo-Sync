import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../rappi/mi-tienda-content-script.js", import.meta.url), "utf8");

function elemento(texto = "", { visible = true, errorInicial = false } = {}) {
  return {
    innerText: texto, textContent: texto, visible,
    getClientRects() { return this.visible ? [{}] : []; },
    querySelector: (selector) => errorInicial && selector === ".error" ? {} : null,
  };
}

function observar() {
  let ahora = 0;
  let revisar;
  let vencer;
  let resultado;
  let receptor;
  const panel = Object.assign(elemento("Cargando imágenes..."), {
    nodos: {},
    querySelectorAll(selector) { return this.nodos[selector] || []; },
  });
  const document = {
    body: { innerText: "" },
    querySelectorAll: (selector) => selector === "app-handle-images-actions" ? [panel] : [],
  };
  const contexto = vm.createContext({
    console, File, atob,
    Date: class extends Date { static now() { return ahora; } },
    setInterval: (fn) => { revisar = fn; return 1; }, clearInterval() {},
    setTimeout: (fn) => { vencer = fn; return 2; }, clearTimeout() {},
    document, location: { href: "https://mitienda.rappi.com.co/fixture" },
    getComputedStyle: () => ({ visibility: "visible" }),
    sessionStorage: { getItem: () => null },
    chrome: { runtime: { onMessage: { addListener: (fn) => { receptor = fn; } } } },
  });
  vm.runInContext(source, contexto);
  const comenzar = () => contexto.esperarResultadoProcesamientoZip(600000).then((r) => { resultado = r; return r; });
  const tick = async (tiempo = ahora + 500) => { ahora = tiempo; revisar(); await Promise.resolve(); };
  const enviar = (mensaje) => new Promise((resolve) => receptor(mensaje, {}, resolve));
  return { contexto, panel, document, comenzar, tick, enviar, vencer: () => vencer(), resultado: () => resultado };
}

function prepararSelectorZip(o, input) {
  const drawer = Object.assign(elemento(), { querySelectorAll: () => [input] });
  input.closest = (selector) => selector === "app-handle-images-actions" ? o.panel : drawer;
  o.panel.nodos["lib-drawer"] = [drawer];
}

test("100 % de transferencia y éxito fuera del panel no confirman las imágenes", async () => {
  const o = observar();
  o.document.body.innerText = "Procesamiento completado en otro panel";
  o.panel.innerText = "Archivo recibido. Asociando imágenes a productos";
  o.panel.nodos[".progress-bar-title"] = [elemento("100%")];
  o.comenzar(); await o.tick();
  assert.equal(o.resultado(), undefined);
  o.panel.innerText = "¡Procesamiento completado!"; await o.tick();
  assert.equal(o.resultado().estado, "exito");
  assert.deepEqual(Array.from(o.resultado().progresos, (p) => p.pct), ["100%"]);
});

test("una copia oculta del panel no confirma éxito", async () => {
  const o = observar(); o.panel.innerText = "¡Carpeta cargada con éxito!"; o.panel.visible = false;
  o.comenzar(); await o.tick(); assert.equal(o.resultado(), undefined);
  o.panel.visible = true; await o.tick(); assert.equal(o.resultado().estado, "exito");
});

test("el error del servidor tiene prioridad aunque el botón Continuar esté habilitado y exista texto de éxito", async () => {
  const o = observar();
  o.panel.innerText = "Procesamiento completado. No se encontró ninguna imagen para asociar";
  o.panel.nodos[".upload-manager.error"] = [elemento("No se encontró ninguna imagen para asociar")];
  o.comenzar(); await o.tick();
  assert.equal(o.resultado().estado, "error_rappi");
  assert.match(o.resultado().detalle, /No se encontró ninguna imagen/);
});

test("un error de transferencia del ZIP se informa sin esperar diez minutos", async () => {
  const o = observar();
  o.panel.innerText = "¡Carpeta no pudo ser cargada!";
  o.panel.nodos[".progress-bar-fill-transition-error"] = [elemento("Error al transferir")];
  o.comenzar(); await o.tick();
  assert.equal(o.resultado().estado, "error_rappi");
});

test("el error inicial por URL aún no disponible puede desaparecer y permitir el envío nativo", async () => {
  const o = observar();
  o.panel.innerText = "Verifica que el peso de cada imagen no supere 1 MB";
  o.panel.nodos[".upload-manager.error"] = [elemento(o.panel.innerText, { errorInicial: true })];
  o.comenzar(); await o.tick(); await o.tick(10000);
  assert.equal(o.resultado(), undefined);
  o.panel.nodos[".upload-manager.error"] = [];
  o.panel.innerText = "Asociando imágenes a productos"; await o.tick(11000);
  assert.equal(o.resultado(), undefined);
  o.panel.innerText = "¡Carpeta cargada con éxito!"; await o.tick(13000);
  assert.equal(o.resultado().estado, "exito");
});

test("un error inicial persistente no libera el proceso por un plazo corto ni acredita un rechazo", async () => {
  const o = observar();
  o.panel.nodos[".upload-manager.error"] = [elemento("Revisa formato y peso del ZIP", { errorInicial: true })];
  const pendiente = o.comenzar(); await o.tick(500); await o.tick(16000); await o.tick(59000);
  assert.equal(o.resultado(), undefined, "La URL firmada aún puede llegar e iniciar el envío nativo.");
  o.vencer(); await pendiente;
  assert.equal(o.resultado().estado, "timeout");
  assert.equal(o.resultado().detalle, "Revisa formato y peso del ZIP");
});

test("una URL firmada tardía conserva el bloqueo hasta completar las imágenes", async () => {
  const o = observar(); const operaciones = [];
  const plantilla = {};
  const zip = { closest: () => o.panel };
  prepararSelectorZip(o, zip);
  o.document.querySelector = (selector) => selector.includes("products_catalog_upload_file_button") ? plantilla : null;
  Object.assign(o.contexto, {
    esperarEstadoDelFlujo: async () => ({ tipo: "plantilla" }),
    esperarContinuarPlantillaOAvance: async () => ({ tipo: "boton", el: { click() {} } }),
    esperarElementoPorTexto: async () => ({ click() {} }),
    esperarSelector: async () => zip,
    asignarArchivosAInput: (input) => operaciones.push(input === zip ? "zip" : "plantilla"),
    esperarArchivosAsignados: async () => true,
    continuarYCcrearProductos: async () => operaciones.push("crear"),
  });
  o.panel.nodos[".upload-manager.error"] = [elemento("URL pendiente", { errorInicial: true })];
  const pendiente = o.enviar({ tipo: "RAPPI_SUBIR_LOTE", xlsxBase64: "AA==", xlsxNombre: "lote.xlsx", imagenesZipBase64: "AA==", imagenesZipNombre: "imagenes.zip" });
  await new Promise(setImmediate);
  await o.tick(500); await o.tick(16000);
  assert.equal((await o.enviar({ tipo: "RAPPI_ESTADO_CARGA" })).cargaEnCurso, true);
  assert.equal((await o.enviar({ tipo: "RAPPI_REINICIAR_PREPARACION" })).ok, false);
  assert.deepEqual(operaciones, ["plantilla", "zip"]);
  o.panel.nodos[".upload-manager.error"] = [];
  o.panel.innerText = "Asociando imágenes a productos"; await o.tick(17000);
  assert.deepEqual(operaciones, ["plantilla", "zip"]);
  o.panel.innerText = "¡Procesamiento completado!"; await o.tick(18000);
  assert.equal((await pendiente).ok, true);
  assert.deepEqual(operaciones, ["plantilla", "zip", "crear"]);
  assert.equal((await o.enviar({ tipo: "RAPPI_ESTADO_CARGA" })).cargaEnCurso, false);
});

test("errores ocultos y recomendaciones de peso no bloquean un procesamiento completado", async () => {
  const o = observar();
  o.panel.innerText = "Verifica que el peso de cada imagen no supere 1 MB. ¡Procesamiento completado!";
  o.panel.nodos[".upload-manager.error"] = [elemento("Error anterior", { visible: false })];
  o.comenzar(); await o.tick(); assert.equal(o.resultado().estado, "exito");
});

test("la vista 404 conserva su señal de recuperación y la espera sin resultado vence", async () => {
  const o = observar(); o.document.body.innerText = "Ooops, página no encontrada";
  o.comenzar(); await o.tick(); assert.equal(o.resultado().estado, "pagina_404");
  const espera = observar(); const pendiente = espera.comenzar(); espera.vencer();
  assert.equal((await pendiente).estado, "timeout");
});

for (const error of [false, true]) test(`la carga masiva ${error ? "se detiene ante error" : "continúa tras el éxito"} sin cambiar el recorrido de creación`, async () => {
  const o = observar(); const operaciones = [];
  const input = { closest: () => o.panel };
  prepararSelectorZip(o, input);
  Object.assign(o.contexto, {
    esperarElementoPorTexto: async () => ({ click: () => operaciones.push("abrir_masiva") }),
    esperarSelector: async () => input,
    asignarArchivosAInput: (_input, archivos) => operaciones.push(archivos[0].name),
    esperarArchivosAsignados: async () => true,
    continuarYCcrearProductos: async () => operaciones.push("crear_existente"),
  });
  const pendiente = o.contexto.subirImagenes(btoa("zip"), "imagenes.zip", () => {});
  await new Promise(setImmediate);
  assert.deepEqual(operaciones, ["abrir_masiva", "imagenes.zip"]);
  o.panel.innerText = error ? "No se pudo asociar el lote" : "¡Procesamiento completado!";
  if (error) o.panel.nodos[".upload-manager.error"] = [elemento(o.panel.innerText)];
  await o.tick(); const r = await pendiente;
  assert.equal(r.paso, error ? "imagenes_error_rappi" : "productos_creados_pendiente_asociacion");
  assert.deepEqual(operaciones, error ? ["abrir_masiva", "imagenes.zip"] : ["abrir_masiva", "imagenes.zip", "crear_existente"]);
  if (error) assert.match(r.mensaje, /No se pudo asociar el lote.*No se pulsó Crear productos/);
});
