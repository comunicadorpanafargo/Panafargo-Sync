import { desdeShopify, ESTADOS } from "../utils/model.js";
import { analizarEntradaLote, consultarLote, resumirLote } from "../utils/lote.js";
import { obtenerSkuBase } from "../utils/sku.js";
import { validarImagenes } from "../images/image-handler.js";
import { validarCamposObligatoriosRappi } from "../rappi/rappi-connector.js";
import { calcularUnidadesDisponiblesAsociacion } from "../rappi/rappi-association.js";
import { guardarProductos, obtenerProductos, limpiarProductosProcesados } from "../storage/storage.js";
import { initRappiTab, cargarProductosValidados } from "./rappi-ui.js";

const $ = (id) => document.getElementById(id);
const input = $("lote-input");
let productos = [];
let contexto = { entrada: "", solicitados: [], errores: [] };
let buscando = false;
let preparando = false;
let fuenteShopify;

async function obtenerFuenteShopify() {
  try {
    fuenteShopify ||= import("../shopify/shopify-api.js");
    return await fuenteShopify;
  } catch {
    throw new Error("No se pudo conectar Shopify. Pide al administrador revisar la configuración de la tienda y recarga la extensión. Tu lote guardado se conserva.");
  }
}

function mensaje(texto, tono = "info") {
  $("mensaje-matriz").textContent = texto;
  $("mensaje-matriz").dataset.tone = tono;
}

