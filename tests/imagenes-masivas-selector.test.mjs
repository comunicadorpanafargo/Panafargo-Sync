import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../rappi/mi-tienda-content-script.js", import.meta.url), "utf8");

function crearEntorno() {
  let paneles = [];
  let intervalo;
  let timeout;
  const contexto = vm.createContext({
    File, atob, console,
    document: { body: { innerText: "" }, querySelector: () => null, querySelectorAll: (selector) => selector === "app-handle-images-actions" ? paneles : [] },
    getComputedStyle: (elemento) => ({ visibility: elemento.visibility || "visible" }),
    sessionStorage: { getItem: () => null },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    setInterval: (fn) => { intervalo = fn; return 1; }, clearInterval() {},
    setTimeout: (fn) => { timeout = fn; return 2; }, clearTimeout() {},
  });
  vm.runInContext(source, contexto);
  const contenedor = ({ visible = true, visibility = "visible" } = {}) => ({
    visibility, getClientRects: () => visible ? [{}] : [],
  });
  const crearPanel = (opciones = {}) => {
    const panel = Object.assign(contenedor(opciones), { drawers: [] });
    panel.querySelectorAll = (selector) => selector === "lib-drawer" ? panel.drawers : [];
    const drawer = Object.assign(contenedor(), { inputs: [] });
    drawer.querySelectorAll = (selector) => selector.includes('input[type="file"]') ? drawer.inputs : [];
    const input = { hidden: true, disabled: false, closest: (selector) => selector === "app-handle-images-actions" ? panel : selector === "lib-drawer" ? drawer : null };
    drawer.inputs.push(input); panel.drawers.push(drawer);
    return { panel, drawer, input };
  };
  return { contexto, crearPanel, mostrar: (...nuevos) => { paneles = nuevos; }, tick: () => intervalo(), vencer: () => timeout() };
}

test("el selector nativo hidden se acepta dentro de su panel y drawer visibles", () => {
  const e = crearEntorno(); const nativo = e.crearPanel(); e.mostrar(nativo.panel);
  const destino = e.contexto.buscarDestinoZipMasivo();
  assert.equal(destino.input, nativo.input);
  assert.equal(destino.panel, nativo.panel);
  assert.equal(destino.drawer, nativo.drawer);
});

test("los selectores ZIP ajenos no sustituyen al control nativo de imágenes", async () => {
  const e = crearEntorno(); const nativo = e.crearPanel();
  const ajeno = { hidden: true, closest: () => null };
  e.contexto.document.querySelector = () => ajeno;
  e.mostrar(nativo.panel);
  assert.equal((await e.contexto.esperarDestinoZipMasivo(15000)).input, nativo.input);
  assert.throws(() => e.contexto.buscarDestinoZipMasivo(ajeno), /no corresponde/);
});

test("un panel antiguo oculto se ignora y no causa una ambigüedad falsa", () => {
  const e = crearEntorno(); const antiguo = e.crearPanel({ visible: false }); const actual = e.crearPanel();
  e.mostrar(antiguo.panel, actual.panel);
  assert.equal(e.contexto.buscarDestinoZipMasivo().input, actual.input);
  assert.throws(() => e.contexto.buscarDestinoZipMasivo(antiguo.input), /no corresponde/);
});

test("visibility hidden en el panel tampoco permite adjuntar el ZIP", () => {
  const e = crearEntorno(); const oculto = e.crearPanel({ visibility: "hidden" }); e.mostrar(oculto.panel);
  assert.equal(e.contexto.buscarDestinoZipMasivo(), null);
});

test("dos paneles nativos visibles impiden elegir un destino", async () => {
  const e = crearEntorno(); e.mostrar(e.crearPanel().panel, e.crearPanel().panel);
  await assert.rejects(e.contexto.esperarDestinoZipMasivo(15000), /más de un panel/);
});

test("dos drawers visibles en el mismo panel impiden elegir un destino", () => {
  const e = crearEntorno(); const actual = e.crearPanel();
  actual.panel.drawers.push({ getClientRects: () => [{}] }); e.mostrar(actual.panel);
  assert.throws(() => e.contexto.buscarDestinoZipMasivo(), /varios formularios/);
});

test("un drawer oculto no convierte su input hidden en un destino válido", () => {
  const e = crearEntorno(); const actual = e.crearPanel();
  actual.drawer.getClientRects = () => []; e.mostrar(actual.panel);
  assert.equal(e.contexto.buscarDestinoZipMasivo(), null);
});

test("varios inputs ZIP en el drawer detienen la asignación, incluso si uno está deshabilitado", () => {
  const e = crearEntorno(); const actual = e.crearPanel();
  actual.drawer.inputs.push({ ...actual.input, disabled: true }); e.mostrar(actual.panel);
  assert.throws(() => e.contexto.buscarDestinoZipMasivo(), /varios selectores ZIP/);
});

test("un input ZIP deshabilitado no es válido ni como inputInicial", () => {
  const e = crearEntorno(); const actual = e.crearPanel(); actual.input.disabled = true; e.mostrar(actual.panel);
  assert.equal(e.contexto.buscarDestinoZipMasivo(), null);
  assert.throws(() => e.contexto.buscarDestinoZipMasivo(actual.input), /deshabilitado/);
});

