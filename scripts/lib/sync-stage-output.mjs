import { imageRemarkOutcome } from "./image-remark-outcome.mjs";
import { createHash } from "node:crypto";
import { generatedAppDataPath } from "./generated-app-data-path.mjs";

import { readCachedDataExport } from "./sync-cache.mjs";
import { getProjectRoot } from "./project-root.mjs";
import { selectReviewEvidence, selectReviewObservation, reviewFallbackEnabled } from "./uk-review-fallback.mjs";

export const PROJECTABLE_SYNC_STAGE_IDS = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
];

const root = getProjectRoot();
const projectionSources = {
  keywords: {
    analysis: [generatedAppDataPath(root, "sif-keyword-analysis-data.ts"), "sifKeywordAnalysisData"],
    enrichment: [generatedAppDataPath(root, "sif-keyword-enrichment-data.ts"), "sifKeywordEnrichmentData"],
  },
  reviews: {
    analysis: [generatedAppDataPath(root, "sorftime-review-analysis-data.ts"), "sorftimeReviewAnalysisData"],
    sellerSprite: [generatedAppDataPath(root, "seller-sprite-mcp-review-analysis-data.ts"), "sellerSpriteMcpReviewAnalysisData"],
    context: [generatedAppDataPath(root, "review-context-data.ts"), "reviewContextData"],
    rating: [generatedAppDataPath(root, "sorftime-rating-data.ts"), "sorftimeRatingData"],
  },
  sales_trend: {
    file: generatedAppDataPath(root, "sorftime-sales-trend-data.ts"),
    exportName: "sorftimeSalesTrendData",
  },
  fba: {
    file: generatedAppDataPath(root, "sorftime-fba-fee-data.ts"),
    exportName: "sorftimeFbaFeeData",
  },
  listing: {
    file: generatedAppDataPath(root, "sorftime-listing-content-data.ts"),
    exportName: "sorftimeListingContentData",
  },
  category: {
    file: generatedAppDataPath(root, "sorftime-category-trend-data.ts"),
    exportName: "sorftimeCategoryTrendData",
  },
  traffic: {
    listing: [generatedAppDataPath(root, "sif-listing-traffic-raw-data.ts"), "sifListingTrafficRawByAsin"],
    monthly: [generatedAppDataPath(root, "sif-monthly-traffic-trend-raw-data.ts"), "sifMonthlyTrafficRawByAsin"],
  },
  child_sales: {
    file: generatedAppDataPath(root, "sorftime-child-sales-data.ts"),
    exportName: "sorftimeChildSales30d",
  },
  price_strategy: {
    file: generatedAppDataPath(root, "sorftime-price-strategy-data.ts"),
    exportName: "sorftimePriceStrategies",
  },
  image_remarks: {
    remarks: [generatedAppDataPath(root, "listing-image-remarks.ts"), "listingImageRemarks"],
    outcomes: [generatedAppDataPath(root, "listing-image-remarks.ts"), "listingImageRemarksMeta"],
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
 *   gapItems?: readonly { asin: string; causeCode: string }[];
 *   dataAsins?: readonly string[];
 *   updatedAt?: string;
 *   now?: () => string;
 *   readExport?: (filePath: string, exportName: string) => unknown;
 *   imageRemarksData?: { remarksByAsin: object; outcomesByAsin: object };
 *   organizationId?: string;
 *   projectId?: string;
 *   runId?: string;
 *   jobId?: string;
 *   marketplace?: string;
 *   ukSellerSpriteReviewFallback?: boolean;
 *   sellerSpriteReviewFallback?: boolean;
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
  imageRemarksData,
  organizationId,
  projectId,
  runId,
  jobId,
  marketplace = "US",
  ukSellerSpriteReviewFallback,
  sellerSpriteReviewFallback = ukSellerSpriteReviewFallback === undefined
    ? reviewFallbackEnabled(marketplace)
    : marketplace === "UK" && ukSellerSpriteReviewFallback,
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
  const readyAsins = stageStatus === "failed" ? [] : projectedAsins;
  if (stageStatus === "failed") {
    const reasonCode = gapReasonCodes.has(gapReasonCode)
      ? gapReasonCode
      : stageStatus === "partial" ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED";
    const gap = boundedGap(stageStatus, reasonCode, gapItems, requestedAsins, readyAsins);
    return { ...draft, gap, contentHash: hashCanonical({ stage: stageId, gap }) };
  }
  const data = projectDoneData(stageId, source, projectedAsins, readExport, imageRemarksData, { marketplace, sellerSpriteReviewFallback });
  if (stageId === 'reviews' && organizationId && projectId) {
    const observations = readSource(source.context, readExport);
    const contextByAsin = Object.fromEntries(requestedAsins.flatMap(asin => {
      const r = observations?.[asin];
      return r?.asin === asin && r.marketplace === marketplace && r.organizationId === organizationId && r.projectId === projectId &&
        Date.parse(r.page?.checkedAt) <= Date.parse(draft.updatedAt) ? [[asin, r]] : [];
    }));
    // Supplemental evidence never changes readyAsins, local rows, or denominators.
    if (Object.keys(contextByAsin).length) data.contextByAsin = contextByAsin;
  }
  if (stageId === "keywords") {
    // Terminal empty observations remain evidence in a partial stage, without
    // promoting those ASINs into the ready cohort or removing their gaps.
    const analysis = readSource(source.analysis, readExport);
    for (const asin of requestedAsins) {
      if (projectedAsins.includes(asin)) continue;
      const record = analysis?.[asin];
      if (validTerminalKeywordEmpty(record, asin, marketplace, draft.updatedAt)) data.analysisByAsin[asin] = record;
    }
  }
  if (stageStatus === "partial" && stageId === "reviews") {
    const primary = readSource(source.analysis, readExport);
    const secondary = sellerSpriteReviewFallback ? readSource(source.sellerSprite, readExport) : {};
    // A rating is product_detail evidence, independent of review sample readiness.
    // The analysis cohort and bounded review gaps continue to use readyAsins.
    const ratings = readSource(source.rating, readExport);
    for (const asin of requestedAsins) {
      if (projectedAsins.includes(asin)) continue;
      const reviewCause = gapItems.find(item => item.asin === asin)?.causeCode ?? gapReasonCode;
      const observation = !reviewCause || reviewCause === "UPSTREAM_EMPTY"
        ? selectReviewObservation(asin, marketplace, primary?.[asin], secondary?.[asin], draft.updatedAt) : null;
      if (observation) data.analysisByAsin[asin] = observation;
      const rating = ratings?.[asin];
      if (validIndependentReviewRating(rating, asin, {
        marketplace, updatedAt: draft.updatedAt, jobId, organizationId, projectId, runId,
      })) data.ratingByAsin[asin] = rating;
    }
  }
  if (stageStatus === 'partial' && stageId === 'sales_trend') {
    // Valid observations are evidence even when natural-month readiness is unavailable.
    // Keep the ASIN in the gap; do not promote daily data to monthly readiness.
    const observations = readSource(source, readExport);
    for (const asin of requestedAsins) {
      const record = observations?.[asin];
      if (record?.asin !== asin || !['empty','error'].includes(record.status)) continue;
      const validPoints = (points, dateField, pattern) => Array.isArray(points) && points.length > 0 &&
        points.every(point => pattern.test(point?.[dateField]) && Number.isFinite(point.value) && point.value >= 0);
      const hasEvidence = ['volume','amount','price','rank'].some(field =>
        validPoints(record[field], 'month', /^\d{4}-(0[1-9]|1[0-2])$/) ||
        validPoints(record.dailyObservations?.[field], 'date', /^\d{4}-\d{2}-\d{2}$/));
      if (hasEvidence || record.observationOutcomes || record.observationErrors) data.trendByAsin[asin] = record;
    }
  }
  if (stageStatus === "partial" && stageId === "image_remarks" && imageRemarksData) {
    // Partial notes and their diagnostics are evidence, not ready-ASIN claims.
    // Keep the ready-only set used by boundedGap unchanged while retaining the
    // scoped incomplete family's successfully analyzed image identities.
    Object.assign(data, projectDoneData(stageId, source, requestedAsins, readExport, imageRemarksData));
  }
  if (stageStatus === "partial") {
    const reasonCode = gapReasonCodes.has(gapReasonCode) ? gapReasonCode : "UPSTREAM_EMPTY";
    const gap = boundedGap("partial", reasonCode, gapItems, requestedAsins, readyAsins);
    return { ...draft, data, gap, contentHash: hashCanonical({ stage: stageId, data, gap }) };
  }
  return { ...draft, data, contentHash: hashCanonical({ stage: stageId, data }) };
}

function validTerminalKeywordEmpty(record, asin, marketplace, updatedAt) {
  return record?.asin === asin && record.marketplace === marketplace &&
    record.status === "empty" && record.terminalReason === "valid-empty" &&
    Array.isArray(record.keywords) && record.keywords.length === 0 &&
    typeof record.fetchedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.fetchedAt) &&
    Number.isFinite(Date.parse(record.fetchedAt)) && Date.parse(record.fetchedAt) <= Date.parse(updatedAt) &&
    record.queryWindow?.time_type === "lately" && record.queryWindow?.time_value === "30" &&
    record.queryWindow?.listingSearch === true;
}

