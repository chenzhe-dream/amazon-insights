import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKeywordDemandAnalysis,
  type KeywordDemandSources,
} from "../../app/features/keywords/keyword-demand-analysis";
import {
  buildProductLaunchAnalysis,
  type LaunchProductInput,
} from "../../app/product-launch-analysis";
import { buildVocDevelopmentSummary } from "../../app/features/voc/voc-development-summary";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";

const EXPECTED_DIGESTS = {
  scooter: "199c1e105f1c21ffd1a5009b379fc6f1e2b82dbd6abc6808817eedb180fc1df4",
  lighting: "92626444fec7ae33e7d3e017be8172d7dfbb608be245133d0bdee5b0e6ba2d20",
} as const;

const PRODUCTS = Object.freeze({
  scooter: Object.freeze<LaunchProductInput>({
    asin: "B0LEGACY01",
    brand: "Legacy Scooter",
    title: "Legacy foldable kick scooter",
    price: 59.99,
    sales: 800,
    subRankCategory: "Kids' Kick Scooters",
    productFamily: "scooter",
  }),
  lighting: Object.freeze<LaunchProductInput>({
    asin: "B0LEGACY02",
    brand: "Legacy Lighting",
    title: "Legacy dimmable floor lamp",
    price: 49.99,
    sales: 600,
    subRankCategory: "Floor Lamps",
    productFamily: "lighting",
  }),
});

function manualRecord(
  asin: string,
  positives: readonly string[],
  negatives: readonly string[],
): ManualAlexaVocNormalizedRecord {
  return Object.freeze({
    asin,
    attention: ["【产品质量】约 60% 评论提及（60 条）"],
    positives: [...positives],
    negatives: [...negatives],
    unmet: ["【可维修设计】约 35% 评论提及（35 条）"],
    audiences: ["【家庭用户】约 55% 评论提及（55 条）"],
    scenarios: ["【日常使用】约 50% 评论提及（50 条）"],
    motives: ["【耐用可靠】约 45% 评论提及（45 条）"],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: `${asin} immutable legacy fixture`,
      asin,
      rating: 4.4,
      reviewCount: 100,
      prompt: "Immutable legacy characterization fixture",
      overallConclusion: "Legacy VOC behavior remains deterministic.",
      captureStatus: "dialog" as const,
    },
  });
}

const MANUAL_VOC = Object.freeze({
  B0LEGACY01: manualRecord(
    "B0LEGACY01",
    ["【产品质量】约 65% 评论提及（65 条）", "【骑行顺滑】约 35% 评论提及（35 条）"],
    ["【耐用性 / 结构强度】约 70% 评论提及（70 条）", "【安装复杂】约 30% 评论提及（30 条）"],
  ),
  B0LEGACY02: manualRecord(
    "B0LEGACY02",
    ["【发光/灯光】约 60% 评论提及（60 条）", "【安装便捷】约 40% 评论提及（40 条）"],
    ["【耐用性 / 结构强度】约 80% 评论提及（80 条）", "【LED 照明 / 色温】约 20% 评论提及（20 条）"],
  ),
}) satisfies Readonly<Record<string, ManualAlexaVocNormalizedRecord>>;

function keywordRow(keyword: string, trafficShare: number, searchVolume: number) {
  return Object.freeze({
    keyword,
    trafficShare,
    searchVolume,
    abaRank: 20_000,
    cpcMedian: 1,
    cpcLow: 0.7,
    cpcHigh: 1.3,
    naturalRatio: 65,
    trafficDependency: "natural_dominant",
    organicRank: "p1,5/48",
    rankEvolution: "stable",
    keywordHealth: "healthy",
    top3ClickShare: 18,
    top3ConversionShare: 16,
    clickConversionRate: 8,
  });
}

const KEYWORD_SOURCES = Object.freeze({
  analysisByAsin: Object.freeze({
    B0LEGACY01: Object.freeze({
      asin: "B0LEGACY01",
      marketplace: "US",
      fetchedAt: "2026-08-31",
      status: "ready",
      totalKeywordsInPeriod: 2,
      topKeywordsAnalyzed: 2,
      keywords: [
        keywordRow("legacy kick scooter", 60, 20_000),
        keywordRow("legacy foldable scooter", 40, 8_000),
      ],
    }),
    B0LEGACY02: Object.freeze({
      asin: "B0LEGACY02",
      marketplace: "US",
      fetchedAt: "2026-08-31",
      status: "ready",
      totalKeywordsInPeriod: 2,
      topKeywordsAnalyzed: 2,
      keywords: [
        keywordRow("legacy floor lamp", 65, 18_000),
        keywordRow("legacy dimmable floor lamp", 35, 7_000),
      ],
    }),
  }),
  enrichmentByKeyword: Object.freeze({}),
}) satisfies KeywordDemandSources;

function legacyProjection(family: "scooter" | "lighting") {
  const product = PRODUCTS[family];
  const products = [product];
  const summary = buildVocDevelopmentSummary(products, MANUAL_VOC);
  const launch = buildProductLaunchAnalysis(products, {
    manualVocByAsin: MANUAL_VOC,
    keywordDemand: buildKeywordDemandAnalysis(products, KEYWORD_SOURCES),
  });

  return {
    summary,
    negativePriorityRows: launch.negativePriorityRows,
    positivePriorityRows: launch.positivePriorityRows,
    opportunities: launch.opportunities.map(
      ({ id, name, tier, priority, priorityScore, demandEvidence, recommendation }) => ({
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

test("legacy scooter VOC aggregation stays exact from immutable records and enrichment", () => {
  const projection = legacyProjection("scooter");
  const negatives = projection.summary.find((dimension) => dimension.key === "negatives");

  assert.deepEqual(
    negatives?.themes.map((theme) => [theme.label, theme.mentionPct]),
    [["耐用性 / 结构强度", 70], ["安装复杂", 30]],
  );
  assert.match(projection.negativePriorityRows[0]?.shouldFix ?? "", /P0\/P1/);
  assert.equal(projection.positivePriorityRows[0]?.shouldKeep, "是 · P0 必须保留并强化");
  assert.equal(projection.mergedThemes[0]?.priority, "P0");
  assert.equal(canonicalJsonSha256(projection), EXPECTED_DIGESTS.scooter);
});

test("legacy lighting VOC aggregation stays exact from immutable records and enrichment", () => {
  const projection = legacyProjection("lighting");
  const negatives = projection.summary.find((dimension) => dimension.key === "negatives");

  assert.deepEqual(
    negatives?.themes.map((theme) => [theme.label, theme.mentionPct]),
    [["耐用性 / 结构强度", 80], ["LED 照明 / 色温", 20]],
  );
  assert.match(projection.negativePriorityRows[0]?.shouldFix ?? "", /P0\/P1/);
  assert.equal(projection.positivePriorityRows[0]?.shouldKeep, "是 · P0 必须保留并强化");
  assert.equal(projection.mergedThemes[0]?.priority, "P0");
  assert.equal(canonicalJsonSha256(projection), EXPECTED_DIGESTS.lighting);
});
