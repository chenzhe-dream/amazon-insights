import fs from "node:fs";
import path from "node:path";
import { IMAGE_REMARK_ESTIMATED_SECONDS_PER_IMAGE } from "./image-remark-policy.mjs";
import { getProjectRoot } from "./project-root.mjs";
import { readCachedDataExport } from "./sync-cache.mjs";

const root = getProjectRoot();

const paths = {
  keywords: path.join(root, "app", "sif-keyword-analysis-data.ts"),
  reviews: path.join(root, "app", "sorftime-review-analysis-data.ts"),
  sales: path.join(root, "app", "sorftime-sales-trend-data.ts"),
  childSales: path.join(root, "app", "sorftime-child-sales-data.ts"),
  priceStrategies: path.join(root, "app", "sorftime-price-strategy-data.ts"),
  fbaFees: path.join(root, "app", "sorftime-fba-fee-data.ts"),
  categoryTrends: path.join(root, "app", "sorftime-category-trend-data.ts"),
  voc: path.join(root, "app", "rufus-voc-data.ts"),
  catalog: path.join(root, "app", "competitor-data.ts"),
  traffic: path.join(root, "app", "sif-listing-traffic-raw-data.ts"),
  listing: path.join(root, "app", "sorftime-listing-content-data.ts"),
  imageRemarks: path.join(root, "app", "listing-image-remarks.ts"),
};

export const ASIN_SYNC_STAGE_IDS = [
  "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
  "fba", "listing", "image_remarks", "category", "alexa_voc", "traffic",
];

export const STATUS_FIELD_BY_STAGE = {
  catalog: "inCatalog",
  keywords: "keywords",
  reviews: "reviews",
  sales_trend: "sales",
  child_sales: "childSales",
  price_strategy: "priceStrategy",
  fba: "fba",
  listing: "listing",
  image_remarks: "imageRemarks",
  category: "category",
  alexa_voc: "voc",
  traffic: "traffic",
};

/** 各阶段预估耗时（秒）— 用于漏斗倒计时 */
export const SYNC_STAGE_ESTIMATES = {
  queue: 3,
  catalogPerAsin: 18,
  keywordsPerAsin: 55,
  reviewsPerAsin: 35,
  salesPerAsin: 30,
  trafficPerAsin: 25,
  listingPerAsin: 12,
  imageRemarksPerImage: IMAGE_REMARK_ESTIMATED_SECONDS_PER_IMAGE,
  build: 65,
  /** Alexa 人工录入 VOC 核心主题，按 ASIN 估算 */
  alexaVocPerAsin: 480,
  /** Playwright 自动抓取 Alexa VOC，按 ASIN 估算 */
  alexaVocAutoPerAsin: 120,
};