function projectDoneData(stageId, source, asins, readExport, imageRemarksData, { marketplace = "US", sellerSpriteReviewFallback = false } = {}) {
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
  if (stageId === "reviews") {
    const sorftime = readSource(source.analysis, readExport);
    const sellerSprite = sellerSpriteReviewFallback ? readSource(source.sellerSprite, readExport) : {};
    return {
      analysisByAsin: Object.fromEntries(asins.flatMap(asin => {
        const selected = selectReviewEvidence(asin, marketplace, sorftime?.[asin], sellerSprite?.[asin]);
        return selected ? [[asin, selected]] : sorftime?.[asin] ? [[asin, sorftime[asin]]] : [];
      })),
      ratingByAsin: pickRequestedAsins(readSource(source.rating, readExport), asins),
    };
  }
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
  if (stageId === "image_remarks") return imageRemarksData ? {
    remarksByAsin: pickRequestedAsins(imageRemarksData.remarksByAsin, asins),
    outcomesByAsin: pickRequestedAsins(sanitizeImageOutcomes(imageRemarksData.outcomesByAsin), asins),
  } : {
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

/**
 * Validate only the independent rating exception; legacy ready-cohort entries
 * keep their existing contract. No unknown values are converted to zero.
 * @param {unknown} value
 * @param {string} asin
 * @param {{ marketplace?: string; updatedAt?: string; jobId?: string;
 * organizationId?: string; projectId?: string; runId?: string }} scope
 */
export function validIndependentReviewRating(value, asin, scope = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.asin !== asin || record.marketplace !== (scope.marketplace ?? "US") || record.status !== "ready"
    || typeof record.rating !== "number" || !Number.isFinite(record.rating) || record.rating < 0 || record.rating > 5
    || (record.reviewCount != null && (!Number.isSafeInteger(record.reviewCount) || record.reviewCount < 0))
    || typeof record.fetchedAt !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(record.fetchedAt)
    || !Number.isFinite(Date.parse(record.fetchedAt))
    || (scope.updatedAt && Date.parse(record.fetchedAt) > Date.parse(scope.updatedAt))
    || (record.source != null && record.source !== "Sorftime")) return false;
  if (record.provenance != null) {
    const provenance = record.provenance;
    if (typeof provenance !== "object" || Array.isArray(provenance)
      || provenance.asin !== asin || provenance.marketplace !== record.marketplace || provenance.connector !== "sorftime"
      || (scope.jobId && provenance.jobId !== scope.jobId)
      || (provenance.fetchedAt != null && provenance.fetchedAt !== record.fetchedAt)
      || ["organizationId", "projectId", "runId"].some(key =>
        scope[key] && provenance[key] != null && provenance[key] !== scope[key])) return false;
  }
  return true;
}

/** @param {unknown} value
 * @param {{ asins: readonly string[]; marketplace?: string; updatedAt?: string; jobId?: string;
 * organizationId?: string; projectId?: string; runId?: string }} scope
 */
export function validIndependentReviewRatings(value, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = /** @type {Record<string, unknown>} */ (value);
  const analysis = data.analysisByAsin, ratings = data.ratingByAsin;
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)
    || !ratings || typeof ratings !== "object" || Array.isArray(ratings)) return false;
  return Object.entries(ratings).every(([asin, rating]) =>
    Object.hasOwn(analysis, asin) ||
    (scope.asins.includes(asin) && validIndependentReviewRating(rating, asin, scope)));
}

