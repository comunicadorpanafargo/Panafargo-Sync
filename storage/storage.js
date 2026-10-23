// ============================================================
// storage/storage.js
// ============================================================
// Almacenamiento local necesario para el funcionamiento de la
// extensión. Productos y matriz son temporales y se limpian al cerrar
// la ventana; las equivalencias se conservan para reutilizarlas. V2 agrega:
//   - Equivalencias reutilizables Categoría/Marca Shopify → Rappi
//     (ficha técnica, secciones 20 y 21: "una vez configurada, debe
//     poder reutilizarse").
//   - Trazabilidad SKU ↔ producto ↔ imagen ↔ lote (sección 25).
// El historial completo detallado (V3.2) llega después.
// ============================================================

const KEY_PRODUCTOS = "panafargo_productos";
const KEY_MATRIZ_V11 = "panafargo_matriz_v11";
const KEY_EQUIV_CATEGORIA = "panafargo_equiv_categoria";
const KEY_EQUIV_MARCA = "panafargo_equiv_marca";

export async function guardarProducto(producto) {
  const { [KEY_PRODUCTOS]: productos = {} } = await chrome.storage.local.get(KEY_PRODUCTOS);
  productos[producto.sku] = { ...productos[producto.sku], ...producto, actualizado: new Date().toISOString() };
  await chrome.storage.local.set({ [KEY_PRODUCTOS]: productos });
}

export async function obtenerProductos() {
  const { [KEY_PRODUCTOS]: productos = {} } = await chrome.storage.local.get(KEY_PRODUCTOS);
  return productos;
}

export async function eliminarProducto(sku) {
  const { [KEY_PRODUCTOS]: productos = {} } = await chrome.storage.local.get(KEY_PRODUCTOS);
  delete productos[sku];
  await chrome.storage.local.set({ [KEY_PRODUCTOS]: productos });
}

export async function limpiarProductosProcesados() {
  await chrome.storage.local.remove([KEY_PRODUCTOS, KEY_MATRIZ_V11]);
}

export async function guardarMatrizV11(fila) {
  const { [KEY_MATRIZ_V11]: matriz = [] } = await chrome.storage.local.get(KEY_MATRIZ_V11);
  const idx = matriz.findIndex((f) => f.sku === fila.sku);
  if (idx >= 0) {
    matriz[idx] = fila;
  } else {
    matriz.push(fila);
  }
  await chrome.storage.local.set({ [KEY_MATRIZ_V11]: matriz });
  return matriz;
}

export async function obtenerMatrizV11() {
  const { [KEY_MATRIZ_V11]: matriz = [] } = await chrome.storage.local.get(KEY_MATRIZ_V11);
  return matriz;
}

export async function limpiarMatrizV11() {
  await chrome.storage.local.set({ [KEY_MATRIZ_V11]: [] });
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

export async function obtenerTodasEquivalenciasCategoria() {
  const { [KEY_EQUIV_CATEGORIA]: mapa = {} } = await chrome.storage.local.get(KEY_EQUIV_CATEGORIA);
  return mapa;
}

/**
 * Devuelve la marca de Rappi equivalente a una marca (vendor) de Shopify
 * cuando no hay coincidencia exacta con el catálogo real de Rappi.
 */
export async function obtenerEquivalenciaMarca(marcaShopify) {
  const { [KEY_EQUIV_MARCA]: mapa = {} } = await chrome.storage.local.get(KEY_EQUIV_MARCA);
  return mapa[claveEquivalencia(marcaShopify)] || null;
}

export async function guardarEquivalenciaMarca(marcaShopify, marcaRappi) {
  const { [KEY_EQUIV_MARCA]: mapa = {} } = await chrome.storage.local.get(KEY_EQUIV_MARCA);
  mapa[claveEquivalencia(marcaShopify)] = marcaRappi;
  await chrome.storage.local.set({ [KEY_EQUIV_MARCA]: mapa });
}

export async function obtenerTodasEquivalenciasMarca() {
  const { [KEY_EQUIV_MARCA]: mapa = {} } = await chrome.storage.local.get(KEY_EQUIV_MARCA);
  return mapa;
}

function claveEquivalencia(valor) {
  return (valor || "").trim().toLowerCase();
}

// ---------------- V2 — Trazabilidad SKU ↔ producto ↔ imagen ↔ lote ----------------

/**
 * Marca un producto ya guardado como incluido en un lote Rappi generado,
 * conservando su relación con la imagen descargada (ficha técnica, sección 25).
 */
export async function registrarEnLote(sku, loteId) {
  const { [KEY_PRODUCTOS]: productos = {} } = await chrome.storage.local.get(KEY_PRODUCTOS);
  if (!productos[sku]) return;
  productos[sku].rappi = {
    ...(productos[sku].rappi || {}),
    ultimoLoteId: loteId,
    preparadoEn: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [KEY_PRODUCTOS]: productos });
}
