// ============================================================
// rappi/rappi-association.js
// ============================================================
// Genera el .xlsx de asociación de productos (Precio y Unidades
// disponibles) a partir de la plantilla que Rappi manda por correo —
// El usuario descarga el resultado y confirma su asociación en Rappi.
//
// Reglas (confirmadas con el usuario sobre la plantilla real):
// - Columnas B-J (ID, ID de tienda, nombre de tienda, ID de producto,
//   EAN, SKU, nombre, descripción, presentación) ya vienen con los
//   datos reales de Rappi para cada producto ya asociado — NO se
//   tocan.
// - Columnas L (Descuento) y M (Disponibilidad) ya vienen con "0" y
//   "SI" — tampoco se tocan.
// - Solo se rellenan K (Precio) y N (Unidades disponibles), por fila,
//   ubicando la fila de cada producto por su SKU en la columna G
//   (con el prefijo "PANAFARGOSAS_").
// - Por seguridad, se borran del archivo TODAS las filas de productos
//   que no son del lote actual, para no arriesgar tocar productos ya
//   asociados que esa misma plantilla trae con Precio/Unidades en
//   blanco.
// ============================================================

import { analizarSku } from "../utils/sku.js";

const HOJA_PRODUCTOS_ASOCIACION = "Productos";
const PREFIJO_SKU_ASOCIACION = "PANAFARGOSAS_";
const COLUMNA_SKU_ASOCIACION = "G";
const COLUMNA_PRECIO_ASOCIACION = "K";
const COLUMNA_UNIDADES_ASOCIACION = "N";
const FILA_INICIO_DATOS_ASOCIACION = 6;
const RUTA_PLANTILLA_ASOCIACION_POR_DEFECTO = "ProductosAsociacion-es.xlsx";

/**
 * Lee el SKU del Excel de Rappi sin cambiar la celda original. Solo se
 * ignoran espacios exteriores; el SKU completo conserva /, guiones y caso.
 */
export function extraerSkuCompletoAsociacion(valorCelda) {
  if (typeof valorCelda !== "string") return null;
  const texto = valorCelda.trim();
  if (!texto.startsWith(PREFIJO_SKU_ASOCIACION)) return null;
  try {
    return analizarSku(texto.slice(PREFIJO_SKU_ASOCIACION.length)).skuCompleto;
  } catch {
    return null;
  }
}

export function calcularUnidadesDisponiblesAsociacion(inventario) {
  if (inventario == null || !Number.isFinite(Number(inventario))) return 0;
  const cantidad = Math.max(0, Math.floor(Number(inventario)));
  return cantidad < 50 ? Math.floor(cantidad / 3) : Math.floor(cantidad / 2);
}

function escribirCeldaAsociacion(hoja, direccion, valor) {
  const esNumero = typeof valor === "number";
  hoja[direccion] = { t: esNumero ? "n" : "s", v: esNumero ? valor : valor ?? "" };
}

/**
 * Carga la plantilla base: primero intenta la guardada por el usuario
 * en chrome.storage.local (la que sube desde "Plantilla de asociación
 * (Rappi)" en el popup); si no hay ninguna, usa la que trae la
 * extensión por defecto.
 */
async function obtenerBufferPlantillaAsociacion() {
  let almacenado;
  try {
    almacenado = await chrome.storage.local.get("plantillaAsociacionBase64");
  } catch {
    throw new Error("No se pudo leer la plantilla de asociación guardada. Vuelve a seleccionar el archivo enviado por Rappi.");
  }
  if (almacenado?.plantillaAsociacionBase64 != null) {
    try {
      if (typeof almacenado.plantillaAsociacionBase64 !== "string" || !almacenado.plantillaAsociacionBase64) throw new Error();
      const binario = atob(almacenado.plantillaAsociacionBase64);
      if (!binario.length) throw new Error();
      const buffer = new Uint8Array(binario.length);
      for (let i = 0; i < binario.length; i++) buffer[i] = binario.charCodeAt(i);
      return buffer.buffer;
    } catch {
      throw new Error("La plantilla de asociación guardada no se pudo leer. Selecciona otra vez el archivo enviado por Rappi.");
    }
  }
  const respuesta = await fetch(new URL(RUTA_PLANTILLA_ASOCIACION_POR_DEFECTO, import.meta.url));
  if (respuesta.ok === false) throw new Error("No se pudo cargar la plantilla de asociación incluida. Selecciona el archivo enviado por Rappi.");
  return respuesta.arrayBuffer();
}

