// ============================================================
// storage/storage.js
// ============================================================
// Almacenamiento local necesario para el funcionamiento de la
// extensión. Cada producto se identifica por su SKU completo; las
// equivalencias de categoría se conservan para reutilizarlas.
// ============================================================

const KEY_PRODUCTOS = "panafargo_productos";
const KEY_MATRIZ_V11 = "panafargo_matriz_v11";
const KEY_EQUIV_CATEGORIA = "panafargo_equiv_categoria";
const KEY_LOTE_UI = "panafargo_lote_ui";

/** Guarda un lote completo con una sola lectura y una sola escritura. */
export async function guardarProductos(productosArray, { reemplazar = false, contexto } = {}) {
  if (!Array.isArray(productosArray) || productosArray.some(
    (producto) => !producto || typeof producto.sku !== "string" || producto.sku.length === 0
  )) {
    throw new TypeError("Cada producto debe tener un SKU completo válido.");
  }

  const productos = reemplazar ? {} : (await chrome.storage.local.get(KEY_PRODUCTOS))[KEY_PRODUCTOS] || {};
  const porSku = new Map(Object.entries(productos));
  const actualizado = new Date().toISOString();
  for (const producto of productosArray) {
    porSku.set(producto.sku, { ...porSku.get(producto.sku), ...producto, actualizado });
  }
  const guardados = Object.fromEntries(porSku);
  const cambios = { [KEY_PRODUCTOS]: guardados };
  if (contexto !== undefined) cambios[KEY_LOTE_UI] = contexto;
  await chrome.storage.local.set(cambios);
  return guardados;
}

export async function obtenerProductos() {
  const { [KEY_PRODUCTOS]: productos = {} } = await chrome.storage.local.get(KEY_PRODUCTOS);
  return productos;
}

export async function limpiarProductosProcesados() {
  await chrome.storage.local.remove([KEY_PRODUCTOS, KEY_MATRIZ_V11, KEY_LOTE_UI, "panafargo_seleccion_rappi"]);
}

/** Reinicia solo la preparación local de Rappi, conservando los datos fuente. */
export async function limpiarPreparacionRappi() {
  await chrome.storage.local.remove([
    "panafargo_seleccion_rappi",
    "plantillaAsociacionBase64",
    "plantillaAsociacionNombre",
    "plantillaAsociacionFecha",
  ]);
}

// ---------------- V2 — Equivalencias Rappi (reutilizables) ----------------

/**
 * Devuelve la categoría de Rappi equivalente a una categoría de Shopify
 * (product_type), o null si todavía no se ha configurado.
 */
export async function obtenerEquivalenciaCategoria(categoriaShopify) {
  const { [KEY_EQUIV_CATEGORIA]: mapa = {} } = await chrome.storage.local.get(KEY_EQUIV_CATEGORIA);
  return mapa[claveEquivalencia(categoriaShopify)] || null;
}

export async function guardarEquivalenciaCategoria(categoriaShopify, categoriaRappi) {
  const { [KEY_EQUIV_CATEGORIA]: mapa = {} } = await chrome.storage.local.get(KEY_EQUIV_CATEGORIA);
  mapa[claveEquivalencia(categoriaShopify)] = categoriaRappi;
  await chrome.storage.local.set({ [KEY_EQUIV_CATEGORIA]: mapa });
}

function claveEquivalencia(valor) {
  return (valor || "").trim().toLowerCase();
}
