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

const HOJA_PRODUCTOS_ASOCIACION = "Productos";
const PREFIJO_SKU_ASOCIACION = "PANAFARGOSAS_";
const COLUMNA_SKU_ASOCIACION = "G";
const COLUMNA_PRECIO_ASOCIACION = "K";
const COLUMNA_UNIDADES_ASOCIACION = "N";
const FILA_INICIO_DATOS_ASOCIACION = 6;
const RUTA_PLANTILLA_ASOCIACION_POR_DEFECTO = "ProductosAsociacion-es.xlsx";

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
  try {
    const almacenado = await chrome.storage.local.get("plantillaAsociacionBase64");
    if (almacenado?.plantillaAsociacionBase64) {
      const binario = atob(almacenado.plantillaAsociacionBase64);
      const buffer = new Uint8Array(binario.length);
      for (let i = 0; i < binario.length; i++) buffer[i] = binario.charCodeAt(i);
      return buffer.buffer;
    }
  } catch (err) {
    console.warn("[Panafargo Sync] No se pudo leer la plantilla de asociación guardada, se usa la incluida.", err);
  }
  return (await fetch(new URL(RUTA_PLANTILLA_ASOCIACION_POR_DEFECTO, import.meta.url))).arrayBuffer();
}

/**
 * @param {Array<{sku:string, precio:number|null, inventario:number|null}>} productos
 * @returns {Promise<{blob: Blob, filasEscritas: number, noEncontrados: string[]}>}
 */
export async function generarPlantillaAsociacion(productos) {
  if (!window.XLSX) throw new Error("SheetJS no está cargado (window.XLSX).");

  const buffer = await obtenerBufferPlantillaAsociacion();
  const libro = window.XLSX.read(buffer, { type: "array" });
  const hoja = libro.Sheets[HOJA_PRODUCTOS_ASOCIACION];
  if (!hoja) throw new Error(`La plantilla de asociación no tiene una hoja "${HOJA_PRODUCTOS_ASOCIACION}".`);

  const rango = window.XLSX.utils.decode_range(hoja["!ref"]);
  const filaPorSku = new Map();
  for (let r = rango.s.r; r <= rango.e.r; r++) {
    const celda = hoja[`${COLUMNA_SKU_ASOCIACION}${r + 1}`];
    if (celda && typeof celda.v === "string" && celda.v.startsWith(PREFIJO_SKU_ASOCIACION)) {
      const skuCompleto = celda.v.slice(PREFIJO_SKU_ASOCIACION.length);
      if (filaPorSku.has(skuCompleto)) throw new Error(`La plantilla tiene varias filas para el SKU completo ${skuCompleto}.`);
      filaPorSku.set(skuCompleto, r + 1);
    }
  }

  const noEncontrados = [];
  const filasDelLote = new Set();
  productos.forEach((producto) => {
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

  for (let r = rango.s.r; r <= rango.e.r; r++) {
    const numeroFila = r + 1;
    if (numeroFila < FILA_INICIO_DATOS_ASOCIACION || filasDelLote.has(numeroFila)) continue;
    for (let col = rango.s.c; col <= rango.e.c; col++) {
      delete hoja[window.XLSX.utils.encode_cell({ r, c: col })];
    }
  }

  const salida = window.XLSX.write(libro, { type: "array", bookType: "xlsx" });
  const blob = new Blob([salida], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return { blob, filasEscritas: filasDelLote.size, noEncontrados };
}