export function readCatalogAsins() {
  if (!fs.existsSync(paths.catalog)) return [];
  const source = fs.readFileSync(paths.catalog, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

export function hasListingTraffic(asin) {
  return deriveAsinModuleStatus(asin, readAsinStatusSources()).traffic === "ready";
}

function isVideoThumb(url) {
  return /play-button|PKplay-button/i.test(String(url ?? ""));
}

function analyzableGalleryImages(record) {
  const gallery = record?.galleryImages ?? [];
  return gallery.filter(url => !isVideoThumb(url));
}

export function hasListingGallery(asin) {
  return deriveAsinModuleStatus(asin, readAsinStatusSources()).listing === "ready";
}

export function filledRemarkCount(slots) {
  return (slots ?? []).filter(item => item?.remark?.trim()).length;
}

export function hasImageRemarks(asin) {
  return deriveAsinModuleStatus(asin, readAsinStatusSources()).imageRemarks === "ready";
}

function hasUsableTrendPoint(record) {
  return record?.status === "ready" && ["volume", "amount", "price", "rank"].some(key =>
    Array.isArray(record[key]) && record[key].some(point =>
      /^\d{4}-\d{2}$/.test(String(point?.month ?? "")) && Number.isFinite(point?.value) && point.value >= 0
    )
  );
}

export function hasCompleteImageRemarks(listingRecord, remarkSlots) {
  const requiredSlots = (listingRecord?.galleryImages ?? [])
    .map((url, slotIndex) => ({ url, slotIndex }))
    .filter(item => !isVideoThumb(item.url));
  return requiredSlots.length > 0 && requiredSlots.every(
    item => Boolean(remarkSlots?.[item.slotIndex]?.remark?.trim()),
  );
}

export function countPendingImageRemarks(asins, sources = readAsinStatusSources()) {
  return asins.reduce((total, asin) => {
    const listingRecord = sources.listing?.[asin];
    if (listingRecord?.status !== "ready" || !Array.isArray(listingRecord.galleryImages)) return total;
    const pending = listingRecord.galleryImages.reduce((count, url, slotIndex) => {
      const validStaticImage = typeof url === "string" && url.trim().length > 0 && !isVideoThumb(url);
      if (!validStaticImage || sources.imageRemarks?.[asin]?.[slotIndex]?.remark?.trim()) return count;
      return count + 1;
    }, 0);
    return total + pending;
  }, 0);
}

export function readAsinStatusSources() {
  return {
    catalogAsins: readCatalogAsins(),
    keywords: readCachedDataExport(paths.keywords, "sifKeywordAnalysisData"),
    reviews: readCachedDataExport(paths.reviews, "sorftimeReviewAnalysisData"),
    sales: readCachedDataExport(paths.sales, "sorftimeSalesTrendData"),
    childSales: readCachedDataExport(paths.childSales, "sorftimeChildSales30d"),
    priceStrategies: readCachedDataExport(paths.priceStrategies, "sorftimePriceStrategies"),
    fbaFees: readCachedDataExport(paths.fbaFees, "sorftimeFbaFeeData"),
    listing: readCachedDataExport(paths.listing, "sorftimeListingContentData"),
    imageRemarks: readCachedDataExport(paths.imageRemarks, "listingImageRemarks"),
    imageRemarkStatuses: readCachedDataExport(paths.imageRemarks, "listingImageRemarksMeta").imageStatusByAsin ?? {},
    categoryTrends: readCachedDataExport(paths.categoryTrends, "sorftimeCategoryTrendData"),
    traffic: readCachedDataExport(paths.traffic, "sifListingTrafficRawByAsin"),
    vocSource: fs.existsSync(paths.voc) ? fs.readFileSync(paths.voc, "utf8") : "",
  };
}

export function readImageRemarkStatuses() {
  return readAsinStatusSources().imageRemarkStatuses;
}

export function deriveAsinModuleStatus(asin, sources) {
  const listingRecord = sources.listing[asin];
  const childRows = sources.childSales[asin];
  const fbaRecord = sources.fbaFees[asin];
  const categoryReady = Object.values(sources.categoryTrends).some(
    record => record?.status === "ready" && Array.isArray(record.asins) && record.asins.includes(asin),
  );
  const trafficRecord = sources.traffic[asin];
  const vocBlock = new RegExp(`${asin}:\\s*\\{[\\s\\S]*?captureStatus:\\s*"dialog"`, "m");

  return {
    asin,
    inCatalog: sources.catalogAsins.includes(asin),
    keywords: sources.keywords[asin]?.status === "ready" ? "ready" : "missing",
    reviews: sources.reviews[asin]?.status === "ready" ? "ready" : "missing",
    sales: hasUsableTrendPoint(sources.sales[asin]) ? "ready" : "missing",
    childSales: Array.isArray(childRows) && childRows.some(row => Number.isFinite(row?.sales) && row.sales >= 0) ? "ready" : "missing",
    priceStrategy: sources.priceStrategies[asin] && typeof sources.priceStrategies[asin] === "object" ? "ready" : "missing",
    fba: fbaRecord?.status === "ready" && Number.isFinite(fbaRecord.fbaFee) && fbaRecord.fbaFee >= 0 ? "ready" : "missing",
    listing: listingRecord?.status === "ready" && analyzableGalleryImages(listingRecord).length > 0 ? "ready" : "missing",
    imageRemarks: hasCompleteImageRemarks(listingRecord, sources.imageRemarks[asin]) ? "ready" : "missing",
    category: categoryReady ? "ready" : "missing",
    traffic: trafficRecord?.overview?.total > 0 && trafficRecord?.structure?.chars?.dims?.length ? "ready" : "missing",
    voc: vocBlock.test(sources.vocSource) ? "ready" : "missing",
  };
}

export function getAsinModuleStatus(asin) {
  return deriveAsinModuleStatus(asin, readAsinStatusSources());
}

export function getAsinDataStatus(asins) {
  const sources = readAsinStatusSources();
  return asins.map(asin => deriveAsinModuleStatus(asin, sources));
}

export function isAsinStageReady(item, stageId) {
  const field = STATUS_FIELD_BY_STAGE[stageId];
  return field === "inCatalog" ? item.inCatalog : item[field] === "ready";
}

export function evaluateAsinStageReadiness(stageId, items) {
  const missingAsins = items.filter(item => !isAsinStageReady(item, stageId)).map(item => item.asin);
  return { stageId, items, ready: items.length > 0 && missingAsins.length === 0, missingAsins };
}

export function readAsinStageReadiness(stageId, asins) {
  return evaluateAsinStageReadiness(stageId, getAsinDataStatus(asins));
}

export function asinsNeedingCatalogSync(asins) {
  return getAsinDataStatus(asins).filter(item => !item.inCatalog).map(item => item.asin);
}

export function asinsNeedingMcpSync(asins) {
  return getAsinDataStatus(asins).filter(
    item =>
      item.keywords === "missing" ||
      item.reviews === "missing" ||
      item.sales === "missing" ||
      item.childSales === "missing" ||
      item.priceStrategy === "missing" ||
      item.fba === "missing" ||
      item.category === "missing"
  );
}

export function asinsNeedingTrafficSync(asins) {
  return getAsinDataStatus(asins).filter(item => item.traffic === "missing");
}

export function asinsNeedingListingSync(asins) {
  return getAsinDataStatus(asins).filter(item => item.listing === "missing");
}

export function asinsNeedingImageRemarksSync(asins) {
  return getAsinDataStatus(asins).filter(item => item.listing === "ready" && item.imageRemarks === "missing");
}

export function asinsNeedingVocSync(asins) {
  return getAsinDataStatus(asins).filter(item => item.voc === "missing");
}

export function asinsNeedingAnySync(asins) {
  return getAsinDataStatus(asins).filter(
    item =>
      !item.inCatalog ||
      item.keywords === "missing" ||
      item.reviews === "missing" ||
      item.sales === "missing" ||
      item.childSales === "missing" ||
      item.priceStrategy === "missing" ||
      item.fba === "missing" ||
      item.listing === "missing" ||
      item.imageRemarks === "missing" ||
      item.category === "missing" ||
      item.traffic === "missing" ||
      item.voc === "missing"
  );
}

export function estimateAutoSyncSeconds(
  asinCount,
  { catalogCount = 0, trafficCount = 0, listingCount = 0, imageRemarksCount = 0 } = {},
) {
  const {
    queue,
    catalogPerAsin,
    keywordsPerAsin,
    reviewsPerAsin,
    salesPerAsin,
    trafficPerAsin,
    listingPerAsin,
    imageRemarksPerImage,
    build,
  } = SYNC_STAGE_ESTIMATES;
  const catalogSeconds = catalogCount * catalogPerAsin;
  const trafficSeconds = trafficCount * trafficPerAsin;
  const listingSeconds = listingCount * listingPerAsin;
  const remarksSeconds = imageRemarksCount * imageRemarksPerImage;
  if (!asinCount) return queue + catalogSeconds + trafficSeconds + listingSeconds + remarksSeconds + build;
  return (
    queue +
    catalogSeconds +
    asinCount * (keywordsPerAsin + reviewsPerAsin + salesPerAsin) +
    trafficSeconds +
    listingSeconds +
    remarksSeconds +
    build
  );
}

export function estimateAlexaVocSeconds(asinCount, { auto = true } = {}) {
  const perAsin = auto ? SYNC_STAGE_ESTIMATES.alexaVocAutoPerAsin : SYNC_STAGE_ESTIMATES.alexaVocPerAsin;
  return asinCount * perAsin;
}
