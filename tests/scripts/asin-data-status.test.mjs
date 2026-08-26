import assert from "node:assert/strict";
import test from "node:test";

import {
  ASIN_SYNC_STAGE_IDS,
  deriveAsinModuleStatus,
  estimateAutoSyncSeconds,
  evaluateAsinStageReadiness,
  hasCompleteImageRemarks,
} from "../../scripts/lib/asin-data-status.mjs";
import * as asinDataStatus from "../../scripts/lib/asin-data-status.mjs";

const asin = "B0C4XRN398";
const listingRecord = {
  status: "ready",
  galleryImages: ["https://img.test/1.jpg", "https://img.test/play-button.jpg", "https://img.test/2.jpg"],
};

const sources = {
  catalogAsins: [asin],
  keywords: { [asin]: { status: "ready" } },
  reviews: { [asin]: { status: "ready" } },
  sales: { [asin]: { status: "empty", volume: [], amount: [], price: [], rank: [] } },
  childSales: { [asin]: [{ asin, sales: 4 }] },
  priceStrategies: { [asin]: { anchor: "price" } },
  fbaFees: { [asin]: { status: "ready", fbaFee: 5.2 } },
  listing: { [asin]: listingRecord },
  imageRemarks: { [asin]: [{ remark: "one" }, { remark: "video" }, { remark: "" }] },
  categoryTrends: { node: { status: "ready", asins: [asin], volume: [{ month: "2026-01", value: 1 }] } },
  traffic: { [asin]: { overview: { total: 1 }, structure: { chars: { dims: ["search"] } } } },
  vocSource: "export const rufusVocData = {};",
};

test("each persisted source controls only its own stage", () => {
  const status = deriveAsinModuleStatus(asin, sources);
  assert.deepEqual(status, {
    asin,
    inCatalog: true,
    keywords: "ready",
    reviews: "ready",
    sales: "missing",
    childSales: "ready",
    priceStrategy: "ready",
    fba: "ready",
    listing: "ready",
    imageRemarks: "missing",
    category: "ready",
    traffic: "ready",
    voc: "missing",
  });
  assert.deepEqual(ASIN_SYNC_STAGE_IDS, [
    "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
    "fba", "listing", "image_remarks", "category", "alexa_voc", "traffic",
  ]);
});

test("sales needs a usable point and image remarks need every analyzable slot", () => {
  assert.equal(hasCompleteImageRemarks(listingRecord, sources.imageRemarks[asin]), false);
  const readySources = {
    ...sources,
    sales: { [asin]: { status: "ready", volume: [{ month: "2026-01", value: 12 }], amount: [], price: [], rank: [] } },
    imageRemarks: { [asin]: [{ remark: "one" }, { remark: "video" }, { remark: "two" }] },
  };
  const status = deriveAsinModuleStatus(asin, readySources);
  assert.equal(status.sales, "ready");
  assert.equal(status.imageRemarks, "ready");
});

test("the observed pre-repair shape is nine of twelve and Alexa stays missing", () => {
  const item = deriveAsinModuleStatus(asin, sources);
  const done = ASIN_SYNC_STAGE_IDS.filter(stageId => evaluateAsinStageReadiness(stageId, [item]).ready);
  assert.deepEqual(done, [
    "catalog", "keywords", "reviews", "child_sales", "price_strategy", "fba", "listing", "category", "traffic",
  ]);
  assert.equal(done.length, 9);
  assert.deepEqual(evaluateAsinStageReadiness("alexa_voc", [item]).missingAsins, [asin]);
});

test("image-only work counts pending valid static slots and keeps ETA above zero", () => {
  assert.equal(typeof asinDataStatus.countPendingImageRemarks, "function");
  assert.equal(asinDataStatus.countPendingImageRemarks([asin], sources), 1);
  const pendingImageCount = asinDataStatus.countPendingImageRemarks([asin], sources);
  assert.equal(estimateAutoSyncSeconds(0, { imageRemarksCount: pendingImageCount }), 113);
});