function boundedGap(state, reasonCode, entries, requestedAsins, dataAsins) {
  const requested = new Set(requestedAsins);
  const ready = new Set(dataAsins);
  const byAsin = new Map([...requested]
    .filter((asin) => !ready.has(asin))
    .map((asin) => [asin, { asin, causeCode: "UPSTREAM_EMPTY" }]));
  for (const raw of entries ?? []) {
    const item = sanitizeGapItem(raw);
    if (!item || !requested.has(item.asin) || ready.has(item.asin)) continue;
    const current = byAsin.get(item.asin);
    if (!current || gapItemPriority(item) > gapItemPriority(current)
      || (gapItemPriority(item) === gapItemPriority(current) && JSON.stringify(item).length > JSON.stringify(current).length)) {
      byAsin.set(item.asin, item);
    }
  }
  const items = [...byAsin.values()].sort((left, right) => left.asin.localeCompare(right.asin) || left.causeCode.localeCompare(right.causeCode)).slice(0, 32);
  return { state, reasonCode, ...(items.length ? { items } : {}) };
}

function gapItemPriority(item) {
  if (item.causeCode === "MCP_SCHEMA" || item.causeCode === "SIF_KEYWORD_SCHEMA_INVALID") return 3;
  if (item.causeCode === "CONNECT_TIMEOUT" || item.causeCode === "CONNECTOR_FAILED") return 2;
  return 1;
}

