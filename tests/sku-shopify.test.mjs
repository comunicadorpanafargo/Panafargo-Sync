import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
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
  };
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