async function cambiarPaso(nombre) {
  if (buscando || preparando) return;
  document.querySelectorAll(".tab-btn").forEach((boton) => {
    const activo = boton.dataset.tab === nombre;
    boton.classList.toggle("activo", activo);
    if (activo) boton.setAttribute("aria-current", "step");
    else boton.removeAttribute("aria-current");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("activo", panel.id === `tab-${nombre}`));
  if (nombre === "rappi" || nombre === "asociacion") await cargarProductosValidados();
}

document.querySelectorAll(".tab-btn").forEach((boton) => boton.addEventListener("click", () => cambiarPaso(boton.dataset.tab)));
$("btn-continuar-rappi").addEventListener("click", () => cambiarPaso("rappi"));
$("btn-procesar-lote").addEventListener("click", () => procesar(false));
$("btn-reintentar-pendientes").addEventListener("click", () => procesar(true));
$("btn-descargar-matriz").addEventListener("click", descargarReporte);
$("btn-nuevo-lote").addEventListener("click", async () => {
  if (buscando || preparando) return;
  await limpiarProductosProcesados();
  productos = [];
  contexto = { entrada: "", solicitados: [], errores: [] };
  input.value = "";
  mensaje("Lote vacío. Pega los códigos que quieres revisar.");
  actualizarEntrada();
  pintarResultados();
  await cargarProductosValidados();
  await cambiarPaso("lote");
});
input.addEventListener("input", actualizarEntrada);
input.addEventListener("scroll", () => { $("sku-lineas").scrollTop = input.scrollTop; });
window.addEventListener("panafargo:ocupado", ({ detail }) => { preparando = Boolean(detail?.ocupado); actualizarControles(); });

function actualizarEntrada() {
  const analisis = analizarEntradaLote(input.value);
  $("lote-conteo").textContent = `${analisis.bases.length} de 10 productos base · ${analisis.skus.length} códigos ingresados`;
  const lineas = Math.max(7, input.value.split("\n").length);
  $("sku-lineas").replaceChildren(...Array.from({ length: lineas }, (_, i) => {
    const li = document.createElement("li"); li.textContent = i + 1; return li;
  }));
  if (analisis.errores.length) mensaje(analisis.errores.join("\n"), "error");
  else if (!buscando) mensaje("");
  actualizarControles();
}

function actualizarControles() {
  const ocupado = buscando || preparando;
  const resumen = resumirLote(productos, contexto.solicitados);
  $("btn-procesar-lote").disabled = ocupado || !analizarEntradaLote(input.value).valido;
  $("btn-procesar-lote").textContent = buscando ? "Buscando publicaciones…" : "Buscar y validar";
  $("btn-reintentar-pendientes").disabled = ocupado || !(resumen.pendientes || contexto.errores.length);
  $("btn-continuar-rappi").disabled = ocupado || resumen.listos === 0;
  $("btn-continuar-rappi").textContent = resumen.listos ? `Continuar con ${resumen.listos} publicaciones listas` : "Continuar a Rappi";
  $("btn-descargar-matriz").disabled = ocupado || !(productos.length || contexto.errores.length);
  $("btn-nuevo-lote").disabled = ocupado;
  input.disabled = ocupado;
  document.querySelectorAll(".tab-btn").forEach((boton) => { boton.disabled = ocupado; });
}

function validarParaRappi(producto) {
  const conImagen = validarImagenes(producto);
  const faltantes = validarCamposObligatoriosRappi(conImagen);
  return { ...conImagen, estado: faltantes.length ? ESTADOS.BLOQUEADO : ESTADOS.VALIDADO };
}

async function procesar(reintento) {
  if (buscando || preparando) return;
  const analisis = analizarEntradaLote(input.value);
  const solicitados = reintento
    ? [...new Set([...productos.filter((p) => p.estado !== ESTADOS.VALIDADO).map((p) => p.sku), ...contexto.errores.map((e) => e.sku)])]
    : analisis.skus;
  if (!reintento && !analisis.valido) return mensaje(analisis.errores.join("\n") || "Ingresa al menos un código.", "error");
  if (!solicitados.length) return;
  buscando = true;
  actualizarControles();
  try {
    const { buscarProductosPorSku } = await obtenerFuenteShopify();
    const resultado = await consultarLote(solicitados, {
      buscar: buscarProductosPorSku, normalizar: desdeShopify, validar: validarParaRappi,
      alProgreso: ({ completadas, total, publicaciones }) => mensaje(`Consultando ${completadas} de ${total} productos base · ${publicaciones} publicaciones encontradas.`),
    });
    const conservar = reintento ? productos.filter((p) => !solicitados.some((s) => s.includes("/") ? s === p.sku : obtenerSkuBase(s) === obtenerSkuBase(p.sku))) : [];
    const nuevosProductos = [...new Map([...conservar, ...resultado.productos].map((p) => [p.sku, p])).values()];
    const nuevoContexto = { entrada: input.value, solicitados: reintento ? contexto.solicitados : analisis.skus, errores: resultado.errores };
    await guardarProductos(nuevosProductos, { reemplazar: true, contexto: nuevoContexto });
    productos = nuevosProductos;
    contexto = nuevoContexto;
    pintarResultados();
    await cargarProductosValidados();
    const resumen = resumirLote(productos, contexto.solicitados);
    mensaje(`${resumen.bases} productos base · ${resumen.publicaciones} publicaciones. ${resumen.listos} listas y ${resumen.pendientes + contexto.errores.length} pendientes.`, resumen.pendientes || contexto.errores.length ? "warning" : "ok");
  } catch (error) {
    mensaje(error.message || "No se pudo completar la consulta. El lote anterior sigue guardado.", "error");
  } finally {
    buscando = false;
    actualizarControles();
  }
}

function elemento(tag, clase, texto) {
  const e = document.createElement(tag); if (clase) e.className = clase; if (texto != null) e.textContent = texto; return e;
}

function pintarResultados() {
  const resumen = resumirLote(productos, contexto.solicitados);
  for (const campo of ["bases", "publicaciones", "listos", "pendientes"]) $("resumen-" + campo).textContent = campo === "pendientes" ? resumen.pendientes + contexto.errores.length : resumen[campo];
  const cards = productos.map((p) => {
    const card = elemento("article", "product-card"); card.dataset.sku = p.sku;
    if (p.imagen_principal) {
      const img = elemento("img", "product-image"); img.src = p.imagen_principal; img.alt = ""; img.loading = "lazy"; card.append(img);
    } else card.append(elemento("div", "product-image image-placeholder", "Sin imagen"));
    const body = elemento("div", "product-content");
    const top = elemento("div", "product-top");
    top.append(elemento("code", "product-sku", p.sku), elemento("span", "badge badge-base", `Base ${p.sku_base || obtenerSkuBase(p.sku)}`));
    body.append(top, elemento("h3", "", p.nombre || p.sku));
    const listo = p.estado === ESTADOS.VALIDADO;
    body.append(elemento("span", listo ? "badge badge-ready" : "badge badge-pending", listo ? "Lista para Rappi" : "Faltan datos"));
    const meta = elemento("div", "product-meta");
    const origen = p.inventario_origen === "conteo_manual_shopify" ? "Conteo manual en Shopify" : "Existencias Shopify";
    meta.append(elemento("span", "", `${origen}: ${p.inventario ?? "sin dato"}`), elemento("span", "", `Disponible para Rappi: ${p.inventario == null ? "sin dato" : calcularUnidadesDisponiblesAsociacion(p.inventario)}`));
    body.append(meta);
    const faltantes = validarCamposObligatoriosRappi(p);
    if (faltantes.length) {
      const ul = elemento("ul", "product-reasons"); faltantes.forEach((f) => ul.append(elemento("li", "", f.motivo))); body.append(ul);
    }
    if (p.url_shopify && /^https:\/\//i.test(p.url_shopify)) {
      const link = elemento("a", "", "Ver publicación en Shopify"); link.href = p.url_shopify; link.target = "_blank"; link.rel = "noopener noreferrer"; body.append(link);
    }
    card.append(body); return card;
  });
  for (const error of contexto.errores) {
    const card = elemento("article", "product-card");
    const body = elemento("div", "product-content");
    body.append(elemento("code", "product-sku", error.sku), elemento("h3", "", error.tipo === "NO_ENCONTRADO" ? "No se encontró una publicación" : "No se pudo consultar"), elemento("p", "product-reasons", error.mensaje));
    card.append(elemento("div", "product-image image-placeholder", "Revisar"), body); cards.push(card);
  }
  $("lista-productos").replaceChildren(...(cards.length ? cards : [elemento("p", "empty-state", "Pega los códigos y pulsa «Buscar y validar». Verás cada publicación por separado.")]));
  actualizarControles();
}

async function descargarReporte() {
  const filas = [["Producto base", "SKU completo", "Producto", "Origen existencias", "Existencias Shopify", "Disponible Rappi", "Estado", "Observaciones"],
    ...productos.map((p) => [p.sku_base, p.sku, p.nombre, p.inventario_origen, p.inventario, p.inventario == null ? "" : calcularUnidadesDisponiblesAsociacion(p.inventario), p.estado, validarCamposObligatoriosRappi(p).map((f) => f.motivo).join(" ")]),
    ...contexto.errores.map((e) => [e.sku_base, e.sku, "", "", "", "", "PENDIENTE", e.mensaje])];
  const csv = filas.map((fila) => fila.map((v) => {
    const texto = String(v ?? ""); return `"${(/^[=+@-]/.test(texto) ? "'" + texto : texto).replace(/"/g, '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  try { await chrome.downloads.download({ url, filename: `Panafargo_Rappi/Reportes/revision_${Date.now()}.csv`, saveAs: false }); }
  catch (error) { mensaje(error.message || "No se pudo descargar el reporte.", "error"); }
  finally { URL.revokeObjectURL(url); }
}

try {
  const guardado = await chrome.storage.local.get("panafargo_lote_ui");
  contexto = { ...contexto, ...guardado.panafargo_lote_ui };
  productos = Object.values(await obtenerProductos());
  input.value = contexto.entrada || "";
  actualizarEntrada();
  pintarResultados();
  await initRappiTab();
} catch (error) {
  mensaje(error.message || "No se pudo recuperar el lote guardado.", "error");
}
