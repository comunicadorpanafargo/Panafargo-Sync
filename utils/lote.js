import { analizarSku, normalizarSkuCompleto, obtenerSkuBase } from "./sku.js";

export const LIMITE_BASES_LOTE = 10;

/** El límite cuenta referencias base; nunca trunca las publicaciones pegadas. */
export function analizarEntradaLote(texto) {
  const skus = [];
  const errores = [];
  for (const [indice, linea] of String(texto ?? "").split(/\r?\n/).entries()) {
    const sku = normalizarSkuCompleto(linea);
    if (!sku) continue;
    try {
      analizarSku(sku);
      if (!skus.includes(sku)) skus.push(sku);
    } catch (error) {
      errores.push(`Línea ${indice + 1}: ${error.message}`);
    }
  }
  const bases = [...new Set(skus.map(obtenerSkuBase))];
  if (bases.length > LIMITE_BASES_LOTE) {
    errores.push(`El lote admite hasta ${LIMITE_BASES_LOTE} productos base. Hay ${bases.length}; no se eliminó ninguna línea.`);
  }
  return { skus, bases, errores, valido: skus.length > 0 && errores.length === 0 };
}

export function resumirLote(productos, solicitados = []) {
  const publicaciones = [...new Map(productos.map((p) => [p.sku, p])).values()];
  return {
    bases: new Set([...publicaciones.map((p) => p.sku), ...solicitados].map(obtenerSkuBase).filter(Boolean)).size,
    publicaciones: publicaciones.length,
    listos: publicaciones.filter((p) => p.estado === "VALIDADO").length,
    pendientes: publicaciones.filter((p) => p.estado !== "VALIDADO").length,
  };
}

/**
 * Consulta cada base una vez. Fuente, normalización y validación se inyectan:
 * el lote no conoce credenciales, categorías ni reglas de otro marketplace.
 */
export async function consultarLote(skus, { buscar, normalizar, validar, alProgreso = () => {} }) {
  const grupos = new Map();
  for (const valor of skus) {
    const { skuCompleto, skuBase, tipoBusqueda } = analizarSku(valor);
    if (!grupos.has(skuBase)) grupos.set(skuBase, { todos: false, solicitados: new Set() });
    const grupo = grupos.get(skuBase);
    grupo.todos ||= tipoBusqueda === "base";
    grupo.solicitados.add(skuCompleto);
  }
  const productos = new Map();
  const errores = [];
  let completadas = 0;
  for (const [base, grupo] of grupos) {
    try {
      const respuesta = await buscar(base);
      const encontrados = (respuesta.raws || []).filter((r) => obtenerSkuBase(r.sku) === base);
      const porSku = new Map();
      for (const raw of encontrados) {
        const completo = normalizarSkuCompleto(raw.sku);
        if (!grupo.todos && !grupo.solicitados.has(completo)) continue;
        if (!porSku.has(completo)) porSku.set(completo, new Map());
        porSku.get(completo).set(raw.id || raw, raw);
      }
      for (const solicitado of grupo.solicitados) {
        const existe = solicitado === base ? encontrados.length > 0 : encontrados.some((r) => normalizarSkuCompleto(r.sku) === solicitado);
        if (!existe) errores.push({ sku: solicitado, sku_base: base, tipo: "NO_ENCONTRADO", mensaje: `No se encontraron publicaciones para ${solicitado}.` });
      }
      for (const [sku, variantes] of porSku) {
        const producto = normalizar(variantes.values().next().value);
        // Un SKU repetido en variantes diferentes es ambiguo; no sumar ni
        // elegir inventario de una publicación de forma silenciosa.
        productos.set(sku, validar({ ...producto, conflicto_sku: variantes.size > 1 }));
      }
    } catch (error) {
      for (const solicitado of grupo.solicitados) {
        errores.push({ sku: solicitado, sku_base: base, tipo: "CONSULTA", mensaje: error.message || "No se pudo consultar Shopify." });
      }
    }
    completadas++;
    await alProgreso({ completadas, total: grupos.size, base, publicaciones: productos.size });
  }
  return { productos: [...productos.values()], errores, basesConsultadas: grupos.size };
}
