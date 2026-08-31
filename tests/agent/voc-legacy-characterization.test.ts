import assert from "node:assert/strict";
import test from "node:test";

import { refreshedCatalog } from "../../app/competitor-data";
import { buildProductLaunchAnalysis } from "../../app/product-launch-analysis";
import { buildKeywordDemandAnalysis } from "../../app/keyword-demand-analysis";
import { rufusVocData } from "../../app/rufus-voc-data";
import { sifKeywordAnalysisData } from "../../app/sif-keyword-analysis-data";
import { sifKeywordEnrichmentData } from "../../app/sif-keyword-enrichment-data";
import { buildVocDevelopmentSummary } from "../../app/voc-development-summary";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import {
  ManualAlexaVocNormalizedRecordSchema,
  type ManualAlexaVocNormalizedRecord,
} from "../../shared/agent-contracts";

const EXPECTED_DIGESTS = {
  scooter: "7d5a2eb92be3337da4c2f52afd0b0bd4ebeead900f20680fc37f50306412ea11",
  lighting: "eb627c95c086bb4f3c93ca950442d4313d5d3fd46ac531361a9615d6dad92095",
} as const;

const LEGACY_ASINS = new Set([
  "B07VY9Q95Q",
  "B0BPXRVWYK",
  "B07DYG1C9B",
  "B07S64PYMM",
  "B08HJ96QJ9",
  "B08T8RY9VK",
  "B09V5RW2VK",
  "B0D48BPKRH",
  "B08Z36X6B4",
  "B0D77D5WKD",
  "B0BVFX154J",
  "B09F9B3BCY",
  "B01NBPHPYF",
  "B0FSS6C79Z",
]);

function productsFor(family: "scooter" | "lighting") {
  return refreshedCatalog.filter(
    (product) => LEGACY_ASINS.has(product.asin) && product.productFamily === family,
  );
}

const legacyManualVocByAsin: Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>> =
  Object.fromEntries(
    Object.entries(rufusVocData).flatMap(([asin, record]) => {
      if (!LEGACY_ASINS.has(asin) || record.captureStatus !== "dialog") return [];
      return [[asin, ManualAlexaVocNormalizedRecordSchema.parse({ asin, ...record })]];
    }),
  );

function legacyProjection(family: "scooter" | "lighting") {
  const products = productsFor(family);
  const launchProducts = products.map((product) => ({
    ...product,
    productFamily: product.productFamily as "scooter" | "lighting",
  }));
  const summary = buildVocDevelopmentSummary(
    products.map(({ asin, brand, productFamily }) => ({
      asin,
      brand,
      productFamily: productFamily as "scooter" | "lighting",
    })),
    legacyManualVocByAsin,
  );
  const launch = buildProductLaunchAnalysis(launchProducts, {
    manualVocByAsin: legacyManualVocByAsin,
    keywordDemand: buildKeywordDemandAnalysis(launchProducts, {
      analysisByAsin: sifKeywordAnalysisData,
      enrichmentByKeyword: sifKeywordEnrichmentData,
    }),
  });

  return {
    summary,
    negativePriorityRows: launch.negativePriorityRows,
    positivePriorityRows: launch.positivePriorityRows,
    opportunities: launch.opportunities.map(
      ({
        id,
        name,
        tier,
        priority,
        priorityScore,
        demandEvidence,
        recommendation,
      }) => ({
        id,
        name,
        tier,
        priority,
        priorityScore,
        demandEvidence,
        recommendation,
      }),
    ),
    mergedThemes: launch.vocPositioning.mergedThemes,
  };
}

test("legacy scooter VOC themes, percentages, priorities, and evidence stay exact", () => {
  const projection = legacyProjection("scooter");
  const negatives = projection.summary.find((dimension) => dimension.key === "negatives");

  assert.equal(negatives?.themes[0]?.label, "耐用性 / 结构强度");
  assert.equal(negatives?.themes[0]?.mentionPct, 54.30417869243319);
  assert.deepEqual(
    projection.negativePriorityRows.slice(0, 3).map((row) => [
      row.issue,
      row.frequency,
      row.shouldFix,
    ]),
    [
      ["耐用性 / 结构强度", "54.3%（维度内）", "是 · 建议 P0/P1 解决"],
      ["安装便捷", "10.5%（维度内）", "是 · 建议 P0/P1 解决"],
      ["LED 发光轮与亮灯表现", "6.5%（维度内）", "观察，勿堆低频功能"],
    ],
  );
  assert.deepEqual(
    projection.positivePriorityRows.slice(0, 3).map((row) => [
      row.theme,
      row.frequency,
      row.shouldKeep,
    ]),
    [
      ["产品质量", "16.1%（维度内）", "是 · P0 必须保留并强化"],
      ["耐用性 / 结构强度", "14.1%（维度内）", "是 · P0 必须保留并强化"],
      ["LED 发光轮与亮灯表现", "12.2%（维度内）", "是 · P0 必须保留并强化"],
    ],
  );
  assert.deepEqual(
    projection.mergedThemes.slice(0, 5).map((row) => [row.theme, row.priority]),
    [
      ["安装与组装体验", "P0"],
      ["结构耐用与可靠性", "P0"],
      ["LED 发光与趣味体验", "P1"],
      ["骑行顺滑", "P2"],
      ["性价比感知", "P2"],
    ],
  );
  assert.deepEqual(
    projection.opportunities.map((row) => [row.id, row.tier, row.priorityScore]),
    [
      ["A", "P0", 94],
      ["B", "P0", 81],
      ["C", "P2", 62],
    ],
  );
  assert.equal(canonicalJsonSha256(projection), EXPECTED_DIGESTS.scooter);
});

test("legacy lighting VOC themes, percentages, priorities, and evidence stay exact", () => {
  const projection = legacyProjection("lighting");
  const negatives = projection.summary.find((dimension) => dimension.key === "negatives");

  assert.equal(negatives?.themes[0]?.label, "耐用性 / 结构强度");
  assert.equal(negatives?.themes[0]?.mentionPct, 82.08041958041957);
  assert.deepEqual(
    projection.negativePriorityRows.map((row) => [
      row.issue,
      row.frequency,
      row.shouldFix,
    ]),
    [
      ["耐用性 / 结构强度", "82.1%（维度内）", "是 · 建议 P0/P1 解决"],
      ["LED 照明 / 色温", "17.9%（维度内）", "是 · 建议 P0/P1 解决"],
    ],
  );
  assert.deepEqual(
    projection.positivePriorityRows.slice(0, 3).map((row) => [
      row.theme,
      row.frequency,
      row.shouldKeep,
    ]),
    [
      ["发光/灯光", "21.8%（维度内）", "是 · P0 必须保留并强化"],
      ["安装便捷", "20.5%（维度内）", "是 · P0 必须保留并强化"],
      ["外观颜值", "18.6%（维度内）", "是 · P0 必须保留并强化"],
    ],
  );
  assert.deepEqual(
    projection.mergedThemes.map((row) => [row.theme, row.priority]),
    [
      ["结构耐用与可靠性", "P0"],
      ["LED 照明与色温", "P0"],
      ["安装与组装体验", "P1"],
      ["性价比感知", "P2"],
    ],
  );
  assert.deepEqual(
    projection.opportunities.map((row) => [row.id, row.tier, row.priorityScore]),
    [
      ["A", "P0", 94],
      ["B", "P0", 81],
      ["C", "P1", 68],
      ["D", "P1", 57],
    ],
  );
  assert.equal(canonicalJsonSha256(projection), EXPECTED_DIGESTS.lighting);
});
