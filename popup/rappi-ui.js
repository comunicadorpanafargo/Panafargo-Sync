// ============================================================
// popup/rappi-ui.js
// ============================================================
// Interfaz de la pestaña "Preparar Rappi (V2 / V4)". Orquesta
// rappi/rappi-connector.js, rappi/rappi-batch.js, rappi/rappi-catalog.js,
// rappi/rappi-images-zip.js, images/image-handler.js y storage/storage.js.
// No contiene reglas de negocio propias.
//
// El SKU se usa tres veces en este flujo:
//   1. Para buscar el producto en Shopify (V1.0).
//   2. Para nombrar la imagen de cada producto dentro del .zip que
//      exige el paso de carga múltiple de imágenes de Mi Tienda.
//   3. Como columna SKU en la fila del producto dentro de la
//      plantilla .xlsx (V2), la misma que ve Rappi al revisar el lote.
//
// V4 agrega "Subir directamente a Rappi (Mi Tienda)": envía la
// plantilla y el .zip de imágenes a un content script que los coloca
// en el formulario real de Mi Tienda, usando la sesión ya iniciada
// por el empleado en esa pestaña — la extensión nunca ve ni guarda
// su usuario/contraseña de Rappi. La extensión deja lista la plantilla
// de asociación, pero la confirmación final siempre la hace el usuario.
// ============================================================

import { ESTADOS } from "../utils/model.js";
import { prepararParaRappi } from "../rappi/rappi-connector.js";
import { generarXlsxLoteRappi, descargarLoteRappi, blobABase64 } from "../rappi/rappi-batch.js";
import { construirZipImagenes } from "../rappi/rappi-images-zip.js";
import { generarPlantillaAsociacion } from "../rappi/rappi-association.js";
import { CATEGORIAS_RAPPI } from "../rappi/rappi-catalog.js";
import { descargarImagenPrincipal } from "../images/image-handler.js";
import {
  obtenerProductos,
  eliminarProducto,
  guardarEquivalenciaCategoria,
} from "../storage/storage.js";
import { logger } from "../utils/logger.js";

// fila = { producto, resultado } donde resultado es lo que devuelve prepararParaRappi
let filas = [];

const PATRON_MI_TIENDA = "https://mitienda.rappi.com.co/*";
const URL_CREACION_PERSONALIZADA = "https://mitienda.rappi.com.co/cms/catalog/bulk-creation/manual/1";

/**
 * Guarda la plantilla de asociación (la que Rappi manda por correo)
 * en chrome.storage.local, como base64. El content script la lee de
 * ahí primero, y si no hay nada guardado usa la que trae la extensión
 * por defecto (rappi/ProductosAsociacion-es.xlsx).
 */
async function guardarPlantillaAsociacion() {
  const input = document.getElementById("input-plantilla-asociacion");
  const mensaje = document.getElementById("mensaje-plantilla-asociacion");
  const archivo = input.files[0];
  if (!archivo) return;

  try {
    const base64 = await blobABase64(archivo);
    await chrome.storage.local.set({
      plantillaAsociacionBase64: base64,
      plantillaAsociacionNombre: archivo.name,
      plantillaAsociacionFecha: Date.now(),
    });
    mensaje.style.color = "#1e7a34";
    mensaje.textContent = `Guardada: ${archivo.name}. Se usará al preparar la próxima asociación.`;
  } catch (err) {
    logger.error(err);
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = "No se pudo guardar la plantilla: " + (err.message || err);
  }
}

/**
 * Carga el archivo elegido en Mi Tienda y deja la confirmación final
 * de asociación para que la ejecute el usuario.
 */
