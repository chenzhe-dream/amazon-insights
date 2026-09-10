const NUMERIC_ROW_FIELDS = [
  "traffic_share",
  "search_volume",
  "aba_rank",
  "cpc_median",
  "cpc_low",
  "cpc_min",
  "cpc_high",
  "cpc_max",
  "natural_ratio",
  "top3_click_share",
  "top3_conversion_share",
  "click_conversion_rate",
  "keyword_click_cvr",
];

const STRING_ROW_FIELDS = ["traffic_dependency", "organic_rank", "rank_evolution", "keyword_health"];
const SUMMARY_FIELDS = ["total_keywords_in_period", "top_keywords_analyzed"];

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalFiniteNumber(value) {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalString(value) {
  return value == null || typeof value === "string";
}

function invalidResult() {
  return {
    kind: "schema-invalid",
    errorCode: "SIF_KEYWORD_SCHEMA_INVALID",
    message: "SIF 关键词响应格式无效",
  };
}

function sanitizeRow(row) {
  if (!isRecord(row) || typeof row.keyword !== "string" || row.keyword.trim() === "") return null;

  if (NUMERIC_ROW_FIELDS.some(field => !isOptionalFiniteNumber(row[field]))) return null;
  if (STRING_ROW_FIELDS.some(field => !isOptionalString(row[field]))) return null;

  return Object.fromEntries(
    ["keyword", ...NUMERIC_ROW_FIELDS, ...STRING_ROW_FIELDS]
      .filter(field => hasOwn(row, field))
      .map(field => [field, row[field]]),
  );
}

export function adaptSifKeywordResponse(payload, requestedAsin, requestedMarketplace) {
  // Observed no-record envelope. Keep the allowlist exact so an error or a
  // conflicting data container cannot silently become an empty keyword set.
  if (isRecord(payload) && payload.message === "no data returned for this asin/period" &&
    Object.keys(payload).every(key => ["message", "data_notice"].includes(key)) &&
    isOptionalString(payload.data_notice)) {
    return { kind: "valid", topKeywords: [], summary: null, dataNotice: payload.data_notice ?? null };
  }
  if (!isRecord(payload) || !hasOwn(payload, "top_keywords") || !Array.isArray(payload.top_keywords)) {
    return invalidResult();
  }

  if (hasOwn(payload, "asin") && payload.asin !== requestedAsin) return invalidResult();
  if (hasOwn(payload, "marketplace") && payload.marketplace !== requestedMarketplace) return invalidResult();
  if (hasOwn(payload, "country") && payload.country !== requestedMarketplace) return invalidResult();
  if (!isOptionalString(payload.data_notice)) return invalidResult();

  if (payload.summary != null) {
    if (!isRecord(payload.summary)) return invalidResult();
    if (SUMMARY_FIELDS.some(field => !isOptionalFiniteNumber(payload.summary[field]))) return invalidResult();
  }

  const topKeywords = payload.top_keywords.map(sanitizeRow);
  if (topKeywords.some(row => row === null)) return invalidResult();

  return {
    kind: "valid",
    topKeywords,
    summary: payload.summary
      ? Object.fromEntries(
          SUMMARY_FIELDS.filter(field => hasOwn(payload.summary, field)).map(field => [field, payload.summary[field]]),
        )
      : null,
    dataNotice: payload.data_notice ?? null,
  };
}
