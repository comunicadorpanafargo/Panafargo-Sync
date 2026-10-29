import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { desdeShopify } from "../utils/model.js";
import {
  analizarSku,
  esSkuPublicacion,
  normalizarSkuCompleto,
  obtenerDisenoSku,
  obtenerSkuBase,
} from "../utils/sku.js";

// Cargar el módulo real con una configuración ficticia en memoria. Nunca se
// crea ni lee shopify/config.js, que contiene las credenciales locales reales.
const apiUrl = new URL("../shopify/shopify-api.js", import.meta.url);
const source = (await readFile(apiUrl, "utf8"))
  .replace('import { SHOPIFY_CONFIG } from "./config.js";', `const SHOPIFY_CONFIG = {
    shopDomain: "prueba.myshopify.com", apiVersion: "2026-10",
    clientId: "cliente-ficticio", clientSecret: "secreto-ficticio"
  };`)
  .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, relative) => `from "${new URL(relative, apiUrl).href}"`);
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { buscarProductosPorSku } = api;
const globals = { fetch: globalThis.fetch, chrome: globalThis.chrome };
let cache;
let requests;
let removed;

beforeEach(() => {
  cache = { access_token: "token-ficticio", expires_at: Date.now() + 3600000 };
  requests = [];
  removed = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: cache }),
        set: async (values) => { cache = values.panafargo_shopify_token; },
        remove: async (key) => { removed.push(key); cache = undefined; },
      },
    },
  };
  globalThis.fetch = async () => { throw new Error("Solicitud no simulada: las pruebas no usan la red."); };
});

after(() => {
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

function variant(sku, id = sku) {
  return {
    id: `gid://shopify/ProductVariant/${id}`, sku, title: "Diseño de prueba",
    image: { url: `https://example.invalid/${encodeURIComponent(sku)}.jpg`, altText: "Diseño" },
    inventoryQuantity: 3,
    product: {
      id: `gid://shopify/Product/${id}`,
      featuredImage: null,
      images: imagePage([]),
    },
  };
}

function imagePage(urls, hasNextPage = false, endCursor = null) {
  return { edges: urls.map((url) => ({ node: { url, altText: "Foto de prueba" } })), pageInfo: { hasNextPage, endCursor } };
}

function imagesResponse(id, urls, hasNextPage = false, endCursor = null) {
  return { data: { product: { id, images: imagePage(urls, hasNextPage, endCursor) } } };
}

function page(nodes, hasNextPage = false, endCursor = null) {
  return { data: { productVariants: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor } } } };
}

function mockPages(pages) {
  globalThis.fetch = async (url, options) => {
    assert.ok(url.endsWith("/admin/api/2026-10/graphql.json"));
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.ok(requests.length <= pages.length, "No repetir indefinidamente la paginación.");
    return new Response(JSON.stringify(pages[requests.length - 1]), { status: 200 });
  };
}

test("la base solo termina en el primer / y conserva los guiones", () => {
  assert.equal(obtenerSkuBase(" 10498-1/azul/brillante "), "10498-1");
  assert.equal(obtenerDisenoSku("10498-1/azul/brillante"), "azul/brillante");
  assert.equal(normalizarSkuCompleto(" 10498-1/azul "), "10498-1/azul");
  assert.equal(esSkuPublicacion("10498-1"), false);
  assert.equal(esSkuPublicacion("10498-1/azul"), true);
  assert.deepEqual(analizarSku(" 10498-1 "), { skuCompleto: "10498-1", skuBase: "10498-1", tipoBusqueda: "base" });
  assert.deepEqual(analizarSku("10498-1/azul"), { skuCompleto: "10498-1/azul", skuBase: "10498-1", tipoBusqueda: "publicacion" });
});

test("los helpers de comparación admiten datos ausentes sin inventar un SKU", () => {
  assert.equal(normalizarSkuCompleto(null), "");
  assert.equal(obtenerSkuBase(undefined), "");
  assert.equal(obtenerDisenoSku("10498"), "");
});

