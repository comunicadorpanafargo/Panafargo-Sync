// Identidad de SKU compartida por todos los mercados: el código completo
// identifica una publicación; solo el texto anterior al primer / es la base.

export function normalizarSkuCompleto(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

export function obtenerSkuBase(valor) {
  return normalizarSkuCompleto(valor).split("/", 1)[0];
}

export function obtenerDisenoSku(valor) {
  const completo = normalizarSkuCompleto(valor);
  const separador = completo.indexOf("/");
  return separador < 0 ? "" : completo.slice(separador + 1);
}

export function esSkuPublicacion(valor) {
  return normalizarSkuCompleto(valor).includes("/");
}

export function analizarSku(valor) {
  const skuCompleto = normalizarSkuCompleto(valor);
  if (!skuCompleto) throw new Error("SKU vacío.");
  if (/[\u0000-\u001f\u007f]/u.test(skuCompleto)) {
    throw new Error("El SKU contiene caracteres de control no válidos.");
  }
  if (skuCompleto.split("/").some((parte) => !parte.trim())) {
    throw new Error("El SKU debe incluir una base y un código después de cada /.");
  }
  return {
    skuCompleto,
    skuBase: obtenerSkuBase(skuCompleto),
    tipoBusqueda: esSkuPublicacion(skuCompleto) ? "publicacion" : "base",
  };
}
