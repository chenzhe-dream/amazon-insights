import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StageOutputSnapshot } from "../../app/lib/stage-output-browser";
import { StageOutputGapCard } from "../../app/features/sync/stage-output-gap-card";

test("missing output renders the bounded-retry gap", () => {
  const snapshot: StageOutputSnapshot = Object.freeze({
    keywords: Object.freeze({ stage: "keywords", stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }),
  });
  const html = JSON.stringify(StageOutputGapCard({ snapshot, stage: "keywords" }));
  assert.match(html, /关键词/);
  assert.match(html, /数据缺口/);
  assert.match(html, /阶段结果暂不可用，已停止自动重试/);
});

test("late projectable stages have a visible bounded-gap label", () => {
  for (const [stage, label] of [["child_sales", "子体销量"], ["price_strategy", "价格策略"], ["image_remarks", "主副图备注"]] as const) {
    const snapshot: StageOutputSnapshot = Object.freeze({
      [stage]: Object.freeze({ stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }),
    });
    assert.match(JSON.stringify(StageOutputGapCard({ snapshot, stage })), new RegExp(label));
  }
});

test("partial gaps disclose the failed ASIN and its bounded precise reason", () => {
  const snapshot: StageOutputSnapshot = Object.freeze({
    keywords: Object.freeze({
      stage: "keywords", stageStatus: "partial",
      data: { analysisByAsin: {}, enrichmentByKeyword: {} },
      gap: { state: "partial", reasonCode: "UPSTREAM_EMPTY", items: [{
        asin: "B0SCHEMA01", causeCode: "SIF_KEYWORD_SCHEMA_INVALID",
      }] },
      jobId: "job", projectId: "10000000-0000-4000-8000-000000000001", runId: "10000000-0000-4000-8000-000000000002",
      jobVersion: 1, outputVersion: 1, contentHash: "a".repeat(64), updatedAt: "2026-09-02T00:00:00.000Z",
    }),
  });
  const html = JSON.stringify(StageOutputGapCard({ snapshot, stage: "keywords" }));
  assert.match(html, /B0SCHEMA01/);
  assert.match(html, /关键词数据结构无效/);
});

test("partial child sales renders a compact per-ASIN gap and explains retained results", () => {
  const snapshot: StageOutputSnapshot = {
    child_sales: {
      stage: "child_sales", stageStatus: "partial", data: { rowsByAsin: {} },
      gap: { state: "partial", reasonCode: "UPSTREAM_EMPTY", items: [
        { asin: "B0F43M9KWW", causeCode: "UPSTREAM_EMPTY" },
        { asin: "B0SCHEMA01", causeCode: "MCP_SCHEMA" },
      ] },
      jobId: "job", projectId: "10000000-0000-4000-8000-000000000001", runId: "10000000-0000-4000-8000-000000000002",
      jobVersion: 1, outputVersion: 1, contentHash: "a".repeat(64), updatedAt: "2026-09-10T00:00:00.000Z",
    },
  };
  const html = renderToStaticMarkup(StageOutputGapCard({ snapshot, stage: "child_sales" }));
  assert.match(html, /stage-output-gap-notice/);
  assert.match(html, /role="status"/);
  assert.match(html, /B0F43M9KWW：数据源暂无可用子体销量/);
  assert.match(html, /B0SCHEMA01：数据源返回结构无效/);
  assert.match(html, /已获取的商品数据正常保留/);
  assert.doesNotMatch(html, /pending-box|class="card"/);
});