test("las entradas inválidas se rechazan antes de consultar Shopify", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("No debe llamarse"); };
  for (const sku of [null, "", "  ", "/azul", "10498/", "10498//azul", "104\n98/azul"]) {
    await assert.rejects(buscarProductosPorSku(sku), /SKU|base|control/);
  }
  assert.equal(calls, 0);
});

test("una base expande todas sus publicaciones a través de las páginas", async () => {
  const wanted = [variant("10498/azul"), variant("10498/rojo"), variant("10498/verde/claro")];
  mockPages([
    page([wanted[0], variant("10498-1/azul"), variant("104980/rojo")], true, "pagina-2"),
    page([wanted[1], wanted[2]]),
  ]);
  const result = await buscarProductosPorSku("10498");
  assert.deepEqual(result, { found: true, raws: wanted, tipoBusqueda: "base", skuBase: "10498" });
  assert.deepEqual(requests.map((r) => r.variables.after), [null, "pagina-2"]);
  assert.ok(requests.every((r) => r.variables.query === "sku:10498*"));
  assert.match(requests[0].query, /pageInfo\s*\{\s*hasNextPage endCursor\s*\}/);
  assert.match(requests[0].query, /image\s*\{\s*url altText\s*\}/);
  assert.match(requests[0].query, /onlineStoreUrl/);
  assert.match(requests[0].query, /images\(first:\s*2\)/);
  assert.equal(result.raws[2].sku, "10498/verde/claro");
  assert.equal(result.raws[0].image.url, wanted[0].image.url);
});

test("la base sin diseños también es una publicación válida y no incluye bases parecidas", async () => {
  const raw = variant("10498-1");
  mockPages([page([variant("10498"), raw, variant("10498-10/azul"), variant("10498-1/rojo")])]);
  const result = await buscarProductosPorSku("10498-1");
  assert.deepEqual(result.raws.map((r) => r.sku), ["10498-1", "10498-1/rojo"]);
  assert.equal(result.skuBase, "10498-1");
  assert.equal(requests[0].variables.query, String.raw`sku:10498\-1*`);
});

test("un SKU completo solo devuelve su diseño exacto y no usa comodín", async () => {
  const exact = variant("10498/azul");
  mockPages([
    page([variant("10498/azul-claro"), variant("10498/azul/otro")], true, "segunda"),
    page([exact, variant("10498/rojo")]),
  ]);
  assert.deepEqual(await buscarProductosPorSku(" 10498/azul "), {
    found: true, raws: [exact], tipoBusqueda: "publicacion", skuBase: "10498",
  });
  assert.ok(requests.every((r) => r.variables.query === "sku:10498/azul"));
});

test("no convierte una coincidencia parcial en un SKU encontrado", async () => {
  mockPages([page([variant("10498-1/azul"), variant("104980/azul")])]);
  assert.deepEqual(await buscarProductosPorSku("10498"), {
    found: false, raws: [], tipoBusqueda: "base", skuBase: "10498",
  });
});

test("diez bases pueden dar catorce publicaciones sin perder sus SKU completos", async () => {
  const bases = Array.from({ length: 10 }, (_, i) => String(10490 + i));
  const all = bases.flatMap((base, i) => i < 4 ? [variant(`${base}/A`), variant(`${base}/B`)] : [variant(base)]);
  mockPages(bases.map(() => page(all)));
  const results = [];
  for (const base of bases) results.push(await buscarProductosPorSku(base));
  assert.equal(new Set(results.map((r) => r.skuBase)).size, 10);
  assert.equal(results.flatMap((r) => r.raws).length, 14);
  assert.equal(new Set(results.flatMap((r) => r.raws.map((v) => v.sku))).size, 14);
});

test("escapa los caracteres reservados del SKU, incluidos operadores aparentes", async () => {
  const sku = '10498/azul" OR sku:*';
  mockPages([page([variant(sku)])]);
  const result = await buscarProductosPorSku(sku);
  assert.equal(result.raws[0].sku, sku);
  assert.equal(requests[0].variables.query, String.raw`sku:10498/azul\"\ OR\ sku\:\*`);
});

