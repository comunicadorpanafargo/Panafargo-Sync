// ============================================================
// rappi/rappi-connector.js
// ============================================================
// Conector Rappi (V2). Recibe un PanafargoProduct y lo transforma
// al modelo requerido por Rappi (ficha técnica, sección 17-19),
// usando los catálogos REALES de rappi-catalog.js y las
// equivalencias guardadas en storage/storage.js.
//
// Regla del proyecto: Rappi no define la estructura del núcleo, y
// el núcleo nunca inventa datos para completar un producto. Si algo
// obligatorio falta o no coincide con el catálogo real, el producto
// queda BLOQUEADO en vez de generar un lote aparentemente correcto.
//
// Todos los campos vienen de Shopify. Lo único que digita el
// empleado es el SKU — tanto al buscar el producto (V1.0) como al
// quedar identificado en la fila del lote que se sube a Rappi (V2).
// ============================================================

import { CATEGORIAS_RAPPI, UNIDAD_PESO_SHOPIFY_A_RAPPI } from "./rappi-catalog.js";
import { sugerirCategoriaAutomatica } from "./rappi-category-match.js";
import { calcularPrecioRappi } from "../utils/model.js";
import {
  obtenerEquivalenciaCategoria,
  guardarEquivalenciaCategoria,
} from "../storage/storage.js";

// Regla fija del negocio para V2 (ver instrucciones del proyecto):
// ningún producto de Panafargo se marca como pesable/preempaquetado.
const ES_PESABLE = "NO";
const ES_PREEMPAQUETADO = "NO";

const CATEGORIAS_VALIDAS = new Set(CATEGORIAS_RAPPI);
const CATEGORIA_PAPELERIA_POR_DEFECTO =
  "Papelería y oficina > Papelería > Otros Papelería";

export function validarCamposObligatoriosRappi(producto) {
  const faltantes = [];

  if (!producto.sku) {
    faltantes.push({ campo: "sku", motivo: "SKU no presente." });
  }
  if (!producto.nombre) {
    faltantes.push({ campo: "nombre", motivo: "Nombre no presente en Shopify." });
  }
  if (producto.precio_rappi == null) {
    faltantes.push({ campo: "precio", motivo: "Precio no disponible en Shopify." });
  }
  if (!producto.imagen_principal || !Array.isArray(producto.imagenes) || producto.imagenes.length === 0) {
    faltantes.push({ campo: "imagen", motivo: "Producto sin imagen." });
  }
  if (producto.inventario == null || !Number.isFinite(Number(producto.inventario))) {
    faltantes.push({ campo: "inventario", motivo: "Inventario no disponible en Shopify." });
  } else if (Number(producto.inventario) < 0) {
    faltantes.push({
      campo: "inventario",
      motivo: `Inventario negativo (${producto.inventario}); debe corregirse en Shopify.`,
    });
  }
  if (
    producto.peso == null ||
    !Number.isFinite(Number(producto.peso)) ||
    Number(producto.peso) <= 0
  ) {
    faltantes.push({ campo: "cantidad", motivo: "El producto no tiene un peso válido mayor que cero en Shopify." });
  }
  if (
    !producto.unidad_peso_shopify ||
    !UNIDAD_PESO_SHOPIFY_A_RAPPI[producto.unidad_peso_shopify]
  ) {
    faltantes.push({
      campo: "unidad_medida",
      motivo: producto.unidad_peso_shopify
        ? `La unidad de peso de Shopify "${producto.unidad_peso_shopify}" no tiene equivalente en el catálogo de unidades de Rappi.`
        : "El producto no tiene unidad de peso registrada en Shopify.",
    });
  }
  if (!producto.descripcion) {
    faltantes.push({
      campo: "descripcion",
      motivo: "El producto no tiene descripción en Shopify.",
    });
  }

  return faltantes;
}

/**
 * Transforma un PanafargoProduct al modelo Rappi.
 * @param {object} producto PanafargoProduct (ver utils/model.js)
 * @returns {Promise<{ok: true, sku: string, rappiProduct: object} | {ok: false, sku: string, faltantes: Array}>}
 */
export async function prepararParaRappi(producto) {
  // Recalcular también los productos cargados antes de cambiar la fórmula,
  // sin modificar el producto almacenado ni los precios publicados en Rappi.
  const precioRappi = calcularPrecioRappi(producto.precio, producto.precio_comparacion);
  const faltantes = validarCamposObligatoriosRappi({ ...producto, precio_rappi: precioRappi });

  // ---- Categoría: obligatoria, debe resolver a una categoría real de Rappi ----
  let categoriaRappi = null;
  let categoriaAutoAsignada = false;
  let categoriaPapeleriaPorDefecto = false;
  if (producto.categoria) {
    categoriaRappi = await obtenerEquivalenciaCategoria(producto.categoria);

    if (!CATEGORIAS_VALIDAS.has(categoriaRappi)) {
      categoriaRappi = null;
    }

    if (!categoriaRappi) {
      const sugerencia = sugerirCategoriaAutomatica(producto.categoria);
      categoriaPapeleriaPorDefecto = !sugerencia;
      categoriaRappi = sugerencia?.categoria || CATEGORIA_PAPELERIA_POR_DEFECTO;
      categoriaAutoAsignada = true;
      await guardarEquivalenciaCategoria(producto.categoria, categoriaRappi);
    }
  }
  if (!categoriaRappi) {
    categoriaRappi = CATEGORIA_PAPELERIA_POR_DEFECTO;
    categoriaAutoAsignada = true;
    categoriaPapeleriaPorDefecto = true;
  }
  if (!CATEGORIAS_VALIDAS.has(categoriaRappi)) {
    throw new Error(
      `La categoría automática "${categoriaRappi}" no existe en el catálogo oficial de Rappi. Actualiza rappi-catalog.js desde la plantilla vigente.`
    );
  }

  // ---- Cantidad / Unidad de medida: desde el peso registrado en Shopify ----
  const cantidad = producto.peso;
  const unidadMedida = UNIDAD_PESO_SHOPIFY_A_RAPPI[producto.unidad_peso_shopify] || null;

  if (faltantes.length > 0) {
    return { ok: false, sku: producto.sku, faltantes };
  }

  return {
    ok: true,
    sku: producto.sku,
    categoriaAutoAsignada,
    categoriaPapeleriaPorDefecto,
    rappiProduct: {
      categoria: categoriaRappi,
      nombre: producto.nombre,
      sku: producto.sku,
      marca: "",
      ean: producto.ean || "",
      descripcion: producto.descripcion,
      presentacion: producto.presentacion,
      precio: precioRappi,
      inventario: producto.inventario,
      disponible_para_venta: producto.disponible_para_venta,
      es_pesable: ES_PESABLE,
      es_preempaquetado: ES_PREEMPAQUETADO,
      cantidad,
      unidad_medida: unidadMedida,
    },
  };
}
