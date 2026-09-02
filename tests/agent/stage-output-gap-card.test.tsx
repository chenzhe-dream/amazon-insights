import assert from "node:assert/strict";
import test from "node:test";
import type { StageOutputSnapshot } from "../../app/lib/stage-output-browser";
import { StageOutputGapCard } from "../../app/stage-output-gap-card";

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