test("un ID repetido entre páginas no duplica una publicación", async () => {
  const repeated = variant("10498/azul", "1");
  mockPages([page([repeated], true, "segunda"), page([repeated, variant("10498/rojo", "2")])]);
  const result = await buscarProductosPorSku("10498");
  assert.equal(result.raws.length, 2);
});

test("recupera todas las imágenes adicionales sin cambiar foto principal, precio ni inventario", async () => {
  const raw = variant("40105");
  raw.price = "6900";
  raw.compareAtPrice = "7000";
  raw.product.featuredImage = { url: "https://example.invalid/principal.jpg" };
  raw.image = { url: "https://example.invalid/principal.jpg" };
  raw.product.images = imagePage([
    raw.image.url,
    "https://example.invalid/secundaria-1.jpg",
  ], true, "foto-2");
  mockPages([
    page([raw]),
    imagesResponse(raw.product.id, ["https://example.invalid/secundaria-2.jpg", "https://example.invalid/secundaria-3.jpg"]),
  ]);
  const result = await buscarProductosPorSku("40105");
  const producto = desdeShopify(result.raws[0]);
  assert.deepEqual(producto.imagenes, [raw.image.url, ...[1, 2, 3].map((i) => `https://example.invalid/secundaria-${i}.jpg`)]);
  assert.equal(producto.imagen_principal, raw.image.url);
  assert.equal(producto.imagenes_completas, true);
  assert.equal(producto.precio, 6900);
  assert.equal(producto.precio_comparacion, 7000);
  assert.equal(producto.inventario, 3);
  assert.match(requests[1].query, /images\(first:\s*250, after:\s*\$after\)/);
  assert.deepEqual(requests[1].variables, { id: raw.product.id, after: "foto-2" });
});

test("la galería completa se consulta una sola vez para las variantes del mismo producto", async () => {
  const azul = variant("10498/azul", "azul");
  const rojo = variant("10498/rojo", "rojo");
  const comunes = ["https://example.invalid/comun-1.jpg", "https://example.invalid/comun-2.jpg"];
  azul.product.images = imagePage(comunes, true, "foto-2");
  rojo.product = { ...azul.product };
  mockPages([
    page([azul, rojo]),
    imagesResponse(azul.product.id, ["https://example.invalid/comun-3.jpg"]),
  ]);
  const result = await buscarProductosPorSku("10498");
  assert.equal(requests.length, 2);
  assert.equal(result.raws[0].product.images.edges.length, 3);
  assert.deepEqual(result.raws[1].product.images, result.raws[0].product.images);
  assert.equal(desdeShopify(result.raws[0]).imagen_principal, azul.image.url);
  assert.equal(desdeShopify(result.raws[1]).imagen_principal, rojo.image.url);
  assert.equal(desdeShopify(result.raws[0]).inventario, azul.inventoryQuantity);
  assert.equal(desdeShopify(result.raws[1]).inventario, rojo.inventoryQuantity);
});

test("pagina toda la galería y deduplica fotos sin perder su orden en el modelo", async () => {
  const raw = variant("40105");
  const fotos = Array.from({ length: 255 }, (_, i) => `https://example.invalid/foto-${i}.jpg`);
  raw.image = { url: fotos[0] };
  raw.product.featuredImage = { url: fotos[0] };
  raw.product.images = imagePage(fotos.slice(0, 2), true, "foto-2");
  mockPages([
    page([raw]),
    imagesResponse(raw.product.id, fotos.slice(2, 252), true, "foto-252"),
    imagesResponse(raw.product.id, [...fotos.slice(252), fotos[1]]),
  ]);
  const result = await buscarProductosPorSku("40105");
  assert.deepEqual(desdeShopify(result.raws[0]).imagenes, fotos);
  assert.equal(desdeShopify(result.raws[0]).imagenes_completas, true);
  assert.deepEqual(requests.slice(1).map((r) => r.variables.after), ["foto-2", "foto-252"]);
});

