/** Shared pure source selection; exporting must never start a translation job. */
export function readOriginalSellingPoints(product: { listingBullets?: unknown; strengths?: unknown }) {
  const full = Array.isArray(product.listingBullets);
  const source = full ? product.listingBullets : product.strengths;
  const original = (Array.isArray(source) ? source : []).filter((value): value is string =>
    typeof value === "string" && Boolean(value.trim()) && !/[…]|\.{3}$|同步中|待.*分析/.test(value)).map(value => value.trim());
  return { original, sourceComplete: full && original.length === (source as unknown[]).length };
}
