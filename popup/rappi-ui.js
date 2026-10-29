// Preparación guiada de publicaciones. El SKU completo identifica cada fila.
import { prepararParaRappi } from "../rappi/rappi-connector.js";
import { generarXlsxLoteRappi, blobABase64 } from "../rappi/rappi-batch.js";
import { construirZipImagenes } from "../rappi/rappi-images-zip.js";
import { generarPlantillaAsociacion, calcularUnidadesDisponiblesAsociacion, extraerSkuCompletoAsociacion } from "../rappi/rappi-association.js";
import { obtenerProductos, limpiarPreparacionRappi } from "../storage/storage.js";
import { obtenerSkuBase } from "../utils/sku.js";
import { calcularPrecioRappi } from "../utils/model.js";
import { logger } from "../utils/logger.js";
import { descargarBlobYEsperar } from "../utils/descargas.js";

const PATRON_MI_TIENDA = "https://mitienda.rappi.com.co/*";
const URL_CREACION = "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/home-manual";
const moneda = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const seleccionPorSku = new Map();
let filas = [];
let ocupado = false;
let cargaActual = null;
let restauracionActual = null;
let guardadoSeleccion = Promise.resolve();
let refrescoPendiente = false;
let inicializado = false;
let ocupacionNotificada;
const el = (id) => document.getElementById(id);
const seleccionadas = () => filas.filter((fila) => fila.resultado.ok && fila.seleccionada);
const tieneSkuConSeparador = (lista) => lista.some(({ producto }) => /[\/\\]/.test(producto.sku));
const estaOcupado = () => ocupado || Boolean(cargaActual) || Boolean(restauracionActual);

export function initRappiTab() {
  if (inicializado) return cargarProductosValidados();
  inicializado = true;
  el("seleccionar-todos-rappi").addEventListener("change", (evento) => {
    if (estaOcupado()) return;
    for (const fila of filas) {
      if (!fila.resultado.ok) continue;
      fila.seleccionada = evento.target.checked;
      seleccionPorSku.set(fila.producto.sku, fila.seleccionada);
    }
    pintarPublicaciones();
    guardarSeleccion();
  });
  el("btn-subir-mi-tienda").addEventListener("click", () => prepararEnMiTienda());
  el("btn-refrescar-rappi").addEventListener("click", refrescarPreparacionRappi);
  el("input-plantilla-asociacion").addEventListener("change", guardarPlantilla);
  el("btn-descargar-plantilla-asociacion-generada").addEventListener("click", descargarAsociacion);
  restauracionActual = Promise.all([restaurarSeleccion(), mostrarPlantillaGuardada()])
    .finally(() => { restauracionActual = null; });
  actualizarControles();
  return restauracionActual.then(cargarProductosValidados);
}

export function cargarProductosValidados() {
  if (restauracionActual) return restauracionActual.then(cargarProductosValidados);
  if (ocupado) {
    refrescoPendiente = true;
    return Promise.resolve();
  }
  if (cargaActual) return cargaActual;
  cargaActual = cargarPublicaciones().finally(() => {
    cargaActual = null;
    actualizarControles();
  });
  actualizarControles();
  return cargaActual;
}

async function cargarPublicaciones({ seleccionarPorDefecto = true } = {}) {
  try {
    const productos = Object.values(await obtenerProductos()).filter((producto) => producto?.sku);
    const nuevas = [];
    for (const producto of productos) {
      let resultado;
      try {
        resultado = await prepararParaRappi(producto);
      } catch (error) {
        resultado = { ok: false, faltantes: [{ motivo: error.message || "No se pudo preparar la publicación." }] };
      }
      nuevas.push({ producto, resultado, seleccionada: resultado.ok && (seleccionPorSku.get(producto.sku) ?? seleccionarPorDefecto) });
      if (!seleccionarPorDefecto) seleccionPorSku.set(producto.sku, false);
    }
    filas = nuevas;
    const presentes = new Set(productos.map((producto) => producto.sku));
    let seleccionPodada = false;
    for (const sku of seleccionPorSku.keys()) {
      if (presentes.has(sku)) continue;
      seleccionPorSku.delete(sku);
      seleccionPodada = true;
    }
    let seleccionGuardada = true;
    if (seleccionPodada || !seleccionarPorDefecto) seleccionGuardada = await guardarSeleccion();
    pintarPublicaciones();
    if (!filas.length) mensaje("mensaje-rappi", "Primero busca y valida los productos del lote.");
    return seleccionGuardada !== false;
  } catch (error) {
    logger.error(error);
    filas = [];
    pintarPublicaciones();
    mensaje("mensaje-rappi", error.message || "No se pudieron leer las publicaciones guardadas.", "error");
    return false;
  }
}

