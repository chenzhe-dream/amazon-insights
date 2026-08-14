import fs from "node:fs";
import path from "node:path";
import { getProjectRoot } from "./project-root.mjs";
import { readCachedDataExport } from "./sync-cache.mjs";

const root = getProjectRoot();

const paths = {
  keywords: path.join(root, "app", "sif-keyword-analysis-data.ts"),
  reviews: path.join(root, "app", "sorftime-review-analysis-data.ts"),
  sales: path.join(root, "app", "sorftime-sales-trend-data.ts"),
  voc: path.join(root, "app", "rufus-voc-data.ts"),
  catalog: path.join(root, "app", "competitor-data.ts"),
  traffic: path.join(root, "app", "sif-listing-traffic-raw-data.ts"),
  listing: path.join(root, "app", "sorftime-listing-content-data.ts"),
  imageRemarks: path.join(root, "app", "listing-image-remarks.ts"),
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
  imageRemarksPerAsin: 45,
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
  const traffic = readCachedDataExport(paths.traffic, "sifListingTrafficRawByAsin");
  const entry = traffic[asin];
  return Boolean(entry?.overview?.total > 0 && entry?.structure?.chars?.dims?.length);
}

function isVideoThumb(url) {
  return /play-button|PKplay-button/i.test(String(url ?? ""));
}

function analyzableGalleryImages(record) {
  const gallery = record?.galleryImages ?? [];
  return gallery.filter(url => !isVideoThumb(url));
}

export function hasListingGallery(asin) {
  const listing = readCachedDataExport(paths.listing, "sorftimeListingContentData");
  const record = listing[asin];
  return record?.status === "ready" && analyzableGalleryImages(record).length > 0;
}

export function filledRemarkCount(slots) {
  return (slots ?? []).filter(item => item?.remark?.trim()).length;
}

export function hasImageRemarks(asin) {
  const listing = readCachedDataExport(paths.listing, "sorftimeListingContentData");
  const remarks = readCachedDataExport(paths.imageRemarks, "listingImageRemarks");
  const needed = analyzableGalleryImages(listing[asin]).length;
  const existing = filledRemarkCount(remarks[asin]);
  return needed > 0 && existing >= needed;
}

export function getAsinModuleStatus(asin) {
  const keywords = readCachedDataExport(paths.keywords, "sifKeywordAnalysisData");
  const reviews = readCachedDataExport(paths.reviews, "sorftimeReviewAnalysisData");
  const sales = readCachedDataExport(paths.sales, "sorftimeSalesTrendData");
  const inCatalog = readCatalogAsins().includes(asin);

  return {
    asin,
    inCatalog,
    keywords: keywords[asin]?.status === "ready" ? "ready" : "missing",
    reviews: reviews[asin]?.status === "ready" ? "ready" : "missing",
    sales: sales[asin]?.status === "ready" ? "ready" : "missing",
    listing: hasListingGallery(asin) ? "ready" : "missing",
    imageRemarks: hasImageRemarks(asin) ? "ready" : "missing",
    traffic: hasListingTraffic(asin) ? "ready" : "missing",
    voc: hasAlexaVocDialog(asin) ? "ready" : "missing",
  };
}

function hasAlexaVocDialog(asin) {
  if (!fs.existsSync(paths.voc)) return false;
  const source = fs.readFileSync(paths.voc, "utf8");
  const block = new RegExp(`${asin}:\\s*\\{[\\s\\S]*?captureStatus:\\s*"dialog"`, "m");
  return block.test(source);
}

export function getAsinDataStatus(asins) {
  return asins.map(getAsinModuleStatus);
}

export function asinsNeedingCatalogSync(asins) {
  const inCatalog = new Set(readCatalogAsins());
  return asins.filter(asin => !inCatalog.has(asin));
}

export function asinsNeedingMcpSync(asins) {
  return getAsinDataStatus(asins).filter(
    item =>
      item.keywords === "missing" ||
      item.reviews === "missing" ||
      item.sales === "missing" ||
      item.traffic === "missing"
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
      item.listing === "missing" ||
      item.imageRemarks === "missing" ||
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
    imageRemarksPerAsin,
    build,
  } = SYNC_STAGE_ESTIMATES;
  const catalogSeconds = catalogCount * catalogPerAsin;
  const trafficSeconds = trafficCount * trafficPerAsin;
  const listingSeconds = listingCount * listingPerAsin;
  const remarksSeconds = imageRemarksCount * imageRemarksPerAsin;
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
