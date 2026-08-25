function toFiniteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Projects the documented Sorftime `product_detail` FBA fields into the local
 * FBA cache contract. Absence of `fba_fee` is a verified empty result; callers
 * must still propagate transport and provider failures rather than converting
 * them to an empty record.
 */
export function buildSorftimeFbaRecord({ asin, marketplace, fetchedAt, response }) {
  const detail = response?.data ?? response ?? {};
  const fbaFee = toFiniteNonNegativeNumber(detail?.fba_fee);
  const packageSize = typeof detail?.package_size_cm === "string" && detail.package_size_cm.trim()
    ? detail.package_size_cm.trim()
    : null;

  return {
    asin,
    marketplace,
    fetchedAt,
    status: fbaFee == null ? "empty" : "ready",
    source: "sorftime",
    fbaFee,
    ...(packageSize ? { packageSize } : {}),
  };
}
