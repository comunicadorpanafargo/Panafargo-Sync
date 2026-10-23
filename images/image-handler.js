// ============================================================
// images/image-handler.js
// ============================================================
// Validación de imágenes obligatorias para Rappi (sección 8) y
// descarga de la imagen como archivo físico cuando se necesite
// (sección 9). La imagen se nombra por SKU — el mismo SKU que
// identifica al producto en el lote generado para Rappi (V2), para
// que al subir imágenes al portal de Rappi queden fácilmente
// asociadas al producto correcto. La gestión avanzada (deduplicación,
// nombres definitivos, organización en carpetas) pertenece a V3.
// ============================================================

import { ESTADOS } from "../utils/model.js";
import { logger } from "../utils/logger.js";

/**
 * Valida que el producto tenga al menos una imagen.
 * Si no la tiene, lo bloquea para Rappi (no continúa silenciosamente).
 * Devuelve el producto con el campo `estado` actualizado.
 */
export function validarImagenes(producto) {
  const tieneImagen = Boolean(producto.imagen_principal) && producto.imagenes.length > 0;

  if (!tieneImagen) {
    logger.warn(`❌ SKU ${producto.sku}: imagen no encontrada. Producto bloqueado para Rappi.`);
    return { ...producto, estado: ESTADOS.BLOQUEADO };
  }

  return { ...producto, estado: ESTADOS.VALIDADO };
}

/**
 * Descarga la imagen principal del producto como archivo físico,
 * dentro de Panafargo_Rappi/Imagenes/, nombrada por SKU, usando la
 * API chrome.downloads. Requiere el permiso "downloads" en el manifest.
 */
export async function descargarImagenPrincipal(producto) {
  if (!producto.imagen_principal) {
    throw new Error(`SKU ${producto.sku} no tiene imagen principal para descargar.`);
  }

  const extension = obtenerExtension(producto.imagen_principal);
  const nombreArchivo = `Panafargo_Rappi/Imagenes/${producto.sku}${extension}`;

  const downloadId = await chrome.downloads.download({
    url: producto.imagen_principal,
    filename: nombreArchivo,
    saveAs: false,
  });

  logger.info(`Imagen de SKU ${producto.sku} descargada (id ${downloadId}) en ${nombreArchivo}`);
  return nombreArchivo;
}

function obtenerExtension(url) {
  const match = url.split("?")[0].match(/\.(jpg|jpeg|png|webp|gif)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".jpg";
}
