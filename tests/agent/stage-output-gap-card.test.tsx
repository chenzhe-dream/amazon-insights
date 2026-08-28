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
