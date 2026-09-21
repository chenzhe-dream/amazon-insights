import assert from "node:assert/strict";
import test from "node:test";

import { buildKeywordDemandAnalysis, type KeywordDemandSources } from "../../app/keyword-demand-analysis";
import { buildProductLaunchAnalysis, type LaunchProductInput } from "../../app/product-launch-analysis";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";

const metrics = { abaRank: null, cpcMedian: null, cpcLow: null, cpcHigh: null, naturalRatio: null, trafficDependency: null, organicRank: null, rankEvolution: null, keywordHealth: null, top3ClickShare: null, top3ConversionShare: null, clickConversionRate: null };

function voc(asin: string): ManualAlexaVocNormalizedRecord {
  return { asin, attention: ["【结构耐用】约 60% 提及"], positives: ["【户外体验】约 40% 提及"], negatives: ["【连接松动】约 30% 提及"], unmet: ["【连接更牢固】约 20% 提及"], audiences: ["【儿童使用需核对】"], scenarios: ["【户外活动】约 60% 提及"], motives: ["【耐用】约 50% 提及"], captureStatus: "dialog", alexaReport: { title: "Fixture", asin, captureStatus: "dialog", rating: 4.5, reviewCount: 100, prompt: "fixture", overallConclusion: "连接需要改进" } };
}

function keywordDemand(product: LaunchProductInput) {
  const sources: KeywordDemandSources = { enrichmentByKeyword: {}, analysisByAsin: { [product.asin]: { asin: product.asin, marketplace: "US", fetchedAt: "2026-09-16", status: "ready", totalKeywordsInPeriod: 2, topKeywordsAnalyzed: 2, keywords: [
    { ...metrics, keyword: "3 wheel scooter", trafficShare: 70, searchVolume: 50_000 },
    { ...metrics, keyword: "wide wheel base scooter", trafficShare: 30, searchVolume: 30_000 },
  ] } } };
  return buildKeywordDemandAnalysis([product], sources);
}

function analyze(product: LaunchProductInput, record = voc(product.asin)) {
  return buildProductLaunchAnalysis([product], { manualVocByAsin: { [product.asin]: record }, keywordDemand: keywordDemand(product) });
}

test("snow keyword structure stays a demand signal and never enters formal direction structure", () => {
  const snow: LaunchProductInput = { asin: "B0SNOWFORM", brand: "Snow", title: "Snow Scooter gliding board, no wheels", subRankCategory: "Snow Sleds" };
  const result = analyze(snow);
  const demandText = result.keywordConclusions?.sections.flatMap(section => section.items).map(item => item.value).join(" ") ?? "";
  const formal = [result.productDefinition.name,...result.productDefinition.mustHave,...result.productDefinition.niceToHave,...result.productDirections.map(direction => `${direction.positioning} ${direction.baseFeatures} ${direction.differentiatedFeatures} ${direction.materialStructure}`)].join(" ");

  assert.match(demandText, /3 wheel scooter/);
  assert.doesNotMatch(formal, /3 wheel|wide wheel base/i);
  assert.ok(result.keywordConclusions?.ruleTrace?.decisions.some(decision => decision.text.match(/3 wheel/i) && decision.outcome === "rejected"));
});

test("confirmed three-wheel product keeps applicable keyword structure with trace linkage", () => {
  const wheeled: LaunchProductInput = { asin: "B03WHEEL01", brand: "Wheel", title: "3 wheel kick scooter with wide wheel base", subRankCategory: "Kick Scooters" };
  const record = { ...voc(wheeled.asin), negatives: ["【稳定性不足】约 30% 提及"] };
  const result = analyze(wheeled, record);
  const formal = result.negativePriorityRows.map(row => row.fixDirection).join(" ");

  assert.match(formal, /轮距|实际轮数/);
  assert.match(result.keywordConclusions?.sections.flatMap(section => section.items).map(item => item.value).join(" ") ?? "", /3 wheel scooter/);
  assert.ok(result.negativePriorityRows.some(row => (row.ruleDecisionIds?.length ?? 0) > 0));
  assert.ok(result.ruleTrace?.decisions.some(decision => decision.text.match(/轮距|实际轮数/) && decision.outcome === "supported"));
});