function pintarPublicaciones() {
  const lista = el("lista-rappi");
  lista.replaceChildren();
  if (!filas.length) lista.appendChild(texto("p", "Las publicaciones de tu lote aparecerán aquí.", "empty-state"));
  for (const fila of filas) {
    const { producto, resultado } = fila;
    const tarjeta = document.createElement("article");
    tarjeta.className = "product-card rappi-card";
    tarjeta.dataset.sku = producto.sku;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = fila.seleccionada;
    checkbox.disabled = !resultado.ok || estaOcupado();
    checkbox.setAttribute("aria-label", `Incluir SKU ${producto.sku}`);
    checkbox.addEventListener("change", () => {
      if (estaOcupado()) return;
      fila.seleccionada = checkbox.checked;
      seleccionPorSku.set(producto.sku, checkbox.checked);
      actualizarControles();
      guardarSeleccion();
    });
    tarjeta.appendChild(checkbox);
    const contenido = document.createElement("div");
    contenido.className = "product-content";
    const encabezado = document.createElement("div");
    encabezado.className = "product-top";
    encabezado.appendChild(texto("h3", producto.nombre || "Publicación sin datos"));
    encabezado.appendChild(texto("span", resultado.ok ? "Lista" : "Por revisar", `badge ${resultado.ok ? "badge-ready" : "badge-pending"}`));
    contenido.appendChild(encabezado);
    contenido.appendChild(texto("p", `SKU ${producto.sku} · Base ${producto.sku_base || obtenerSkuBase(producto.sku)}`, "product-sku"));
    const stock = producto.inventario == null ? "Sin dato" : String(producto.inventario);
    const origen = producto.inventario_origen === "conteo_manual_shopify" ? "Conteo manual en Shopify" : "Inventario de Shopify";
    const disponibles = producto.inventario == null ? "—" : calcularUnidadesDisponiblesAsociacion(producto.inventario);
    contenido.appendChild(texto("p", `${origen}: ${stock} · Para Rappi: ${disponibles} unidades`, "product-meta"));
    let precio = resultado.rappiProduct?.precio ?? null;
    if (!resultado.ok) {
      try { precio = calcularPrecioRappi(producto.precio, producto.precio_comparacion); } catch { /* El motivo ya aparece en la validación. */ }
    }
    contenido.appendChild(texto("p", `Precio Rappi: ${precio == null ? "Pendiente" : moneda.format(precio)}`, "product-meta publication-price"));
    if (!resultado.ok) {
      contenido.appendChild(texto("p", (resultado.faltantes || []).map((falta) => falta.motivo).join(" ") || "Revisa los datos en Shopify.", "product-meta"));
    }
    tarjeta.appendChild(contenido);
    lista.appendChild(tarjeta);
  }
  actualizarControles();
}

