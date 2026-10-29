import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { limpiarPreparacionRappi } from "../storage/storage.js";

const require = createRequire(import.meta.url);
const JSZip = require("../vendor/jszip.min.js");
const XLSX = require("../vendor/xlsx.full.min.js");

const originales = { document: globalThis.document, window: globalThis.window, chrome: globalThis.chrome };
afterEach(() => {
  for (const [nombre, valor] of Object.entries(originales)) {
    if (valor === undefined) delete globalThis[nombre];
    else globalThis[nombre] = valor;
  }
});

class Nodo {
  constructor(etiqueta = "div") {
    this.etiqueta = etiqueta;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.value = "";
    this.files = [];
    this.disabled = false;
    this.textContent = "";
  }
  appendChild(nodo) { this.children.push(nodo); return nodo; }
  replaceChildren(...nodos) { this.children = nodos; }
  setAttribute(nombre, valor) { this[nombre] = valor; }
  addEventListener(tipo, callback) {
    const callbacks = this.listeners.get(tipo) || [];
    callbacks.push(callback);
    this.listeners.set(tipo, callbacks);
  }
  querySelectorAll() {
    return this.children.flatMap((nodo) => [
      ...(nodo.etiqueta === "input" && nodo.type === "checkbox" ? [nodo] : []),
      ...nodo.querySelectorAll(),
    ]);
  }
  emitir(tipo) { return Promise.all((this.listeners.get(tipo) || []).map((callback) => callback({ target: this }))); }
}

const diferido = () => {
  let resolver;
  const promesa = new Promise((resolve) => { resolver = resolve; });
  return { promesa, resolver };
};
const clavesRappi = ["panafargo_seleccion_rappi", "plantillaAsociacionBase64", "plantillaAsociacionNombre", "plantillaAsociacionFecha"];
let secuencia = 0;

async function interfaz(t, hooks = {}, esperarInicio = true) {
  t.mock.method(console, "error", () => {});
  const producto = (sku, inventario) => ({
    sku, nombre: `Producto ${sku}`, precio: 3500, precio_comparacion: null, inventario,
    peso: 1, unidad_peso_shopify: "GRAMS", descripcion: "Descripción local de prueba",
    imagen_principal: "https://example.invalid/prueba.png", imagenes: ["https://example.invalid/prueba.png"],
  });
  const almacen = {
    panafargo_productos: hooks.productos || { "2247/1": producto("2247/1", 3), "2247/3": producto("2247/3", 6) },
    panafargo_lote_ui: { entradas: ["2247"], ubicacion: "LOCAL" },
    panafargo_matriz_v11: [{ sku: "2247/1" }],
    panafargo_equiv_categoria: { anterior: "Papelería" },
    panafargo_shopify_token: { access_token: "dato-simulado-de-prueba" },
    panafargo_seleccion_rappi: { "2247/1": true, "2247/3": true },
    plantillaAsociacionBase64: "plantilla-anterior-simulada",
    plantillaAsociacionNombre: "anterior.xlsx", plantillaAsociacionFecha: 123,
  };
  const nodos = new Map();
  const nodo = (id) => {
    if (!nodos.has(id)) nodos.set(id, new Nodo());
    return nodos.get(id);
  };
  const borrados = [];
  const eventos = [];
  const mensajesPortal = [];
  const escriturasPortal = [];
  const listenersActualizacion = new Set();
  globalThis.document = { getElementById: nodo, createElement: (tag) => new Nodo(tag) };
  globalThis.window = new EventTarget();
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "4.1.7" }),
      getURL: (ruta) => `chrome-extension://prueba/${ruta}`,
    },
    storage: { local: {
      get: async (key) => {
        await hooks.antesDeLeer?.(key);
        return structuredClone({ [key]: almacen[key] });
      },
      set: async (values) => {
        await hooks.antesDeGuardar?.(values);
        Object.assign(almacen, structuredClone(values));
        eventos.push("guardado");
      },
      remove: async (keys) => {
        await hooks.antesDeBorrar?.(keys);
        borrados.push([...keys]);
        eventos.push("borrado");
        for (const key of keys) delete almacen[key];
      },
    } },
    tabs: {
      query: async () => hooks.tabs || [],
      sendMessage: async (id, mensaje) => {
        mensajesPortal.push({ id, mensaje });
        if (mensaje.tipo === "RAPPI_REINICIAR_PREPARACION") {
          return hooks.reiniciarPortal ? hooks.reiniciarPortal(id) : { ok: true, reiniciado: true };
        }
        if (mensaje.tipo === "RAPPI_SUBIR_LOTE") {
          return hooks.subirLote ? hooks.subirLote(id, mensaje) : { ok: true, paso: "productos_creados_pendiente_asociacion", mensaje: "Resultado simulado de Rappi." };
        }
        return hooks.estadoPortal ? hooks.estadoPortal(id) : { ok: true, cargaEnCurso: false, reiniciarPreparacion: true, versionExtension: "4.1.7" };
      },
      onUpdated: {
        addListener: (callback) => listenersActualizacion.add(callback),
        removeListener: (callback) => listenersActualizacion.delete(callback),
      },
      get: async (id) => ({ id, url: "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/home-manual", status: "complete" }),
      update: async (id, opciones) => {
        await hooks.antesDeNavegar?.(id, opciones);
        escriturasPortal.push({ tipo: "update", id, opciones });
        const tab = { id, url: opciones.url, status: "complete" };
        queueMicrotask(() => {
          for (const callback of listenersActualizacion) callback(id, { status: "complete" }, tab);
        });
        return tab;
      },
      reload: async () => escriturasPortal.push("reload"),
      create: async () => escriturasPortal.push("create"),
    },
    downloads: { download: async () => escriturasPortal.push("download") },
  };
  const url = new URL(`../popup/rappi-ui.js?prueba_reset=${++secuencia}`, import.meta.url);
  const modulo = await import(url.href);
  const inicio = modulo.initRappiTab();
  if (esperarInicio) await inicio;
  return { almacen, nodo, borrados, eventos, mensajesPortal, escriturasPortal, listenersActualizacion, inicio };
}

