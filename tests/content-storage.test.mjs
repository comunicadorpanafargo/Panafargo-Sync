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
  const local = new Map();
  const intervalos = [];
  const pantallas = new Set();
  const crearElemento = () => ({
    style: {},
    setAttribute() {},
    append() {},
    appendChild() {},
    animate: () => ({ cancel() {} }),
    remove() { pantallas.delete(this); },
  });
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
    localStorage: {
      getItem: (key) => local.get(key) ?? null,
      removeItem: (key) => local.delete(key),
      setItem: (key, value) => local.set(key, String(value)),
    },
    chrome: { runtime: { onMessage: { addListener: (callback) => { receptor = callback; } } } },
    document: {
      body: { innerText: "", appendChild: (elemento) => pantallas.add(elemento) },
      createElement: crearElemento,
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(contenido, contexto, { filename: "mi-tienda-content-script.js" });
  const esperarEstadoReal = contexto.esperarEstadoDelFlujo;
  const continuarCrearReal = contexto.continuarYCcrearProductos;
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
  return { contexto, operaciones, enviar, sesion, local, intervalos, esperarEstadoReal, continuarCrearReal, pantallas };
}

const plantilla = { xlsxBase64: "AA==", xlsxNombre: "lote-prueba.xlsx" };
const imagenesManuales = { ...plantilla, imagenesManualesPorSku: true, skus: ["2247/1", "2247/3"] };
const imagenesPorFila = {
  ...plantilla,
  skus: ["34534/hola", "67890/hola"],
  imagenesPorSku: [
    { sku: "34534/hola", nombre: "34534%2Fhola.png", tipoMime: "image/png", base64: "AA==" },
    { sku: "67890/hola", nombre: "67890%2Fhola.png", tipoMime: "image/png", base64: "AA==" },
  ],
};

