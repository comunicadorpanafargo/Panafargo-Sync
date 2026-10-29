import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { descargarBlobYEsperar } from "../utils/descargas.js";

const originales = {
  chrome: globalThis.chrome,
  crear: URL.createObjectURL,
  revocar: URL.revokeObjectURL,
};
const siguiente = () => new Promise(setImmediate);
const diferido = () => {
  let resolve, reject;
  const promise = new Promise((resolver, rechazar) => { resolve = resolver; reject = rechazar; });
  return { promise, resolve, reject };
};
const evento = () => {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emitir: (...args) => { for (const listener of [...listeners]) listener(...args); },
    get cantidad() { return listeners.size; },
  };
};
let estado, api, urls, revocadas, solicitudes, canceladas, consultas;

beforeEach(() => {
  estado = "in_progress";
  urls = [];
  revocadas = [];
  solicitudes = [];
  canceladas = [];
  consultas = [];
  URL.createObjectURL = (blob) => {
    assert.ok(blob instanceof Blob);
    const url = `blob:prueba-${urls.length}`;
    urls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => revocadas.push(url);
  api = {
    onChanged: evento(), onErased: evento(),
    download: async (solicitud) => { solicitudes.push(solicitud); return 7; },
    search: async (consulta) => { consultas.push(consulta); return [{ id: 7, state: estado }]; },
    cancel: async (id) => { canceladas.push(id); estado = "interrupted"; },
  };
  globalThis.chrome = { downloads: api };
});

afterEach(async () => {
  await siguiente();
  assert.equal(api.onChanged.cantidad, 0, "No quedan listeners de cambios después de terminar.");
  assert.equal(api.onErased.cantidad, 0, "No quedan listeners de borrado después de terminar.");
  if (originales.chrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originales.chrome;
  URL.createObjectURL = originales.crear;
  URL.revokeObjectURL = originales.revocar;
});

const descargar = (opciones) => descargarBlobYEsperar(new Blob(["lote sintético"]), "Panafargo_Rappi/Lotes/prueba.xlsx", opciones);

test("devolver un ID de inicio no habilita el proceso hasta que Chrome confirma complete", async () => {
  let resuelta = false;
  const descarga = descargar().then((id) => { resuelta = true; return id; });
  await siguiente();
  assert.equal(resuelta, false);
  assert.deepEqual(revocadas, []);
  assert.deepEqual(solicitudes, [{ url: "blob:prueba-0", filename: "Panafargo_Rappi/Lotes/prueba.xlsx", saveAs: false }]);
  api.onChanged.emitir({ id: 99, state: { current: "complete" } });
  assert.equal(resuelta, false, "Otra descarga no completa la del lote.");
  api.onChanged.emitir({ id: 7, bytesReceived: { current: 23 } });
  assert.equal(resuelta, false);
  api.onChanged.emitir({ id: 7, state: { current: "complete" } });
  assert.equal(await descarga, 7);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
  assert.deepEqual(canceladas, []);
});

test("un archivo ya terminado en search no depende de recibir otro evento", async () => {
  estado = "complete";
  assert.equal(await descargar(), 7);
  assert.deepEqual(consultas, [{ id: 7 }]);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("la terminación anterior a la resolución del ID se conserva", async () => {
  api.download = async () => {
    assert.equal(api.onChanged.cantidad, 1, "El listener se instala antes de iniciar.");
    api.onChanged.emitir({ id: 7, state: { current: "complete" } });
    return 7;
  };
  assert.equal(await descargar(), 7);
  assert.deepEqual(consultas, [], "El evento completo ya confirmó el resultado.");
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("un complete mientras search está pendiente prevalece sobre una respuesta antigua", async () => {
  const consulta = diferido();
  api.search = () => consulta.promise;
  const descarga = descargar();
  await siguiente();
  api.onChanged.emitir({ id: 7, state: { current: "complete" } });
  assert.equal(await descarga, 7);
  consulta.resolve([{ id: 7, state: "in_progress" }]);
  await siguiente();
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("cancelación e interrupción de Chrome detienen la descarga y conservan el motivo", async () => {
  const descarga = descargar();
  const rechazo = assert.rejects(descarga, /USER_CANCELED/);
  await siguiente();
  api.onChanged.emitir({ id: 7, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
  await rechazo;
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
  assert.deepEqual(canceladas, [], "Una interrupción terminal no necesita otra cancelación.");
});

test("una interrupción antes del ID también se rechaza sin intentar cargar a Rappi", async () => {
  api.download = async () => {
    api.onChanged.emitir({ id: 7, state: { current: "interrupted" }, error: { current: "NETWORK_FAILED" } });
    return 7;
  };
  await assert.rejects(descargar(), /NETWORK_FAILED/);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("interrupted en search es fallo aunque no haya evento onChanged", async () => {
  api.search = async () => [{ id: 7, state: "interrupted", error: "FILE_ACCESS_DENIED" }];
  await assert.rejects(descargar(), /FILE_ACCESS_DENIED/);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("borrar la descarga pendiente la rechaza y solicita detenerla", async () => {
  const descarga = descargar();
  const rechazo = assert.rejects(descarga, /Se eliminó la descarga/);
  await siguiente();
  api.onErased.emitir(99);
  assert.deepEqual(canceladas, []);
  api.onErased.emitir(7);
  await rechazo;
  await siguiente();
  assert.deepEqual(canceladas, [7]);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("borrar antes de que Chrome devuelva el ID no se confunde con éxito", async () => {
  api.download = async () => { api.onErased.emitir(7); return 7; };
  await assert.rejects(descargar(), /Se eliminó la descarga/);
  await siguiente();
  assert.deepEqual(canceladas, [7]);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("un fallo al iniciar retira la URL y ambos listeners", async () => {
  api.download = async () => { throw new Error("Permiso de descarga denegado"); };
  await assert.rejects(descargar(), /Permiso de descarga denegado/);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
  assert.deepEqual(canceladas, []);
});

test("un ID inválido no se interpreta como un archivo descargado", async () => {
  for (const id of [undefined, null, -1, "7", NaN]) {
    api.download = async () => id;
    await assert.rejects(descargar(), /Chrome no inició la descarga/);
  }
  assert.equal(revocadas.length, 5);
});

test("si falla la consulta se rechaza y cancela la descarga activa", async () => {
  api.search = async () => { throw new Error("Consulta no disponible"); };
  await assert.rejects(descargar(), /Consulta no disponible/);
  await siguiente();
  assert.deepEqual(canceladas, [7]);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("si search no encuentra su ID no se usa otro archivo como confirmación", async () => {
  api.search = async () => [{ id: 99, state: "complete" }];
  await assert.rejects(descargar(), /Chrome no encuentra la descarga/);
  await siguiente();
  assert.deepEqual(canceladas, [7]);
});

test("timeout detiene el flujo y retiene el Blob hasta confirmar la cancelación", async () => {
  const cancelacion = diferido();
  api.cancel = (id) => { canceladas.push(id); return cancelacion.promise; };
  await assert.rejects(descargar({ timeoutMs: 15 }), /Chrome no confirmó que terminara/);
  assert.deepEqual(canceladas, [7]);
  assert.deepEqual(revocadas, [], "No se revoca un Blob que Chrome puede seguir leyendo.");
  cancelacion.resolve();
  await siguiente();
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("si iniciar queda pendiente al vencer el plazo, se cancela su ID cuando llega", async () => {
  const inicio = diferido();
  api.download = () => inicio.promise;
  await assert.rejects(descargar({ timeoutMs: 15 }), /Chrome no confirmó que terminara/);
  assert.deepEqual(revocadas, []);
  inicio.resolve(7);
  await siguiente();
  assert.deepEqual(canceladas, [7]);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("un fallo tardío de inicio después del timeout libera el Blob una sola vez", async () => {
  const inicio = diferido();
  api.download = () => inicio.promise;
  await assert.rejects(descargar({ timeoutMs: 15 }), /Chrome no confirmó que terminara/);
  inicio.reject(new Error("Inicio cancelado"));
  await siguiente();
  assert.deepEqual(canceladas, []);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("cancel fallido con archivo activo no revoca la URL hasta el evento terminal", async () => {
  api.cancel = async (id) => { canceladas.push(id); throw new Error("Cancel aún pendiente"); };
  await assert.rejects(descargar({ timeoutMs: 15 }), /Chrome no confirmó que terminara/);
  await siguiente();
  assert.deepEqual(revocadas, []);
  assert.equal(api.onChanged.cantidad, 1);
  api.onChanged.emitir({ id: 7, state: { current: "interrupted" } });
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("cancel fallido porque el archivo ya terminó se limpia mediante search", async () => {
  let busquedas = 0;
  api.search = async () => [{ id: 7, state: ++busquedas === 1 ? "in_progress" : "complete" }];
  api.cancel = async (id) => { canceladas.push(id); throw new Error("Ya terminó"); };
  await assert.rejects(descargar({ timeoutMs: 15 }), /Chrome no confirmó que terminara/);
  await siguiente();
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("eventos duplicados y una consulta tardía no revocan la URL dos veces", async () => {
  const consulta = diferido();
  api.search = () => consulta.promise;
  const descarga = descargar();
  await siguiente();
  api.onChanged.emitir({ id: 7, state: { current: "complete" } });
  api.onChanged.emitir({ id: 7, state: { current: "complete" } });
  api.onErased.emitir(7);
  assert.equal(await descarga, 7);
  consulta.reject(new Error("Consulta tardía fallida"));
  await siguiente();
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
  assert.deepEqual(canceladas, []);
});

test("sin capacidades para confirmar el archivo, no inicia una descarga", async () => {
  delete globalThis.chrome.downloads.search;
  await assert.rejects(descargar(), /Chrome no permite comprobar/);
  assert.deepEqual(solicitudes, []);
  assert.deepEqual(urls, []);
});

test("un contexto de Chrome inválido al instalar listeners no deja URL ni timers activos", async () => {
  api.onErased.addListener = () => { throw new Error("Extension context invalidated"); };
  await assert.rejects(descargar(), /Extension context invalidated/);
  assert.deepEqual(solicitudes, []);
  assert.deepEqual(revocadas, ["blob:prueba-0"]);
});

test("opciones inválidas se rechazan antes de crear la URL", async () => {
  for (const timeoutMs of [0, -1, NaN, 1.5, Infinity]) await assert.rejects(descargar({ timeoutMs }), /tiempo máximo/);
  await assert.rejects(descargarBlobYEsperar(new Blob(), " "), /nombre de archivo/);
  assert.deepEqual(urls, []);
  assert.deepEqual(solicitudes, []);
});
