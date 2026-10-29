// ============================================================
// utils/model.js
// ============================================================
// Modelo interno PanafargoProduct. Deliberadamente independiente
// de Rappi para que el núcleo permanezca estable cuando se agreguen
// otros conectores (ver ficha técnica, sección 7).
//
// V2 agrega los campos mínimos que el conector Rappi necesita para
// transformar el producto (marca, categoría, descripción, peso).
// El inventario pertenece a cada SKU completo de Shopify. Los diseños
// con / tienen conteo manual registrado allí; no heredan stock de su base.
// ============================================================

import { normalizarSkuCompleto, obtenerSkuBase, obtenerDisenoSku, esSkuPublicacion } from "./sku.js";

export const ESTADOS = Object.freeze({
  ENCONTRADO: "ENCONTRADO", // Producto localizado en Shopify
  VALIDADO: "VALIDADO",     // Cumple las validaciones de V1.0
  BLOQUEADO: "BLOQUEADO",   // No puede continuar por información obligatoria faltante
  LISTO: "LISTO",           // Preparado para el siguiente proceso
  ERROR: "ERROR",           // Se produjo un fallo técnico o de procesamiento
});

/**
 * Convierte la respuesta cruda de Shopify (GraphQL) al modelo interno
 * PanafargoProduct: incluye identidad de variante/producto, inventario,
 * precio, EAN y opciones de variante, además de los campos de Rappi.
 */
export function desdeShopify(rawVariant) {
  const product = rawVariant.product;
  const sku = normalizarSkuCompleto(rawVariant.sku);
  const imagenes = [...new Set([
    rawVariant.image?.url,
    product.featuredImage?.url,
    ...(product.images?.edges || []).map((e) => e.node.url),
  ].filter(Boolean))];
  const imagenPrincipal = imagenes[0] || null;

  return {
    shopify_variant_id: rawVariant.id || null,
    shopify_product_id: product.id || null,
    nombre: product.title,
    sku,
    sku_base: obtenerSkuBase(sku),
    diseno_sku: obtenerDisenoSku(sku),
    nombre_variante: rawVariant.title || null,
    ean: rawVariant.barcode || null,
    precio: numeroNumero(rawVariant.price),
    precio_comparacion: numeroNumero(rawVariant.compareAtPrice),
    precio_rappi: calcularPrecioRappi(rawVariant.price, rawVariant.compareAtPrice),
    inventario: numeroEntero(rawVariant.inventoryQuantity),
    inventario_origen: esSkuPublicacion(sku) ? "conteo_manual_shopify" : "shopify",
    disponible_para_venta: rawVariant.availableForSale === true,
    inventario_controlado: rawVariant.inventoryItem?.tracked === true,
    opciones_variante: rawVariant.selectedOptions || [],
    imagenes,
    imagen_principal: imagenPrincipal,
    // Solo una galería cuya última página fue confirmada permite preparar
    // todas las secundarias. Los datos antiguos sin pageInfo se actualizan
    // consultando Shopify otra vez; dos URL guardadas no prueban integridad.
    imagenes_completas: product.images?.pageInfo?.hasNextPage === false,
    estado: ESTADOS.ENCONTRADO,
    destinos: ["rappi"],

    // ---- Campos V2 (Rappi), siempre desde Shopify ----
    marca: normalizarTextoShopify(product.vendor),
    categoria: normalizarTextoShopify(product.category?.fullName || product.productType),
    descripcion: limpiarHtml(product.descriptionHtml) || null,
    handle_shopify: product.handle || null,
    url_shopify: product.onlineStoreUrl || null,
    etiquetas_shopify: product.tags || [],
    peso: rawVariant.inventoryItem?.measurement?.weight?.value ?? null,
    unidad_peso_shopify: rawVariant.inventoryItem?.measurement?.weight?.unit ?? null,
    presentacion: construirPresentacion(rawVariant.inventoryItem?.measurement?.weight),
  };
}

function numeroNumero(valor) {
  if (valor == null || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function normalizarTextoShopify(valor) {
  const texto = typeof valor === "string" ? valor.trim() : "";
  return texto || null;
}

/**
 * Usa el precio normal de Shopify. Hasta $444.500 inclusive resta 20 %;
 * por encima resta 10 %. Divide entre 0,70 y redondea solo el resultado
 * final hacia arriba a centenas, conservando los múltiplos exactos.
 */
export function calcularPrecioRappi(precio, precioComparacion) {
  const precioActual = numeroNumero(precio);
  const precioAnterior = numeroNumero(precioComparacion);
  const precioBase =
    precioAnterior != null && (precioActual == null || precioAnterior > precioActual)
      ? precioAnterior
      : precioActual;

  if (precioBase == null || !Number.isSafeInteger(precioBase) || precioBase < 0) {
    return null;
  }

  const base = BigInt(precioBase);
  // P × 0,80 / 0,70 = P × 8/7; en el tramo superior es P × 9/7.
  // Dividir además entre 100 permite redondear directamente a centenas.
  const numerador = precioBase > 444500 ? 9n : 8n;
  const denominador = 700n;
  const centenas = (base * numerador + denominador - 1n) / denominador;
  const precioRappi = centenas * 100n;

  if (precioRappi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("El precio calculado para Rappi excede el rango entero seguro.");
  }

  return Number(precioRappi);
}

function numeroEntero(valor) {
  const numero = numeroNumero(valor);
  return numero == null ? null : Math.floor(numero);
}

function construirPresentacion(peso) {
  if (peso?.value == null || !peso.unit) return null;
  const unidades = { GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb" };
  const unidad = unidades[peso.unit] || String(peso.unit).toLowerCase();
  return `${peso.value}${unidad}`;
}

/**
 * Quita etiquetas HTML básicas del campo descriptionHtml de Shopify,
 * dejando texto plano legible para la Descripción de Rappi.
 */
function limpiarHtml(html) {
  if (!html) return null;
  return html
    .replace(/<\/(p|li|br|div)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
