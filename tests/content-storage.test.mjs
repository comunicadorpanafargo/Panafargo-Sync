import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { guardarProductos, obtenerProductos, limpiarProductosProcesados } from "../storage/storage.js";
import { calcularUnidadesDisponiblesAsociacion } from "../rappi/rappi-association.js";

describe("Almacenamiento del lote por SKU completo", () => {
  const originalChrome = globalThis.chrome;
  let almacen;
  let lecturas;
  let escrituras;

  beforeEach(() => {
    almacen = {
      panafargo_productos: {
        "2247": { sku: "2247", inventario: 10 },
        "2247/1": { sku: "2247/1", descripcion: "Conservar al actualizar" },
      },
      panafargo_equiv_categoria: { papel: "Papelería" },
    };
    lecturas = 0;
    escrituras = [];
    globalThis.chrome = { storage: { local: {
      get: async (key) => {
        lecturas++;
        return structuredClone({ [key]: almacen[key] });
      },
      set: async (values) => {
        escrituras.push(structuredClone(values));
        Object.assign(almacen, structuredClone(values));
      },
      remove: async (keys) => { for (const key of keys) delete almacen[key]; },
    } } };
  });

  afterEach(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  });

  test("guarda variantes independientes en una escritura y conserva la reserva por producto", async () => {
    const entradas = [
      Object.freeze({ sku: "2247/1", inventario: 3 }),
      Object.freeze({ sku: "2247/3", inventario: 7 }),
    ];
    await guardarProductos(entradas);
    assert.equal(lecturas, 1);
    assert.equal(escrituras.length, 1);
    const productos = await obtenerProductos();
    assert.deepEqual(Object.keys(productos), ["2247", "2247/1", "2247/3"]);
    assert.equal(productos["2247/1"].descripcion, "Conservar al actualizar");
    for (const [sku, stock, publicable] of [["2247", 10, 3], ["2247/1", 3, 1], ["2247/3", 7, 2]]) {
      assert.equal(productos[sku].inventario, stock);
      assert.equal(calcularUnidadesDisponiblesAsociacion(productos[sku].inventario), publicable);
    }
    assert.equal(Object.hasOwn(entradas[0], "actualizado"), false);
  });

  test("reemplaza productos y contexto en el mismo guardado sin conservar un lote anterior", async () => {
    const contexto = { entradas: ["2247/3"], ubicacion: "LOCAL" };
    await guardarProductos([{ sku: "2247/3", inventario: 3 }], { reemplazar: true, contexto });
    assert.equal(escrituras.length, 1);
    assert.deepEqual(Object.keys(almacen.panafargo_productos), ["2247/3"]);
    assert.deepEqual(escrituras[0].panafargo_lote_ui, contexto);
    assert.deepEqual(Object.keys(escrituras[0].panafargo_productos), ["2247/3"]);
    assert.deepEqual(almacen.panafargo_equiv_categoria, { papel: "Papelería" });
  });

  test("un lote inválido no modifica productos ni contexto", async () => {
    const anterior = structuredClone(almacen);
    await assert.rejects(guardarProductos([{ sku: "2247/1" }, {}], { reemplazar: true, contexto: {} }), /SKU completo/);
    assert.equal(escrituras.length, 0);
    assert.deepEqual(almacen, anterior);
  });

  test("acepta un SKU con nombre de propiedad reservada sin perder los otros productos", async () => {
    await guardarProductos([{ sku: "__proto__", inventario: 3 }]);
    const productos = await obtenerProductos();
    assert.equal(Object.hasOwn(productos, "__proto__"), true);
    assert.equal(productos.__proto__.inventario, 3);
    assert.equal(productos["2247"].inventario, 10);
  });

  test("reiniciar el lote elimina su contexto y selección pero conserva equivalencias", async () => {
    almacen.panafargo_lote_ui = { entradas: ["2247"] };
    almacen.panafargo_matriz_v11 = [{ sku: "2247" }];
    almacen.panafargo_seleccion_rappi = { "2247": true };
    await limpiarProductosProcesados();
    assert.deepEqual(almacen, { panafargo_equiv_categoria: { papel: "Papelería" } });
  });
});

const contenido = await readFile(new URL("../rappi/mi-tienda-content-script.js", import.meta.url), "utf8");

