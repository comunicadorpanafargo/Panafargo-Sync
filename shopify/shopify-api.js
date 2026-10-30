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

const GRAPHQL_QUERY = `
  query buscarProductoPorSku($query: String!) {
    productVariants(first: 1, query: $query) {
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
            tags
            featuredImage { url altText }
            images(first: 10) {
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

/**
 * Consulta un producto en Shopify a partir de su SKU.
 * @param {string} sku
 * @returns {Promise<{found: boolean, raw?: object}>}
 */
export async function buscarProductoPorSku(sku) {
  if (!sku || !sku.trim()) {
    throw new Error("SKU vacío.");
  }

  const accessToken = await obtenerAccessToken();

  const response = await fetch(endpointGraphQL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: { query: `sku:${sku.trim()}` },
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

  const data = await response.json();

  if (data.errors) {
    throw new Error(
      "Shopify devolvió un error (revisa permisos/scopes de la app): " +
        data.errors.map((e) => e.message).join("; ")
    );
  }

  const edge = data?.data?.productVariants?.edges?.[0];
  if (!edge) {
    return { found: false };
  }

  return { found: true, raw: edge.node };
}
