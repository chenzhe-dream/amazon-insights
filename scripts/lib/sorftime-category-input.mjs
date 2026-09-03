/**
 * A category request is authoritative even when the optional SellerSprite
 * catalog has no matching row. Catalog metadata enriches the request but must
 * never decide whether Sorftime receives that ASIN.
 */
export function selectSorftimeCategoryInputs(catalogProducts, requestedAsins = null) {
  const catalogByAsin = new Map((catalogProducts ?? []).map(product => [product.asin, product]));
  if (!requestedAsins) return [...catalogByAsin.values()];

  return [...new Set(requestedAsins.map(asin => String(asin).trim().toUpperCase()).filter(Boolean))]
    .map(asin => catalogByAsin.get(asin) ?? { asin, subRankCategory: "" });
}
