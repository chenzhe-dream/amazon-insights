import fs from "node:fs";
import path from "node:path";
import { readCachedDataExport } from "./sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const paths = {
  keywords: path.join(root, "app", "sif-keyword-analysis-data.ts"),
  reviews: path.join(root, "app", "sorftime-review-analysis-data.ts"),
  sales: path.join(root, "app", "sorftime-sales-trend-data.ts"),
  voc: path.join(root, "app", "rufus-voc-data.ts"),
  catalog: path.join(root, "app", "competitor-data.ts"),
};

/** 各阶段预估耗时（秒）— 用于漏斗倒计时 */
export const SYNC_STAGE_ESTIMATES = {
  queue: 3,
  keywordsPerAsin: 55,
  reviewsPerAsin: 35,
  salesPerAsin: 30,
  build: 65,
  /** Alexa 人工录入 VOC 核心主题，按 ASIN 估算 */
  alexaVocPerAsin: 480,
};

export function readCatalogAsins() {
  if (!fs.existsSync(paths.catalog)) return [];
  const source = fs.readFileSync(paths.catalog, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
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

export function asinsNeedingMcpSync(asins) {
  return getAsinDataStatus(asins).filter(
    item => item.keywords === "missing" || item.reviews === "missing" || item.sales === "missing"
  );
}

export function estimateAutoSyncSeconds(asinCount) {
  const { queue, keywordsPerAsin, reviewsPerAsin, salesPerAsin, build } = SYNC_STAGE_ESTIMATES;
  if (!asinCount) return queue + build;
  return queue + asinCount * (keywordsPerAsin + reviewsPerAsin + salesPerAsin) + build;
}

export function estimateAlexaVocSeconds(asinCount) {
  return asinCount * SYNC_STAGE_ESTIMATES.alexaVocPerAsin;
}