test("sin imagen de variante conserva el fallback featured y todas las secundarias", async () => {
  const raw = variant("40105");
  raw.image = null;
  raw.product.featuredImage = { url: "https://example.invalid/featured.jpg" };
  raw.product.images = imagePage(["https://example.invalid/otra-1.jpg", "https://example.invalid/otra-2.jpg"], true, "foto-2");
  mockPages([
    page([raw]),
    imagesResponse(raw.product.id, ["https://example.invalid/otra-3.jpg"]),
  ]);
  const producto = desdeShopify((await buscarProductosPorSku("40105")).raws[0]);
  assert.equal(producto.imagen_principal, raw.product.featuredImage.url);
  assert.deepEqual(producto.imagenes, [raw.product.featuredImage.url, ...[1, 2, 3].map((i) => `https://example.invalid/otra-${i}.jpg`)]);
  assert.equal(producto.imagenes_completas, true);
});

test("las galerías antiguas sin pageInfo y las páginas incompletas no se marcan como completas", () => {
  for (const pageInfo of [undefined, { hasNextPage: true, endCursor: "foto-2" }]) {
    const raw = variant("40105");
    raw.product.images = imagePage(["https://example.invalid/1.jpg", "https://example.invalid/2.jpg"]);
    if (pageInfo === undefined) delete raw.product.images.pageInfo;
    else raw.product.images.pageInfo = pageInfo;
    const producto = desdeShopify(raw);
    assert.equal(producto.imagenes_completas, false);
    assert.equal(producto.imagen_principal, raw.image.url);
    assert.equal(producto.imagenes.length, 3, "Las fotos siguen visibles mientras se actualiza su integridad.");
  }
});

test("galería vacía confirmada conserva el marcador completo y los fallback de imagen", async () => {
  const variante = variant("40105");
  const featured = variant("40106");
  featured.image = null;
  featured.product.featuredImage = { url: "https://example.invalid/featured.jpg" };
  mockPages([page([variante]), page([featured])]);
  const desdeVariante = desdeShopify((await buscarProductosPorSku("40105")).raws[0]);
  const desdeFeatured = desdeShopify((await buscarProductosPorSku("40106")).raws[0]);
  assert.equal(desdeVariante.imagenes_completas, true);
  assert.equal(desdeFeatured.imagenes_completas, true);
  assert.deepEqual(desdeVariante.imagenes, [variante.image.url]);
  assert.deepEqual(desdeFeatured.imagenes, [featured.product.featuredImage.url]);
});

for (const [nombre, cursor, siguientes] of [
  ["cursor ausente", null, []],
  ["cursor repetido", "foto-2", [imagesResponse("gid://shopify/Product/40105", ["https://example.invalid/3.jpg"], true, "foto-2")]],
]) {
  test(`no devuelve una galería parcial si la paginación falla: ${nombre}`, async () => {
    const raw = variant("40105");
    raw.product.images = imagePage(["https://example.invalid/1.jpg", "https://example.invalid/2.jpg"], true, cursor);
    mockPages([page([raw]), ...siguientes]);
    await assert.rejects(buscarProductosPorSku("40105"), /paginación de imágenes inválida.*no se usaron imágenes parciales/);
  });
}

test("un error de Shopify al completar las fotos cancela el resultado parcial", async () => {
  const raw = variant("40105");
  raw.product.images = imagePage(["https://example.invalid/1.jpg"], true, "foto-1");
  mockPages([page([raw]), { errors: [{ message: "No se pudo obtener la galería" }] }]);
  await assert.rejects(buscarProductosPorSku("40105"), /No se pudo obtener la galería/);
});

test("un 401 durante la paginación de imágenes invalida el token", async () => {
  const raw = variant("40105");
  raw.product.images = imagePage(["https://example.invalid/1.jpg"], true, "foto-1");
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response(JSON.stringify(page([raw])))
    : new Response("{}", { status: 401 });
  await assert.rejects(buscarProductosPorSku("40105"), /401/);
  assert.equal(calls, 2);
  assert.deepEqual(removed, ["panafargo_shopify_token"]);
});

