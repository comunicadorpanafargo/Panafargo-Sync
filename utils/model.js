// ============================================================
// utils/model.js
// ============================================================
// Modelo interno PanafargoProduct. Deliberadamente independiente
// de Rappi para que el núcleo permanezca estable cuando se agreguen
// otros conectores (ver ficha técnica, sección 7).
//
// V2 agrega los campos mínimos que el conector Rappi necesita para
// transformar el producto (marca, categoría, descripción, peso).
// Estos campos SIEMPRE se obtienen de Shopify — el empleado nunca
// los digita a mano (la única entrada manual del flujo es el SKU,
// tanto al buscar el producto como al quedar registrado en el lote
// que se sube a Rappi).
// ============================================================

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
  const imagenes = (product.images?.edges || []).map((e) => e.node.url);
  const imagenPrincipal = product.featuredImage?.url || imagenes[0] || null;

  return {
    shopify_variant_id: rawVariant.id || null,
    shopify_product_id: product.id || null,
    nombre: product.title,
    sku: rawVariant.sku,
    nombre_variante: rawVariant.title || null,
    ean: rawVariant.barcode || null,
    precio: numeroNumero(rawVariant.price),
    precio_comparacion: numeroNumero(rawVariant.compareAtPrice),
    precio_rappi: calcularPrecioRappi(rawVariant.price, rawVariant.compareAtPrice),
    inventario: numeroEntero(rawVariant.inventoryQuantity),
    disponible_para_venta: rawVariant.availableForSale === true,
    inventario_controlado: rawVariant.inventoryItem?.tracked === true,
    opciones_variante: rawVariant.selectedOptions || [],
    imagenes,
    imagen_principal: imagenPrincipal,
    estado: ESTADOS.ENCONTRADO,
    destinos: ["rappi"],

    // ---- Campos V2 (Rappi), siempre desde Shopify ----
    marca: normalizarTextoShopify(product.vendor),
    categoria: normalizarTextoShopify(product.category?.fullName || product.productType),
    descripcion: limpiarHtml(product.descriptionHtml) || null,
    handle_shopify: product.handle || null,
    etiquetas_shopify: product.tags || [],
    peso: rawVariant.inventoryItem?.measurement?.weight?.value ?? null,
    unidad_peso_shopify: rawVariant.inventoryItem?.measurement?.weight?.unit ?? null,
    presentacion: construirPresentacion(rawVariant.inventoryItem?.measurement?.weight),
  };
}

/**
 * Producto vacío/no encontrado, para mantener un shape consistente
 * incluso cuando Shopify no devuelve resultados (TC-02).
 */
export function productoNoEncontrado(sku) {
  return {
    shopify_variant_id: null,
    shopify_product_id: null,
    nombre: null,
    sku,
    nombre_variante: null,
    ean: null,
    precio: null,
    precio_comparacion: null,
    precio_rappi: null,
    inventario: null,
    disponible_para_venta: false,
    inventario_controlado: false,
    opciones_variante: [],
    imagenes: [],
    imagen_principal: null,
    estado: ESTADOS.ERROR,
    destinos: [],
    marca: null,
    categoria: null,
    descripcion: null,
    handle_shopify: null,
    etiquetas_shopify: [],
    peso: null,
    unidad_peso_shopify: null,
    presentacion: null,
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
  // Descontar 20 % hasta $444.500 inclusive o 10 % por encima,
  // dividir entre 0,70 y redondear solo el resultado final a centenas.
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