function crearContenido(estadoInicial = "plantilla", { recuperacion = false } = {}) {
  let receptor;
  const operaciones = [];
  const sesion = new Map(recuperacion ? [["panafargoSync:zipReloadIntento", "1"]] : []);
  const intervalos = [];
  const temporizadores = recuperacion ? {
    setInterval: (callback) => { intervalos.push(callback); return callback; },
    clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  } : { setTimeout, clearTimeout, setInterval, clearInterval };
  const contexto = vm.createContext({
    console, ...temporizadores, File, atob,
    sessionStorage: {
      getItem: (key) => sesion.get(key) ?? null,
      removeItem: (key) => sesion.delete(key),
      setItem: (key, value) => sesion.set(key, String(value)),
    },
    chrome: { runtime: { onMessage: { addListener: (callback) => { receptor = callback; } } } },
    document: { body: { innerText: "" }, querySelectorAll: () => [] },
  });
  vm.runInContext(contenido, contexto, { filename: "mi-tienda-content-script.js" });
  const esperarEstadoReal = contexto.esperarEstadoDelFlujo;
  const input = {};
  // Simular solo las fronteras de DOM/espera. El manejador real del mensaje
  // decide si está permitido cargar imágenes, crear o detener el flujo.
  contexto.document.querySelector = (selector) => selector.includes("products_catalog_upload_file_button") ? input : null;
  contexto.esperarSelector = async () => input;
  contexto.esperarEstadoDelFlujo = async (_timeout, esperado) => ({ tipo: esperado || estadoInicial });
  contexto.asignarArchivosAInput = (_input, archivos) => operaciones.push(["plantilla", archivos[0].name]);
  contexto.esperarContinuarPlantillaOAvance = async () => ({
    tipo: "boton", el: { click: () => operaciones.push(["continuar"]) },
  });
  contexto.subirImagenes = async (zip) => {
    operaciones.push(["zip", zip]);
    return { paso: "zip_simulado" };
  };
  contexto.continuarYCcrearProductos = async () => operaciones.push(["crear"]);

  const enviar = (datos) => new Promise((resolve) => {
    receptor({ tipo: "RAPPI_SUBIR_LOTE", ...datos }, {}, resolve);
  });
  return { contexto, operaciones, enviar, sesion, intervalos, esperarEstadoReal };
}

const plantilla = { xlsxBase64: "AA==", xlsxNombre: "lote-prueba.xlsx" };
const imagenesManuales = { ...plantilla, imagenesManualesPorSku: true, skus: ["2247/1", "2247/3"] };

