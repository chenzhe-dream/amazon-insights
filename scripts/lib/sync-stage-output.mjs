import { createHash } from "node:crypto";
import path from "node:path";

import { readCachedDataExport } from "./sync-cache.mjs";
import { getProjectRoot } from "./project-root.mjs";

export const PROJECTABLE_SYNC_STAGE_IDS = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
];

const root = getProjectRoot();
const projectionSources = {
  keywords: {
    analysis: [path.join(root, "app", "sif-keyword-analysis-data.ts"), "sifKeywordAnalysisData"],
    enrichment: [path.join(root, "app", "sif-keyword-enrichment-data.ts"), "sifKeywordEnrichmentData"],
  },
  reviews: {
    analysis: [path.join(root, "app", "sorftime-review-analysis-data.ts"), "sorftimeReviewAnalysisData"],
    rating: [path.join(root, "app", "sorftime-rating-data.ts"), "sorftimeRatingData"],
  },
  sales_trend: {
    file: path.join(root, "app", "sorftime-sales-trend-data.ts"),
    exportName: "sorftimeSalesTrendData",
  },
  fba: {
    file: path.join(root, "app", "sorftime-fba-fee-data.ts"),
    exportName: "sorftimeFbaFeeData",
  },
  listing: {
    file: path.join(root, "app", "sorftime-listing-content-data.ts"),
    exportName: "sorftimeListingContentData",
  },
  category: {
    file: path.join(root, "app", "sorftime-category-trend-data.ts"),
    exportName: "sorftimeCategoryTrendData",
  },
  traffic: {
    listing: [path.join(root, "app", "sif-listing-traffic-raw-data.ts"), "sifListingTrafficRawByAsin"],
    monthly: [path.join(root, "app", "sif-monthly-traffic-trend-raw-data.ts"), "sifMonthlyTrafficRawByAsin"],
  },
  child_sales: {
    file: path.join(root, "app", "sorftime-child-sales-data.ts"),
    exportName: "sorftimeChildSales30d",
  },
  price_strategy: {
    file: path.join(root, "app", "sorftime-price-strategy-data.ts"),
    exportName: "sorftimePriceStrategies",
  },
  image_remarks: {
    remarks: [path.join(root, "app", "listing-image-remarks.ts"), "listingImageRemarks"],
    outcomes: [path.join(root, "app", "listing-image-remarks.ts"), "listingImageRemarksMeta"],
  },
};

const gapReasonCodes = new Set([
  "CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED",
  "SIF_KEYWORD_SCHEMA_INVALID", "MCP_SCHEMA",
]);

export function isProjectableSyncStage(stageId) {
  return PROJECTABLE_SYNC_STAGE_IDS.includes(stageId);
}

/**
 * @param {string} stageId
 * @param {readonly string[]} asins
 * @param {{
 *   stageStatus?: "done" | "partial" | "failed";
 *   gapReasonCode?: "CONNECT_TIMEOUT" | "UPSTREAM_EMPTY" | "CONNECTOR_FAILED" | "SIF_KEYWORD_SCHEMA_INVALID" | "MCP_SCHEMA";
 *   updatedAt?: string;
 *   now?: () => string;
 *   readExport?: (filePath: string, exportName: string) => unknown;
 *   organizationId?: string;
 *   projectId?: string;
 *   runId?: string;
 * }} options
 */