function sanitizeGapItem(raw) {
  const asin = String(raw?.asin ?? "").toUpperCase();
  const causeCode = gapReasonCodes.has(raw?.causeCode) ? raw.causeCode : null;
  if (!/^[A-Z0-9]{10}$/.test(asin) || !causeCode) return null;
  const item = { asin, causeCode };
  const operations = new Set(["tools/list", "asin_detail", "asin_sales_trend", "keepa_info", "review", "product_customers_say", "product_reviews", "product_detail", "product_content", "product_trend", "product_variations", "category_name_search", "category_trend"]);
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
    ? sanitizeImageOutcomes(meta.imageOutcomesByAsin)
    : {};
}

function sanitizeImageOutcomes(outcomes) {
  return Object.fromEntries(Object.entries(outcomes ?? {}).map(([asin, slots]) => [asin,
    Array.isArray(slots) ? slots.map(outcome => outcome == null ? null : imageRemarkOutcome(outcome.status, outcome)) : [],
  ]));
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

const trafficAdChannelOrder = [
  ["sp", "SP(常规)"],
  ["recommend", "SP(推荐)"],
  ["sb", "SB(常规)"],
  ["sbv", "SBV"],
];

function trafficScore(value) {
  return Math.round(finiteNumber(value) ?? 0);
}

function trafficPercent(value) {
  return Math.round((finiteNumber(value) ?? 0) * 1000) / 10;
}

function trafficUpdatedThrough(notice) {
  if (typeof notice !== "string") return null;
  return notice.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
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
    const fetchedAt = typeof record.fetchedAt === "string" ? { fetchedAt: record.fetchedAt } : {};

    if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) {
      return [[asin, {
        ...fetchedAt,
        ...(total !== null ? { total } : {}),
        ...(natural !== null ? { natural } : {}),
        ...(advertising !== null ? { advertising } : {}),
      }]];
    }

    const rawAdChannels = outerOverview?.ad;
    const adChannels = rawAdChannels && typeof rawAdChannels === "object" && !Array.isArray(rawAdChannels)
      ? trafficAdChannelOrder.flatMap(([key, label]) => {
        const item = rawAdChannels[key];
        return item && (finiteNumber(item.score) ?? 0) > 0
          ? [{ label, score: trafficScore(item.score), ratio: trafficPercent(item.ratio) }]
          : [];
      })
      : null;
    const rawRecommendations = outerOverview?.recommend;
    const recommendationSources = rawRecommendations && typeof rawRecommendations === "object" && !Array.isArray(rawRecommendations)
      ? Object.values(rawRecommendations)
        .filter((item) => item && (finiteNumber(item.score) ?? 0) > 0 && (finiteNumber(item.ratio) ?? 0) >= 0.01)
        .sort((left, right) => (finiteNumber(right.score) ?? 0) - (finiteNumber(left.score) ?? 0))
        .slice(0, 6)
        .map((item) => ({
          label: String(item.name),
          score: trafficScore(item.score),
          ratio: trafficPercent(item.ratio),
        }))
      : null;

    const chars = record.structure?.chars;
    const dims = chars && typeof chars === "object" && !Array.isArray(chars) && Array.isArray(chars.dims)
      ? chars.dims
      : null;
    const channelScore = (key, index) => trafficScore(Array.isArray(chars?.[key]) ? chars[key][index]?.score : 0);
    const children = dims?.flatMap((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const childAsin = typeof item.val === "string"
        ? item.val.match(/(?:^|[^A-Z0-9])([A-Z0-9]{10})(?=$|[^A-Z0-9])/i)?.[1]?.toUpperCase()
        : null;
      if (!childAsin) return [];
      return [{
        asin: childAsin,
        label: Array.isArray(item.features) ? item.features.filter(Boolean).join(" / ") || "默认" : "默认",
        image: typeof item.img === "string" ? item.img : "",
        totalScore: trafficScore(item.sumScore),
        sharePct: trafficPercent(item.ratio),
        organic: channelScore("nfs", index),
        sp: channelScore("sps", index),
        spRecommend: channelScore("recs", index),
        sb: channelScore("sbs", index),
        sbv: channelScore("sbvs", index),
      }];
    });

    return [[asin, {
      ...fetchedAt,
      totalScore: trafficScore(total),
      naturalAd: [
        { label: "自然流量", score: trafficScore(natural), ratio: trafficPercent(distribution.nf?.ratio) },
        { label: "广告流量", score: trafficScore(advertising), ratio: trafficPercent(distribution.ad?.ratio) },
      ],
      ...(adChannels !== null ? { adChannels } : {}),
      ...(recommendationSources !== null ? { recommendationSources } : {}),
      ...(children !== undefined ? { children } : {}),
      updatedThrough: trafficUpdatedThrough(outerOverview?.data_notice),
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

export function persistedStageOutputContentHash(output) {
  if (!output || typeof output !== "object" || !isProjectableSyncStage(output.stage)) {
    throw new TypeError("Invalid persisted stage output");
  }
  const body = { stage: output.stage };
  if (output.stageStatus === "done" && output.data && !output.gap) body.data = output.data;
  else if (output.stageStatus === "partial" && output.data && output.gap) {
    body.data = output.data;
    body.gap = output.gap;
  } else if (output.stageStatus === "failed" && !output.data && output.gap) body.gap = output.gap;
  else throw new TypeError("Invalid persisted stage status or body");
  return hashCanonical(body);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
