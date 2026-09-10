import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProductDefinitionSection } from "../../app/product-definition-section";
import { PRODUCT_DEFINITION_DATA_BOUNDARY } from "../../shared/product-definition-output";

const products = [{ asin: "B000000001", brand: "Local Brand", title: "LOCAL_SYNTHESIS_MARKER" }];
const sources = { reviewAnalysis: { source: "LOCAL_SOURCE_MARKER" } } as never;

const persistedResult = {
  schemaVersion: "1.0.0",
  kind: "amazon-product-definition",
  status: "complete",
  identity: {
    vocReportId: "11111111-1111-4111-8111-111111111111",
    vocReportVersion: 1,
    keywordSnapshotId: "22222222-2222-4222-8222-222222222222",
    keywordContentHash: "a".repeat(64),
    dataCutoffAt: "2026-09-10T00:00:00.000Z",
  },
  opportunity: { grade: "B", scope: "demand-and-product-definition-opportunity", projectApproval: "not-approved" },
  evidenceMatrix: [{
    themeKey: "durability", keywordGroupId: "durable", vocEvidenceIds: ["voc-1"],
    keywordEvidenceIds: ["kw-1"], judgment: "dual-validation", productRole: "core-foundation", priority: "P0",
  }],
  finalDefinition: [{
    dimension: "pain-point", conclusion: "PERSISTED_RESULT_MARKER", vocEvidenceIds: ["voc-1"],
    keywordEvidenceIds: ["kw-1"], action: "redesign", priority: "P0", validationStatus: "supported",
  }],
  configurationLayers: {
    mustHave: [{ item: "加固结构", evidenceIds: ["voc-1"] }], differentiation: [], optional: [], notInV1: [], p0Avoid: [],
  },
  keywordLanding: [{
    groupId: "durable", role: "feature", productLink: "加固结构", listingAngle: "耐用", skuHint: "基础款", evidenceIds: ["kw-1"],
  }],
  priorities: [{ priority: "P0", direction: "重做连接处", evidenceIds: ["voc-1", "kw-1"], action: "redesign", acceptance: "跌落测试" }],
  risks: [
    { area: "cost", status: "requires-validation", nextStep: "核算成本" },
    { area: "profitability", status: "requires-validation", nextStep: "核算利润" },
    { area: "patent", status: "requires-validation", nextStep: "完成专利检索" },
    { area: "compliance", status: "requires-validation", nextStep: "完成合规核验" },
    { area: "supply-chain", status: "requires-validation", nextStep: "验证供应链" },
  ],
  commercialValidation: {
    cost: "requires-validation", profitability: "requires-validation", patent: "requires-validation",
    compliance: "requires-validation", supplyChain: "requires-validation",
  },
  dataBoundary: PRODUCT_DEFINITION_DATA_BOUNDARY,
};

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(ProductDefinitionSection, { products, sources, ...props }));
}

test("local products and sources never synthesize a product definition without a saved report", () => {
  const html = render({ current: true, executionState: "succeeded" });
  assert.match(html, /等待已保存的新品定义报告/);
  assert.doesNotMatch(html, /LOCAL_SYNTHESIS_MARKER|LOCAL_SOURCE_MARKER|机会等级\s*<b>B/);
});

test("running or failed execution keeps historical output separate from the current result", () => {
  for (const executionState of ["running", "failed"]) {
    const html = render({
      current: false,
      executionState,
      sourceLabel: "历史版本 v1",
      savedReport: { id: "report-old", status: "complete", result: persistedResult },
    });
    assert.match(html, /历史报告/);
    assert.match(html, /历史版本 v1/);
    assert.match(html, /PERSISTED_RESULT_MARKER/);
    assert.match(html, executionState === "running" ? /当前执行中/ : /当前执行失败/);
    assert.doesNotMatch(html, /当前结果已保存/);
  }
});

test("only a current successful execution renders a saved report as current output", () => {
  const html = render({
    current: true,
    executionState: "succeeded",
    savedReport: { id: "report-current", status: "partial", result: { ...persistedResult, status: "partial", opportunity: { ...persistedResult.opportunity, grade: null, pendingReason: "商业条件待验证" } } },
  });
  assert.match(html, /当前结果已保存/);
  assert.match(html, /PERSISTED_RESULT_MARKER/);
  assert.match(html, /机会等级\s*<b>待验证/);
});

test("invalid persisted schema never renders as a final result", () => {
  const html = render({
    current: true,
    executionState: "succeeded",
    savedReport: { id: "report-invalid", status: "complete", result: { kind: "amazon-product-definition" } },
  });
  assert.match(html, /报告格式无法识别/);
  assert.doesNotMatch(html, /当前结果已保存/);
});

test("shared schema rejects a plausible report with invalid identity and commercial state", () => {
  const html = render({
    current: true,
    executionState: "succeeded",
    savedReport: {
      id: "report-invalid-contract",
      status: "complete",
      result: {
        ...persistedResult,
        identity: { ...persistedResult.identity, vocReportId: "not-an-entity-id" },
        commercialValidation: { ...persistedResult.commercialValidation, cost: "approved" },
      },
    },
  });

  assert.match(html, /报告格式无法识别/);
  assert.doesNotMatch(html, /PERSISTED_RESULT_MARKER/);
});

test("schema-valid single-source evidence with null counterpart renders", () => {
  const html = render({
    current: true,
    executionState: "succeeded",
    savedReport: {
      id: "report-single-source",
      status: "partial",
      result: {
        ...persistedResult,
        status: "partial",
        opportunity: { ...persistedResult.opportunity, grade: null, pendingReason: "仅有 VOC 证据" },
        evidenceMatrix: [{
          ...persistedResult.evidenceMatrix[0],
          keywordGroupId: null,
          keywordEvidenceIds: [],
          judgment: "voc-only",
        }],
      },
    },
  });

  assert.match(html, /当前结果已保存/);
  assert.match(html, /VOC 单侧验证/);
  assert.match(html, /机会等级\s*<b>待验证/);
});
