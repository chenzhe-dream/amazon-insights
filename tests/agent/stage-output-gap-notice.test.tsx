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

test("page keeps contextual gaps and fallbacks without duplicate overview notices", () => {
  const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const harnessSource = readFileSync(
    new URL("./helpers/asin-sync-funnel-browser-harness.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(pageSource.match(/<StageOutputGapNotice/g)?.length, 1);
  assert.doesNotMatch(pageSource, /<StageOutputGapCard[^>]+stage="(?:reviews|fba|child_sales)"/);
  for (const stage of ["category", "sales_trend", "listing", "keywords", "traffic", "price_strategy", "image_remarks"]) {
    assert.match(pageSource, new RegExp(`<StageOutputGapCard[^>]+stage="${stage}"`));
  }
  for (const fallback of ["childSalesByAsin", "priceStrategyByAsin", "imageRemarksByAsin", "imageRemarkOutcomesByAsin"]) {
    assert.match(pageSource, new RegExp(`${fallback}: scopedRuntimeAnalysisData`));
  }
  assert.match(pageSource, /records=\{reviewAnalysisByAsin\}/);
  assert.match(pageSource, /fbaFeeByAsin=\{fbaFeeByAsin\}/);

  assert.equal(harnessSource.match(/createElement\(StageOutputGapNotice/g)?.length, 2);
  assert.doesNotMatch(harnessSource, /createElement\(StageOutputGapCard, \{ snapshot: stageOutputs, stage: "(?:reviews|fba)" \}\)/);
  for (const stage of ["keywords", "sales_trend", "listing"]) {
    assert.match(harnessSource, new RegExp(`createElement\\(StageOutputGapCard, \\{ snapshot: stageOutputs, stage: "${stage}" \\}\\)`));
  }
});


test("mixed ASIN failures use individual causes instead of labelling the entire group as timed out", () => {
  const html = JSON.stringify(StageOutputGapNotice({ label: "评论数据", asins: ["B000000001", "B000000002"], records: {},
    reasonCode: "CONNECT_TIMEOUT", gapItems: [{ asin: "B000000001", causeCode: "CONNECT_TIMEOUT" }, { asin: "B000000002", causeCode: "CONNECTOR_FAILED" }] }));
  assert.match(html, /B000000001：连接超时/);
  assert.match(html, /B000000002：连接失败/);
});

test("saved review observations do not hide authoritative analysis gaps", () => {
  const html = JSON.stringify(StageOutputGapNotice({ label: "评论数据",
    asins: ["B000000001", "B000000002"],
    records: { B000000001: { status: "ready" }, B000000002: { status: "ready", sampledReviews: 5 } },
    reasonCode: "UPSTREAM_EMPTY",
    gapItems: [{ asin: "B000000002", causeCode: "UPSTREAM_EMPTY" }, { asin: "B0OTHER001", causeCode: "CONNECT_TIMEOUT" }],
  }));
  assert.match(html, /评论数据 1\/2/);
  assert.match(html, /B000000002：已有评论样本，暂无可用分析主题/);
  assert.doesNotMatch(html, /上游暂无记录|B0OTHER001/);
});

test("a current connector failure still outranks an older review observation", () => {
  const html = JSON.stringify(StageOutputGapNotice({ label: "评论数据", asins: ["B000000001"],
    records: { B000000001: { status: "ready", sampledReviews: 5 } }, reasonCode: "CONNECT_TIMEOUT",
    gapItems: [{ asin: "B000000001", causeCode: "CONNECT_TIMEOUT" }],
  }));
  assert.match(html, /评论数据 0\/1/);
  assert.match(html, /B000000001：连接超时/);
  assert.doesNotMatch(html, /暂无可用分析主题/);
});