function actualizarControles() {
  const disponibles = filas.filter((fila) => fila.resultado.ok);
  const lista = seleccionadas();
  const bloqueado = estaOcupado();
  const todos = el("seleccionar-todos-rappi");
  todos.checked = disponibles.length > 0 && lista.length === disponibles.length;
  todos.indeterminate = lista.length > 0 && lista.length < disponibles.length;
  todos.disabled = bloqueado || disponibles.length === 0;
  el("seleccion-rappi").textContent = `${lista.length} de ${disponibles.length} publicaciones listas seleccionadas`;
  for (const id of ["btn-subir-mi-tienda", "btn-descargar-plantilla-asociacion-generada"]) {
    el(id).disabled = bloqueado || lista.length === 0;
  }
  el("btn-subir-mi-tienda").disabled ||= tieneSkuConSeparador(lista);
  el("input-plantilla-asociacion").disabled = bloqueado;
  el("btn-refrescar-rappi").disabled = bloqueado;
  el("lista-rappi").querySelectorAll('input[type="checkbox"]').forEach((checkbox, indice) => {
    checkbox.disabled = bloqueado || !filas[indice]?.resultado.ok;
  });
  const aviso = el("aviso-imagenes-disenos");
  aviso.hidden = !tieneSkuConSeparador(lista);
  aviso.textContent = "La carga masiva de imágenes para SKU con / o \\ queda pendiente. Desmarca esas publicaciones para crear las demás con todas sus fotos mediante el ZIP de Rappi. Se conserva el SKU completo y no se cambia el inventario de ningún diseño.";
  if (bloqueado !== ocupacionNotificada) {
    ocupacionNotificada = bloqueado;
    window.dispatchEvent(new CustomEvent("panafargo:ocupado", { detail: { ocupado: bloqueado, origen: "rappi" } }));
  }
}

async function tarea(idMensaje, accion, requiereSeleccion = true) {
  if (estaOcupado()) return;
  const lista = seleccionadas();
  if (requiereSeleccion && !lista.length) return;
  ocupado = true;
  actualizarControles();
  try {
    await guardadoSeleccion;
    await accion(lista);
  } catch (error) {
    logger.error(error);
    const detalle = error.message || "No se pudo completar la preparación.";
    mensaje(idMensaje, idMensaje === "mensaje-plantilla-asociacion" ? `${detalle} La plantilla actual se conserva.` : detalle, "error");
  } finally {
    ocupado = false;
    actualizarControles();
    if (refrescoPendiente) {
      refrescoPendiente = false;
      await cargarProductosValidados();
    }
  }
}

async function consultarMiTienda(tabId, solicitud) {
  let limite;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, solicitud),
      new Promise((resolve) => { limite = setTimeout(() => resolve(null), 5000); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(limite);
  }
}

const consultarEstadoMiTienda = (tabId) => consultarMiTienda(tabId, { tipo: "RAPPI_ESTADO_CARGA" });

async function refrescarPreparacionRappi() {
  await tarea("mensaje-rappi", async () => {
    mensaje("mensaje-rappi", "Comprobando que Mi Tienda no tenga una carga en curso…");
    const tabs = await chrome.tabs.query({ url: PATRON_MI_TIENDA });
    const estados = await Promise.all(tabs.map((tab) => consultarEstadoMiTienda(tab.id)));
    if (estados.some((estado) => estado?.cargaEnCurso)) {
      throw new Error("Mi Tienda tiene una carga o recuperación en curso. Espera a que termine antes de refrescar Rappi. Los datos anteriores se conservan.");
    }
    if (estados.some((estado) => !estado?.ok || typeof estado.cargaEnCurso !== "boolean")) {
      throw new Error("No se pudo comprobar el estado de una pestaña de Mi Tienda. Activa la versión actual de la extensión en esa pestaña antes de reiniciar Rappi. Los datos anteriores se conservan.");
    }
    if (estados.some((estado) => estado.reiniciarPreparacion !== true)) {
      throw new Error("Una pestaña de Mi Tienda todavía usa una versión anterior. Recárgala (F5) después de actualizar la extensión y vuelve a refrescar Rappi. Los datos anteriores se conservan.");
    }

    const reinicios = await Promise.all(tabs.map((tab) => consultarMiTienda(tab.id, { tipo: "RAPPI_REINICIAR_PREPARACION" })));
    if (reinicios.some((respuesta) => respuesta?.ok !== true || respuesta.reiniciado !== true)) {
      throw new Error("No se confirmó el reinicio en todas las pestañas de Mi Tienda. Revisa si alguna empezó a procesar productos y vuelve a refrescar Rappi. La selección y la plantilla locales se conservan.");
    }
    await Promise.all(tabs.map((tab) => navegarYEsperarCarga(tab.id, { active: false })));

    await limpiarPreparacionRappi();
    seleccionPorSku.clear();
    filas = [];
    el("input-plantilla-asociacion").value = "";
    el("plantilla-actual").textContent = "Plantilla actual: incluida con la extensión";
    mensaje("mensaje-plantilla-asociacion", "");
    mensaje("mensaje-plantilla-asociacion-generada", "");
    pintarPublicaciones();
    const recargado = await cargarPublicaciones({ seleccionarPorDefecto: false });
    if (recargado) {
      const estadoPortal = tabs.length ? "Mi Tienda quedó lista para una plantilla nueva." : "Al crear el lote se abrirá Mi Tienda.";
      mensaje("mensaje-rappi", `Rappi se refrescó y descartó la preparación anterior. ${estadoPortal} Se conservan los productos y datos de Shopify; selecciona las publicaciones para crear el nuevo lote.`, "ok");
    }
  }, false);
}

