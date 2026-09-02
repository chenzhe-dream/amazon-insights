export const SORFTIME_FBA_PACING_MS = 300;

function isTransportDemotedToolError(response) {
  const keys = Object.keys(response);
  return keys.length === 2
    && keys.includes("code")
    && keys.includes("message")
    && typeof response.code === "string"
    && response.code.trim().length > 0
    && typeof response.message === "string"
    && response.message.trim().length > 0;
}

export function shouldUseCachedSorftimeFbaRecord(record, { forceRefresh = false } = {}) {
  return !forceRefresh && record?.status === "ready" && record?.source === "sorftime";
}

export function requiresSorftimeFbaCredential(asins, records, { forceRefresh = false } = {}) {
  return (asins ?? []).some(asin => !shouldUseCachedSorftimeFbaRecord(records?.[asin], { forceRefresh }));
}

/**
 * Projects the documented Sorftime `product_detail` FBA fields into the local
 * FBA cache contract. Absence of `fba_fee` is a verified empty result; callers
 * must still propagate transport and provider failures rather than converting
 * them to an empty record.
 */
export function buildSorftimeFbaRecord({ asin, marketplace, fetchedAt, response }) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("Sorftime product_detail response must be an object");
  }
  if (response.isError === true || Object.hasOwn(response, "error")) {
    throw new TypeError("Sorftime product_detail returned a tool error");
  }
  if (isTransportDemotedToolError(response)) {
    throw new TypeError("Sorftime product_detail returned a transport-demoted tool error");
  }

  const detail = Object.hasOwn(response, "data") ? response.data : response;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new TypeError("Sorftime product_detail data must be an object");
  }

  const hasFee = Object.hasOwn(detail, "fba_fee");
  const rawFee = detail.fba_fee;
  if (hasFee && rawFee != null && (typeof rawFee !== "number" || !Number.isFinite(rawFee) || rawFee < 0)) {
    throw new TypeError("Sorftime product_detail fba_fee must be a finite non-negative number");
  }
  const fbaFee = positiveMoneyOrNull(rawFee);
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
import { positiveMoneyOrNull } from "./commerce-data-validity.mjs";