test("no acepta una galería perteneciente a otro producto", async () => {
  const raw = variant("40105");
  raw.product.images = imagePage(["https://example.invalid/1.jpg"], true, "foto-1");
  mockPages([page([raw]), imagesResponse("gid://shopify/Product/otro", ["https://example.invalid/otra.jpg"])]);
  await assert.rejects(buscarProductosPorSku("40105"), /producto esperado/);
});

for (const conexion of [null, { edges: [] }, { edges: [{ node: {} }], pageInfo: { hasNextPage: false } }]) {
  test(`no presenta una galería incompleta como válida: ${JSON.stringify(conexion)}`, async () => {
    const raw = variant("40105");
    raw.product.images = conexion;
    mockPages([page([raw])]);
    await assert.rejects(buscarProductosPorSku("40105"), /galería de imágenes inválida.*no se usaron imágenes parciales/);
  });
}

test("no colapsa variantes distintas solo porque comparten un SKU", async () => {
  mockPages([page([variant("10498/azul", "1"), variant("10498/azul", "2")])]);
  assert.equal((await buscarProductosPorSku("10498/azul")).raws.length, 2);
});

test("respuesta vacía válida conserva el contrato de búsqueda", async () => {
  mockPages([page([])]);
  assert.deepEqual(await buscarProductosPorSku("10498/rojo"), {
    found: false, raws: [], tipoBusqueda: "publicacion", skuBase: "10498",
  });
});

for (const [name, pages] of [
  ["cursor ausente", [page([variant("10498/azul")], true, null)]],
  ["cursor repetido", [page([variant("10498/azul")], true, "igual"), page([variant("10498/rojo")], true, "igual")]],
]) {
  test(`la paginación inválida rechaza resultados parciales: ${name}`, async () => {
    mockPages(pages);
    await assert.rejects(buscarProductosPorSku("10498"), /paginación.*inválida/);
  });
}

test("401 invalida el token y no devuelve una página parcial", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response(JSON.stringify(page([variant("10498/azul")], true, "segunda")))
    : new Response("{}", { status: 401 });
  await assert.rejects(buscarProductosPorSku("10498"), /401/);
  assert.equal(calls, 2);
  assert.deepEqual(removed, ["panafargo_shopify_token"]);
  assert.equal(cache, undefined);
});

test("un error HTTP no se presenta como SKU no encontrado", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  await assert.rejects(buscarProductosPorSku("10498"), /HTTP 500/);
});

test("los errores GraphQL se conservan", async () => {
  mockPages([{ errors: [{ message: "Falta read_products" }] }]);
  await assert.rejects(buscarProductosPorSku("10498"), /read_products/);
});

for (const data of [null, {}, { data: { productVariants: { edges: [] } } }]) {
  test(`una respuesta incompleta no se presenta como resultado vacío: ${JSON.stringify(data)}`, async () => {
    mockPages([data]);
    await assert.rejects(buscarProductosPorSku("10498"), /respuesta de productos inválida/);
  });
}

test("el JSON inválido se informa como fallo de Shopify", async () => {
  globalThis.fetch = async () => new Response("no-json", { status: 200 });
  await assert.rejects(buscarProductosPorSku("10498"), /JSON inválida/);
});

test("si no hay token vigente lo obtiene antes de buscar", async () => {
  cache = undefined;
  const endpoints = [];
  globalThis.fetch = async (url) => {
    endpoints.push(url);
    return url.endsWith("/admin/oauth/access_token")
      ? new Response(JSON.stringify({ access_token: "token-renovado-ficticio", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify(page([variant("10498/azul")])));
  };
  assert.equal((await buscarProductosPorSku("10498")).raws.length, 1);
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints[0].endsWith("/admin/oauth/access_token"));
  assert.equal(cache.access_token, "token-renovado-ficticio");
});