export function projectStageOutput(stageId, asins, {
  stageStatus = "done",
  gapReasonCode,
  gapItems = [],
  dataAsins,
  updatedAt,
  now = () => new Date().toISOString(),
  readExport = readCachedDataExport,
  organizationId,
  projectId,
  runId,
} = {}) {
  const source = projectionSources[stageId];
  if (!source) throw new TypeError(`Stage ${stageId} cannot be projected`);
  if (!["done", "partial", "failed"].includes(stageStatus)) {
    throw new TypeError("stageStatus must be done, partial, or failed");
  }
  const draft = {
    ...(organizationId ? { organizationId: String(organizationId) } : {}),
    ...(projectId ? { projectId: String(projectId) } : {}),
    ...(runId ? { runId: String(runId) } : {}),
    stage: stageId,
    stageStatus,
    updatedAt: updatedAt ?? now(),
  };
  const requestedAsins = [...new Set(asins.map((asin) => String(asin).trim().toUpperCase()))].sort();
  const projectedAsins = dataAsins === undefined ? requestedAsins : normalizeAsins(dataAsins);
  if (stageStatus === "failed") {
    const reasonCode = gapReasonCodes.has(gapReasonCode)
      ? gapReasonCode
      : stageStatus === "partial" ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED";
    const gap = boundedGap(stageStatus, reasonCode, gapItems, requestedAsins, projectedAsins);
    return { ...draft, gap, contentHash: hashCanonical({ stage: stageId, gap }) };
  }
  const data = projectDoneData(stageId, source, projectedAsins, readExport);
  if (stageStatus === "partial") {
    const reasonCode = gapReasonCodes.has(gapReasonCode) ? gapReasonCode : "UPSTREAM_EMPTY";
    const gap = boundedGap("partial", reasonCode, gapItems, requestedAsins, projectedAsins);
    return { ...draft, data, gap, contentHash: hashCanonical({ stage: stageId, data, gap }) };
  }
  return { ...draft, data, contentHash: hashCanonical({ stage: stageId, data }) };
}

function projectDoneData(stageId, source, asins, readExport) {
  if (stageId === "keywords") {
    const analysisByAsin = pickRequestedAsins(readSource(source.analysis, readExport), asins);
    const requestedKeywords = new Set(Object.values(analysisByAsin)
      .flatMap((record) => Array.isArray(record?.keywords) ? record.keywords : [])
      .flatMap((keyword) => typeof keyword?.keyword === "string" ? [keyword.keyword] : []));
    const enrichment = readSource(source.enrichment, readExport);
    return {
      analysisByAsin,
      enrichmentByKeyword: pickObjectKeys(enrichment, requestedKeywords),
    };
  }
  if (stageId === "reviews") return {
    analysisByAsin: pickRequestedAsins(readSource(source.analysis, readExport), asins),
    ratingByAsin: pickRequestedAsins(readSource(source.rating, readExport), asins),
  };
  if (stageId === "sales_trend") return {
    trendByAsin: pickRequestedAsins(readSource(source, readExport), asins),
  };
  if (stageId === "fba") return {
    feeByAsin: pickRequestedAsins(readSource(source, readExport), asins),
  };
  if (stageId === "listing") return {
    contentByAsin: pickRequestedAsins(readSource(source, readExport), asins),
  };
  if (stageId === "category") return {
    trendByNode: trendByNode(readSource(source, readExport), asins),
  };
  if (stageId === "child_sales") return {
    rowsByAsin: pickRequestedAsins(readSource(source, readExport), asins),
  };
  if (stageId === "price_strategy") return {
    strategyByAsin: pickRequestedAsins(readSource(source, readExport), asins),
  };
  if (stageId === "image_remarks") return {
    remarksByAsin: pickRequestedAsins(readSource(source.remarks, readExport), asins),
    outcomesByAsin: pickRequestedAsins(readImageOutcomes(source.outcomes, readExport), asins),
  };
  return {
    listingByAsin: normalizedTrafficListing(readSource(source.listing, readExport), asins),
    monthlyByAsin: normalizedMonthlyTraffic(readSource(source.monthly, readExport), asins),
  };
}

function normalizeAsins(asins) {
  return [...new Set((asins ?? []).map((asin) => String(asin).trim().toUpperCase()).filter(asin => /^[A-Z0-9]{10}$/.test(asin)))].sort();
}

function boundedGap(state, reasonCode, entries, requestedAsins, dataAsins) {
  const requested = new Set(requestedAsins);
  const ready = new Set(dataAsins);
  const byAsin = new Map();
  for (const raw of entries ?? []) {
    const item = sanitizeGapItem(raw);
    if (!item || !requested.has(item.asin) || ready.has(item.asin)) continue;
    const current = byAsin.get(item.asin);
    if (!current || JSON.stringify(item).length > JSON.stringify(current).length) byAsin.set(item.asin, item);
  }
  const items = [...byAsin.values()].sort((left, right) => left.asin.localeCompare(right.asin) || left.causeCode.localeCompare(right.causeCode)).slice(0, 32);
  return { state, reasonCode, ...(items.length ? { items } : {}) };
}

