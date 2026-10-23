// ============================================================
// popup/popup.js
// ============================================================
// Interfaz para el empleado. Orquesta los módulos de shopify/,
// utils/, images/, storage/ y rappi/. No contiene lógica de negocio
// propia: solo llama a los módulos correspondientes y pinta el
// resultado.
// ============================================================

import { buscarProductoPorSku } from "../shopify/shopify-api.js";
import { desdeShopify, productoNoEncontrado, ESTADOS } from "../utils/model.js";
import { validarCamposObligatoriosRappi } from "../rappi/rappi-connector.js";
import { validarImagenes, descargarImagenPrincipal } from "../images/image-handler.js";
import {
  guardarProducto,
  guardarMatrizV11,
  limpiarMatrizV11,
  limpiarProductosProcesados,
} from "../storage/storage.js";
import { logger } from "../utils/logger.js";
import { initRappiTab } from "./rappi-ui.js";

await limpiarProductosProcesados();

// ---------------- Pestañas ----------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("activo"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("activo"));
    btn.classList.add("activo");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("activo");
  });
});

// ---------------- V1.0 — Búsqueda individual ----------------
const skuInput = document.getElementById("sku-input");
const btnBuscar = document.getElementById("btn-buscar");
const btnValidar = document.getElementById("btn-validar");
const btnDescargar = document.getElementById("btn-descargar");
const resultadoBox = document.getElementById("resultado");
const mensajeBox = document.getElementById("mensaje");

let productoActual = null;

btnBuscar.addEventListener("click", async () => {
  const sku = skuInput.value.trim();
  mostrarMensaje("");
  if (!sku) return mostrarMensaje("Ingresa un SKU.");

  btnBuscar.disabled = true;
  btnBuscar.textContent = "Buscando...";
  try {
    productoActual = await consultarYNormalizar(sku);
    pintarResultado(productoActual);
    await guardarProducto(productoActual);
  } catch (err) {
    logger.error(err);
    mostrarMensaje(err.message || "Error consultando Shopify.");
    resultadoBox.classList.add("oculto");
  } finally {
    btnBuscar.disabled = false;
    btnBuscar.textContent = "Buscar en Shopify";
  }
});

btnValidar.addEventListener("click", async () => {
  if (!productoActual) return;
  productoActual = validarProductoCompleto(productoActual);
  pintarResultado(productoActual);
  await guardarProducto(productoActual);
  const faltantes = validarCamposObligatoriosRappi(productoActual);
  mostrarMensaje(
    faltantes.length
      ? `Producto bloqueado: ${faltantes.map((faltante) => faltante.motivo).join(" ")}`
      : "Producto validado y listo para Rappi.",
    faltantes.length > 0
  );
});

btnDescargar.addEventListener("click", async () => {
  if (!productoActual) return;
  btnDescargar.disabled = true;
  try {
    await descargarImagenPrincipal(productoActual);
    mostrarMensaje(`Imagen de ${productoActual.sku} descargada.`, false);
  } catch (err) {
    mostrarMensaje(err.message, true);
  } finally {
    btnDescargar.disabled = false;
  }
});

async function consultarYNormalizar(sku) {
  const respuesta = await buscarProductoPorSku(sku);
  if (!respuesta.found) {
    return productoNoEncontrado(sku);
  }
  return desdeShopify(respuesta.raw);
}

function pintarResultado(producto) {
  resultadoBox.classList.remove("oculto");
  document.getElementById("resultado-img").src = producto.imagen_principal || "";
  document.getElementById("resultado-nombre").textContent = producto.nombre || "(sin nombre — SKU no encontrado)";
  document.getElementById("resultado-sku").textContent = producto.sku;

  const estadoEl = document.getElementById("resultado-estado");
  estadoEl.textContent = producto.estado;
  estadoEl.className = `estado ${producto.estado}`;

  btnDescargar.disabled = !producto.imagen_principal;
}

function mostrarMensaje(texto, esError = true) {
  mensajeBox.textContent = texto;
  mensajeBox.style.color = esError ? "#b02a2a" : "#1e7a34";
}

// ---------------- V1.1 — Prueba con 10 productos reales ----------------
const LIMITE_PRUEBA_V11 = 10;

const loteInput = document.getElementById("lote-input");
const btnProcesarLote = document.getElementById("btn-procesar-lote");
const tablaMatriz = document.getElementById("tabla-matriz");
const tablaMatrizBody = document.getElementById("tabla-matriz-body");
const mensajeMatriz = document.getElementById("mensaje-matriz");
const loteConteo = document.getElementById("lote-conteo");

btnProcesarLote.addEventListener("click", procesarYDescargarMatriz);
loteInput.addEventListener("input", limitarLineasSku);
loteInput.addEventListener("keydown", (evento) => {
  if (evento.key !== "Enter") return;

  const valor = loteInput.value;
  const nuevoValor =
    valor.slice(0, loteInput.selectionStart) +
    "\n" +
    valor.slice(loteInput.selectionEnd);
  if (nuevoValor.split("\n").length > LIMITE_PRUEBA_V11) {
    evento.preventDefault();
    mostrarMensajeMatriz(`Máximo ${LIMITE_PRUEBA_V11} líneas de SKU.`);
  }
});
loteInput.addEventListener("paste", (evento) => {
  const pegado = evento.clipboardData?.getData("text");
  if (pegado == null) return;

  evento.preventDefault();
  const textoPegado = pegado.replace(/\r\n?/g, "\n");
  const inicioSeleccion = loteInput.selectionStart;
  const finSeleccion = loteInput.selectionEnd;
  const valor =
    loteInput.value.slice(0, inicioSeleccion) +
    textoPegado +
    loteInput.value.slice(finSeleccion);
  const lineas = valor.split("\n");
  const limitado = lineas.slice(0, LIMITE_PRUEBA_V11).join("\n");
  const posicionCursor = Math.min(
    inicioSeleccion + textoPegado.length,
    limitado.length
  );
  loteInput.value = limitado;
  loteInput.setSelectionRange(posicionCursor, posicionCursor);
  if (lineas.length > LIMITE_PRUEBA_V11) {
    mostrarMensajeMatriz(`Solo se pegaron las primeras ${LIMITE_PRUEBA_V11} líneas.`);
  }
  actualizarConteoSku();
});
actualizarConteoSku();

