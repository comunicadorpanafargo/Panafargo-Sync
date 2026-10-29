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
  const nombreArchivo = `Panafargo_Rappi/Imagenes/${nombreArchivoImagenLocal(producto.sku, extension)}`;

  const downloadId = await chrome.downloads.download({
    url: producto.imagen_principal,
    filename: nombreArchivo,
    saveAs: false,
  });

  logger.info(`Imagen de SKU ${producto.sku} descargada (id ${downloadId}) en ${nombreArchivo}`);
  return nombreArchivo;
}

/**
 * Nombre plano para una copia LOCAL. La codificación se puede revertir con
 * decodeURIComponent, sin cambiar el SKU del producto. No implica que Rappi
 * decodifique estos nombres al importar imágenes masivamente.
 */
export function nombreArchivoImagenLocal(sku, extension = ".jpg") {
  if (typeof sku !== "string" || sku.length === 0) {
    throw new Error("La imagen necesita un SKU completo no vacío.");
  }
  if (!/^\.(jpg|jpeg|png|webp|gif)$/i.test(extension)) {
    throw new Error("La imagen necesita una extensión de archivo reconocida.");
  }

  // RFC 3986: también codifica %, separadores, caracteres de Windows y los
  // caracteres que encodeURIComponent deja sin escapar pero no son seguros.
  let nombre = encodeURIComponent(sku).replace(/[!'()*]/g, (caracter) =>
    `%${caracter.charCodeAt(0).toString(16).toUpperCase()}`
  );
  // Windows reserva estos nombres incluso si se agrega una extensión.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(nombre) || /^\.{1,2}$/.test(nombre)) {
    nombre = `%${nombre.charCodeAt(0).toString(16).toUpperCase()}${nombre.slice(1)}`;
  }
  return `${nombre}${extension.toLowerCase()}`;
}

/**
 * Adjunto del control de imagen por fila de Rappi. Su pipe concatena el
 * nombre recibido en una URL sin escapar %, por lo que no sirve el nombre
 * codificado de la copia local. La identidad sigue siendo el SKU de la fila.
 */
export async function nombreArchivoImagenRappi(sku, extension = ".jpg") {
  if (typeof sku !== "string" || !sku || sku.trim() !== sku || /[\u0000-\u001f\u007f]/.test(sku)) {
    throw new Error("La imagen necesita un SKU completo válido.");
  }
  if (![".jpg", ".png"].includes(extension)) throw new Error("El adjunto de Rappi debe ser JPG o PNG.");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(sku));
  const nombre = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pf_img_${nombre}${extension}`;
}

function obtenerExtension(url) {
  const match = url.split("?")[0].match(/\.(jpg|jpeg|png|webp|gif)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".jpg";
}
