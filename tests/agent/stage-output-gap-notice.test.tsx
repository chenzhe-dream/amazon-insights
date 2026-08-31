import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { StageOutputGapNotice, stageOutputGapReasonCode } from "../../app/stage-output-gap-notice";

test("only a non-done stage projection exposes a notice reason", () => {
  assert.equal(stageOutputGapReasonCode(undefined), null);
  assert.equal(stageOutputGapReasonCode({ stageStatus: "done" }), null);
  assert.equal(stageOutputGapReasonCode({
    stageStatus: "partial",
    gap: { reasonCode: "CONNECT_TIMEOUT" },
  }), "CONNECT_TIMEOUT");
  assert.equal(stageOutputGapReasonCode({
    stageStatus: "missing-output",
    reasonCode: "OUTPUT_UNAVAILABLE",
  }), "OUTPUT_UNAVAILABLE");
});

test("partial review output names the missing ASIN and preserves the safe reason", () => {
  const html = JSON.stringify(StageOutputGapNotice({
    label: "评论数据",
    asins: ["B000000001", "B000000002", "B000000003"],
    records: {
      B000000001: { status: "ready" },
      B000000002: { status: "error" },
      B000000003: { status: "ready" },
    },
    reasonCode: "CONNECTOR_FAILED",
  }));

  assert.match(html, /评论数据 2\/3/);
  assert.match(html, /；B000000002/);
  assert.match(html, /连接失败/);
  assert.doesNotMatch(html, /当前页面保留已验证数据；此状态不代表模块成功/);
});

test("partial FBA output reports only missing ASINs", () => {
  const html = JSON.stringify(StageOutputGapNotice({
    label: "FBA费用",
    asins: ["B000000001", "B000000002", "B000000003"],
    records: {
      B000000001: { status: "ready" },
      B000000002: { status: "ready" },
    },
    reasonCode: "UPSTREAM_EMPTY",
  }));

  assert.match(html, /FBA费用 2\/3/);
  assert.match(html, /；B000000003/);
  assert.doesNotMatch(html, /B000000001、B000000002/);
  assert.match(html, /上游暂无记录/);
});

test("complete ASIN output renders no gap notice", () => {
  const notice = StageOutputGapNotice({
    label: "评论数据",
    asins: ["B000000001", "B000000002", "B000000003"],
    records: {
      B000000001: { status: "ready" },
      B000000002: { status: "ready" },
      B000000003: { status: "ready" },
    },
    reasonCode: "OUTPUT_UNAVAILABLE",
  });

  assert.equal(notice, null);
});

test("page and browser harness replace only review and FBA full-gap cards", () => {
  const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const harnessSource = readFileSync(
    new URL("./helpers/asin-sync-funnel-browser-harness.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(pageSource.match(/<StageOutputGapNotice/g)?.length, 3);
  assert.doesNotMatch(pageSource, /<StageOutputGapCard[^>]+stage="(?:reviews|fba)"/);
  for (const stage of ["category", "sales_trend", "listing", "keywords", "traffic"]) {
    assert.match(pageSource, new RegExp(`<StageOutputGapCard[^>]+stage="${stage}"`));
  }
  assert.match(pageSource, /records=\{reviewAnalysisByAsin\}/);
  assert.match(pageSource, /records=\{fbaFeeByAsin\}/);

  assert.equal(harnessSource.match(/createElement\(StageOutputGapNotice/g)?.length, 2);
  assert.doesNotMatch(harnessSource, /createElement\(StageOutputGapCard, \{ snapshot: stageOutputs, stage: "(?:reviews|fba)" \}\)/);
  for (const stage of ["keywords", "sales_trend", "listing"]) {
    assert.match(harnessSource, new RegExp(`createElement\\(StageOutputGapCard, \\{ snapshot: stageOutputs, stage: "${stage}" \\}\\)`));
  }
});
