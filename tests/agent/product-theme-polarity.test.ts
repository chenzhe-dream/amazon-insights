import assert from "node:assert/strict";
import test from "node:test";
import { buildProductLaunchAnalysis, type LaunchProductInput } from "../../app/product-launch-analysis";
import { buildFinalProductDefinition } from "../../app/final-product-definition";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";

const praisedAsin = "B0AUDIT001";
const criticizedAsin = "B0AUDIT002";

function buildSameThemeWithOppositeFeedback() {
  const products: LaunchProductInput[] = [praisedAsin, criticizedAsin].map(asin => ({
    asin, title: "Three Wheel Scooter", price: 40, brand: "Fixture",
  }));
  const record = (asin: string, positives: string[], negatives: string[]): ManualAlexaVocNormalizedRecord => ({
    asin, attention: [], positives, negatives, unmet: [], audiences: [], scenarios: [], motives: [], captureStatus: "dialog",
    alexaReport: { title: "Offline controlled fixture", asin, rating: 4, reviewCount: 20, prompt: "fixture", overallConclusion: "Synthetic polarity regression fixture", captureStatus: "dialog" },
  });
  const analysis = buildProductLaunchAnalysis(products, {
    keywordDemand: null,
    manualVocByAsin: {
      [praisedAsin]: record(praisedAsin, ["【稳定性】占比100%：转弯平稳不侧翻"], []),
      [criticizedAsin]: record(criticizedAsin, [], ["【稳定性】占比100%：转弯不稳容易侧翻"]),
    },
  });
  return buildFinalProductDefinition({
    categoryLabel: analysis.meta.categoryLabel, productCount: products.length, dataMonth: analysis.meta.dataMonth,
    vocPositioning: analysis.vocPositioning, keyword: analysis.keywordConclusions, hasVocData: true,
  });
}

test("same-name theme preserves only positive ASIN evidence in VOC core-retention features", () => {
  const report = buildSameThemeWithOppositeFeedback();
  const rows = report.featureLayers.mustHave.filter(row => /VOC 核心保留/.test(row.item));
  assert.ok(rows.length, "the positive experience must remain a retained feature");
  for (const row of rows) {
    assert.ok(row.ruleDecisionIds?.length);
    const decisions = row.ruleDecisionIds!.map(id => report.ruleTrace!.decisions.find(decision => decision.candidateId === id)!);
    assert.ok(decisions.every(decision => decision.asin === praisedAsin), "a negative-only ASIN must not acquire a positive retention claim");
    assert.ok(decisions.every(decision => decision.evidenceRefs.every(ref => (report.ruleTrace!.sources.find(source => source.id === ref)?.kind !== "voc" || report.ruleTrace!.sources.find(source => source.id === ref)?.location === "positives"))));
  }
});

test("electronic durability feedback does not inherit mechanical-load acceptance", () => {
  const asin = "B0AUDIT003";
  const product: LaunchProductInput = { asin, title: "Candle Warmer Lamp", price: 40, brand: "Fixture" };
  const record: ManualAlexaVocNormalizedRecord = {
    asin, attention: [], positives: [], negatives: ["【耐久性差】占比100%：产品使用2至4个月后故障，或灯泡频繁损坏，整体耐久性较差"],
    unmet: [], audiences: [], scenarios: [], motives: [], captureStatus: "dialog",
    alexaReport: { title: "Offline controlled fixture", asin, rating: 4, reviewCount: 20, prompt: "fixture", overallConclusion: "Synthetic electrical durability fixture", captureStatus: "dialog" },
  };
  const analysis = buildProductLaunchAnalysis([product], { manualVocByAsin: { [asin]: record }, keywordDemand: null });
  const report = buildFinalProductDefinition({
    categoryLabel: analysis.meta.categoryLabel, productCount: 1, dataMonth: analysis.meta.dataMonth,
    vocPositioning: analysis.vocPositioning, keyword: analysis.keywordConclusions, hasVocData: true,
  });
  const priorities = report.priorityRows.filter(row => /耐用|耐久|可靠/.test(row.direction));
  assert.ok(priorities.length, "the durability failure still needs development work");
  assert.ok(priorities.some(row => /耐久性差/.test(row.action)), "the original failure stays in the action");
  for (const row of priorities) assert.doesNotMatch(row.acceptance, /承力结构循环载荷|连接件防松/, "bulb failure alone does not support mechanical-load acceptance");
});

test("same-name theme does not assign another ASIN's pain to the positive-only product", () => {
  const report = buildSameThemeWithOppositeFeedback();
  const rows = report.featureLayers.p0Avoid.filter(row => /稳定性/.test(row.item));
  assert.ok(rows.length, "the negative stability feedback must remain a P0 avoid item");
  for (const row of rows) {
    assert.ok(row.ruleDecisionIds?.length);
    const decisions = row.ruleDecisionIds!.map(id => report.ruleTrace!.decisions.find(decision => decision.candidateId === id)!);
    assert.ok(decisions.every(decision => decision.asin === criticizedAsin), "the positive-only ASIN has no stability pain to fix");
    assert.ok(decisions.every(decision => decision.evidenceRefs.every(ref => (report.ruleTrace!.sources.find(source => source.id === ref)?.kind !== "voc" || report.ruleTrace!.sources.find(source => source.id === ref)?.location === "negatives"))));
  }
});

test("merged priorities retain each ASIN's own preserve or fix action", () => {
  const report = buildSameThemeWithOppositeFeedback();
  const rows = report.priorityRows.filter(row => /稳定性/.test(row.direction));
  assert.ok(rows.length);
  const decisions = rows.flatMap(row => (row.ruleDecisionIds ?? []).map(id => report.ruleTrace!.decisions.find(decision => decision.candidateId === id)!));
  const praised = decisions.filter(decision => decision.asin === praisedAsin);
  const criticized = decisions.filter(decision => decision.asin === criticizedAsin);
  assert.ok(praised.length && criticized.length, "both products keep their own development action");
  assert.ok(praised.every(decision => /保留/.test(decision.text) && !/复现/.test(decision.text)));
  assert.ok(criticized.every(decision => /复现/.test(decision.text) && !/保留/.test(decision.text)));
  assert.ok(praised.every(decision => decision.evidenceRefs.every(ref => (report.ruleTrace!.sources.find(source => source.id === ref)?.kind !== "voc" || report.ruleTrace!.sources.find(source => source.id === ref)?.location === "positives"))));
  assert.ok(criticized.every(decision => decision.evidenceRefs.every(ref => (report.ruleTrace!.sources.find(source => source.id === ref)?.kind !== "voc" || report.ruleTrace!.sources.find(source => source.id === ref)?.location === "negatives"))));
});
