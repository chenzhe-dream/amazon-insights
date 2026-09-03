import assert from "node:assert/strict";
import test from "node:test";

import { presentVocReadiness, submitReadyVocRun, summarizeVocReadiness } from "../../app/lib/voc-readiness";

const runId = "11111111-1111-4111-8111-111111111111";

test("VOC readiness requires one normalized record for every requested ASIN", () => {
  assert.deepEqual(summarizeVocReadiness(["B000000001", "B000000002", "B000000003"], {
    B000000001: { normalizedRecord: {} },
    B000000003: { normalizedRecord: {} },
  }), {
    ready: 2,
    total: 3,
    missing: ["B000000002"],
    canSubmit: false,
  });
});

test("incomplete VOC readiness never invokes the submission callback", async () => {
  let calls = 0;
  await assert.rejects(() => submitReadyVocRun(
    ["B000000001", "B000000002", "B000000003"],
    "US",
    { B000000001: { normalizedRecord: {} }, B000000003: { normalizedRecord: {} } },
    async () => { calls += 1; return { projectId: runId, runId }; },
  ), /尚未录入/);
  assert.equal(calls, 0);
});

test("VOC readiness presentation distinguishes 0/3, 2/3, and 3/3 input states", () => {
  const asins = ["B000000001", "B000000002", "B000000003"];
  assert.deepEqual(presentVocReadiness(summarizeVocReadiness(asins, {})), {
    summary: "VOC 数据已准备 0/3",
    missing: "待录入：B000000001、B000000002、B000000003",
    disabled: true,
    actionLabel: "开始 VOC 独立分析",
  });
  assert.deepEqual(presentVocReadiness(summarizeVocReadiness(asins, {
    B000000001: { normalizedRecord: {} },
    B000000003: { normalizedRecord: {} },
  })), {
    summary: "VOC 数据已准备 2/3",
    missing: "待录入：B000000002",
    disabled: true,
    actionLabel: "开始 VOC 独立分析",
  });
  assert.deepEqual(presentVocReadiness(summarizeVocReadiness(asins, {
    B000000001: { normalizedRecord: {} },
    B000000002: { normalizedRecord: {} },
    B000000003: { normalizedRecord: {} },
  })), {
    summary: "VOC 数据已准备 3/3",
    missing: null,
    disabled: false,
    actionLabel: "开始 VOC 独立分析",
  });
});

test("two ready ASINs remain blocked and never invoke submission", async () => {
  let calls = 0;
  await assert.rejects(() => submitReadyVocRun(
    ["B000000001", "B000000002"],
    "US",
    { B000000001: { normalizedRecord: {} }, B000000002: { normalizedRecord: {} } },
    async () => { calls += 1; return { projectId: runId, runId }; },
  ));
  assert.equal(calls, 0);
});

test("eleven ready ASINs remain blocked and never invoke submission", async () => {
  const asins = Array.from({ length: 11 }, (_, index) => `B${String(index + 1).padStart(9, "0")}`);
  const records = Object.fromEntries(asins.map((asin) => [asin, { normalizedRecord: {} }]));
  let calls = 0;

  assert.equal(summarizeVocReadiness(asins, records).canSubmit, false);
  await assert.rejects(() => submitReadyVocRun(
    asins,
    "US",
    records,
    async () => { calls += 1; return { projectId: runId, runId }; },
  ));
  assert.equal(calls, 0);
});
