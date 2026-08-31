import assert from "node:assert/strict";
import test from "node:test";

import { submitReadyVocRun, summarizeVocReadiness } from "../../app/lib/voc-readiness";

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
