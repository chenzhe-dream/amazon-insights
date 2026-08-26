import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNC_STAGE_TEMPLATE,
  collectAsinModuleGaps,
  collectUnavailableProviderWarnings,
  idleStageStatus,
  jobLifecycleLabel,
  parseUnavailableProviderCapabilities,
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

const capabilities = {
  schemaVersion: "1.0.0",
  capabilities: {
    storage: { configured: true, available: true, reason: null },
    openai: { configured: true, available: true, reason: null },
    sif: { configured: true, available: true, reason: null, checkedAt: null },
    sorftime: { configured: true, available: true, reason: null, checkedAt: null },
    sellerSprite: { configured: true, available: false, reason: "provider secret", checkedAt: null },
    manualVoc: { configured: true, available: false, reason: "manual", },
  },
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
  const imageStage = SYNC_STAGE_TEMPLATE.find(stage => stage.id === "image_remarks");
  assert.equal(imageStage?.detail, "最多同时分析 4 张图片 · 单图上限 120 秒");
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

test("unavailable SellerSprite warns when the current ASINs are missing catalog data", () => {
  assert.deepEqual(collectUnavailableProviderWarnings([{ ...item, inCatalog: false }], capabilities), [{
    connectorId: "sellerSprite",
    label: "SellerSprite",
    modules: ["商品底库"],
    message: "SellerSprite 当前不可用，将跳过商品底库；其他可用数据源仍会继续。",
  }]);
});

test("unavailable SellerSprite does not warn when every current ASIN already has catalog data", () => {
  assert.deepEqual(collectUnavailableProviderWarnings([item], capabilities), []);
});

test("unavailable SIF and Sorftime list only their missing modules with fixed Chinese labels", () => {
  const unavailableCapabilities = {
    ...capabilities,
    capabilities: {
      ...capabilities.capabilities,
      sellerSprite: { ...capabilities.capabilities.sellerSprite, available: true },
      sif: { ...capabilities.capabilities.sif, available: false },
      sorftime: { ...capabilities.capabilities.sorftime, available: false },
    },
  };
  const missingProviderData = {
    ...item,
    inCatalog: false,
    keywords: "missing" as const,
    reviews: "missing" as const,
    childSales: "missing" as const,
    priceStrategy: "missing" as const,
    fba: "missing" as const,
    listing: "missing" as const,
    category: "missing" as const,
    traffic: "missing" as const,
  };

  assert.deepEqual(collectUnavailableProviderWarnings([missingProviderData], unavailableCapabilities), [
    {
      connectorId: "sif",
      label: "SIF",
      modules: ["关键词", "竞品流量"],
      message: "SIF 当前不可用，将跳过关键词、竞品流量；其他可用数据源仍会继续。",
    },
    {
      connectorId: "sorftime",
      label: "Sorftime",
      modules: ["评论", "销量趋势", "子体销量", "价格策略", "FBA", "Listing", "类目趋势"],
      message: "Sorftime 当前不可用，将跳过评论、销量趋势、子体销量、价格策略、FBA、Listing、类目趋势；其他可用数据源仍会继续。",
    },
  ]);
});

test("all unavailable providers suppress the continue-sync warning when every missing module is blocked", () => {
  const allUnavailableCapabilities = {
    ...capabilities,
    capabilities: {
      ...capabilities.capabilities,
      sif: { ...capabilities.capabilities.sif, available: false },
      sorftime: { ...capabilities.capabilities.sorftime, available: false },
    },
  };
  const allMissingProviderData = {
    ...item,
    inCatalog: false,
    keywords: "missing" as const,
    reviews: "missing" as const,
    childSales: "missing" as const,
    priceStrategy: "missing" as const,
    fba: "missing" as const,
    listing: "missing" as const,
    category: "missing" as const,
    traffic: "missing" as const,
  };

  assert.deepEqual(collectUnavailableProviderWarnings([allMissingProviderData], allUnavailableCapabilities), []);
});

test("malformed capabilities HTTP payload is rejected before the progress section renders warnings", () => {
  assert.equal(parseUnavailableProviderCapabilities({
    capabilities: {
      sellerSprite: { available: false },
      sif: { available: "false" },
      sorftime: {},
    },
  }), null);
});