test("un input de un drawer anidado distinto no se atribuye al formulario actual", () => {
  const e = crearEntorno(); const actual = e.crearPanel();
  actual.input.closest = (selector) => selector === "app-handle-images-actions" ? actual.panel : {};
  e.mostrar(actual.panel); assert.equal(e.contexto.buscarDestinoZipMasivo(), null);
});

test("la espera permite que el panel aparezca después de pulsar Cárgalas aquí", async () => {
  const e = crearEntorno(); const actual = e.crearPanel(); let resuelto = false;
  const espera = e.contexto.esperarDestinoZipMasivo(15000).then((r) => { resuelto = true; return r; });
  await Promise.resolve(); assert.equal(resuelto, false);
  e.mostrar(actual.panel); e.tick();
  assert.equal((await espera).input, actual.input);
});

test("si solo existe un ZIP ajeno, la espera vence sin atribuírselo a Rappi", async () => {
  const e = crearEntorno(); e.contexto.document.querySelector = () => ({ hidden: true });
  const espera = e.contexto.esperarDestinoZipMasivo(15000); e.vencer();
  assert.equal(await espera, null);
});

test("subirImagenes abre la opción masiva y adjunta una sola vez al input nativo", async () => {
  const e = crearEntorno(); const actual = e.crearPanel(); const operaciones = [];
  const enlace = { click: () => { operaciones.push("Cárgalas aquí"); e.mostrar(actual.panel); } };
  Object.assign(e.contexto, {
    esperarElementoPorTexto: async () => enlace,
    asignarArchivosAInput: (input, archivos) => { assert.equal(input, actual.input); operaciones.push(archivos[0].name); },
    esperarArchivosAsignados: async () => true,
    esperarResultadoProcesamientoZip: async (_timeout, panel) => {
      assert.equal(panel, actual.panel); return { estado: "error_rappi", detalle: "Fixture", segundos: 1, progresos: [], cambioUrl: null };
    },
    continuarYCcrearProductos: async () => operaciones.push("Crear"),
  });
  const respuesta = await e.contexto.subirImagenes("AA==", "imagenes.zip", () => {});
  assert.equal(respuesta.paso, "imagenes_error_rappi");
  assert.deepEqual(operaciones, ["Cárgalas aquí", "imagenes.zip"]);
});

test("inputInicial también se valida antes de enviar archivos", async () => {
  const e = crearEntorno(); const actual = e.crearPanel(); e.mostrar(actual.panel);
  let asignaciones = 0; e.contexto.asignarArchivosAInput = () => { asignaciones++; };
  await assert.rejects(e.contexto.subirImagenes("AA==", "imagenes.zip", () => {}, null, { disabled: false }), /no corresponde/);
  assert.equal(asignaciones, 0);
  assert.equal(e.contexto.buscarDestinoZipMasivo(actual.input).input, actual.input);
});

test("una carga ambigua se detiene antes de asignar el ZIP", async () => {
  const e = crearEntorno(); let asignaciones = 0;
  Object.assign(e.contexto, {
    esperarElementoPorTexto: async () => ({ click: () => e.mostrar(e.crearPanel().panel, e.crearPanel().panel) }),
    asignarArchivosAInput: () => { asignaciones++; },
  });
  await assert.rejects(e.contexto.subirImagenes("AA==", "imagenes.zip", () => {}), /más de un panel/);
  assert.equal(asignaciones, 0);
});

test("un selector que sigue deshabilitado vence sin recibir el ZIP", async () => {
  const e = crearEntorno(); const actual = e.crearPanel(); actual.input.disabled = true;
  let asignaciones = 0;
  Object.assign(e.contexto, {
    esperarElementoPorTexto: async () => ({ click: () => e.mostrar(actual.panel) }),
    asignarArchivosAInput: () => { asignaciones++; },
  });
  const pendiente = e.contexto.subirImagenes("AA==", "imagenes.zip", () => {});
  await new Promise(setImmediate); e.vencer();
  assert.equal((await pendiente).paso, "imagenes_formulario_no_encontrado");
  assert.equal(asignaciones, 0);
});

test("un ZIP ajeno o un panel antiguo oculto no convierten una plantilla nueva en revisión de imágenes", () => {
  const e = crearEntorno(); const antiguo = e.crearPanel({ visible: false }); const plantilla = {};
  e.mostrar(antiguo.panel);
  e.contexto.document.querySelector = (selector) => selector.includes("products_catalog_upload_file_button") ? plantilla : { hidden: true };
  assert.equal(e.contexto.detectarEstadoDelFlujo().tipo, "plantilla");
});

test("el ZIP del drawer nativo abierto identifica la revisión sin depender de un encabezado", () => {
  const e = crearEntorno(); const actual = e.crearPanel(); e.mostrar(actual.panel);
  const estado = e.contexto.detectarEstadoDelFlujo();
  assert.equal(estado.tipo, "imagenes"); assert.equal(estado.inputZip, actual.input);
});

test("una revisión con paneles ambiguos exige revisar y no escoge un input", () => {
  const e = crearEntorno(); e.mostrar(e.crearPanel().panel, e.crearPanel().panel);
  const estado = e.contexto.detectarEstadoDelFlujo();
  assert.equal(estado.tipo, "imagenes"); assert.equal(estado.ambiguo, true); assert.equal(estado.inputZip, null);
});
