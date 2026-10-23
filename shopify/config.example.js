// ============================================================
// shopify/config.example.js
// ============================================================
// Este es el ÚNICO archivo con la forma de las credenciales que se
// sube al repositorio. Es una plantilla, no contiene datos reales.
//
// Para trabajar:
//   1. Copia este archivo y renómbralo a "config.js"
//        cp shopify/config.example.js shopify/config.js
//   2. Reemplaza los valores de ejemplo por los reales de la tienda.
//   3. "config.js" YA está en .gitignore: nunca se sube al repo.
// ============================================================

export const SHOPIFY_CONFIG = {
  // Dominio de la tienda, tal cual aparece en el admin de Shopify.
  shopDomain: "tu-tienda.myshopify.com",

  // Client ID y Client Secret de la app creada en el Dev Dashboard
  // de Shopify (dev.shopify.com → tu app → Settings → API credentials).
  // shopify-api.js los usa para pedir un access token temporal
  // (client_credentials grant); no hace falta pegar un token a mano.
  clientId: "TU_CLIENT_ID",
  clientSecret: "TU_CLIENT_SECRET",

  // Versión de la API Admin de Shopify a utilizar.
  apiVersion: "2024-10",
};
