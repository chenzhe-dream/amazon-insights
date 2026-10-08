import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordOriginalEstimate } from "../../server/domain/market-research/keyword-original-estimate";
import { keywordRuleFixture } from "./helpers/market-keyword-rule-fixture";
import { canonicalJsonSha256 as digest } from "../../server/runtime/model-request-accounting";

const expectedIds = [
  "demand-conclusion",
  "target-audience",
  "use-scenario",
  "purchase-motivation",
  "basic-features",
  "differentiated-features",
  "specifications",
  "unmet-needs",
  "price-band",
  "competition-difficulty",
  "development-plan",
  "opportunity-level",
  "risks",
  "next-steps",
] as const;

test("keyword estimate exposes all 14 business outputs with evidence or explicit gaps", () => {
  const facts = structuredClone(keywordRuleFixture().response.run.facts!);
  facts.members.forEach((member, index) => {
    member.pageMetrics.monthlySearchVolume = { value: index === 0 ? 100 : 50, reason: null };
  });
  const { factsId: _factsId, ...basis } = facts;
  facts.factsId = `market-keyword-facts:${digest(basis)}`;

  const estimate = buildKeywordOriginalEstimate({ facts, productSeed: "lamp" });
  const outputs = (estimate.report as unknown as {
    businessOutputs?: Array<{ id: string; status: string; conclusion: string; sourceRefs: string[]; missing: string[] }>;
  }).businessOutputs;

  assert.ok(outputs);
  assert.deepEqual(outputs.map(output => output.id), expectedIds);
  for (const output of outputs) {
    assert.ok(output.conclusion.length > 0);
    assert.ok(output.status === "ready" ? output.sourceRefs.length > 0 : output.missing.length > 0);
  }
  assert.equal(outputs.find(output => output.id === "price-band")?.status, "pending");
  assert.equal(outputs.find(output => output.id === "unmet-needs")?.status, "pending");
});