function sanitizeGapItem(raw) {
  const asin = String(raw?.asin ?? "").toUpperCase();
  const causeCode = gapReasonCodes.has(raw?.causeCode) ? raw.causeCode : null;
  if (!/^[A-Z0-9]{10}$/.test(asin) || !causeCode) return null;
  const item = { asin, causeCode };
  const operations = new Set(["tools/list", "asin_detail", "asin_sales_trend", "keepa_info", "review", "product_customers_say", "product_reviews", "product_detail", "product_trend", "product_variations", "category_name_search", "category_trend"]);
  const boundaries = new Set(["response-body", "rpc-envelope", "tool-content", "consumer-shape"]);
  if (operations.has(raw.operation)) item.operation = raw.operation;
  if (boundaries.has(raw.boundary)) item.boundary = raw.boundary;
  const shape = sanitizeShape(raw.shape);
  if (shape) item.shape = shape;
  return item;
}

function sanitizeShape(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const types = new Set(["unknown", "null", "array", "object", "string", "number", "boolean"]);
  const presences = new Set(["unknown", "missing", "present"]);
  const field = value => ({ presence: presences.has(value?.presence) ? value.presence : "unknown", type: types.has(value?.type) ? value.type : "unknown" });
  return { topLevelType: types.has(raw.topLevelType) ? raw.topLevelType : "unknown", data: field(raw.data), details: field(raw.details), items: field(raw.items) };
}

function readImageOutcomes(source, readExport) {
  const meta = readSource(source, readExport);
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? meta.imageOutcomesByAsin
    : {};
}

function readSource(source, readExport) {
  return Array.isArray(source) ? readExport(source[0], source[1]) : readExport(source.file, source.exportName);
}

function pickRequestedAsins(source, asins) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(asins.flatMap((asin) =>
    Object.hasOwn(source, asin) ? [[asin, source[asin]]] : []
  ));
}

function pickObjectKeys(source, keys) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries([...keys].sort().flatMap((key) =>
    Object.hasOwn(source, key) ? [[key, source[key]]] : []
  ));
}

function trendByNode(source, asins) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const requested = new Set(asins);
  const byNode = {};
  for (const [nodeId, rawRecord] of Object.entries(source)) {
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) continue;
    const record = rawRecord;
    if (!Array.isArray(record.asins)) continue;
    const selectedAsins = record.asins.filter((value) => requested.has(value));
    if (!selectedAsins.length) continue;
    byNode[nodeId] = Object.fromEntries(Object.entries(record)
      .filter(([key]) => categoryRecordKeys.has(key)));
    byNode[nodeId].asins = selectedAsins.sort();
  }
  return byNode;
}

function normalizedTrafficListing(source, asins) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(asins.flatMap((asin) => {
    const record = source[asin];
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const outerOverview = record.overview;
    const distribution = outerOverview?.overview;
    const total = finiteNumber(outerOverview?.total?.score ?? outerOverview?.total);
    const natural = finiteNumber(distribution?.nf?.score ?? outerOverview?.nf?.score);
    const advertising = finiteNumber(distribution?.ad?.score ?? outerOverview?.ad?.score);
    return [[asin, {
      ...(typeof record.fetchedAt === "string" ? { fetchedAt: record.fetchedAt } : {}),
      ...(total !== null ? { total } : {}),
      ...(natural !== null ? { natural } : {}),
      ...(advertising !== null ? { advertising } : {}),
    }]];
  }));
}

function normalizedMonthlyTraffic(source, asins) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(asins.flatMap((asin) => {
    const record = source[asin];
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const dates = Array.isArray(record.dates) ? record.dates : [];
    const natural = Array.isArray(record.nf) ? record.nf : [];
    const advertising = Array.isArray(record.ad) ? record.ad : [];
    return [[asin, {
      asin,
      points: dates.flatMap((month, index) => {
        if (typeof month !== "string") return [];
        const naturalValue = finiteNumber(natural[index]?.score) ?? 0;
        const advertisingValue = finiteNumber(advertising[index]?.score) ?? 0;
        return [{ month, natural: naturalValue, advertising: advertisingValue, total: naturalValue + advertisingValue }];
      }),
    }]];
  }));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const categoryRecordKeys = new Set([
  "nodeId", "categoryName", "topCategory", "asins", "marketplace", "fetchedAt", "status",
  "statusMessage", "volume", "avgPrice", "amount", "listingMonopoly", "brandMonopoly",
  "sellerMonopoly", "note",
]);

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