async function subirPlantillaAsociacionAhora() {
  const input = document.getElementById("input-plantilla-asociacion");
  const mensaje = document.getElementById("mensaje-plantilla-asociacion-ahora");
  const archivo = input.files[0];
  if (!archivo) {
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = 'No hay ningún archivo seleccionado arriba — elige el .xlsx primero con "Seleccionar archivo".';
    return;
  }

  const btn = document.getElementById("btn-subir-plantilla-asociacion-ahora");
  btn.disabled = true;
  mensaje.style.color = "#222";
  mensaje.textContent = "Buscando la pestaña de Mi Tienda...";

  try {
    const [tab] = await chrome.tabs.query({ url: PATRON_MI_TIENDA });
    if (!tab) {
      throw new Error('No encontré una pestaña de Mi Tienda abierta. Ábrela primero en la pantalla "Subir plantilla".');
    }

    const archivoBase64 = await blobABase64(archivo);
    mensaje.textContent = "Cargando la plantilla en Mi Tienda...";
    const respuesta = await chrome.tabs.sendMessage(tab.id, {
      tipo: "RAPPI_SUBIR_PLANTILLA_ASOCIACION_AHORA",
      archivoBase64,
      archivoNombre: archivo.name,
    });

    if (!respuesta?.ok) {
      throw new Error(respuesta?.error || "No se pudo completar la subida.");
    }
    mensaje.style.color = "#1e7a34";
    mensaje.textContent = respuesta.mensaje || "Plantilla lista. Revisa y confirma la asociación en Mi Tienda.";
  } catch (err) {
    logger.error(err);
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = err.message || "Error subiendo la plantilla de asociación.";
  } finally {
    btn.disabled = input.files.length === 0;
  }
}

/**
 * Genera (con la MISMA lógica que usa el flujo automático) el .xlsx
 * de asociación para los productos marcados "Incluir", y lo descarga
 * a disco — para subirlo a mano a Rappi y ver si el problema está en
 * el archivo que armamos o en cómo Rappi lo procesa después.
 */
async function descargarPlantillaAsociacionGenerada() {
  const listos = obtenerFilasSeleccionadas();
  if (listos.length === 0) return;

  const mensaje = document.getElementById("mensaje-plantilla-asociacion-generada");
  const btn = document.getElementById("btn-descargar-plantilla-asociacion-generada");
  btn.disabled = true;
  mensaje.style.color = "#222";
  mensaje.textContent = "Generando plantilla de asociación...";

  try {
    const productos = listos.map((f) => ({
      sku: f.producto.sku,
      precio: f.resultado.rappiProduct.precio,
      inventario: f.producto.inventario,
    }));
    const { blob, filasEscritas, noEncontrados } = await generarPlantillaAsociacion(productos);

    const url = URL.createObjectURL(blob);
    const nombreArchivo = `Panafargo_Rappi/Asociacion/asociacion_${Date.now()}.xlsx`;
    await chrome.downloads.download({ url, filename: nombreArchivo, saveAs: false });

    let texto = `.xlsx descargado en ${nombreArchivo} — ${filasEscritas} fila(s) con datos.`;
    if (noEncontrados.length > 0) {
      texto += ` SKU sin fila en la plantilla (se omitieron): ${noEncontrados.join(", ")}.`;
    }
    mensaje.style.color = filasEscritas > 0 ? "#1e7a34" : "#b02a2a";
    mensaje.textContent = texto;
  } catch (err) {
    logger.error(err);
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = err.message || "Error generando la plantilla de asociación.";
  } finally {
    actualizarBotones();
  }
}

