import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { limpiarPreparacionRappi } from "../storage/storage.js";

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
    panafargo_productos: { "2247/1": producto("2247/1", 3), "2247/3": producto("2247/3", 6) },
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
  globalThis.document = { getElementById: nodo, createElement: (tag) => new Nodo(tag) };
  globalThis.window = new EventTarget();
  globalThis.chrome = {
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
        return hooks.estadoPortal ? hooks.estadoPortal(id) : { ok: true, cargaEnCurso: false };
      },
      update: async () => escriturasPortal.push("update"),
      reload: async () => escriturasPortal.push("reload"),
      create: async () => escriturasPortal.push("create"),
    },
    downloads: { download: async () => escriturasPortal.push("download") },
  };
  const url = new URL(`../popup/rappi-ui.js?prueba_reset=${++secuencia}`, import.meta.url);
  const modulo = await import(url.href);
  const inicio = modulo.initRappiTab();
  if (esperarInicio) await inicio;
  return { almacen, nodo, borrados, eventos, mensajesPortal, escriturasPortal, inicio };
}

test("el borrado local de Rappi conserva fuente Shopify, contexto, equivalencias y token", async (t) => {
  const { almacen, borrados } = await interfaz(t);
  const esperados = structuredClone(almacen);
  for (const key of clavesRappi) delete esperados[key];
  await limpiarPreparacionRappi();
  assert.deepEqual(almacen, esperados);
  assert.deepEqual(borrados, [clavesRappi]);
});

test("refrescar limpia plantilla y resultados Rappi, recarga fuente sin seleccionar y no toca el portal", async (t) => {
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
  assert.deepEqual(mensajesPortal, [{ id: 1, mensaje: { tipo: "RAPPI_ESTADO_CARGA" } }]);
  assert.deepEqual(escriturasPortal, []);
});

test("una carga o recuperación activa en cualquier pestaña impide borrar la preparación", async (t) => {
  const hooks = { tabs: [{ id: 1 }, { id: 2 }], estadoPortal: async (id) => ({ ok: true, cargaEnCurso: id === 2 }) };
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
  estado.resolver({ ok: true, cargaEnCurso: false });
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