function obtenerRangoAsociacion(hoja) {
  let rango;
  try {
    if (typeof hoja["!ref"] !== "string" || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(hoja["!ref"])) throw new Error();
    rango = window.XLSX.utils.decode_range(hoja["!ref"]);
    const { s, e } = rango;
    if (![s.r, s.c, e.r, e.c].every(Number.isSafeInteger)
      || s.r < 0 || s.c < 0 || s.r > e.r || s.c > e.c
      || e.r >= 1048576 || e.c >= 16384 || e.r < FILA_INICIO_DATOS_ASOCIACION - 1
      || s.c > 6 || e.c < 13) throw new Error();
  } catch {
    throw new Error("La hoja Productos no tiene un rango de asociación válido. Usa la plantilla enviada por Rappi con SKU en G, precio en K y unidades en N.");
  }
  return rango;
}

/**
 * @param {Array<{sku:string, precio:number|null, inventario:number|null}>} productos
 * @returns {Promise<{blob: Blob, filasEscritas: number, noEncontrados: string[]}>}
 */
export async function generarPlantillaAsociacion(productos) {
  if (!window.XLSX) throw new Error("SheetJS no está cargado (window.XLSX).");
  if (!Array.isArray(productos)) throw new Error("La asociación necesita una lista de publicaciones con su SKU completo.");
  const skusSolicitados = new Set();
  const publicaciones = productos.map((producto) => {
    const sku = analizarSku(producto?.sku).skuCompleto;
    if (skusSolicitados.has(sku)) throw new Error(`El lote repite el SKU completo ${sku}; revisa la selección antes de asociar.`);
    skusSolicitados.add(sku);
    return { ...producto, sku };
  });

  const buffer = await obtenerBufferPlantillaAsociacion();
  const libro = window.XLSX.read(buffer, { type: "array" });
  const hoja = libro.Sheets[HOJA_PRODUCTOS_ASOCIACION];
  if (!hoja) throw new Error(`La plantilla de asociación no tiene una hoja "${HOJA_PRODUCTOS_ASOCIACION}".`);

  const rango = obtenerRangoAsociacion(hoja);
  const filaPorSku = new Map();
  const patronCeldaSku = new RegExp(`^${COLUMNA_SKU_ASOCIACION}([1-9]\\d*)$`);
  // Revisar solo celdas existentes evita recorrer cada posición vacía de
  // una hoja cuyo rango incluye muchas filas preformateadas.
  for (const direccion of Object.keys(hoja)) {
    const coincidencia = patronCeldaSku.exec(direccion);
    if (!coincidencia) continue;
    const numeroFila = Number(coincidencia[1]);
    if (numeroFila < FILA_INICIO_DATOS_ASOCIACION || numeroFila < rango.s.r + 1 || numeroFila > rango.e.r + 1) continue;
    const skuCompleto = extraerSkuCompletoAsociacion(hoja[direccion]?.v);
    if (skuCompleto == null) continue;
    if (filaPorSku.has(skuCompleto)) throw new Error(`La plantilla tiene varias filas para el SKU completo ${skuCompleto}.`);
    filaPorSku.set(skuCompleto, numeroFila);
  }

  const noEncontrados = [];
  const filasDelLote = new Set();
  publicaciones.forEach((producto) => {
    const fila = filaPorSku.get(producto.sku);
    if (!fila) {
      noEncontrados.push(producto.sku);
      return;
    }
    filasDelLote.add(fila);
    escribirCeldaAsociacion(hoja, `${COLUMNA_PRECIO_ASOCIACION}${fila}`, producto.precio ?? "");
    escribirCeldaAsociacion(
      hoja,
      `${COLUMNA_UNIDADES_ASOCIACION}${fila}`,
      calcularUnidadesDisponiblesAsociacion(producto.inventario)
    );
  });

  for (const direccion of Object.keys(hoja)) {
    const celda = /^[A-Z]+([1-9]\d*)$/.exec(direccion);
    if (!celda) continue;
    const numeroFila = Number(celda[1]);
    if (numeroFila < FILA_INICIO_DATOS_ASOCIACION || filasDelLote.has(numeroFila)) continue;
    delete hoja[direccion];
  }

  const salida = window.XLSX.write(libro, { type: "array", bookType: "xlsx" });
  const blob = new Blob([salida], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return { blob, filasEscritas: filasDelLote.size, noEncontrados };
}