export function initRappiTab() {
  document.getElementById("btn-cargar-rappi").addEventListener("click", cargarProductosValidados);
  document.getElementById("seleccionar-todos-rappi").addEventListener("change", (evento) => {
    filas.forEach((fila) => {
      if (fila.resultado.ok) fila.seleccionada = evento.target.checked;
    });
    pintarTabla();
  });
  document.getElementById("btn-generar-lote-rappi").addEventListener("click", generarYDescargarLocal);
  document.getElementById("btn-subir-mi-tienda").addEventListener("click", subirDirectamenteARappi);
  document.getElementById("input-plantilla-asociacion").addEventListener("change", () => {
    const hayArchivo = document.getElementById("input-plantilla-asociacion").files.length > 0;
    document.getElementById("btn-guardar-plantilla-asociacion").disabled = !hayArchivo;
    document.getElementById("btn-subir-plantilla-asociacion-ahora").disabled = !hayArchivo;
  });
  document.getElementById("btn-guardar-plantilla-asociacion").addEventListener("click", guardarPlantillaAsociacion);
  document
    .getElementById("btn-subir-plantilla-asociacion-ahora")
    .addEventListener("click", subirPlantillaAsociacionAhora);
  document
    .getElementById("btn-descargar-plantilla-asociacion-generada")
    .addEventListener("click", descargarPlantillaAsociacionGenerada);
}

async function cargarProductosValidados() {
  const mensaje = document.getElementById("mensaje-rappi");
  const boton = document.getElementById("btn-cargar-rappi");
  boton.disabled = true;
  mensaje.style.color = "#222";
  mensaje.textContent = "Buscando productos validados...";

  try {
    const todos = await obtenerProductos();
    const candidatos = Object.values(todos).filter(
      (producto) =>
        producto?.sku &&
        (producto.estado === ESTADOS.VALIDADO || producto.estado === ESTADOS.LISTO)
    );
    const filasPorSku = new Map(filas.map((fila) => [fila.producto.sku, fila]));
    let agregados = 0;

    for (const producto of candidatos) {
      const filaExistente = filasPorSku.get(producto.sku);
      let resultado;
      try {
        resultado = await prepararParaRappi(producto);
      } catch (err) {
        logger.error(`No se pudo preparar el SKU ${producto.sku} para Rappi:`, err);
        resultado = {
          ok: false,
          sku: producto.sku,
          faltantes: [{ campo: "preparacion", motivo: err.message || "Error preparando el producto." }],
        };
      }

      if (filaExistente) {
        filaExistente.producto = producto;
        filaExistente.resultado = resultado;
        if (!resultado.ok) filaExistente.seleccionada = false;
      } else {
        const fila = { producto, resultado, seleccionada: false };
        filas.push(fila);
        filasPorSku.set(producto.sku, fila);
        agregados++;
      }
    }

    if (filas.length > 0) pintarTabla();
    if (candidatos.length === 0) {
      mensaje.style.color = "#b02a2a";
      mensaje.textContent = "No hay productos validados. Procésalos primero en la pestaña anterior.";
    } else if (agregados > 0) {
      mensaje.style.color = "#1e7a34";
      mensaje.textContent = `${agregados} producto(s) nuevo(s) agregado(s); ${filas.length} en la lista.`;
    } else {
      mensaje.style.color = "#1e7a34";
      mensaje.textContent = `No hay productos nuevos; ${filas.length} producto(s) en la lista.`;
    }
  } catch (err) {
    logger.error("No se pudieron cargar los productos validados para Rappi.", err);
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = err.message || "No se pudieron leer los productos validados.";
  } finally {
    boton.disabled = false;
  }
}