async function restaurarSeleccion() {
  try {
    const guardado = await chrome.storage.local.get("panafargo_seleccion_rappi");
    for (const [sku, seleccionada] of Object.entries(guardado.panafargo_seleccion_rappi || {})) {
      if (typeof seleccionada === "boolean") seleccionPorSku.set(sku, seleccionada);
    }
  } catch (error) {
    logger.error(error);
    mensaje("mensaje-rappi", "No se recuperó la selección anterior. Revisa las publicaciones marcadas antes de continuar.", "warning");
  }
}

function guardarSeleccion() {
  const seleccion = Object.fromEntries(seleccionPorSku);
  guardadoSeleccion = guardadoSeleccion.then(async () => {
    await chrome.storage.local.set({ panafargo_seleccion_rappi: seleccion });
    return true;
  }).catch((error) => {
    logger.error(error);
    mensaje("mensaje-rappi", "No se pudo guardar la selección. Las casillas actuales siguen vigentes; revísalas si vuelves a abrir la ventana.", "warning");
    return false;
  });
  return guardadoSeleccion;
}

async function comprobarDisponibilidadMiTienda(tab, { esperarInicio = false } = {}) {
  let estado;
  const limite = Date.now() + 5000;
  do {
    estado = await consultarEstadoMiTienda(tab.id);
    if (estado || !esperarInicio || Date.now() >= limite) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < limite);
  if (!estado?.ok || typeof estado.cargaEnCurso !== "boolean"
    || estado.versionExtension !== chrome.runtime.getManifest().version) {
    throw new Error("Recarga la pestaña de Mi Tienda (F5) después de actualizar la extensión para activar el flujo actual. Todavía no se envió el lote.");
  }
  if (estado.cargaEnCurso) throw new Error("Mi Tienda ya está procesando un lote. Espera su resultado antes de enviar otro.");
  if (estado.estadoFlujo === "imagenes" || esPantallaRevision(tab.url)) {
    throw new Error("Mi Tienda conserva un lote anterior en revisión de imágenes. Pulsa Refrescar Rappi para descartarlo y empezar con una plantilla nueva; después selecciona las publicaciones y pulsa Crear productos.");
  }
}