test("el borrado local de Rappi conserva fuente Shopify, contexto, equivalencias y token", async (t) => {
  const { almacen, borrados } = await interfaz(t);
  const esperados = structuredClone(almacen);
  for (const key of clavesRappi) delete esperados[key];
  await limpiarPreparacionRappi();
  assert.deepEqual(almacen, esperados);
  assert.deepEqual(borrados, [clavesRappi]);
});

test("refrescar olvida el borrador del portal, vuelve al inicio y limpia solo la preparación Rappi", async (t) => {
  const entorno = await interfaz(t, { tabs: [{ id: 1 }] });
  const { almacen, nodo, borrados, mensajesPortal, escriturasPortal } = entorno;
  const fuente = structuredClone(almacen.panafargo_productos);
  const contexto = structuredClone(almacen.panafargo_lote_ui);
  nodo("mensaje-plantilla-asociacion").textContent = "Resultado anterior";
  nodo("mensaje-plantilla-asociacion-generada").textContent = "Descarga anterior";
  nodo("input-plantilla-asociacion").value = "archivo-elegido.xlsx";
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen.panafargo_productos, fuente);
  assert.deepEqual(almacen.panafargo_lote_ui, contexto);
  assert.equal(borrados.length, 1);
  assert.equal(nodo("lista-rappi").children.length, 2);
  assert.ok(nodo("lista-rappi").querySelectorAll().every((checkbox) => !checkbox.checked));
  assert.deepEqual(almacen.panafargo_seleccion_rappi, { "2247/1": false, "2247/3": false });
  for (const key of clavesRappi.slice(1)) assert.equal(Object.hasOwn(almacen, key), false);
  assert.equal(nodo("input-plantilla-asociacion").value, "");
  assert.match(nodo("plantilla-actual").textContent, /incluida/);
  assert.equal(nodo("mensaje-plantilla-asociacion").textContent, "");
  assert.equal(nodo("mensaje-plantilla-asociacion-generada").textContent, "");
  assert.equal(nodo("mensaje-rappi").dataset.tone, "ok");
  assert.deepEqual(mensajesPortal, [
    { id: 1, mensaje: { tipo: "RAPPI_ESTADO_CARGA" } },
    { id: 1, mensaje: { tipo: "RAPPI_REINICIAR_PREPARACION" } },
  ]);
  assert.deepEqual(escriturasPortal.map(({ tipo, id, opciones }) => [tipo, id, opciones.url]), [
    ["update", 1, "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/home-manual"],
  ]);
  assert.equal(entorno.listenersActualizacion.size, 0);
});

