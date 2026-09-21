import assert from "node:assert/strict";
import test from "node:test";
import { buildProductLaunchAnalysis, type LaunchProductInput } from "../../app/product-launch-analysis";
import { buildFinalProductDefinition } from "../../app/final-product-definition";
import { buildKeywordDemandAnalysis } from "../../app/keyword-demand-analysis";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";

function analyze(title: string, need: string, keywordText: string) {
  const product: LaunchProductInput = { asin: "B0FINAL001", title, brand: "Fixture", price: 40 };
  const voc: ManualAlexaVocNormalizedRecord = { asin: product.asin, attention: [need], positives: [need], negatives: [need], unmet: [need], audiences: [], scenarios: [], motives: [], captureStatus: "dialog", alexaReport: { title: "Fixture", asin: product.asin, rating: 4, reviewCount: 20, prompt: "fixture", overallConclusion: need, captureStatus: "dialog" } };
  const keywordDemand = buildKeywordDemandAnalysis([product], { analysisByAsin: {}, enrichmentByKeyword: {} });
  const analysis = buildProductLaunchAnalysis([product], { manualVocByAsin: { [product.asin]: voc }, keywordDemand, analysisScope: { organizationId: "org", projectId: "project", marketplace: "US" } });
  const keyword = analysis.keywordConclusions!;
  keyword.hasData = true;
  keyword.functionMatrix = [{ keyword: keywordText, type: "基础必备", volume: 10000, coverage: 100, action: "全 SKU 标配" }, { keyword: keywordText, type: "差异化", volume: 5000, coverage: 50, action: "升级配置" }];
  keyword.keywordCombos = [{ keyword: keywordText, elements: "需求词", volume: 10000 }];
  return { analysis, keyword };
}
function final(input: ReturnType<typeof analyze>) {
  return buildFinalProductDefinition({ categoryLabel: input.analysis.meta.categoryLabel, productCount: 1, dataMonth: input.analysis.meta.dataMonth, vocPositioning: input.analysis.vocPositioning, keyword: input.keyword, hasVocData: true });
}

test("snow cross-shape keywords cannot become final feature or priority hardware commitments", () => {
  const input = analyze("Snow Scooter, ski-bottom, no wheels", "连接松动", "three wheel scooter");
  input.analysis.vocPositioning.optimizeRows[0].productAction = "增加轮距并验证转向稳定性";
  input.analysis.vocPositioning.optimizeRows[0].direction = "增加轮距";
  const result = final(input);
  assert.doesNotMatch([...result.featureLayers.mustHave, ...result.featureLayers.differentiation].map(row => row.item).join(" "), /three wheel|轮距/);
  assert.doesNotMatch(result.priorityRows.map(row => `${row.direction} ${row.action}`).join(" "), /增加轮距/);
  assert.ok(result.keywordGroups.some(row => row.keywords.includes("three wheel scooter")), "raw demand keyword remains visible");
  assert.doesNotMatch(result.keywordGroups.map(row => row.skuHint).join(" "), /全 SKU 标配/);
  assert.doesNotMatch(result.featureLayers.notInV1.map(row => row.item).join(" "), /转向机构|大改模具/);
  assert.ok(result.ruleTrace!.decisions.some(decision => /增加轮距/.test(decision.text) && decision.outcome === "rejected"));
  assert.ok(result.priorityRows.every(row => row.ruleDecisionIds?.length));
  assert.ok(result.keywordGroups.every(row => row.ruleDecisionIds?.length));
});

test("real wheel structure and stability need retain useful final configurations with decisions", () => {
  const result = final(analyze("Three wheel scooter", "转弯稳定性不足，需要提高稳定性", "three wheel scooter"));
  const row = result.featureLayers.mustHave.find(row => /稳定/.test(row.item));
  assert.ok(row);
  assert.ok(row.ruleDecisionIds?.length);
  assert.ok(row.ruleDecisionIds!.every(id => result.ruleTrace!.decisions.some(decision => decision.candidateId === id && decision.outcome === "supported")));
  assert.ok(result.priorityRows.some(row => /轮距|稳定/.test(row.action)));
});

test("unknown nonelectric products retain capacity improvements without steering-platform templates", () => {
  const result = final(analyze("Woven storage basket", "容量不足取放困难", "storage capacity"));
  assert.ok([...result.featureLayers.mustHave, ...result.featureLayers.differentiation].some(row => /容量|capacity/.test(row.item)));
  assert.ok(result.priorityRows.some(row => /容量|取放/.test(row.action)));
  assert.doesNotMatch(JSON.stringify(result.featureLayers), /转向机构|大改模具|轮距/);
});

test("final definition consumes accepted keyword product recommendations, never raw hypotheses", () => {
  const input = analyze("Snow Scooter, ski-bottom, no wheels", "连接松动", "three wheel scooter");
  const section = { id: "product_dev", title: "产品开发", items: [] as Array<{ label: string; value: string; acceptedValue?: string }> };
  input.keyword.sections.push(section);
  for (const label of ["基础功能清单", "差异化功能清单", "建议材质与规格", "建议颜色/SKU", "建议产品形态"]) {
    const item = section.items.find(item => item.label === label);
    if (item) { item.value = "三轮轮距30厘米铝合金支架"; item.acceptedValue = "待核对当前商品结构及来源"; }
    else section.items.push({ label, value: "三轮轮距30厘米铝合金支架", acceptedValue: "待核对当前商品结构及来源" });
  }
  const result = final(input);
  assert.doesNotMatch(result.definitionRows.map(row => `${row.conclusion} ${row.action} ${row.keywordBasis}`).join(" "), /三轮轮距30厘米铝合金支架/);
  assert.doesNotMatch([...result.featureLayers.mustHave, ...result.featureLayers.differentiation, ...result.featureLayers.optional].map(row => row.item).join(" "), /三轮轮距30厘米铝合金支架/);
});