async function prepararEnMiTienda() {
  await tarea("mensaje-rappi", async (lista) => {
    if (tieneSkuConSeparador(lista)) {
      throw new Error("La carga masiva para SKU con / o \\ queda pendiente. Desmarca esas publicaciones y pulsa Crear productos para subir las demás con todas sus imágenes.");
    }
    if (lista.some(({ producto }) => producto.imagenes_completas !== true)) {
      throw new Error("Vuelve a Buscar y validar los productos para confirmar su galería completa de Shopify y evitar subir fotos incompletas. Todavía no se descargó ni se envió el lote.");
    }
    mensaje("mensaje-rappi", "Comprobando Mi Tienda antes de preparar los archivos…");
    const tabs = await chrome.tabs.query({ url: PATRON_MI_TIENDA });
    let tab = tabs.find((pestana) => esPantallaCreacion(pestana.url)) || tabs[0];
    if (tab) await comprobarDisponibilidadMiTienda(tab);

    mensaje("mensaje-rappi", "Preparando el Excel y las imágenes del lote…");
    const [xlsx, imagenes] = await Promise.all([
      generarXlsxLoteRappi(lista.map((fila) => fila.resultado.rappiProduct)),
      construirZipImagenes(lista),
    ]);
    const lote = `lote_${Date.now()}`;
    const solicitud = {
      tipo: "RAPPI_SUBIR_LOTE", skus: lista.map((fila) => fila.producto.sku),
      xlsxBase64: await blobABase64(xlsx), xlsxNombre: `${lote}.xlsx`,
      imagenesZipBase64: await blobABase64(imagenes),
      imagenesZipNombre: `${lote}_imagenes.zip`,
    };
    // Presupuesto conservador para no sobrepasar el transporte de mensajes
    // con lotes que representan muchas publicaciones por cada base.
    if (new Blob([JSON.stringify(solicitud)]).size > 48 * 1024 * 1024) {
      throw new Error("El lote y sus imágenes son demasiado grandes para enviarlos juntos. Selecciona menos publicaciones y prepara el resto en otro lote.");
    }
    // La copia local y la carga masiva usan exactamente el mismo ZIP.
    // Ninguna imagen se vuelve a descargar ni a normalizar para guardarlo.
    try {
      mensaje("mensaje-rappi", "Descargando el Excel del lote. Esperando a que Chrome confirme la descarga…");
      await descargarBlobYEsperar(xlsx, `Panafargo_Rappi/Lotes/${lote}.xlsx`);
      mensaje("mensaje-rappi", "Excel descargado. Descargando el ZIP de carga masiva con todas las imágenes y esperando su confirmación…");
      await descargarBlobYEsperar(imagenes, `Panafargo_Rappi/Imagenes/imagenes_rappi_${lote}.zip`);
    } catch (error) {
      throw new Error(`No terminaron correctamente las dos descargas. No se envió el lote ni se crearon productos en Rappi. ${error.message || "Vuelve a intentarlo."}`);
    }

    // Solo después de ambas descargas completas se permite abrir, navegar o
    // enviar el lote a Mi Tienda. La comprobación anterior fue de solo lectura.
    let esperarInicio = false;
    if (!tab) {
      mensaje("mensaje-rappi", "Excel y ZIP descargados. Abriendo Mi Tienda para crear los productos…");
      tab = await abrirMiTiendaYEsperarCarga();
      esperarInicio = true;
      if (!esPantallaCreacion(tab.url)) {
        mensaje("mensaje-rappi", "Excel y ZIP descargados. Mi Tienda solicita iniciar sesión; complétala en su pestaña y después pulsa Crear productos. Todavía no se envió el lote.", "warning");
        return;
      }
    } else {
      try { tab = await chrome.tabs.get(tab.id); } catch {
        throw new Error("Los archivos ya se descargaron, pero se cerró la pestaña de Mi Tienda. Ábrela y vuelve a pulsar Crear productos.");
      }
    }
    if (!esPantallaCreacion(tab.url)) {
      tab = await navegarYEsperarCarga(tab.id);
      esperarInicio = true;
    }
    if (!esPantallaCreacion(tab.url)) {
      throw new Error("Los archivos ya se descargaron. Revisa Mi Tienda e inicia sesión; después vuelve a pulsar Crear productos.");
    }
    await comprobarDisponibilidadMiTienda(tab, { esperarInicio });
    mensaje("mensaje-rappi", "Excel y ZIP descargados. Cargando todas las imágenes mediante la opción masiva de Mi Tienda…");
    let respuesta;
    try {
      respuesta = await chrome.tabs.sendMessage(tab.id, solicitud);
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/i.test(error.message || "")) {
        throw new Error("Recarga la pestaña de Mi Tienda para activar la extensión y vuelve a pulsar Crear productos.");
      }
      throw error;
    }
    if (!respuesta?.ok) throw new Error(respuesta?.error || respuesta?.mensaje || "Mi Tienda no confirmó la preparación. Revisa su pestaña antes de repetir el envío.");
    if (respuesta.paso === "revision_lote_existente") {
      throw new Error("Mi Tienda conserva un lote anterior. Pulsa Refrescar Rappi para descartarlo y después crea el lote nuevamente.");
    }
    const tono = ["imagenes_error_rappi", "imagenes_formulario_no_encontrado", "zip_no_asignado"].includes(respuesta.paso) ? "error"
      : respuesta.paso === "productos_creados_pendiente_asociacion" ? "ok" : "warning";
    mensaje("mensaje-rappi", respuesta.mensaje || "Revisa el resultado en Mi Tienda. La asociación requiere tu confirmación.", tono);
  });
}

