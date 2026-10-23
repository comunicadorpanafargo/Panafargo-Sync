// ============================================================
// rappi/rappi-category-match.js
// ============================================================
// Sugiere automáticamente una categoría del catálogo REAL de Rappi
// (rappi-catalog.js) a partir de la categoría de Shopify
// (product_type), comparando palabras en común. Así el empleado ya
// no tiene que elegirla a mano en la mayoría de los casos.
//
// Es una sugerencia con umbral, no una adivinanza libre: si no hay
// suficiente coincidencia de palabras, no se asigna nada. El conector
// usa entonces una categoría genérica aceptada por la plantilla.
// ============================================================

import { CATEGORIAS_RAPPI } from "./rappi-catalog.js";

const STOPWORDS = new Set([
  "y", "de", "del", "la", "el", "los", "las", "en", "para", "con", "por", "un", "una", "unos", "unas", "o",
]);

// Al menos esta proporción de las palabras significativas de la
// categoría de Shopify debe aparecer en la categoría de Rappi.
const UMBRAL_MINIMO = 0.5;

const CATEGORIAS_TOKENIZADAS = CATEGORIAS_RAPPI.map((categoria) => ({
  categoria,
  tokens: tokenizar(categoria),
  tokensUltimoSegmento: tokenizar(categoria.split(">").pop()),
}));

/**
 * Devuelve la mejor categoría de Rappi que coincide con la categoría
 * de Shopify, o null si ninguna coincide lo suficiente.
 * @returns {{categoria: string, puntaje: number} | null}
 */
export function sugerirCategoriaAutomatica(categoriaShopify) {
  const tokensProducto = tokenizar(categoriaShopify || "");
  if (tokensProducto.size === 0) return null;

  let mejor = null;
  let mejorPuntaje = 0;

  for (const { categoria, tokens, tokensUltimoSegmento } of CATEGORIAS_TOKENIZADAS) {
    const interseccion = [...tokensProducto].filter((t) => tokens.has(t));
    if (interseccion.length === 0) continue;

    const proporcion = interseccion.length / tokensProducto.size;
    // Bono si la coincidencia cae en el segmento más específico
    // (el último tramo de "A > B > C"), no solo en las ramas generales.
    const coincideEnUltimoSegmento = interseccion.some((t) => tokensUltimoSegmento.has(t));
    const puntaje = proporcion + (coincideEnUltimoSegmento ? 0.5 : 0);

    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = categoria;
    }
  }

  if (!mejor || mejorPuntaje < UMBRAL_MINIMO) return null;
  return { categoria: mejor, puntaje: mejorPuntaje };
}

function tokenizar(texto) {
  return new Set(
    quitarAcentos(String(texto).toLowerCase())
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function quitarAcentos(texto) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
