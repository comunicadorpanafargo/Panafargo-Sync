// Preparación guiada de publicaciones. El SKU completo identifica cada fila.
import { prepararParaRappi } from "../rappi/rappi-connector.js";
import { generarXlsxLoteRappi, blobABase64 } from "../rappi/rappi-batch.js";
import { construirZipImagenes, construirPaqueteImagenesLocales } from "../rappi/rappi-images-zip.js";
import { generarPlantillaAsociacion, calcularUnidadesDisponiblesAsociacion } from "../rappi/rappi-association.js";
import { obtenerProductos } from "../storage/storage.js";
import { obtenerSkuBase } from "../utils/sku.js";
import { calcularPrecioRappi } from "../utils/model.js";
import { logger } from "../utils/logger.js";

const PATRON_MI_TIENDA = "https://mitienda.rappi.com.co/*";
const URL_CREACION = "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/manual/1";
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
const imagenesManuales = (lista) => lista.some(({ producto }) => /[\/\\]/.test(producto.sku));
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
  el("btn-generar-lote-rappi").addEventListener("click", descargarArchivos);
  el("btn-subir-mi-tienda").addEventListener("click", prepararEnMiTienda);
  el("input-plantilla-asociacion").addEventListener("change", guardarPlantilla);
  el("btn-descargar-plantilla-asociacion-generada").addEventListener("click", descargarAsociacion);
  restauracionActual = restaurarSeleccion().finally(() => { restauracionActual = null; });
  actualizarControles();
  return Promise.all([mostrarPlantillaGuardada(), restauracionActual.then(cargarProductosValidados)]);
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

async function cargarPublicaciones() {
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
      nuevas.push({ producto, resultado, seleccionada: resultado.ok && (seleccionPorSku.get(producto.sku) ?? true) });
    }
    filas = nuevas;
    const presentes = new Set(productos.map((producto) => producto.sku));
    let seleccionPodada = false;
    for (const sku of seleccionPorSku.keys()) {
      if (presentes.has(sku)) continue;
      seleccionPorSku.delete(sku);
      seleccionPodada = true;
    }
    if (seleccionPodada) await guardarSeleccion();
    pintarPublicaciones();
    if (!filas.length) mensaje("mensaje-rappi", "Primero busca y valida los productos del lote.");
  } catch (error) {
    logger.error(error);
    filas = [];
    pintarPublicaciones();
    mensaje("mensaje-rappi", error.message || "No se pudieron leer las publicaciones guardadas.", "error");
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
  for (const id of ["btn-generar-lote-rappi", "btn-subir-mi-tienda", "btn-descargar-plantilla-asociacion-generada"]) {
    el(id).disabled = bloqueado || lista.length === 0;
  }
  el("input-plantilla-asociacion").disabled = bloqueado;
  el("lista-rappi").querySelectorAll('input[type="checkbox"]').forEach((checkbox, indice) => {
    checkbox.disabled = bloqueado || !filas[indice]?.resultado.ok;
  });
  const aviso = el("aviso-imagenes-disenos");
  aviso.hidden = !imagenesManuales(lista);
  aviso.textContent = "Este lote incluye SKU con /. Se preparará el Excel y Mi Tienda se detendrá en la revisión. Descarga el paquete de imágenes y asígnalas por SKU completo antes de continuar manualmente; estas publicaciones no se crean automáticamente.";
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
    mensaje(idMensaje, error.message || "No se pudo completar la preparación.", "error");
  } finally {
    ocupado = false;
    actualizarControles();
    if (refrescoPendiente) {
      refrescoPendiente = false;
      await cargarProductosValidados();
    }
  }
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
  guardadoSeleccion = guardadoSeleccion.then(() => chrome.storage.local.set({ panafargo_seleccion_rappi: seleccion })).catch((error) => {
    logger.error(error);
    mensaje("mensaje-rappi", "No se pudo guardar la selección. Las casillas actuales siguen vigentes; revísalas si vuelves a abrir la ventana.", "warning");
  });
  return guardadoSeleccion;
}

async function descargarArchivos() {
  await tarea("mensaje-rappi", async (lista) => {
    mensaje("mensaje-rappi", "Preparando el Excel y las imágenes del lote…");
    const manual = imagenesManuales(lista);
    const [xlsx, zip] = await Promise.all([
      generarXlsxLoteRappi(lista.map((fila) => fila.resultado.rappiProduct)),
      manual ? construirPaqueteImagenesLocales(lista) : construirZipImagenes(lista),
    ]);
    const lote = Date.now();
    await descargarBlob(xlsx, `Panafargo_Rappi/Lotes/lote_${lote}.xlsx`);
    try {
      await descargarBlob(zip, `Panafargo_Rappi/Imagenes/${manual ? "asignacion_manual" : "imagenes_rappi"}_${lote}.zip`);
    } catch (error) {
      throw new Error(`Se inició la descarga del Excel, pero no la del paquete de imágenes. ${error.message || "Vuelve a intentarlo."}`);
    }
    mensaje("mensaje-rappi", manual
      ? "Descargas iniciadas: Excel de creación y paquete local de imágenes con su mapa por SKU completo. Asigna estas imágenes manualmente en Mi Tienda; el paquete no es un ZIP de importación de Rappi."
      : "Descargas iniciadas: un Excel de creación y un ZIP de imágenes para Mi Tienda. La asociación se prepara por separado.", manual ? "warning" : "ok");
  });
}

