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

import { nombreArchivoImagenLocal } from "../images/image-handler.js";
import { analizarSku } from "../utils/sku.js";

export class ErrorImagenesRappi extends Error {
  constructor(code, mensaje, skus = []) {
    super(mensaje);
    this.name = "ErrorImagenesRappi";
    this.code = code;
    this.skus = skus;
  }
}

/**
 * @param {Array<{producto: object}>} filasListas filas con resultado.ok === true
 * @returns {Promise<Blob>} el .zip listo para subir
 */
const LIMITE_BYTES_IMAGEN = 1_000_000; // 1 MB — límite máximo por imagen exigido por Rappi.
const FORMATOS_PERMITIDOS = new Set(["jpg", "jpeg", "png", "webp"]); // Rappi no acepta GIF.
const FORMATOS_INDIVIDUALES = new Set(["jpg", "jpeg", "png"]); // Formatos documentados para el control individual.

export async function construirZipImagenes(filasListas) {
  validarNombresParaCargaMasiva(filasListas);
  comprobarJsZip();

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
 * Prepara la foto principal de CADA publicación para un control individual.
 * El consumidor debe localizar una fila por SKU completo y asignar el File a
 * esa fila. El nombre seguro no es un alias de SKU ni una regla de importación
 * del ZIP; no se confía en que Rappi decodifique sus caracteres.
 * @returns {Promise<Array<{sku:string,nombre:string,tipoMime:string,base64:string}>>}
 */
export async function prepararImagenesIndividualesPorSku(filasListas) {
  if (!Array.isArray(filasListas) || filasListas.length === 0) {
    throw new ErrorImagenesRappi("LOTE_IMAGENES_VACIO", "Selecciona las publicaciones cuyas imágenes quieres preparar.");
  }
  const vistos = new Set();
  for (const fila of filasListas) {
    const producto = fila?.producto;
    const sku = producto?.sku;
    try {
      if (analizarSku(sku).skuCompleto !== sku) throw new Error("El SKU no debe incluir espacios en sus extremos.");
    } catch (error) {
      throw new ErrorImagenesRappi("SKU_IMAGEN_INVALIDO", `No se puede preparar una imagen sin un SKU completo válido. ${error.message}`, [sku]);
    }
    if (vistos.has(sku)) {
      throw new ErrorImagenesRappi("SKU_IMAGEN_DUPLICADO", `El SKU completo ${sku} está repetido. No se puede elegir una imagen para dos publicaciones con la misma identidad.`, [sku]);
    }
    vistos.add(sku);
    if (typeof producto.imagen_principal !== "string" || !producto.imagen_principal) {
      throw new ErrorImagenesRappi("IMAGEN_PRINCIPAL_AUSENTE", `SKU ${sku} no tiene imagen principal. Revisa la foto de esa publicación en Shopify.`, [sku]);
    }
  }

  const imagenes = [];
  for (const { producto } of filasListas) {
    const imagen = await descargarImagenPrincipalNormalizada(producto, FORMATOS_INDIVIDUALES);
    const tipoMime = imagen.extension === ".png" ? "image/png" : "image/jpeg";
    let binario = "";
    for (let inicio = 0; inicio < imagen.bytes.length; inicio += 32768) {
      binario += String.fromCharCode(...imagen.bytes.subarray(inicio, inicio + 32768));
    }
    imagenes.push({
      sku: producto.sku,
      nombre: nombreArchivoImagenLocal(producto.sku, imagen.extension),
      tipoMime,
      base64: btoa(binario),
    });
  }
  return imagenes;
}

/**
 * Respaldo LOCAL para asignar imágenes manualmente por SKU completo. Solo
 * contiene la imagen principal por publicación y un mapa de nombres; NO es
 * un ZIP importable de Rappi. El portal no ha confirmado cómo relaciona
 * nombres de archivo con SKU que contienen separadores.
 */
export async function construirPaqueteImagenesLocales(filasListas) {
  comprobarJsZip();
  const nombres = new Set();
  // Revisa las identidades antes de descargar o generar archivos.
  for (const { producto } of filasListas) {
    const nombre = nombreArchivoImagenLocal(producto.sku, ".jpg");
    const clave = nombre.toLowerCase();
    if (nombres.has(clave)) {
      throw new ErrorImagenesRappi(
        "NOMBRE_IMAGEN_DUPLICADO",
        `Los SKU del paquete generan nombres de imagen duplicados: ${producto.sku}.`,
        [producto.sku]
      );
    }
    nombres.add(clave);
  }

  const entradas = [];
  for (const { producto } of filasListas) {
    const imagen = await descargarImagenPrincipalNormalizada(producto);
    const archivo = nombreArchivoImagenLocal(producto.sku, imagen.extension);
    entradas.push({ sku: producto.sku, archivo, bytes: imagen.bytes });
  }
  return empaquetarImagenesLocales(entradas);
}

/** Respalda los mismos bytes preparados para Rappi, sin volver a consultar Shopify. */
export async function construirPaqueteImagenesLocalesDesdePreparadas(imagenes) {
  comprobarJsZip();
  if (!Array.isArray(imagenes) || !imagenes.length) {
    throw new Error("No hay imágenes preparadas para incluir en el respaldo.");
  }
  const nombres = new Set();
  const skus = new Set();
  const entradas = imagenes.map((imagen) => {
    const { sku, nombre, tipoMime, base64 } = imagen || {};
    let extension;
    try {
      if (analizarSku(sku).skuCompleto !== sku) throw new Error();
      extension = tipoMime === "image/png" ? ".png" : tipoMime === "image/jpeg" ? ".jpg" : null;
      if (!extension || nombre !== nombreArchivoImagenLocal(sku, extension)) throw new Error();
      if (typeof base64 !== "string" || !base64) throw new Error();
    } catch {
      throw new ErrorImagenesRappi("IMAGEN_PREPARADA_INVALIDA", "El respaldo necesita imágenes JPG/PNG con su SKU completo y nombre seguro.", [sku]);
    }
    if (skus.has(sku) || nombres.has(nombre.toLowerCase())) {
      throw new ErrorImagenesRappi("NOMBRE_IMAGEN_DUPLICADO", `El respaldo contiene un SKU o nombre de imagen duplicado: ${sku}.`, [sku]);
    }
    skus.add(sku);
    nombres.add(nombre.toLowerCase());
    let binario;
    try { binario = atob(base64); } catch {
      throw new ErrorImagenesRappi("IMAGEN_PREPARADA_INVALIDA", `La imagen preparada del SKU ${sku} está dañada.`, [sku]);
    }
    if (!binario.length || binario.length > LIMITE_BYTES_IMAGEN) {
      throw new ErrorImagenesRappi("IMAGEN_PREPARADA_INVALIDA", `La imagen preparada del SKU ${sku} debe tener contenido y no superar 1 MB.`, [sku]);
    }
    return { sku, archivo: nombre, bytes: Uint8Array.from(binario, (letra) => letra.charCodeAt(0)) };
  });
  return empaquetarImagenesLocales(entradas);
}

async function empaquetarImagenesLocales(entradas) {
  if (!entradas.length) throw new Error("No hay imágenes para incluir en el paquete local.");
  const zip = new window.JSZip();
  const mapa = [];
  for (const { sku, archivo, bytes } of entradas) {
    zip.file(archivo, bytes);
    mapa.push({ sku, archivo });
  }

  // JSON conserva los SKU exactamente, incluidos ceros iniciales y símbolos.
  zip.file("mapa_imagenes.json", JSON.stringify({ uso: "asignacion_manual", imagenes: mapa }, null, 2));
  const csv = [
    "SKU completo,Archivo de imagen",
    ...mapa.map(({ sku, archivo }) => `${celdaCsvTexto(sku)},${celdaCsvTexto(archivo)}`),
  ].join("\r\n");
  zip.file("mapa_imagenes.csv", `\uFEFF${csv}\r\n`);
  zip.file("LEEME.txt", [
    "PAQUETE LOCAL PARA ASIGNACION MANUAL DE IMAGENES",
    "Este archivo NO es el ZIP de carga masiva de Rappi.",
    "No subas este ZIP en Cárgalas aquí: ese importador no tiene una vinculación confirmada para los nombres codificados.",
    "Extrae los archivos y asigna cada imagen al SKU completo indicado en el mapa.",
    "Los nombres codificados evitan que / y otros caracteres se conviertan en rutas.",
    "El SKU original se conserva exactamente en mapa_imagenes.json.",
    "El CSV protege las celdas que una hoja de calculo podria interpretar como formulas.",
  ].join("\r\n"));
  return zip.generateAsync({ type: "blob" });
}

function comprobarJsZip() {
  if (!window.JSZip) {
    throw new Error(
      "JSZip no está cargado. Verifica que vendor/jszip.min.js esté incluido antes de popup.js en popup.html."
    );
  }
}

function validarNombresParaCargaMasiva(filasListas) {
  const nombres = new Map();
  for (const { producto } of filasListas) {
    const sku = producto.sku;
    if (typeof sku !== "string" || !sku || /[\u0000-\u001F\u007F]/.test(sku)) {
      throw new ErrorImagenesRappi("SKU_IMAGEN_INVALIDO", "La carga de imágenes necesita un SKU completo válido.", [sku]);
    }
    if (/[\/\\]/.test(sku)) {
      throw new ErrorImagenesRappi(
        "SKU_IMAGEN_REQUIERE_ASIGNACION_MANUAL",
        `El SKU ${sku} contiene un separador. Conserva el SKU completo en Rappi y asigna su imagen manualmente con el paquete local; la carga masiva no tiene una correspondencia de nombres confirmada para ese SKU.`,
        [sku]
      );
    }
    if (!producto.imagen_principal) continue;
    const cantidad = producto.imagenes?.[1] ? 2 : 1;
    for (let indice = 0; indice < cantidad; indice++) {
      const nombre = `${sku}${indice ? `_${indice}` : ""}`;
      if (nombres.has(nombre)) {
        throw new ErrorImagenesRappi(
          "NOMBRE_IMAGEN_DUPLICADO",
          `Los SKU ${nombres.get(nombre)} y ${sku} generan el mismo nombre de imagen: ${nombre}. Revisa las imágenes antes de cargar el lote.`,
          [nombres.get(nombre), sku]
        );
      }
      nombres.set(nombre, sku);
    }
  }
}

function celdaCsvTexto(valor) {
  const texto = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return `"${texto.replace(/"/g, '""')}"`;
}

async function descargarImagenPrincipalNormalizada(producto, formatosPermitidos = FORMATOS_PERMITIDOS) {
  if (!producto.imagen_principal) {
    throw new Error(`SKU ${producto.sku} no tiene imagen principal para preparar.`);
  }
  const respuesta = await fetch(producto.imagen_principal);
  if (!respuesta.ok) {
    throw new Error(`No se pudo descargar la imagen de SKU ${producto.sku} (HTTP ${respuesta.status}).`);
  }
  const bytes = await respuesta.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`La imagen del SKU ${producto.sku} llegó vacía desde Shopify.`);
  }
  const tipoMime = (respuesta.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  return normalizarImagen(bytes, tipoMime, producto.sku, formatosPermitidos);
}