function pintarTabla() {
  const tabla = document.getElementById("tabla-rappi");
  const cuerpo = document.getElementById("tabla-rappi-body");
  cuerpo.innerHTML = "";
  tabla.classList.remove("oculto");

  filas.forEach((fila, idx) => {
    const tr = document.createElement("tr");

    const tdSeleccion = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = fila.seleccionada;
    checkbox.disabled = !fila.resultado.ok;
    checkbox.title = "Incluir este producto en el lote";
    checkbox.addEventListener("change", () => {
      fila.seleccionada = checkbox.checked;
      actualizarBotones();
    });
    tdSeleccion.appendChild(checkbox);
    tr.appendChild(tdSeleccion);

    const tdSku = document.createElement("td");
    tdSku.textContent = fila.producto.sku;
    tr.appendChild(tdSku);

    const tdNombre = document.createElement("td");
    tdNombre.textContent = fila.producto.nombre || "(sin nombre)";
    tr.appendChild(tdNombre);

    const tdEstado = document.createElement("td");
    const tdAccion = document.createElement("td");

    if (fila.resultado.ok) {
      tdEstado.innerHTML = `<span class="estado LISTO">LISTO PARA LOTE</span>`;
      const ajustesAutomaticos = [];
      if (fila.resultado.categoriaPapeleriaPorDefecto) ajustesAutomaticos.push("Papelería auto.");
      else if (fila.resultado.categoriaAutoAsignada) ajustesAutomaticos.push("Categoría auto.");
      tdAccion.textContent = ajustesAutomaticos.join(" · ") || "—";
    } else {
      const motivos = fila.resultado.faltantes.map((f) => f.motivo).join(" ");
      tdEstado.innerHTML = `<span class="estado BLOQUEADO">FALTA INFO</span><p class="ayuda">${motivos}</p>`;

      const equivalenciasFaltantes = fila.resultado.faltantes.filter((f) => f.requiereEquivalencia);
      if (equivalenciasFaltantes.length > 0) {
        equivalenciasFaltantes.forEach((f) => {
          tdAccion.appendChild(crearControlEquivalencia(f, idx));
        });
      } else {
        tdAccion.textContent = "Revisar en Shopify";
      }
    }

    tr.appendChild(tdEstado);
    tr.appendChild(tdAccion);

    const tdQuitar = document.createElement("td");
    const btnQuitar = document.createElement("button");
    btnQuitar.type = "button";
    btnQuitar.className = "btn-quitar-producto";
    btnQuitar.textContent = "×";
    btnQuitar.title = `Quitar ${fila.producto.sku} de la lista`;
    btnQuitar.setAttribute("aria-label", `Quitar producto ${fila.producto.sku}`);
    btnQuitar.addEventListener("click", async () => {
      btnQuitar.disabled = true;
      try {
        await eliminarProducto(fila.producto.sku);
        filas.splice(idx, 1);
        pintarTabla();
      } catch (err) {
        logger.error(err);
        document.getElementById("mensaje-rappi").textContent =
          err.message || `No se pudo quitar el SKU ${fila.producto.sku}.`;
        btnQuitar.disabled = false;
      }
    });
    tdQuitar.appendChild(btnQuitar);
    tr.appendChild(tdQuitar);
    cuerpo.appendChild(tr);
  });

  actualizarBotones();
}

function crearControlEquivalencia(faltante, idx) {
  const wrapper = document.createElement("div");
  wrapper.className = "equivalencia";

  const catalogo = CATEGORIAS_RAPPI;
  const datalistId = `datalist-${faltante.requiereEquivalencia}-${idx}`;

  const label = document.createElement("label");
  label.textContent = `Categoría Rappi para "${faltante.valorOrigen}":`;
  wrapper.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("list", datalistId);
  input.placeholder = "Escribe para buscar...";

  const datalist = document.createElement("datalist");
  datalist.id = datalistId;

  input.addEventListener("input", () => {
    const texto = input.value.trim().toLowerCase();
    datalist.innerHTML = "";
    if (texto.length < 2) return;
    const coincidencias = catalogo.filter((c) => c.toLowerCase().includes(texto)).slice(0, 50);
    coincidencias.forEach((c) => {
      const option = document.createElement("option");
      option.value = c;
      datalist.appendChild(option);
    });
  });

  const btnGuardar = document.createElement("button");
  btnGuardar.textContent = "Guardar equivalencia";
  btnGuardar.addEventListener("click", async () => {
    const valorElegido = input.value.trim();
    if (!catalogo.includes(valorElegido)) {
      alert("Elige un valor exacto de la lista (no se aceptan valores libres — debe existir en el catálogo real de Rappi).");
      return;
    }
    await guardarEquivalenciaCategoria(faltante.valorOrigen, valorElegido);
    // Vuelve a evaluar todas las filas: la misma equivalencia puede
    // desbloquear varios productos que comparten esa categoría.
    for (const fila of filas) {
      fila.resultado = await prepararParaRappi(fila.producto);
    }
    pintarTabla();
  });

  wrapper.appendChild(input);
  wrapper.appendChild(datalist);
  wrapper.appendChild(btnGuardar);
  return wrapper;
}

