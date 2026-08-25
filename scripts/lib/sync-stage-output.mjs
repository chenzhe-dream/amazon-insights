import { createHash } from "node:crypto";
import path from "node:path";

import { readCachedDataExport } from "./sync-cache.mjs";
import { getProjectRoot } from "./project-root.mjs";

export const PROJECTABLE_SYNC_STAGE_IDS = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
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
};

const gapReasonCodes = new Set(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED"]);

export function isProjectableSyncStage(stageId) {
  return PROJECTABLE_SYNC_STAGE_IDS.includes(stageId);
}

/**
 * @param {"keywords" | "reviews" | "sales_trend" | "fba" | "listing" | "category" | "traffic"} stageId
 * @param {readonly string[]} asins
 * @param {{
 *   stageStatus?: "done" | "partial" | "failed";
 *   gapReasonCode?: "CONNECT_TIMEOUT" | "UPSTREAM_EMPTY" | "CONNECTOR_FAILED";
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
  if (stageStatus !== "done") {
    const reasonCode = gapReasonCodes.has(gapReasonCode)
      ? gapReasonCode
      : stageStatus === "partial" ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED";
    const gap = { state: stageStatus, reasonCode };
    return { ...draft, gap, contentHash: hashCanonical({ stage: stageId, gap }) };
  }
  const requestedAsins = [...new Set(asins.map((asin) => String(asin).trim().toUpperCase()))].sort();
  const data = projectDoneData(stageId, source, requestedAsins, readExport);
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
  return {
    listingByAsin: normalizedTrafficListing(readSource(source.listing, readExport), asins),
    monthlyByAsin: normalizedMonthlyTraffic(readSource(source.monthly, readExport), asins),
  };
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