async function prepararEnMiTienda() {
  await tarea("mensaje-rappi", async (lista) => {
    mensaje("mensaje-rappi", "Buscando Mi Tienda…");
    const tabs = await chrome.tabs.query({ url: PATRON_MI_TIENDA });
    let tab = tabs.find((pestana) => esPantallaCreacion(pestana.url)) || tabs[0];
    if (!tab) {
      await chrome.tabs.create({ url: URL_CREACION, active: true });
      mensaje("mensaje-rappi", "Abrí Mi Tienda. Inicia sesión si se solicita y vuelve a pulsar Preparar en Mi Tienda.");
      return;
    }
    if (!esPantallaCreacion(tab.url)) tab = await navegarYEsperarCarga(tab.id);
    if (!esPantallaCreacion(tab.url)) {
      mensaje("mensaje-rappi", "Revisa la pestaña de Mi Tienda e inicia sesión. Después vuelve a preparar el lote.", "warning");
      return;
    }
    const manual = imagenesManuales(lista);
    mensaje("mensaje-rappi", manual ? "Preparando el Excel y el paquete para asignar imágenes por SKU completo…" : "Preparando el Excel y las imágenes…");
    const [xlsx, zip] = await Promise.all([
      generarXlsxLoteRappi(lista.map((fila) => fila.resultado.rappiProduct)),
      manual ? construirPaqueteImagenesLocales(lista) : construirZipImagenes(lista),
    ]);
    const lote = `lote_${Date.now()}`;
    const solicitud = { tipo: "RAPPI_SUBIR_LOTE", xlsxBase64: await blobABase64(xlsx), xlsxNombre: `${lote}.xlsx` };
    if (manual) {
      await descargarBlob(zip, `Panafargo_Rappi/Imagenes/asignacion_manual_${lote}.zip`);
      solicitud.imagenesManualesPorSku = true;
      solicitud.skus = lista.map((fila) => fila.producto.sku);
    } else {
      solicitud.imagenesZipBase64 = await blobABase64(zip);
      solicitud.imagenesZipNombre = `${lote}_imagenes.zip`;
    }
    mensaje("mensaje-rappi", manual ? "Cargando el Excel; la extensión se detendrá antes de crear los productos…" : "Preparando el lote en Mi Tienda. Espera a que termine…");
    let respuesta;
    try {
      respuesta = await chrome.tabs.sendMessage(tab.id, solicitud);
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/i.test(error.message || "")) {
        throw new Error("Recarga la pestaña de Mi Tienda para activar la extensión y vuelve a preparar el lote.");
      }
      throw error;
    }
    if (!respuesta?.ok) throw new Error(respuesta?.error || respuesta?.mensaje || "Mi Tienda no confirmó la preparación. Revisa su pestaña antes de repetir el envío.");
    const tono = ["imagenes_error_rappi", "imagenes_formulario_no_encontrado", "zip_no_asignado"].includes(respuesta.paso) ? "error"
      : !manual && respuesta.paso === "productos_creados_pendiente_asociacion" ? "ok" : "warning";
    mensaje("mensaje-rappi", respuesta.mensaje || "Revisa el resultado en Mi Tienda. La asociación requiere tu confirmación.", tono);
  });
}

async function mostrarPlantillaGuardada() {
  try {
    const guardado = await chrome.storage.local.get("plantillaAsociacionNombre");
    el("plantilla-actual").textContent = guardado.plantillaAsociacionNombre || "Plantilla incluida";
  } catch (error) {
    mensaje("mensaje-plantilla-asociacion", "No se pudo leer la plantilla guardada. Vuelve a seleccionarla.", "error");
  }
}

async function guardarPlantilla() {
  const archivo = el("input-plantilla-asociacion").files?.[0];
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
        if (typeof sku === "string" && sku.startsWith("PANAFARGOSAS_") && sku.length > "PANAFARGOSAS_".length) {
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
    el("plantilla-actual").textContent = archivo.name;
    mensaje("mensaje-plantilla-asociacion", "Plantilla comprobada y guardada. Ya puedes generar la asociación.", "ok");
  }, false);
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
    await descargarBlob(blob, `Panafargo_Rappi/Asociacion/asociacion_${Date.now()}.xlsx`);
    const faltantes = noEncontrados.length ? ` Sin fila en la plantilla: ${noEncontrados.join(", ")}.` : "";
    mensaje("mensaje-plantilla-asociacion-generada", `Descarga iniciada: ${filasEscritas} de ${lista.length} publicaciones incluidas.${faltantes} Revisa el archivo y confirma la asociación en Mi Tienda.`, noEncontrados.length ? "warning" : "ok");
  });
}

function esPantallaCreacion(url) {
  try {
    const actual = new URL(url);
    return actual.origin === "https://mitienda.rappi.com.co" && actual.pathname === "/cms/catalog/bulk-creation/manual/1";
  } catch { return false; }
}

function navegarYEsperarCarga(tabId) {
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
    chrome.tabs.update(tabId, { url: URL_CREACION, active: true }).catch((error) => terminar(error));
  });
}

async function descargarBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    const alCambiar = (cambio) => {
      if (cambio.id === id && cambio.state && cambio.state.current !== "in_progress") {
        URL.revokeObjectURL(url);
        chrome.downloads.onChanged.removeListener(alCambiar);
      }
    };
    if (chrome.downloads.onChanged?.addListener) chrome.downloads.onChanged.addListener(alCambiar);
    else setTimeout(() => URL.revokeObjectURL(url), 10000);
    return id;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
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
