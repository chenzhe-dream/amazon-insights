import assert from "node:assert/strict";
import test from "node:test";

import { buildFinalProductDefinition } from "../../app/final-product-definition";
import {
  buildKeywordDemandAnalysis,
  type KeywordDemandSources,
} from "../../app/keyword-demand-analysis";
import {
  buildProductLaunchAnalysis,
  hasProductLaunchAnalysis,
} from "../../app/product-launch-analysis";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";

const asin = "B0UNIT1001";
const product = {
  asin,
  brand: "Unit One",
  title: "Quiet foldable kick scooter",
  price: 69.99,
  sales: 120,
  subRankCategory: "Kids' Kick Scooters",
  productFamily: "scooter" as const,
};

const manualVoc: ManualAlexaVocNormalizedRecord = {
  asin,
  attention: ["【静音轴承】约 70% 评论提及（70 条）"],
  positives: ["【静音轴承】约 65% 评论提及（65 条）"],
  negatives: ["【刹车松动】约 40% 评论提及（40 条）"],
  unmet: ["【可更换静音轴承】约 35% 评论提及（35 条）"],
  audiences: ["【通勤家庭】约 60% 评论提及（60 条）"],
  scenarios: ["【安静社区骑行】约 55% 评论提及（55 条）"],
  motives: ["【低噪出行】约 50% 评论提及（50 条）"],
  captureStatus: "dialog",
  alexaReport: {
    title: "Unit one manual VOC",
    asin,
    rating: 4.5,
    reviewCount: 100,
    prompt: "Summarize seven dimensions",
    overallConclusion: "Quiet bearings matter to commuting families.",
    captureStatus: "dialog",
  },
};

const keywordSources: KeywordDemandSources = {
  analysisByAsin: {
    [asin]: {
      asin,
      marketplace: "US",
      fetchedAt: "2026-08-31",
      status: "ready",
      totalKeywordsInPeriod: 2,
      topKeywordsAnalyzed: 2,
      keywords: [
        {
          keyword: "kick scooter",
          trafficShare: 55,
          searchVolume: 24_000,
          abaRank: 12_000,
          cpcMedian: 1.2,
          cpcLow: 0.8,
          cpcHigh: 1.5,
          naturalRatio: 70,
          trafficDependency: "natural_dominant",
          organicRank: "p1,3/48",
          rankEvolution: "rising",
          keywordHealth: "healthy",
          top3ClickShare: 20,
          top3ConversionShare: 18,
          clickConversionRate: 9,
        },
        {
          keyword: "foldable scooter",
          trafficShare: 45,
          searchVolume: 9_000,
          abaRank: 25_000,
          cpcMedian: 0.9,
          cpcLow: 0.6,
          cpcHigh: 1.2,
          naturalRatio: 62,
          trafficDependency: "mixed",
          organicRank: "p1,8/48",
          rankEvolution: "stable",
          keywordHealth: "healthy",
          top3ClickShare: 14,
          top3ConversionShare: 12,
          clickConversionRate: 7,
        },
      ],
    },
  },
  enrichmentByKeyword: {},
};

function buildDefinition(analysis: ReturnType<typeof buildProductLaunchAnalysis>) {
  return buildFinalProductDefinition({
    categoryLabel: analysis.meta.categoryLabel,
    productCount: analysis.meta.productCount,
    dataMonth: analysis.meta.dataMonth,
    vocPositioning: analysis.vocPositioning,
    keyword: analysis.keywordConclusions,
    priceBand: analysis.productDefinition.targetPrice,
    hasVocData: true,
  });
}

test("explicit Manual VOC and keyword sources reach all four product-analysis consumers", () => {
  const keywordDemand = buildKeywordDemandAnalysis([product], keywordSources);
  const sources = {
    manualVocByAsin: { [asin]: manualVoc },
    keywordDemand,
  };

  const analysis = buildProductLaunchAnalysis([product], sources);
  const serializedKeyword = JSON.stringify(analysis.keywordConclusions);
  const definition = buildDefinition(analysis);

  assert.equal(hasProductLaunchAnalysis([product], sources), true);
  assert.ok(analysis.positivePriorityRows.some((row) => row.theme.includes("静音轴承")));
  assert.ok(JSON.stringify(analysis.vocPositioning).includes("静音轴承"));
  assert.ok(serializedKeyword.includes("foldable scooter"));
  assert.ok(JSON.stringify(definition).includes("foldable scooter"));
  assert.match(analysis.checklistResearch.topAttention, /静音轴承/);
});

test("keywordDemand null produces the documented keyword-not-ready C grade", () => {
  const sources = {
    manualVocByAsin: { [asin]: manualVoc },
    keywordDemand: null,
  };

  const analysis = buildProductLaunchAnalysis([product], sources);
  const definition = buildDefinition(analysis);

  assert.equal(analysis.keywordConclusions, null);
  assert.equal(analysis.definitionSynthesis.keywordSummary, "关键词需求数据未就绪，本次定义以 VOC 机会评分为主。");
  assert.equal(definition.opportunity.grade, "C");
  assert.match(definition.opportunity.judgment, /关键词需求未就绪/);
});

test("an empty Manual map returns a bounded missing-VOC model", () => {
  const sources = { manualVocByAsin: {}, keywordDemand: null };
  const analysis = buildProductLaunchAnalysis([product], sources);

  assert.equal(hasProductLaunchAnalysis([product], sources), false);
  assert.equal(analysis.meta.productCount, 1);
  assert.equal(analysis.verdict.status, "hold");
  assert.equal(analysis.finalDecision, "暂不开发");
  assert.equal(analysis.vocInsightRows.length, 7);
  assert.ok(analysis.checklistMeta.totalItems < 200);
});
