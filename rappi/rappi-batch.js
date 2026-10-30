// ============================================================
// rappi/rappi-batch.js
// ============================================================
// Generación del lote Rappi (ficha técnica, sección 22).
//
// Genera un .xlsx REAL, no un .csv: parte de la plantilla oficial
// de Rappi bundleada en la extensión (rappi/plantilla-rappi-base.xlsx,
// una copia de ProductosPersonalizados-es.xlsx sin el producto de
// ejemplo) y le inserta las filas generadas, conservando la hoja
// "Productos" con sus mismos encabezados y desplegables, tal como
// exige el proceso de subida de Rappi ("Mi Tienda" → subir archivo →
// cargar imágenes de cada producto → asociar a puntos de venta).
//
// Requiere que vendor/xlsx.full.min.js (SheetJS) esté cargado ANTES
// de este módulo — ver el <script> agregado en popup.html — y expone
// la librería como window.XLSX.
// ============================================================

const RUTA_PLANTILLA = "rappi/plantilla-rappi-base.xlsx";
const HOJA_PRODUCTOS = "Productos";
// La plantilla oficial de Rappi empieza a recibir productos en la fila 6
// (filas 1-5 son título, subtítulo, encabezados y ayuda).
const FILA_INICIO_DATOS = 6;

/**
 * Construye el workbook .xlsx del lote a partir de una lista de
 * rappiProduct (la salida de prepararParaRappi en rappi-connector.js).
 * @returns {Promise<Blob>}
 */
export async function generarXlsxLoteRappi(rappiProducts) {
  if (!window.XLSX) {
    throw new Error(
      "SheetJS (XLSX) no está cargado. Verifica que vendor/xlsx.full.min.js esté incluido antes de popup.js en popup.html."
    );
  }

  const buffer = await (await fetch(chrome.runtime.getURL(RUTA_PLANTILLA))).arrayBuffer();
  const wb = window.XLSX.read(buffer, { type: "array" });

  const hoja = wb.Sheets[HOJA_PRODUCTOS];
  if (!hoja) {
    throw new Error(`La plantilla no tiene una hoja "${HOJA_PRODUCTOS}".`);
  }

  rappiProducts.forEach((p, i) => {
    const fila = FILA_INICIO_DATOS + i;
    escribirCelda(hoja, `B${fila}`, p.categoria);
    escribirCelda(hoja, `C${fila}`, p.nombre);
    escribirCelda(hoja, `D${fila}`, p.sku);
    // Marca es opcional en la plantilla y debe quedar en blanco.
    escribirCelda(hoja, `E${fila}`, "");
    // EAN eliminado del proyecto (ficha técnica, sección 18) — se deja vacío.
    escribirCelda(hoja, `F${fila}`, "");
    escribirCelda(hoja, `G${fila}`, p.descripcion);
    escribirCelda(hoja, `H${fila}`, p.es_pesable);
    escribirCelda(hoja, `I${fila}`, p.es_preempaquetado);
    escribirCelda(hoja, `J${fila}`, p.cantidad);
    escribirCelda(hoja, `K${fila}`, p.unidad_medida);
  });

  // Extiende el rango declarado de la hoja para incluir todas las filas escritas.
  const ultimaFilaIdx = FILA_INICIO_DATOS - 1 + rappiProducts.length - 1; // 0-indexed
  const rango = window.XLSX.utils.decode_range(hoja["!ref"]);
  rango.e.r = Math.max(rango.e.r, ultimaFilaIdx);
  hoja["!ref"] = window.XLSX.utils.encode_range(rango);

  const salida = window.XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([salida], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/**
 * Descarga el lote como archivo físico en Panafargo_Rappi/Lotes/.
 * @returns {Promise<string>} nombre/ruta del archivo descargado (usado como loteId)
 */
export async function descargarLoteRappi(blob) {
  const url = URL.createObjectURL(blob);
  const nombreArchivo = `Panafargo_Rappi/Lotes/lote_rappi_${Date.now()}.xlsx`;

  await chrome.downloads.download({
    url,
    filename: nombreArchivo,
    saveAs: false,
  });

  return nombreArchivo;
}

function escribirCelda(hoja, direccion, valor) {
  const esNumero = typeof valor === "number";
  hoja[direccion] = { t: esNumero ? "n" : "s", v: esNumero ? valor : valor ?? "" };
}

/**
 * Convierte un Blob a base64 (sin el prefijo data:...;base64,).
 * Usado para enviar el lote al content script de Mi Tienda (V4),
 * ya que chrome.tabs.sendMessage no transporta Blobs de forma fiable.
 */
export async function blobABase64(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binario = "";
  const TAMANO_BLOQUE = 0x8000;
  for (let i = 0; i < buffer.length; i += TAMANO_BLOQUE) {
    binario += String.fromCharCode(...buffer.subarray(i, i + TAMANO_BLOQUE));
  }
  return btoa(binario);
}