function actualizarBotones() {
  const seleccionables = filas.filter((fila) => fila.resultado.ok);
  const seleccionados = seleccionables.filter((fila) => fila.seleccionada).length;
  const seleccionarTodos = document.getElementById("seleccionar-todos-rappi");
  seleccionarTodos.checked = seleccionables.length > 0 && seleccionados === seleccionables.length;
  seleccionarTodos.indeterminate = seleccionados > 0 && seleccionados < seleccionables.length;
  seleccionarTodos.disabled = seleccionables.length === 0;

  const listos = filas.filter((f) => f.seleccionada && f.resultado.ok).length;

  const btnLocal = document.getElementById("btn-generar-lote-rappi");
  btnLocal.disabled = listos === 0;
  btnLocal.textContent = `Descargar lote (.xlsx) — ${listos}`;

  document.getElementById("btn-descargar-plantilla-asociacion-generada").disabled = listos === 0;

  const btnSubir = document.getElementById("btn-subir-mi-tienda");
  btnSubir.disabled = listos === 0;
  btnSubir.textContent = `Preparar en Mi Tienda — ${listos}`;
}

function obtenerFilasSeleccionadas() {
  return filas.filter((f) => f.seleccionada && f.resultado.ok);
}

/**
 * Genera el .xlsx y descarga localmente el lote + las imágenes,
 * como respaldo (Panafargo_Rappi/Lotes y Panafargo_Rappi/Imagenes).
 * No toca la pestaña de Mi Tienda.
 */
async function generarYDescargarLocal() {
  const listos = obtenerFilasSeleccionadas();
  if (listos.length === 0) return;

  const mensaje = document.getElementById("mensaje-rappi");
  const btn = document.getElementById("btn-generar-lote-rappi");
  btn.disabled = true;
  mensaje.style.color = "#222";
  mensaje.textContent = "Generando lote y descargando imágenes...";

  try {
    const blob = await generarXlsxLoteRappi(listos.map((f) => f.resultado.rappiProduct));
    const loteId = await descargarLoteRappi(blob);

    let imagenesDescargadas = 0;
    for (const fila of listos) {
      try {
        await descargarImagenPrincipal(fila.producto);
        imagenesDescargadas++;
      } catch (err) {
        logger.error(`No se pudo descargar la imagen de SKU ${fila.producto.sku}:`, err);
      }
    }

    mensaje.style.color = "#1e7a34";
    mensaje.textContent = `Lote descargado: ${loteId} (${listos.length} producto(s), ${imagenesDescargadas} imagen(es) en Panafargo_Rappi/Imagenes/). Los productos siguen disponibles para subirlos a Rappi.`;
  } catch (err) {
    logger.error(err);
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = err.message || "Error generando el lote.";
  } finally {
    actualizarBotones();
  }
}

/**
 * V4 — Arma la plantilla .xlsx y el .zip de imágenes, y se los envía
 * al content script de la pestaña de Mi Tienda ya abierta para que
 * los coloque en el formulario real. Requiere que el empleado ya
 * tenga esa pestaña abierta y logueada (Mi Tienda → Productos →
 * creación por lotes → Personalizado).
 */