async function mostrarPlantillaGuardada() {
  try {
    const guardado = await chrome.storage.local.get("plantillaAsociacionNombre");
    el("plantilla-actual").textContent = `Plantilla actual: ${guardado.plantillaAsociacionNombre || "incluida con la extensión"}`;
  } catch (error) {
    el("plantilla-actual").textContent = "Plantilla actual: no se pudo comprobar";
    mensaje("mensaje-plantilla-asociacion", "No se pudo leer la plantilla guardada. Vuelve a seleccionarla.", "error");
  }
}

async function guardarPlantilla() {
  const input = el("input-plantilla-asociacion");
  const archivo = input.files?.[0];
  if (!archivo) return;
  await tarea("mensaje-plantilla-asociacion", async () => {
    mensaje("mensaje-plantilla-asociacion", "Comprobando la plantilla…");
    if (!/\.xlsx$/i.test(archivo.name)) throw new Error("Selecciona la plantilla .xlsx enviada por Rappi.");
    if (!window.XLSX) throw new Error("No se pudo cargar el lector de Excel.");
    const libro = window.XLSX.read(await archivo.arrayBuffer(), { type: "array" });
    const hoja = libro.Sheets?.Productos;
    let rango;
    try { rango = hoja?.["!ref"] && window.XLSX.utils.decode_range(hoja["!ref"]); } catch { /* Se informa el contrato esperado abajo. */ }
    const rangoValido = rango && [rango.s.r, rango.s.c, rango.e.r, rango.e.c].every(Number.isSafeInteger)
      && rango.s.r >= 0 && rango.s.c >= 0 && rango.e.r >= rango.s.r && rango.e.c >= rango.s.c
      && rango.e.r < 1048576 && rango.e.c < 16384;
    let tieneSkuAsociacion = false;
    if (rangoValido) {
      for (let fila = Math.max(5, rango.s.r); fila <= rango.e.r; fila++) {
        const sku = hoja[`G${fila + 1}`]?.v;
        if (extraerSkuCompletoAsociacion(sku) !== null) {
          tieneSkuAsociacion = true;
          break;
        }
      }
    }
    if (!tieneSkuAsociacion) {
      throw new Error("Selecciona la plantilla de asociación enviada por Rappi, con los SKU PANAFARGOSAS_ en la columna G de Productos. El Excel de creación no sirve para este paso.");
    }
    await chrome.storage.local.set({
      plantillaAsociacionBase64: await blobABase64(archivo),
      plantillaAsociacionNombre: archivo.name,
      plantillaAsociacionFecha: Date.now(),
    });
    el("plantilla-actual").textContent = `Plantilla actual: ${archivo.name}`;
    mensaje("mensaje-plantilla-asociacion", "Plantilla guardada automáticamente. Este archivo reemplaza al anterior para las próximas asociaciones.", "ok");
  }, false);
  // La plantilla vigente se muestra arriba. Limpiar el selector permite
  // volver a elegir un archivo actualizado que tenga el mismo nombre.
  input.value = "";
}