function limitarLineasSku() {
  const lineas = loteInput.value.split("\n");
  if (lineas.length > LIMITE_PRUEBA_V11) {
    const posicionCursor = loteInput.selectionStart;
    loteInput.value = lineas.slice(0, LIMITE_PRUEBA_V11).join("\n");
    loteInput.setSelectionRange(
      Math.min(posicionCursor, loteInput.value.length),
      Math.min(posicionCursor, loteInput.value.length)
    );
    mostrarMensajeMatriz(`Máximo ${LIMITE_PRUEBA_V11} líneas de SKU.`);
  }
  actualizarConteoSku();
}

function actualizarConteoSku() {
  const skus = new Set(
    loteInput.value
      .split("\n")
      .map((sku) => sku.trim())
      .filter(Boolean)
  );
  loteConteo.textContent = `${skus.size}/${LIMITE_PRUEBA_V11} SKU`;
}

async function procesarYDescargarMatriz() {
  const skus = [...new Set(loteInput.value.split("\n").map((sku) => sku.trim()).filter(Boolean))];
  if (skus.length === 0) return mostrarMensajeMatriz("Ingresa al menos un SKU.");
  if (skus.length > LIMITE_PRUEBA_V11) {
    return mostrarMensajeMatriz(`Máximo ${LIMITE_PRUEBA_V11} SKU por proceso.`);
  }

  mostrarMensajeMatriz("");
  btnProcesarLote.disabled = true;
  btnProcesarLote.textContent = "Procesando...";
  try {
    await limpiarMatrizV11();
    tablaMatrizBody.innerHTML = "";
    tablaMatriz.classList.remove("oculto");

    const matriz = [];
    for (const sku of skus) {
      const fila = await procesarSkuParaMatriz(sku);
      matriz.push(fila);
      await guardarMatrizV11(fila);
      pintarFilaMatriz(fila);
    }

    const validos = matriz.filter(
      (fila) => fila.shopify === "OK" && fila.imagen === "OK" && fila.validacion === "OK"
    );

    const bloqueados = matriz.length - validos.length;
    await descargarMatriz(matriz);
    mostrarMensajeMatriz(
      `Matriz descargada: ${validos.length} válido(s) y ${bloqueados} bloqueado(s). Revise las observaciones antes de preparar Rappi.`,
      bloqueados > 0
    );
  } catch (err) {
    logger.error(err);
    mostrarMensajeMatriz(err.message || "No se pudo procesar o descargar la matriz.");
  } finally {
    btnProcesarLote.disabled = false;
    btnProcesarLote.textContent = "Procesar y descargar matriz (.csv)";
  }
}

async function procesarSkuParaMatriz(sku) {
  try {
    const producto = await consultarYNormalizar(sku);

    if (producto.estado === ESTADOS.ERROR) {
      return { sku, shopify: "ERROR", imagen: "ERROR", validacion: "BLOQUEADO", observaciones: "SKU no encontrado en Shopify (TC-02)" };
    }

    const validado = validarProductoCompleto(producto);
    await guardarProducto(validado);

    const faltantes = validarCamposObligatoriosRappi(validado);
    const observaciones = faltantes.map((faltante) => faltante.motivo);

    return {
      sku,
      shopify: "OK",
      imagen: validado.imagen_principal ? "OK" : "ERROR",
      validacion: validado.estado === ESTADOS.VALIDADO ? "OK" : "BLOQUEADO",
      observaciones: observaciones.join("; "),
    };
  } catch (err) {
    logger.error(err);
    return { sku, shopify: "ERROR", imagen: "ERROR", validacion: "BLOQUEADO", observaciones: err.message || "Error de conexión (TC-05)" };
  }
}

function validarProductoCompleto(producto) {
  const conImagenValidada = validarImagenes(producto);
  const faltantes = validarCamposObligatoriosRappi(conImagenValidada);
  return {
    ...conImagenValidada,
    estado: faltantes.length === 0 ? ESTADOS.VALIDADO : ESTADOS.BLOQUEADO,
  };
}

function pintarFilaMatriz(fila) {
  const tr = document.createElement("tr");
  [fila.sku, fila.shopify, fila.imagen, fila.validacion, fila.observaciones].forEach((valor) => {
    const td = document.createElement("td");
    td.textContent = valor;
    tr.appendChild(td);
  });
  tablaMatrizBody.appendChild(tr);
}

async function descargarMatriz(matriz) {
  const encabezado = "SKU,Shopify,Imagen,Validacion,Observaciones";
  const filas = matriz.map((f) =>
    [f.sku, f.shopify, f.imagen, f.validacion, f.observaciones]
      .map((valor) => `"${String(valor ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );
  const csv = [encabezado, ...filas].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `Panafargo_Rappi/Logs/matriz_validacion_${Date.now()}.csv`,
    saveAs: false,
  });
}

function mostrarMensajeMatriz(texto, esError = true) {
  mensajeMatriz.textContent = texto;
  mensajeMatriz.style.color = esError ? "#b02a2a" : "#1e7a34";
}

// ---------------- V2 — Preparar Rappi ----------------
initRappiTab();