test("una carga o recuperación activa en cualquier pestaña impide borrar la preparación", async (t) => {
  const hooks = { tabs: [{ id: 1 }, { id: 2 }], estadoPortal: async (id) => ({ ok: true, cargaEnCurso: id === 2, reiniciarPreparacion: true }) };
  const { almacen, nodo, borrados, mensajesPortal } = await interfaz(t, hooks);
  const anterior = structuredClone(almacen);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.equal(mensajesPortal.length, 2);
  assert.match(nodo("mensaje-rappi").textContent, /carga o recuperación en curso/);
});

test("no borra si una pestaña de Mi Tienda no confirma el estado", async (t) => {
  const { almacen, nodo, borrados } = await interfaz(t, { tabs: [{ id: 1 }], estadoPortal: async () => null });
  const anterior = structuredClone(almacen);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.match(nodo("mensaje-rappi").textContent, /No se pudo comprobar/);
});

test("una pestaña antigua impide reiniciar todas antes de enviar el primer borrado al portal", async (t) => {
  const { almacen, nodo, borrados, mensajesPortal, escriturasPortal } = await interfaz(t, {
    tabs: [{ id: 1 }, { id: 2 }],
    estadoPortal: (id) => ({ ok: true, cargaEnCurso: false, reiniciarPreparacion: id === 1 }),
  });
  const anterior = structuredClone(almacen);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.equal(mensajesPortal.length, 2);
  assert.ok(mensajesPortal.every(({ mensaje }) => mensaje.tipo === "RAPPI_ESTADO_CARGA"));
  assert.deepEqual(escriturasPortal, []);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});

test("un rechazo del reinicio en el portal conserva selección y plantilla locales", async (t) => {
  const { almacen, nodo, borrados, escriturasPortal } = await interfaz(t, {
    tabs: [{ id: 1 }], reiniciarPortal: () => ({ ok: false, error: "Comenzó otra carga" }),
  });
  const anterior = structuredClone(almacen);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.deepEqual(escriturasPortal, []);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});

test("si el portal no confirma el reinicio, vence la espera sin borrar datos locales", async (t) => {
  const { almacen, nodo, borrados, escriturasPortal } = await interfaz(t, {
    tabs: [{ id: 1 }], reiniciarPortal: () => new Promise(() => {}),
  });
  const anterior = structuredClone(almacen);
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    assert.equal(ms, 5000);
    queueMicrotask(callback);
    return 0;
  });
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.deepEqual(escriturasPortal, []);
  assert.equal(nodo("btn-refrescar-rappi").disabled, false);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});

test("si falla volver al formulario, se conserva la preparación local y se retiran los listeners", async (t) => {
  const { almacen, nodo, borrados, listenersActualizacion } = await interfaz(t, {
    tabs: [{ id: 1 }], antesDeNavegar: () => { throw new Error("Navegación rechazada"); },
  });
  const anterior = structuredClone(almacen);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.equal(listenersActualizacion.size, 0);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});

test("con dos pestañas libres, ambas descartan sus borradores y vuelven al inicio antes del borrado local", async (t) => {
  const { nodo, borrados, mensajesPortal, escriturasPortal } = await interfaz(t, {
    tabs: [{ id: 1 }, { id: 2 }],
  });
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.equal(borrados.length, 1);
  assert.deepEqual(mensajesPortal.map(({ id, mensaje }) => [id, mensaje.tipo]), [
    [1, "RAPPI_ESTADO_CARGA"], [2, "RAPPI_ESTADO_CARGA"],
    [1, "RAPPI_REINICIAR_PREPARACION"], [2, "RAPPI_REINICIAR_PREPARACION"],
  ]);
  assert.deepEqual(escriturasPortal.map(({ tipo, id }) => [tipo, id]), [["update", 1], ["update", 2]]);
});