describe("Subida a Mi Tienda sin usar un lote anterior", () => {
  test("la introducción con solo Subir plantilla se reconoce y continúa hasta cargar el archivo", async () => {
    const { contexto, operaciones, enviar, esperarEstadoReal } = crearContenido();
    let pantalla = "introduccion";
    const input = {};
    const botonIrASubir = { click: () => { pantalla = "plantilla"; operaciones.push(["abrir_formulario"]); } };
    contexto.document.querySelector = (selector) => {
      if (selector.includes("products_catalog_upload_template_button")) return pantalla === "introduccion" ? botonIrASubir : null;
      if (selector.includes("products_catalog_upload_file_button")) return pantalla === "plantilla" ? input : null;
      return null;
    };
    contexto.esperarSelector = async () => {
      assert.equal(pantalla, "plantilla");
      return input;
    };
    contexto.esperarEstadoDelFlujo = esperarEstadoReal;
    assert.equal(contexto.detectarEstadoDelFlujo()?.tipo, "plantilla");
    const resultado = await enviar({ ...plantilla, imagenesZipBase64: "ZIP-NUEVO" });
    assert.equal(resultado.ok, true);
    assert.deepEqual(operaciones, [["abrir_formulario"], ["plantilla", "lote-prueba.xlsx"], ["continuar"], ["zip", "ZIP-NUEVO"]]);
  });

  test("los SKU con imágenes manuales se detienen después de validar la plantilla", async () => {
    const { enviar, operaciones } = crearContenido();
    const resultado = await enviar(imagenesManuales);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.paso, "imagenes_manuales_por_sku");
    assert.equal(resultado.plantillaSubida, true);
    assert.equal(resultado.productosPublicados, false);
    assert.deepEqual(Array.from(resultado.skus), ["2247/1", "2247/3"]);
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"]]);
  });

  for (const manual of [false, true]) {
    test(`una revisión anterior bloquea nuevas imágenes en modo ${manual ? "manual" : "ZIP"}`, async () => {
      const { enviar, operaciones } = crearContenido("imagenes");
      const resultado = await enviar({ ...plantilla, imagenesManualesPorSku: manual, skus: ["2247/1"], imagenesZipBase64: "ZIP-NUEVO" });
      assert.equal(resultado.ok, true);
      assert.equal(resultado.plantillaSubida, false);
      assert.equal(resultado.productosPublicados, false);
      assert.equal(resultado.paso, manual ? "imagenes_manuales_por_sku" : "revision_lote_existente");
      assert.deepEqual(operaciones, []);
    });
  }

  test("el flujo normal de una plantilla nueva conserva la carga automática del ZIP", async () => {
    const { enviar, operaciones } = crearContenido();
    const resultado = await enviar({ ...plantilla, imagenesZipBase64: "ZIP-NUEVO" });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.paso, "zip_simulado");
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"], ["zip", "ZIP-NUEVO"]]);
  });

  test("una plantilla que no supera la validación no carga ZIP ni crea productos", async () => {
    const { contexto, enviar, operaciones } = crearContenido();
    contexto.esperarContinuarPlantillaOAvance = async () => null;
    const resultado = await enviar(imagenesManuales);
    assert.equal(resultado.paso, "plantilla_subida_sin_continuar");
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"]]);
  });

  test("si no llega la revisión de imágenes se informa el fallo y se detiene", async () => {
    const { contexto, enviar, operaciones } = crearContenido();
    contexto.esperarEstadoDelFlujo = async (_timeout, esperado) => esperado ? null : { tipo: "plantilla" };
    const resultado = await enviar(imagenesManuales);
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /no se confirmó la pantalla/);
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"]]);
  });

  test("dos mensajes simultáneos no pueden mezclar sus plantillas e imágenes", async () => {
    const { contexto, enviar, operaciones } = crearContenido();
    let liberarEstado;
    contexto.esperarEstadoDelFlujo = async (_timeout, esperado) => esperado
      ? { tipo: "imagenes" }
      : new Promise((resolve) => { liberarEstado = resolve; });
    const primero = enviar(imagenesManuales);
    const duplicado = await enviar({ ...plantilla, imagenesZipBase64: "ZIP-OTRO-LOTE" });
    assert.equal(duplicado.ok, false);
    assert.match(duplicado.error, /carga de productos en curso/);
    assert.deepEqual(operaciones, []);
    liberarEstado({ tipo: "plantilla" });
    assert.equal((await primero).paso, "imagenes_manuales_por_sku");
    contexto.esperarEstadoDelFlujo = async (_timeout, esperado) => ({ tipo: esperado || "plantilla" });
    assert.equal((await enviar(imagenesManuales)).ok, true, "La parada manual libera el bloqueo.");
  });

  test("una recuperación programada mantiene bloqueados nuevos lotes", async () => {
    const { enviar, operaciones, sesion } = crearContenido();
    sesion.set("panafargoSync:zipReloadIntento", "1");
    const bloqueado = await enviar(imagenesManuales);
    assert.equal(bloqueado.ok, false);
    assert.match(bloqueado.error, /recuperación pendiente/);
    assert.deepEqual(operaciones, []);
    sesion.delete("panafargoSync:zipReloadIntento");
    assert.equal((await enviar(imagenesManuales)).ok, true);
  });

  test("la continuación tras recarga conserva el bloqueo hasta terminar y no confirma la asociación", async () => {
    const { contexto, enviar, operaciones, sesion, intervalos } = crearContenido("plantilla", { recuperacion: true });
    assert.equal(sesion.has("panafargoSync:zipReloadIntento"), false);
    assert.equal((await enviar(imagenesManuales)).ok, false);
    let confirmarPantallaAsociacion;
    contexto.buscarBotonPorTexto = () => ({ disabled: false, click: () => operaciones.push(["crear_tras_recarga"]) });
    contexto.esperarBotonPorTexto = () => new Promise((resolve) => { confirmarPantallaAsociacion = resolve; });
    intervalos[0]();
    await Promise.resolve();
    assert.deepEqual(operaciones, [["crear_tras_recarga"]]);
    assert.equal((await enviar(imagenesManuales)).ok, false, "El indicador de sesión ya se retiró, pero la continuación sigue activa.");
    confirmarPantallaAsociacion({ click: () => operaciones.push(["asociar"]) });
    await new Promise(setImmediate);
    assert.equal((await enviar(imagenesManuales)).ok, true);
    assert.equal(operaciones.some(([accion]) => accion === "asociar"), false);
  });
});
