import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default new Proxy({}, { get: (_, key) => String(key) });",
      };
    }
    return nextLoad(url, context);
  },
});

const { AnalysisRuleExplanation, RuleDecisionExplanation } = await import("../../app/analysis-rule-explanation");
const { RULE_DEFINITIONS } = await import("../../shared/product-structure-rules");

const rule = RULE_DEFINITIONS.find(item => item.id === "R04")!;

const trace = {
  ruleSetVersion: "2026.09.16",
  ruleDefinitions: [rule],
  inputScope: { organizationId: "org-1", projectId: "project-1", marketplace: "US", asins: ["B0SNOW0001"], inputRevision: "rev-1" },
  sources: [{ id: "source-title", text: "Snow Scooter for Toddlers", kind: "title", scope: "asin", asin: "B0SNOW0001" }],
  decisions: [
    {
      candidateId: "voc-unmet:0",
      asin: "B0SNOW0001",
      kind: "proposal",
      text: "改成三轮",
      outcome: "rejected",
      reasonCode: "structure-not-supported",
      summary: "雪地滑行结构不支持三轮建议",
      checks: ["核对实际使用方式"],
      ruleSetVersion: "2026.09.16",
      ruleIds: ["R04"],
      ruleVersions: { R04: "1.0.0" },
      inputScope: { organizationId: "org-1", projectId: "project-1", marketplace: "US", asins: ["B0SNOW0001"], inputRevision: "rev-1" },
      evidenceRefs: ["source-title", "source-missing"],
      matchedConditions: [{ predicate: { op: "candidate_kind_is", value: "proposal" }, description: "候选输出为开发建议", passed: true }],
    },
  ],
};

test("rule overview is available without analysis data and presents executable conditions", () => {
  const html = renderToStaticMarkup(createElement(AnalysisRuleExplanation, { resultAvailable: false }));
  assert.match(html, /分析规则说明/);
  assert.match(html, /当前规则版本/);
  assert.match(html, /R01/);
  assert.match(html, /适用条件/);
  assert.match(html, /正例/);
  assert.doesNotMatch(html, /编辑规则|绕过判定/);
  assert.doesNotMatch(html, /历史结果未记录规则版本/);
});

test("legacy result states explicitly that no historical rule version was recorded", () => {
  const html = renderToStaticMarkup(createElement(AnalysisRuleExplanation, { resultAvailable: true }));
  assert.match(html, /历史结果未记录规则版本/);
  assert.match(html, /不会用当前规则冒充/);
});

test("trace separates rejected candidates and preserves source availability", () => {
  const html = renderToStaticMarkup(createElement(AnalysisRuleExplanation, { resultAvailable: true, trace: trace as never }));
  assert.match(html, /结果采用版本/);
  assert.match(html, /2026\.09\.16/);
  assert.match(html, /R01/);
  assert.match(html, /R12/);
  assert.match(html, /未采用的建议/);
  assert.match(html, /改成三轮/);
  assert.match(html, /B0SNOW0001/);
  assert.match(html, /Snow Scooter for Toddlers/);
  assert.match(html, /来源不可用/);
});

test("row explanation renders matched conditions and only its requested decisions", () => {
  const html = renderToStaticMarkup(createElement(RuleDecisionExplanation, {
    trace: trace as never,
    decisionIds: ["voc-unmet:0"],
  }));
  assert.match(html, /为什么这样判断/);
  assert.match(html, /候选输出为开发建议/);
  assert.match(html, /满足/);
  assert.match(html, /R04 v1\.0\.0/);
});