test("espera la restauración inicial completa antes de permitir el reset", async (t) => {
  const lectura = diferido();
  const entorno = await interfaz(t, { antesDeLeer: (key) => key === "plantillaAsociacionNombre" ? lectura.promesa : undefined }, false);
  assert.equal(entorno.nodo("btn-refrescar-rappi").disabled, true);
  await entorno.nodo("btn-refrescar-rappi").emitir("click");
  assert.equal(entorno.borrados.length, 0);
  lectura.resolver();
  await entorno.inicio;
  assert.equal(entorno.nodo("btn-refrescar-rappi").disabled, false);
});

test("drena los guardados anteriores para que la selección vieja no reaparezca después del reset", async (t) => {
  const escritura = diferido();
  let detenerPrimera = true;
  const hooks = { antesDeGuardar: (values) => {
    if (values.panafargo_seleccion_rappi && detenerPrimera) {
      detenerPrimera = false;
      return escritura.promesa;
    }
  } };
  const { almacen, nodo, borrados, eventos } = await interfaz(t, hooks);
  nodo("seleccionar-todos-rappi").checked = false;
  await nodo("seleccionar-todos-rappi").emitir("change");
  const reset = nodo("btn-refrescar-rappi").emitir("click");
  await Promise.resolve();
  assert.equal(borrados.length, 0);
  escritura.resolver();
  await reset;
  assert.deepEqual(eventos, ["guardado", "borrado", "guardado"]);
  assert.deepEqual(almacen.panafargo_seleccion_rappi, { "2247/1": false, "2247/3": false });
});

test("un segundo clic mientras se consulta el portal no inicia otro reset", async (t) => {
  const estado = diferido();
  const { nodo, borrados, mensajesPortal } = await interfaz(t, { tabs: [{ id: 1 }], estadoPortal: () => estado.promesa });
  const primero = nodo("btn-refrescar-rappi").emitir("click");
  await new Promise(setImmediate);
  assert.equal(nodo("btn-refrescar-rappi").disabled, true);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.equal(mensajesPortal.length, 1);
  estado.resolver({ ok: true, cargaEnCurso: false, reiniciarPreparacion: true });
  await primero;
  assert.equal(borrados.length, 1);
});

test("un fallo al borrar conserva la plantilla y selección visibles", async (t) => {
  const { almacen, nodo } = await interfaz(t, { antesDeBorrar: async () => { throw new Error("Guardado no disponible"); } });
  const anterior = structuredClone(almacen);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.match(nodo("plantilla-actual").textContent, /anterior.xlsx/);
  assert.ok(nodo("lista-rappi").querySelectorAll().every((checkbox) => checkbox.checked));
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});

test("una consulta al portal sin respuesta termina sin borrar datos", async (t) => {
  const { almacen, nodo, borrados } = await interfaz(t, { tabs: [{ id: 1 }], estadoPortal: () => new Promise(() => {}) });
  const anterior = structuredClone(almacen);
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    assert.equal(ms, 5000);
    queueMicrotask(callback);
    return 0;
  });
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen, anterior);
  assert.equal(borrados.length, 0);
  assert.equal(nodo("btn-refrescar-rappi").disabled, false);
  assert.match(nodo("mensaje-rappi").textContent, /No se pudo comprobar/);
});

