import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNC_STAGE_TEMPLATE,
  collectAsinModuleGaps,
  idleStageStatus,
  jobLifecycleLabel,
  type AsinDataStatusItem,
} from "../../app/lib/sync-job-display";

const item: AsinDataStatusItem = {
  asin: "B0C4XRN398",
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
};

test("idle readiness maps every stage to its own field", () => {
  const states = Object.fromEntries(SYNC_STAGE_TEMPLATE.map(stage => [stage.id, idleStageStatus(stage.id, [item])]));
  assert.deepEqual(states, {
    catalog: "done",
    keywords: "done",
    reviews: "done",
    sales_trend: "pending",
    child_sales: "done",
    price_strategy: "done",
    fba: "done",
    listing: "done",
    image_remarks: "pending",
    category: "done",
    alexa_voc: "manual",
    traffic: "done",
  });
  assert.equal(Object.values(states).filter(value => value === "done").length, 9);
  assert.equal(Math.round((9 / SYNC_STAGE_TEMPLATE.length) * 100), 75);
});

test("sync display truthfully exposes base-ready, enriching, manual and partial per-ASIN gaps", () => {
  assert.equal(jobLifecycleLabel("base-ready"), "基础数据已就绪");
  assert.equal(jobLifecycleLabel("enriching"), "正在补充图片备注");
  assert.deepEqual(collectAsinModuleGaps({
    B0C4XRN398: {
      traffic: { status: "ready", reason: null, updatedAt: "2026-08-22T00:00:00.000Z" },
      alexa_voc: { status: "manual", reason: "需人工录入", updatedAt: "2026-08-22T00:00:00.000Z" },
      image_remarks: { status: "timeout", reason: "图片分析超过 90 秒", updatedAt: "2026-08-22T00:00:00.000Z" },
    },
  }), [
    { asin: "B0C4XRN398", module: "alexa_voc", status: "manual", reason: "需人工录入" },
    { asin: "B0C4XRN398", module: "image_remarks", status: "timeout", reason: "图片分析超过 90 秒" },
  ]);
});