async function descargarAsociacion() {
  await tarea("mensaje-plantilla-asociacion-generada", async (lista) => {
    mensaje("mensaje-plantilla-asociacion-generada", "Preparando precios y unidades por SKU completo…");
    const { blob, filasEscritas, noEncontrados } = await generarPlantillaAsociacion(lista.map((fila) => ({
      sku: fila.producto.sku,
      precio: fila.resultado.rappiProduct.precio,
      inventario: fila.producto.inventario,
    })));
    if (!filasEscritas) throw new Error("La plantilla no contiene los SKU completos seleccionados. Usa la plantilla de asociación que Rappi envió para estas publicaciones.");
    await descargarBlobYEsperar(blob, `Panafargo_Rappi/Asociacion/asociacion_${Date.now()}.xlsx`);
    const faltantes = noEncontrados.length ? ` Sin fila en la plantilla: ${noEncontrados.join(", ")}.` : "";
    mensaje("mensaje-plantilla-asociacion-generada", `Descarga completada: ${filasEscritas} de ${lista.length} publicaciones incluidas.${faltantes} Revisa el archivo y confirma la asociación en Mi Tienda.`, noEncontrados.length ? "warning" : "ok");
  });
}

function esPantallaCreacion(url) {
  try {
    const actual = new URL(url);
    if (actual.origin !== "https://mitienda.rappi.com.co") return false;
    if (/^\/cms\/catalog\/bulk-creation\/(?:home-manual|home|manual\/[1-9]\d*)\/?$/.test(actual.pathname)) return true;
    const formulario = actual.pathname.match(/^\/cms\/catalog\/manager-upload-files((?:;[^/]*)?)\/?$/);
    if (!formulario) return false;
    // Angular usa parámetros de matriz para elegir el formulario manual.
    const parametros = new URLSearchParams(formulario[1].replace(/^;/, "").replace(/;/g, "&"));
    return parametros.getAll("isManual").length === 1 && parametros.get("isManual") === "true";
  } catch { return false; }
}

function esPantallaRevision(url) {
  try {
    const actual = new URL(url);
    return actual.origin === "https://mitienda.rappi.com.co" && /^\/cms\/catalog\/bulk-creation\/manual\/[1-9]\d*\/?$/.test(actual.pathname);
  } catch { return false; }
}

function abrirMiTiendaYEsperarCarga() {
  return new Promise((resolve, reject) => {
    let tabId;
    let terminado = false;
    const completas = new Map();
    const terminar = (error, tab) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve(tab);
    };
    const listener = (id, cambio, tab) => {
      if (cambio.status !== "complete") return;
      completas.set(id, tab);
      if (id === tabId) terminar(null, tab || { id, url: URL_CREACION });
    };
    const timer = setTimeout(() => terminar(new Error("Los archivos ya se descargaron, pero Mi Tienda tardó demasiado en abrir. Revisa su pestaña antes de repetir el envío.")), 20000);
    // Registrar antes de create también cubre una pestaña que termina de
    // cargar antes de que Chrome resuelva la promesa de creación.
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.create({ url: URL_CREACION, active: true }).then(async (tab) => {
      if (terminado) return;
      if (!Number.isInteger(tab?.id)) throw new Error("Chrome no confirmó la nueva pestaña de Mi Tienda.");
      tabId = tab.id;
      if (completas.has(tabId)) return terminar(null, completas.get(tabId) || tab);
      if (tab.status === "complete") return terminar(null, tab);
      const actual = await chrome.tabs.get(tabId);
      if (actual.status === "complete") terminar(null, actual);
    }).catch((error) => terminar(error));
  });
}

function navegarYEsperarCarga(tabId, { active = true } = {}) {
  return new Promise((resolve, reject) => {
    const terminar = (error, tab) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve(tab);
    };
    const listener = (id, cambio, tab) => {
      if (id === tabId && cambio.status === "complete") terminar(null, tab || { id: tabId, url: URL_CREACION });
    };
    const timer = setTimeout(() => terminar(new Error("Mi Tienda tardó demasiado en cargar. Revisa su pestaña antes de repetir.")), 20000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url: URL_CREACION, active }).catch((error) => terminar(error));
  });
}

function texto(etiqueta, contenido, clase = "") {
  const nodo = document.createElement(etiqueta);
  nodo.textContent = contenido;
  if (clase) nodo.className = clase;
  return nodo;
}

function mensaje(id, contenido, tono = "info") {
  el(id).textContent = contenido;
  el(id).dataset.tone = tono;
}
