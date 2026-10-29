// ============================================================
// shopify/shopify-api.js
// ============================================================
// Comunicación con Shopify. Único módulo que conoce la forma real
// de la API y el manejo de credenciales — el resto de la extensión
// solo conoce PanafargoProduct (ver utils/model.js).
//
// Desde enero de 2026, las apps creadas en el Dev Dashboard ya no
// entregan un access token permanente (shpat_...) para pegar en
// config.js. En su lugar, la app guarda su Client ID + Client
// Secret y este módulo los intercambia por un access token temporal
// (client_credentials grant, expira ~24h) cada vez que hace falta,
// cacheándolo en chrome.storage.local para no pedirlo en cada SKU.
// ============================================================

import { SHOPIFY_CONFIG } from "./config.js";
import { logger } from "../utils/logger.js";
import { analizarSku, obtenerSkuBase } from "../utils/sku.js";

const GRAPHQL_QUERY = `
  query buscarProductosPorSku($query: String!, $after: String) {
    productVariants(first: 50, query: $query, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          title
          barcode
          price
          compareAtPrice
          inventoryQuantity
          availableForSale
          selectedOptions { name value }
          image { url altText }
          inventoryItem {
            measurement {
              weight { value unit }
            }
            tracked
          }
          product {
            id
            title
            status
            vendor
            productType
            category { fullName }
            descriptionHtml
            handle
            onlineStoreUrl
            tags
            featuredImage { url altText }
            images(first: 2) {
              edges { node { url altText } }
            }
          }
        }
      }
    }
  }
`;

function endpointGraphQL() {
  return `https://${SHOPIFY_CONFIG.shopDomain}/admin/api/${SHOPIFY_CONFIG.apiVersion}/graphql.json`;
}

function endpointToken() {
  return `https://${SHOPIFY_CONFIG.shopDomain}/admin/oauth/access_token`;
}

const KEY_TOKEN_CACHE = "panafargo_shopify_token";
// Renovamos el token 2 minutos antes de que expire, como margen de seguridad.
const MARGEN_EXPIRACION_MS = 2 * 60 * 1000;

/**
 * Devuelve un access token válido: reutiliza el cacheado en
 * chrome.storage.local si aún no está por expirar, o pide uno nuevo
 * a Shopify (client_credentials grant) en caso contrario.
 */
async function obtenerAccessToken() {
  const { [KEY_TOKEN_CACHE]: cache } = await chrome.storage.local.get(KEY_TOKEN_CACHE);

  if (cache?.access_token && cache.expires_at > Date.now() + MARGEN_EXPIRACION_MS) {
    return cache.access_token;
  }

  logger.info("Token de Shopify vencido o inexistente. Solicitando uno nuevo...");

  const response = await fetch(endpointToken(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CONFIG.clientId,
      client_secret: SHOPIFY_CONFIG.clientSecret,
    }),
  });

  let data = {};
  let rawText = "";
  try {
    rawText = await response.clone().text();
    data = JSON.parse(rawText);
  } catch (_) {
    // La respuesta no era JSON — nos quedamos con rawText tal cual.
  }

  if (!response.ok) {
    logger.error("Respuesta cruda del endpoint de token:", rawText);
    const detalle = data.error_description || data.error || rawText.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(`No se pudo obtener el token de Shopify: ${detalle}`);
  }

  if (!data.access_token) {
    throw new Error("Shopify no devolvió un access_token. Verifica que la app esté instalada en la tienda.");
  }

  const nuevoCache = {
    access_token: data.access_token,
    // expires_in viene en segundos (normalmente 86399 ≈ 24h).
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await chrome.storage.local.set({ [KEY_TOKEN_CACHE]: nuevoCache });

  logger.info(`Nuevo token de Shopify obtenido, expira en ~${Math.round(data.expires_in / 3600)}h.`);
  return nuevoCache.access_token;
}

// Escapar la sintaxis de búsqueda es independiente de serializar el JSON.
// El único comodín no escapado se añade expresamente para la búsqueda base.
function escaparLiteralBusqueda(sku) {
  return sku.replace(/[\\\s:()"'*<>!=\-]/gu, "\\$&");
}

async function consultarPaginaVariantes(accessToken, query, after) {
  const response = await fetch(endpointGraphQL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: { query, after },
    }),
  });

  if (response.status === 401) {
    // El token cacheado pudo haber sido revocado fuera de esta sesión.
    // Limpiamos la caché para forzar uno nuevo en el próximo intento.
    await chrome.storage.local.remove(KEY_TOKEN_CACHE);
    throw new Error("Shopify rechazó el token (401). Se limpió la caché; intenta buscar de nuevo.");
  }

  if (!response.ok) {
    throw new Error(`Error de conexión con Shopify (HTTP ${response.status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error("Shopify devolvió una respuesta JSON inválida.");
  }

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(
      "Shopify devolvió un error (revisa permisos/scopes de la app): " +
        data.errors.map((e) => e.message).join("; ")
    );
  }

  const variantes = data?.data?.productVariants;
  if (!Array.isArray(variantes?.edges) || typeof variantes?.pageInfo?.hasNextPage !== "boolean") {
    throw new Error("Shopify devolvió una respuesta de productos inválida.");
  }
  return variantes;
}

/**
 * Una base devuelve todas sus publicaciones; un SKU con / devuelve solo
 * coincidencias completas. La búsqueda de Shopify es amplia: el filtro
 * final evita confundir bases como 10498 y 10498-1. Se recorren todas las
 * páginas sin sustituir ni truncar el SKU original de cada variante.
 * @param {string} sku
 * @returns {Promise<{found: boolean, raws: object[], tipoBusqueda: "base"|"publicacion", skuBase: string}>}
 */
export async function buscarProductosPorSku(sku) {
  const { skuCompleto, skuBase, tipoBusqueda } = analizarSku(sku);
  const query = `sku:${escaparLiteralBusqueda(skuCompleto)}${tipoBusqueda === "base" ? "*" : ""}`;
  const accessToken = await obtenerAccessToken();
  const raws = [];
  const idsVistos = new Set();
  const cursoresVistos = new Set();
  let after = null;

  while (true) {
    const pagina = await consultarPaginaVariantes(accessToken, query, after);
    for (const edge of pagina.edges) {
      const node = edge?.node;
      if (typeof node?.sku !== "string") continue;
      const coincide = tipoBusqueda === "base"
        ? obtenerSkuBase(node.sku) === skuBase
        : node.sku === skuCompleto;
      if (!coincide || (node.id && idsVistos.has(node.id))) continue;
      if (node.id) idsVistos.add(node.id);
      raws.push(node);
    }

    if (!pagina.pageInfo.hasNextPage) break;
    const siguiente = pagina.pageInfo.endCursor;
    if (typeof siguiente !== "string" || !siguiente || cursoresVistos.has(siguiente)) {
      throw new Error("Shopify devolvió una paginación de productos inválida; no se usaron resultados parciales.");
    }
    cursoresVistos.add(siguiente);
    after = siguiente;
  }

  return { found: raws.length > 0, raws, tipoBusqueda, skuBase };
}
