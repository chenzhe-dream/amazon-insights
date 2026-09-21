import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordLaunchConclusions } from "../../app/keyword-demand-conclusions";

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

const readyKeywordDemand = buildKeywordDemandAnalysis([product], keywordSources);

function functionDemandFixture(values: Array<[string, number | null, number]>) {
  const demand = structuredClone(readyKeywordDemand);
  demand.meta.readyCount = 4;
  const bucket = demand.categories.find(row => row.id === "function")!;
  assert.ok(bucket);
  bucket.keywords = values.map(([keyword, searchVolume, competitorCount], index) => ({
    keyword, searchVolume, competitorCount, category: "function", categoryLabel: "功能",
    aggregateShare: 100 - index, maxShare: 10, abaRank: null, competitors: [], listingHint: "功能词",
  }));
  bucket.keywordCount = values.length;
  return demand;
}

const dimmableKeyword = "unit dimmable candle warmer lamp";
const candleDemand = () => functionDemandFixture([
  ["unit candle warmer lamp with timer", 166151, 4],
  ["unit adjustable height candle warmer lamp", 8772, 1],
  ["unit candle warmer with timer", 16070, 2],
  [dimmableKeyword, 8212, 2],
]);

test("functional search evidence below priority thresholds stays pending instead of becoming a false need", () => {
  const result = buildKeywordLaunchConclusions(candleDemand(), [product]);
  assert.deepEqual(result.functionMatrix.map(row => row.type), ["基础必备", "高关注", "高关注", "待验证"]);
  const dimmable = result.functionMatrix.find(row => row.keyword === dimmableKeyword)!;
  assert.equal(dimmable.volume, 8212);
  assert.equal(dimmable.coverage, 2);
  assert.match(dimmable.action, /VOC/);
  assert.doesNotMatch(dimmable.action, /不单独配置|伪需求/);
  const profile = result.sections.find(row => row.id === "customer_profile")!;
  assert.ok(profile.items.some(row => row.label === "功能搜索信号" && row.value.includes(dimmableKeyword)));
  assert.ok(!profile.items.some(row => row.label === "最关注功能"));
});

test("missing search volumes cannot acquire a positive priority through a zero threshold", () => {
  for (const values of [
    [["unit missing volume", null, 4], ["unit zero volume", 0, 1]],
    [["unit known volume", 9000, 4], ["unit missing volume", null, 4]],
  ] as Array<Array<[string, number | null, number]>>) {
    const result = buildKeywordLaunchConclusions(functionDemandFixture(values), [product]);
    for (const row of result.functionMatrix.filter(row => row.keyword !== "unit known volume")) {
      assert.equal(row.type, "数据不足");
      assert.match(row.action, /补齐/);
    }
  }
});

test("uncertain keyword functions are retained for validation and never become automatic avoid recommendations", () => {
  const demand = candleDemand();
  demand.categories.find(row => row.id === "function")!.keywords.push({
    ...demand.categories.find(row => row.id === "function")!.keywords[3],
    keyword: "unit missing dimming evidence", searchVolume: null,
  });
  const launch = analysisWith(demand);
  const definition = buildDefinition(launch);
  for (const keyword of [dimmableKeyword, "unit missing dimming evidence"]) {
    const avoid = JSON.stringify({
      launch: launch.productDefinition.avoid,
      directions: launch.productDirections.map(row => row.avoidFeatures),
      final: definition.featureLayers.notInV1,
      requirements: definition.definitionRows.filter(row => row.dimension === "避坑要求"),
      riskWords: definition.keywordGroups.filter(row => /风险词/.test(row.type)),
    });
    assert.equal(avoid.includes(keyword), false, avoid);
    assert.ok(definition.nextValidations.some(row => row.includes(keyword)));
  }
});
const proxyKeywordDemand = buildKeywordDemandAnalysis([product], {
  analysisByAsin: {},
  enrichmentByKeyword: {},
});

function analysisWith(keywordDemand: typeof readyKeywordDemand | null) {
  return buildProductLaunchAnalysis([product], {
    manualVocByAsin: { [asin]: manualVoc },
    keywordDemand,
  });
}

