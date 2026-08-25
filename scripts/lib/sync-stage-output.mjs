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
    file: path.join(root, "app", "sif-keyword-analysis-data.ts"),
    exportName: "sifKeywordAnalysisData",
    dataKey: "keywordByAsin",
  },
  reviews: {
    file: path.join(root, "app", "sorftime-review-analysis-data.ts"),
    exportName: "sorftimeReviewAnalysisData",
    dataKey: "reviewByAsin",
  },
  sales_trend: {
    file: path.join(root, "app", "sorftime-sales-trend-data.ts"),
    exportName: "sorftimeSalesTrendData",
    dataKey: "trendByAsin",
  },
  fba: {
    file: path.join(root, "app", "sorftime-fba-fee-data.ts"),
    exportName: "sorftimeFbaFeeData",
    dataKey: "feeByAsin",
  },
  listing: {
    file: path.join(root, "app", "sorftime-listing-content-data.ts"),
    exportName: "sorftimeListingContentData",
    dataKey: "listingByAsin",
  },
  category: {
    file: path.join(root, "app", "sorftime-category-trend-data.ts"),
    exportName: "sorftimeCategoryTrendData",
    dataKey: "categoryByAsin",
  },
  traffic: {
    file: path.join(root, "app", "sif-listing-traffic-raw-data.ts"),
    exportName: "sifListingTrafficRawByAsin",
    dataKey: "trafficByAsin",
  },
};

const gapReasonCodes = new Set(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED"]);

export function isProjectableSyncStage(stageId) {
  return PROJECTABLE_SYNC_STAGE_IDS.includes(stageId);
}

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
  const sourceData = readExport(source.file, source.exportName);
  const data = stageId === "category"
    ? { [source.dataKey]: categoryByAsin(sourceData, requestedAsins) }
    : { [source.dataKey]: pickRequestedAsins(sourceData, requestedAsins) };
  return { ...draft, data, contentHash: hashCanonical({ stage: stageId, data }) };
}

function pickRequestedAsins(source, asins) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(asins.flatMap((asin) =>
    Object.hasOwn(source, asin) ? [[asin, source[asin]]] : []
  ));
}

function categoryByAsin(source, asins) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const requested = new Set(asins);
  const direct = pickRequestedAsins(source, asins);
  if (Object.keys(direct).length > 0) return direct;
  const byAsin = Object.fromEntries(asins.map((asin) => [asin, []]));
  for (const [category, rawRecord] of Object.entries(source)) {
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) continue;
    const record = rawRecord;
    if (!Array.isArray(record.asins)) continue;
    for (const asin of record.asins.filter((value) => requested.has(value))) {
      byAsin[asin].push({ category, ...record, asins: [asin] });
    }
  }
  return Object.fromEntries(Object.entries(byAsin).filter(([, records]) => records.length > 0));
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
