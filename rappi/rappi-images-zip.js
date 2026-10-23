// ============================================================
// rappi/rappi-images-zip.js
// ============================================================
// V4 — arma el .zip de imágenes que exige el paso "¿Prefieres
// cargar múltiples imágenes a la vez? Cárgalas aquí" de Mi Tienda
// (ese paso solo acepta un input[type=file][accept=".zip"], no
// imágenes sueltas). Cada imagen se nombra por SKU — el mismo SKU
// que identifica la fila del producto en la plantilla .xlsx — para
// que Rappi pueda asociarlas automáticamente al revisar el lote.
//
// Requiere que vendor/jszip.min.js esté cargado ANTES de este
// módulo (ver popup.html), exponiendo window.JSZip.
// ============================================================

/**
 * Descarga a disco el mismo .zip de imágenes (ya comprimidas/validadas)
 * que arma el flujo automático — pensado para probar manualmente en
 * Mi Tienda, sin la extensión, y así aislar si un fallo es de Rappi
 * o de la automatización.
 * @param {Array<{producto: object}>} filasListas
 * @returns {Promise<string>} ruta del archivo descargado
 */
export async function descargarZipImagenesRappi(filasListas) {
  const blob = await construirZipImagenes(filasListas);
  const url = URL.createObjectURL(blob);
  const nombreArchivo = `Panafargo_Rappi/Imagenes/lote_imagenes_${Date.now()}.zip`;

  await chrome.downloads.download({
    url,
    filename: nombreArchivo,
    saveAs: false,
  });

  return nombreArchivo;
}

/**
 * @param {Array<{producto: object}>} filasListas filas con resultado.ok === true
 * @returns {Promise<Blob>} el .zip listo para subir
 */
const LIMITE_BYTES_IMAGEN = 1_000_000; // 1 MB — límite máximo por imagen exigido por Rappi.
const FORMATOS_PERMITIDOS = new Set(["jpg", "jpeg", "png", "webp"]); // Rappi no acepta GIF.

export async function construirZipImagenes(filasListas) {
  if (!window.JSZip) {
    throw new Error(
      "JSZip no está cargado. Verifica que vendor/jszip.min.js esté incluido antes de popup.js en popup.html."
    );
  }

  const zip = new window.JSZip();
  let cantidadImagenes = 0;

  for (const { producto } of filasListas) {
    if (!producto.imagen_principal) continue; // ya bloqueado antes en el validador

    // Imagen principal: sin sufijo (ej. "41161-2.jpg"). Imagen
    // secundaria (si Shopify trae una segunda foto): con sufijo "_1"
    // (ej. "41161-2_1.jpg"), tal como exige Rappi.
    const urlsImagenes = [producto.imagen_principal, ...(producto.imagenes || []).slice(1, 2)];

    for (let indice = 0; indice < urlsImagenes.length; indice++) {
      const url = urlsImagenes[indice];
      if (!url) continue;
      const sufijo = indice === 0 ? "" : `_${indice}`;

      const respuesta = await fetch(url);
      if (!respuesta.ok) {
        if (indice === 0) {
          throw new Error(`No se pudo descargar la imagen de SKU ${producto.sku} (HTTP ${respuesta.status}).`);
        }
        continue; // la secundaria es opcional: si falla, se omite sin romper el lote
      }
      const bytes = await respuesta.arrayBuffer();
      if (bytes.byteLength === 0) {
        if (indice === 0) {
          throw new Error(`La imagen del SKU ${producto.sku} llegó vacía desde Shopify.`);
        }
        continue;
      }
      const tipoMime = (respuesta.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
      const { bytes: bytesFinales, extension } = await normalizarImagen(bytes, tipoMime, producto.sku);
      zip.file(`${producto.sku}${sufijo}${extension}`, bytesFinales);
      cantidadImagenes++;
    }
  }

  if (cantidadImagenes === 0) {
    throw new Error("No se pudo incluir ninguna imagen en el ZIP del lote.");
  }

  return zip.generateAsync({ type: "blob" });
}

/**
 * Deja la imagen lista para Rappi: si ya viene en un formato permitido
 * (jpg/jpeg/png/webp) y pesa 1 MB o menos, se usa tal cual. Si no, se
 * recodifica como JPG reduciendo calidad y, si hace falta, dimensiones,
 * hasta quedar bajo el límite de 1 MB (o hasta agotar los intentos, en
 * cuyo caso se entrega la mejor versión lograda).
 */
async function normalizarImagen(bytes, tipoMime, sku) {
  const extensionOriginal = detectarExtensionImagen(bytes, tipoMime, sku).slice(1);
  const formatoValido = FORMATOS_PERMITIDOS.has(extensionOriginal);
  const demasiadoGrande = bytes.byteLength > LIMITE_BYTES_IMAGEN;

  if (formatoValido && !demasiadoGrande) {
    return { bytes: new Uint8Array(bytes), extension: `.${extensionOriginal}` };
  }

  const bitmap = await createImageBitmap(new Blob([bytes]));
  let ancho = bitmap.width;
  let alto = bitmap.height;
  let calidad = 0.9;

  for (let intento = 0; intento < 8; intento++) {
    const canvas = new OffscreenCanvas(ancho, alto);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, ancho, alto);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: calidad });
    if (blob.size <= LIMITE_BYTES_IMAGEN) {
      return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: ".jpg" };
    }
    if (calidad > 0.5) {
      calidad -= 0.15;
    } else {
      ancho = Math.round(ancho * 0.8);
      alto = Math.round(alto * 0.8);
      calidad = 0.8;
    }
  }

  // Se agotaron los intentos: se entrega la última versión generada,
  // aunque pueda seguir por encima del límite de Rappi.
  const canvasFinal = new OffscreenCanvas(ancho, alto);
  canvasFinal.getContext("2d").drawImage(bitmap, 0, 0, ancho, alto);
  const blobFinal = await canvasFinal.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  return { bytes: new Uint8Array(await blobFinal.arrayBuffer()), extension: ".jpg" };
}

function detectarExtensionImagen(buffer, tipoMime, sku) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return ".gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return ".webp";

  const extensionPorMime = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  }[tipoMime];
  if (extensionPorMime) return extensionPorMime;

  throw new Error(`La imagen del SKU ${sku} no tiene un formato reconocible.`);
}