test("un fallo al persistir la selección reiniciada conserva la advertencia", async (t) => {
  const { almacen, nodo } = await interfaz(t, { antesDeGuardar: (values) => {
    if (values.panafargo_seleccion_rappi) throw new Error("Selección no guardada");
  } });
  const fuente = structuredClone(almacen.panafargo_productos);
  await nodo("btn-refrescar-rappi").emitir("click");
  assert.deepEqual(almacen.panafargo_productos, fuente);
  assert.ok(nodo("lista-rappi").querySelectorAll().every((checkbox) => !checkbox.checked));
  assert.equal(nodo("mensaje-rappi").dataset.tone, "warning");
  assert.match(nodo("mensaje-rappi").textContent, /No se pudo guardar la selección/);
});

const publicacionNormal = (sku = "40105") => ({
  sku, nombre: `Producto ${sku}`, precio: 3500, precio_comparacion: null, inventario: 50,
  peso: 1, unidad_peso_shopify: "GRAMS", descripcion: "Descripción local de prueba",
  imagen_principal: "https://example.invalid/principal.png",
  imagenes: ["https://example.invalid/principal.png", "https://example.invalid/secundaria-1.png", "https://example.invalid/secundaria-2.png"],
  imagenes_completas: true,
});

const esperarHasta = async (condicion) => {
  for (let intento = 0; intento < 100 && !condicion(); intento++) await new Promise(setImmediate);
  assert.ok(condicion(), "El proceso local debe alcanzar el estado esperado.");
};

test("un lote con / queda pendiente antes de descargas o envío y permite desmarcarlo", async (t) => {
  const { nodo, mensajesPortal, escriturasPortal } = await interfaz(t);
  assert.equal(nodo("btn-subir-mi-tienda").disabled, true);
  assert.equal(nodo("aviso-imagenes-disenos").hidden, false);
  assert.match(nodo("aviso-imagenes-disenos").textContent, /queda pendiente.*Desmarca/);
  // Un evento programático también debe respetar la restricción del botón.
  await nodo("btn-subir-mi-tienda").emitir("click");
  assert.deepEqual(mensajesPortal, []);
  assert.deepEqual(escriturasPortal, []);
  assert.match(nodo("mensaje-rappi").textContent, /queda pendiente/);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
  assert.equal(nodo("btn-descargar-plantilla-asociacion-generada").disabled, false,
    "La asociación de productos existentes con SKU completo sigue disponible.");
  assert.ok(nodo("lista-rappi").querySelectorAll().every((checkbox) => !checkbox.disabled));
});