describe("Subida a Mi Tienda sin usar un lote anterior", () => {
  test("las imágenes por SKU se confirman antes de crear, sin usar el ZIP", async () => {
    const { contexto, enviar, operaciones, pantallas } = crearContenido();
    contexto.PanafargoImagenesPorSku = {
      validar: (imagenes, skus) => {
        assert.deepEqual(Array.from(skus), imagenesPorFila.skus);
        return { skus, imagenes };
      },
      asignar: async (paquete, { alProgreso }) => {
        operaciones.push(["imagenes_sku", Array.from(paquete.skus)]);
        alProgreso({ sku: paquete.skus[1], completadas: 2, total: 2 });
        return { skus: paquete.skus, imagenesSubidas: 2 };
      },
    };
    const resultado = await enviar(imagenesPorFila);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.paso, "productos_creados_pendiente_asociacion");
    assert.equal(resultado.imagenesSubidas, 2);
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"], ["imagenes_sku", imagenesPorFila.skus], ["crear"]]);
    assert.equal(pantallas.size, 0);
  });

  test("si una imagen no se confirma no crea productos y retira la espera", async () => {
    const { contexto, enviar, operaciones, pantallas } = crearContenido();
    contexto.PanafargoImagenesPorSku = {
      validar: (_imagenes, skus) => ({ skus }),
      asignar: async () => { throw new Error("No se confirmó una imagen nueva para el SKU 67890/hola"); },
    };
    const resultado = await enviar(imagenesPorFila);
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /67890\/hola/);
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"]]);
    assert.equal(pantallas.size, 0);
  });

  test("una revisión anterior exige refrescar y no ofrece retomar ni modifica el lote", async () => {
    const { contexto, enviar, operaciones } = crearContenido("imagenes");
    contexto.PanafargoImagenesPorSku = {
      validar: (_imagenes, skus) => ({ skus }),
      asignar: async () => { throw new Error("No debe ejecutarse"); },
    };
    const resultado = await enviar(imagenesPorFila);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.paso, "revision_lote_existente");
    assert.equal(resultado.plantillaSubida, false);
    assert.equal(resultado.productosPublicados, false);
    assert.notEqual(resultado.reanudarRevisionDisponible, true);
    assert.match(resultado.mensaje, /[Rr]efrescar Rappi/);
    assert.deepEqual(operaciones, []);
  });

  for (const estado of ["imagenes", "plantilla"]) test(`un mensaje antiguo para retomar no modifica la pantalla de ${estado}`, async () => {
    const { contexto, enviar, operaciones } = crearContenido(estado);
    contexto.PanafargoImagenesPorSku = {
      validar: (_imagenes, skus) => ({ skus }),
      asignar: async () => { throw new Error("No debe asignar imágenes"); },
    };
    const resultado = await enviar({ ...imagenesPorFila, reanudarRevision: true });
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /[Rr]efrescar|actualiz/i);
    assert.deepEqual(operaciones, []);
  });

  test("si Crear se pulsó pero no llegó la confirmación, no se repite tras recargar", async () => {
    const { contexto, operaciones, sesion, continuarCrearReal } = crearContenido("imagenes");
    contexto.localStorage = { getItem: () => "123" };
    contexto.esperarBotonHabilitadoConTexto = async () => ({ click: () => operaciones.push(["crear_real"]) });
    contexto.esperarBotonPorTexto = async () => null;
    await assert.rejects(continuarCrearReal(), /no confirmó que la creación terminó/);
    assert.deepEqual(operaciones, [["crear_real"]]);
    const marca = sesion.get("panafargoSync:creacionPendiente");
    assert.equal(JSON.parse(marca).fileId, "123");
    const recargado = crearContenido("imagenes");
    recargado.sesion.set("panafargoSync:creacionPendiente", marca);
    recargado.contexto.localStorage = { getItem: () => "123" };
    recargado.contexto.PanafargoImagenesPorSku = { validar: (_imagenes, skus) => ({ skus }) };
    for (let intento = 0; intento < 2; intento++) {
      const respuesta = await recargado.enviar(imagenesPorFila);
      assert.equal(respuesta.ok, false);
      assert.match(respuesta.error, /Ya se pulsó Crear productos/);
      assert.deepEqual(recargado.operaciones, []);
    }
  });

  test("confirmar la pantalla de asociación retira la marca sin pulsar Asociar", async () => {
    const { contexto, operaciones, sesion, continuarCrearReal } = crearContenido("imagenes");
    contexto.localStorage = { getItem: () => "123" };
    contexto.esperarBotonHabilitadoConTexto = async () => ({ click: () => operaciones.push(["crear_real"]) });
    contexto.esperarBotonPorTexto = async () => ({ click: () => operaciones.push(["asociar"]) });
    await continuarCrearReal();
    assert.deepEqual(operaciones, [["crear_real"]]);
    assert.equal(sesion.has("panafargoSync:creacionPendiente"), false);
  });

  test("un ID cambiado por otra pestaña no permite retomar una creación incierta", async () => {
    for (const actual of [null, "123", "124"]) {
      const { contexto, enviar, operaciones, sesion } = crearContenido("imagenes");
      contexto.localStorage = { getItem: () => actual };
      sesion.set("panafargoSync:creacionPendiente", JSON.stringify({ fileId: "123" }));
      contexto.PanafargoImagenesPorSku = { validar: (_imagenes, skus) => ({ skus }) };
      const resultado = await enviar(imagenesPorFila);
      assert.equal(resultado.ok, false);
      assert.equal(sesion.has("panafargoSync:creacionPendiente"), true);
      assert.deepEqual(operaciones, []);
    }
  });

  test("una plantilla nueva confirmada con ID distinto permite continuar, sin repetir la anterior", async () => {
    const { contexto, enviar, operaciones, sesion } = crearContenido("plantilla");
    contexto.localStorage = { getItem: () => "124" };
    sesion.set("panafargoSync:creacionPendiente", JSON.stringify({ fileId: "123" }));
    contexto.PanafargoImagenesPorSku = {
      validar: (_imagenes, skus) => ({ skus }),
      asignar: async (paquete) => {
        operaciones.push(["imagenes_sku", Array.from(paquete.skus)]);
        return { skus: paquete.skus, imagenesSubidas: 2 };
      },
    };
    const resultado = await enviar(imagenesPorFila);
    assert.equal(resultado.ok, true);
    assert.equal(sesion.has("panafargoSync:creacionPendiente"), false);
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"], ["imagenes_sku", imagenesPorFila.skus], ["crear"]]);
  });

  for (const zip of [false, true]) test(`un archivo sin ID nuevo no recibe ${zip ? "ZIP" : "imágenes"} tras una creación incierta`, async () => {
    const { contexto, enviar, operaciones, sesion } = crearContenido("plantilla");
    contexto.localStorage = { getItem: () => "123" };
    sesion.set("panafargoSync:creacionPendiente", JSON.stringify({ fileId: "123" }));
    contexto.PanafargoImagenesPorSku = {
      validar: (_imagenes, skus) => ({ skus }),
      asignar: async () => { throw new Error("No debe asignar imágenes"); },
    };
    const resultado = await enviar(zip ? { ...plantilla, imagenesZipBase64: "ZIP-NUEVO" } : imagenesPorFila);
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /Ya se pulsó Crear productos/);
    assert.deepEqual(operaciones, [["plantilla", "lote-prueba.xlsx"], ["continuar"]]);
  });

  test("una marca de creación ilegible bloquea la repetición en vez de asumir éxito", async () => {
    const { contexto, enviar, operaciones, sesion } = crearContenido("imagenes");
    contexto.localStorage = { getItem: () => "123" };
    sesion.set("panafargoSync:creacionPendiente", "marca dañada");
    const resultado = await enviar(plantilla);
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /Ya se pulsó Crear productos/);
    assert.deepEqual(operaciones, []);
  });

  test("un mapa de imágenes inválido se rechaza antes de cargar el Excel", async () => {
    const { contexto, enviar, operaciones } = crearContenido();
    contexto.PanafargoImagenesPorSku = { validar() { throw new Error("Faltan imágenes del lote"); } };
    const resultado = await enviar(imagenesPorFila);
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /Faltan imágenes/);
    assert.deepEqual(operaciones, []);
  });

  test("consultar el estado no limpia la sesión ni modifica productos", async () => {
    const { contexto, enviar, operaciones, sesion } = crearContenido();
    contexto.chrome.runtime.getManifest = () => ({ version: "4.1.4" });
    const consultar = () => enviar({ tipo: "RAPPI_ESTADO_CARGA" });
    const libre = await consultar();
    assert.equal(libre.ok, true);
    assert.equal(libre.cargaEnCurso, false);
    assert.equal(libre.versionExtension, "4.1.4");
    assert.equal(libre.reiniciarPreparacion, true);
    assert.equal(libre.estadoFlujo, "plantilla");
    assert.equal(Object.hasOwn(libre, "reanudarRevisionPorSku"), false);
    sesion.set("panafargoSync:zipReloadIntento", "1");
    assert.equal((await consultar()).cargaEnCurso, true);
    assert.equal(sesion.get("panafargoSync:zipReloadIntento"), "1");
    assert.deepEqual(operaciones, []);
  });

  test("refrescar elimina únicamente el borrador de Rappi y conserva la sesión autenticada", async () => {
    const { contexto, enviar, operaciones, sesion, local } = crearContenido("imagenes");
    contexto.PanafargoImagenesPorSku = { validar: (_imagenes, skus) => ({ skus }) };
    sesion.set("panafargoSync:creacionPendiente", JSON.stringify({ fileId: "123" }));
    sesion.set("sesion-empleado", "sesion-sintetica");
    local.set("ean-match-creation-file-id", "123");
    local.set("rappi-auth-token", "token-sintetico");
    local.set("preferencia-tienda", "preferencia-sintetica");
    const resultado = await enviar({ tipo: "RAPPI_REINICIAR_PREPARACION" });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.reiniciado, true);
    assert.deepEqual([...sesion], [["sesion-empleado", "sesion-sintetica"]]);
    assert.deepEqual([...local], [["rappi-auth-token", "token-sintetico"], ["preferencia-tienda", "preferencia-sintetica"]]);
    assert.deepEqual(operaciones, [], "El content script no crea, asocia ni navega por su cuenta.");
    const repetido = await enviar(imagenesPorFila);
    assert.equal(repetido.paso, "revision_lote_existente", "La vista vieja no se reutiliza tras olvidar sus marcas.");
    assert.deepEqual(operaciones, []);
  });

  test("una recuperación programada impide refrescar sin borrar borrador ni marcas", async () => {
    const { enviar, operaciones, sesion, local } = crearContenido();
    sesion.set("panafargoSync:zipReloadIntento", "1");
    sesion.set("panafargoSync:creacionPendiente", JSON.stringify({ fileId: "123" }));
    local.set("ean-match-creation-file-id", "123");
    const anterior = { sesion: [...sesion], local: [...local] };
    const resultado = await enviar({ tipo: "RAPPI_REINICIAR_PREPARACION" });
    assert.equal(resultado.ok, false);
    assert.notEqual(resultado.reiniciado, true);
    assert.deepEqual({ sesion: [...sesion], local: [...local] }, anterior);
    assert.deepEqual(operaciones, []);
  });

  test("un envío activo impide refrescar hasta que termina la validación", async () => {
    const { contexto, enviar, operaciones, local } = crearContenido();
    let liberar;
    contexto.esperarEstadoDelFlujo = async (_timeout, esperado) => esperado
      ? { tipo: "imagenes" }
      : new Promise((resolve) => { liberar = resolve; });
    local.set("ean-match-creation-file-id", "123");
    const subida = enviar(imagenesManuales);
    const resultado = await enviar({ tipo: "RAPPI_REINICIAR_PREPARACION" });
    assert.equal(resultado.ok, false);
    assert.equal(local.get("ean-match-creation-file-id"), "123");
    assert.deepEqual(operaciones, []);
    liberar({ tipo: "plantilla" });
    await subida;
    const libre = await enviar({ tipo: "RAPPI_REINICIAR_PREPARACION" });
    assert.equal(libre.ok, true);
    assert.equal(libre.reiniciado, true);
    assert.equal(local.has("ean-match-creation-file-id"), false);
  });

  test("el estado informa un envío activo hasta que termina su revisión", async () => {
    const { contexto, enviar } = crearContenido();
    let resolver;
    contexto.esperarEstadoDelFlujo = async (_timeout, esperado) => esperado
      ? { tipo: "imagenes" }
      : new Promise((resolve) => { resolver = resolve; });
    const subida = enviar(imagenesManuales);
    assert.equal((await enviar({ tipo: "RAPPI_ESTADO_CARGA" })).cargaEnCurso, true);
    resolver({ tipo: "plantilla" });
    await subida;
    assert.equal((await enviar({ tipo: "RAPPI_ESTADO_CARGA" })).cargaEnCurso, false);
  });

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
      assert.equal(resultado.paso, "revision_lote_existente");
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
    const { contexto, enviar, operaciones, sesion, intervalos, pantallas } = crearContenido("plantilla", { recuperacion: true });
    assert.equal(sesion.has("panafargoSync:zipReloadIntento"), false);
    assert.equal(pantallas.size, 1, "La espera sigue cubierta tras actualizar Mi Tienda.");
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
    assert.equal(pantallas.size, 0, "La pantalla de espera se retira al confirmar el resultado.");
    assert.equal((await enviar(imagenesManuales)).ok, true);
    assert.equal(operaciones.some(([accion]) => accion === "asociar"), false);
  });

  test("si falla la continuación tras recarga, se retira la espera y se libera el bloqueo", async () => {
    const { contexto, enviar, operaciones, intervalos, pantallas } = crearContenido("plantilla", { recuperacion: true });
    const errores = [];
    contexto.console = { ...console, error: (...args) => errores.push(args) };
    contexto.buscarBotonPorTexto = () => ({ disabled: false, click: () => operaciones.push(["crear_tras_recarga"]) });
    contexto.esperarBotonPorTexto = async () => { throw new Error("No se confirmó la creación"); };
    assert.equal(pantallas.size, 1);
    intervalos[0]();
    await new Promise(setImmediate);
    assert.equal(pantallas.size, 0, "El error real de Mi Tienda vuelve a ser visible.");
    assert.equal(errores.length, 1);
    assert.match(errores[0][1].message, /No se confirmó la creación/);
    assert.equal((await enviar(imagenesManuales)).ok, true);
    assert.equal(operaciones.some(([accion]) => accion === "asociar"), false);
  });
});