/**
 * Deja la imagen lista para Rappi: si ya viene en un formato permitido
 * (jpg/jpeg/png/webp) y pesa 1 MB o menos, se usa tal cual. Si no, se
 * recodifica como JPG reduciendo calidad y, si hace falta, dimensiones,
 * hasta quedar bajo el límite de 1 MB. Si agota los intentos sin cumplir
 * el límite, detiene el lote para no enviar una imagen que Rappi rechace.
 */
async function normalizarImagen(bytes, tipoMime, sku, formatosPermitidos = FORMATOS_PERMITIDOS) {
  const extensionOriginal = detectarExtensionImagen(bytes, tipoMime, sku).slice(1);
  const formatoValido = formatosPermitidos.has(extensionOriginal);
  const demasiadoGrande = bytes.byteLength > LIMITE_BYTES_IMAGEN;

  if (formatoValido && !demasiadoGrande) {
    return { bytes: new Uint8Array(bytes), extension: `.${extensionOriginal}` };
  }

  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
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

    const canvasFinal = new OffscreenCanvas(ancho, alto);
    canvasFinal.getContext("2d").drawImage(bitmap, 0, 0, ancho, alto);
    const blobFinal = await canvasFinal.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    if (blobFinal.size > LIMITE_BYTES_IMAGEN) {
      throw new ErrorImagenesRappi(
        "IMAGEN_SUPERA_LIMITE",
        `La imagen del SKU ${sku} sigue superando el límite de 1 MB de Rappi después de comprimirla. Reduce su tamaño en Shopify y vuelve a preparar el lote.`,
        [sku]
      );
    }
    return { bytes: new Uint8Array(await blobFinal.arrayBuffer()), extension: ".jpg" };
  } finally {
    bitmap.close?.();
  }
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