test("desmarcar / restaura ZIP masivo completo y envía exactamente el ZIP descargado tras las dos descargas", async (t) => {
  const normal = publicacionNormal();
  const diseno = publicacionNormal("11351/MoveForward");
  const { nodo, mensajesPortal } = await interfaz(t, {
    productos: { [normal.sku]: normal, [diseno.sku]: diseno },
    tabs: [{ id: 1, url: "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/home-manual" }],
  });
  assert.equal(nodo("btn-subir-mi-tienda").disabled, true);
  const checks = nodo("lista-rappi").querySelectorAll();
  checks[1].checked = false;
  await checks[1].emitir("change");
  assert.equal(nodo("btn-subir-mi-tienda").disabled, false);
  assert.equal(nodo("aviso-imagenes-disenos").hidden, true);

  window.XLSX = XLSX;
  window.JSZip = JSZip;
  const plantilla = await readFile(new URL("../rappi/plantilla-rappi-base.xlsx", import.meta.url));
  const foto = await readFile(new URL("../icons/icon48.png", import.meta.url));
  const consultas = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    consultas.push(url);
    return String(url).startsWith("chrome-extension:")
      ? new Response(plantilla)
      : new Response(foto, { headers: { "content-type": "image/png" } });
  });
  const blobs = new Map();
  const descargas = [];
  const estados = new Map();
  const listeners = new Set();
  t.mock.method(URL, "createObjectURL", (blob) => {
    const url = `blob:prueba-zip-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", () => {});
  chrome.downloads = {
    download: async (solicitud) => {
      const id = descargas.length + 1;
      descargas.push({ ...solicitud, id });
      estados.set(id, "in_progress");
      return id;
    },
    search: async ({ id }) => [{ id, state: estados.get(id) }],
    cancel: async (id) => estados.set(id, "interrupted"),
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    onErased: { addListener() {}, removeListener() {} },
  };
  const completar = (id) => {
    estados.set(id, "complete");
    for (const listener of [...listeners]) listener({ id, state: { current: "complete" } });
  };
  const envio = nodo("btn-subir-mi-tienda").emitir("click");
  await esperarHasta(() => descargas.length === 1);
  assert.match(descargas[0].filename, /\.xlsx$/);
  assert.equal(mensajesPortal.some(({ mensaje }) => mensaje.tipo === "RAPPI_SUBIR_LOTE"), false);
  completar(1);
  await esperarHasta(() => descargas.length === 2);
  assert.match(descargas[1].filename, /Imagenes\/imagenes_rappi_.*\.zip$/);
  assert.equal(mensajesPortal.some(({ mensaje }) => mensaje.tipo === "RAPPI_SUBIR_LOTE"), false);
  const zipDescargado = new Uint8Array(await blobs.get(descargas[1].url).arrayBuffer());
  const zip = await JSZip.loadAsync(zipDescargado);
  assert.deepEqual(Object.keys(zip.files), ["40105.png", "40105_1.png", "40105_2.png"]);
  assert.ok(Object.keys(zip.files).every((nombre) => !/mapa|LEEME|pf_img/.test(nombre)));
  completar(2);
  await envio;
  const envios = mensajesPortal.filter(({ mensaje }) => mensaje.tipo === "RAPPI_SUBIR_LOTE");
  assert.equal(envios.length, 1);
  const solicitud = envios[0].mensaje;
  assert.deepEqual(solicitud.skus, [normal.sku]);
  assert.equal(Object.hasOwn(solicitud, "imagenesPorSku"), false);
  assert.equal(Object.hasOwn(solicitud, "imagenesManualesPorSku"), false);
  assert.deepEqual(Uint8Array.from(Buffer.from(solicitud.imagenesZipBase64, "base64")), zipDescargado);
  for (const url of normal.imagenes) assert.equal(consultas.filter((consulta) => consulta === url).length, 1);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "ok");
  assert.equal(listeners.size, 0);
});

test("una pestaña con content script anterior detiene el lote antes de preparar o descargar archivos", async (t) => {
  const normal = publicacionNormal();
  const { nodo, mensajesPortal, escriturasPortal } = await interfaz(t, {
    productos: { [normal.sku]: normal },
    tabs: [{ id: 1, url: "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/home-manual" }],
    estadoPortal: () => ({ ok: true, cargaEnCurso: false, versionExtension: "4.1.6" }),
  });
  t.mock.method(globalThis, "fetch", async () => assert.fail("No se preparan archivos con content script anterior."));
  await nodo("btn-subir-mi-tienda").emitir("click");
  assert.deepEqual(mensajesPortal, [{ id: 1, mensaje: { tipo: "RAPPI_ESTADO_CARGA" } }]);
  assert.deepEqual(escriturasPortal, []);
  assert.match(nodo("mensaje-rappi").textContent, /Recarga.*F5/);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});

test("un producto guardado antes de confirmar galerías completas exige buscar otra vez sin preparar ni enviar archivos", async (t) => {
  const anterior = publicacionNormal();
  delete anterior.imagenes_completas;
  const { nodo, mensajesPortal, escriturasPortal } = await interfaz(t, {
    productos: { [anterior.sku]: anterior },
    tabs: [{ id: 1, url: "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/home-manual" }],
  });
  assert.equal(nodo("btn-subir-mi-tienda").disabled, false, "El botón permite mostrar la instrucción para renovar la consulta.");
  t.mock.method(globalThis, "fetch", async () => assert.fail("La galería antigua no debe iniciar consultas de archivos."));
  await nodo("btn-subir-mi-tienda").emitir("click");
  assert.deepEqual(mensajesPortal, []);
  assert.deepEqual(escriturasPortal, []);
  assert.match(nodo("mensaje-rappi").textContent, /Vuelve a Buscar y validar.*galería completa/);
  assert.equal(nodo("mensaje-rappi").dataset.tone, "error");
});