test("ready keywords change launch verdict and executive outputs without replacing Manual VOC", () => {
  const ready = analysisWith(readyKeywordDemand);
  const proxy = analysisWith(proxyKeywordDemand);

  assert.equal(hasProductLaunchAnalysis([product], {
    manualVocByAsin: { [asin]: manualVoc },
    keywordDemand: readyKeywordDemand,
  }), true);
  assert.ok(ready.positivePriorityRows.some((row) => row.theme.includes("静音轴承")));
  assert.ok(proxy.positivePriorityRows.some((row) => row.theme.includes("静音轴承")));
  assert.match(ready.verdict.summary, /foldable scooter/);
  assert.match(ready.executiveSummary, /foldable scooter/);
  assert.match(proxy.verdict.summary, /关键词需求未就绪.*代理/);
  assert.match(proxy.executiveSummary, /关键词需求未就绪.*代理/);
  assert.notEqual(ready.verdict.title, proxy.verdict.title);
});

test("ready keywords change VOC positioning while preserving the VOC-only proxy boundary", () => {
  const ready = analysisWith(readyKeywordDemand);
  const proxy = analysisWith(proxyKeywordDemand);

  assert.match(JSON.stringify(ready.vocPositioning), /静音轴承/);
  assert.match(JSON.stringify(proxy.vocPositioning), /静音轴承/);
  assert.match(ready.vocPositioning.dataBoundary, /foldable scooter/);
  assert.match(proxy.vocPositioning.dataBoundary, /关键词需求未就绪.*VOC.*代理/);
  assert.notDeepEqual(ready.vocPositioning.rationale, proxy.vocPositioning.rationale);
});

test("ready keywords change final product definition while proxy keywords stay C-grade", () => {
  const ready = buildDefinition(analysisWith(readyKeywordDemand));
  const proxy = buildDefinition(analysisWith(proxyKeywordDemand));

  assert.match(JSON.stringify(ready), /静音轴承/);
  assert.match(JSON.stringify(ready), /foldable scooter/);
  assert.equal(proxy.opportunity.grade, "C");
  assert.match(proxy.opportunity.judgment, /关键词需求未就绪/);
  assert.notDeepEqual(ready.opportunity, proxy.opportunity);
});

test("ready keywords change launch checklist evidence while preserving Manual research", () => {
  const ready = analysisWith(readyKeywordDemand);
  const proxy = analysisWith(proxyKeywordDemand);

  assert.match(ready.checklistResearch.topAttention, /静音轴承/);
  assert.match(proxy.checklistResearch.topAttention, /静音轴承/);
  assert.match(ready.checklistResearch.verdictTitle, /foldable scooter/);
  assert.match(proxy.checklistResearch.verdictTitle, /关键词需求未就绪.*代理/);
  assert.notEqual(ready.checklistResearch.verdictTitle, proxy.checklistResearch.verdictTitle);
});

test("keywordDemand null produces the same documented keyword-not-ready boundary and C grade", () => {
  const analysis = analysisWith(null);
  const definition = buildDefinition(analysis);

  assert.equal(analysis.keywordConclusions, null);
  assert.equal(analysis.definitionSynthesis.keywordSummary, "关键词需求数据未就绪，本次定义以 VOC 机会评分为主。");
  assert.match(analysis.vocPositioning.dataBoundary, /关键词需求未就绪.*VOC.*代理/);
  assert.match(analysis.checklistResearch.verdictTitle, /关键词需求未就绪.*代理/);
  assert.equal(definition.opportunity.grade, "C");
  assert.match(definition.opportunity.judgment, /关键词需求未就绪/);
});

test("ready keywords cannot replace an empty Manual map in the bounded missing-VOC model", () => {
  const sources = { manualVocByAsin: {}, keywordDemand: readyKeywordDemand };
  const analysis = buildProductLaunchAnalysis([product], sources);

  assert.equal(hasProductLaunchAnalysis([product], sources), false);
  assert.equal(analysis.meta.productCount, 1);
  assert.equal(analysis.verdict.status, "hold");
  assert.match(analysis.verdict.summary, /关键词不能替代缺失 VOC/);
  assert.equal(analysis.finalDecision, "暂不开发");
  assert.equal(analysis.vocInsightRows.length, 7);
  assert.ok(analysis.checklistMeta.totalItems < 200);
});