async function subirDirectamenteARappi() {
  const listos = obtenerFilasSeleccionadas();
  if (listos.length === 0) return;

  const mensaje = document.getElementById("mensaje-rappi");
  const btn = document.getElementById("btn-subir-mi-tienda");
  btn.disabled = true;

  try {
    const tab = await encontrarPestanaMiTienda();
    if (!tab) {
      mensaje.style.color = "#b02a2a";
      mensaje.textContent =
        "No encontré una pestaña de Mi Tienda abierta. Abre https://mitienda.rappi.com.co, inicia sesión, y vuelve a intentar (la extensión te lleva a la pantalla correcta automáticamente).";
      return;
    }

    mensaje.style.color = "#222";
    mensaje.textContent = "Generando plantilla y empaquetando imágenes...";
    const loteId = `lote_rappi_${Date.now()}`;
    const blobXlsx = await generarXlsxLoteRappi(listos.map((f) => f.resultado.rappiProduct));
    const blobZip = await construirZipImagenes(listos);

    mensaje.textContent = "Enviando a la pestaña de Mi Tienda...";
    let respuesta;
    try {
      respuesta = await chrome.tabs.sendMessage(tab.id, {
        tipo: "RAPPI_SUBIR_LOTE",
        xlsxBase64: await blobABase64(blobXlsx),
        xlsxNombre: `${loteId}.xlsx`,
        imagenesZipBase64: await blobABase64(blobZip),
        imagenesZipNombre: `${loteId}_imagenes.zip`,
      });
    } catch (errEnvio) {
      if (/Receiving end does not exist|Could not establish connection/i.test(errEnvio.message || "")) {
        throw new Error(
          'La extensión no está activa en esa pestaña todavía (pasa cuando la pestaña ya estaba abierta antes de instalar/recargar la extensión). Recarga la pestaña de Mi Tienda (F5) y vuelve a intentar — no hace falta hacer nada más.'
        );
      }
      throw errEnvio;
    }

    if (!respuesta) {
      throw new Error(
        "No hubo respuesta del content script. Recarga la pestaña de Mi Tienda (para que cargue la extensión) e intenta de nuevo."
      );
    }
    if (!respuesta.ok) {
      throw new Error(respuesta.error || "La automatización falló en Mi Tienda.");
    }

    mensaje.style.color =
      respuesta.paso === "imagenes_error_rappi"
        ? "#b02a2a"
        : respuesta.paso === "imagenes_sin_terminar"
          ? "#b06a00"
          : "#1e7a34";
    mensaje.textContent = respuesta.mensaje || respuesta.paso;
  } catch (err) {
    logger.error(err);
    mensaje.style.color = "#b02a2a";
    mensaje.textContent = err.message || "Error subiendo el lote a Mi Tienda.";
  } finally {
    actualizarBotones();
  }
}

async function encontrarPestanaMiTienda() {
  const tabs = await chrome.tabs.query({ url: PATRON_MI_TIENDA });
  return tabs[0] || null;
}

/**
 * Navega la pestaña a `url` y espera a que termine de cargar (evento
 * "complete") antes de continuar — necesario porque cambiar la URL
 * dispara una recarga real de la SPA, y el content script solo queda
 * listo para recibir mensajes después de esa recarga.
 */
function navegarYEsperarCarga(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("La pestaña de Mi Tienda tardó demasiado en cargar la pantalla de creación por lotes."));
    }, timeoutMs);

    function listener(tabId_, changeInfo) {
      if (tabId_ === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Pequeño margen extra para que Angular termine de montar la vista.
        setTimeout(resolve, 800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

/**
 * Igual que navegarYEsperarCarga, pero para cuando la pestaña ya está
 * en la URL objetivo y por eso no sirve un chrome.tabs.update — hay
 * que forzar un reload real para que la SPA reinicie su estado
 * interno (paso actual del flujo, datos cargados en memoria, etc.).
 */
function recargarYEsperarCarga(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("La pestaña de Mi Tienda tardó demasiado en recargar."));
    }, timeoutMs);

    function listener(tabId_, changeInfo) {
      if (tabId_ === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId, { bypassCache: true });
  });
}
