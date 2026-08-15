import assert from "node:assert/strict";
import test from "node:test";

import {
  observeVocRun,
  searchWithVocRunId,
  submitVocRun,
  vocRunIdFromSearch,
  VocRunClientError,
} from "../../app/lib/voc-run-browser";

const runId = "11111111-1111-4111-8111-111111111111";

test("VOC run identity round-trips through the URL without dropping workspace parameters", () => {
  const next = searchWithVocRunId("?project=p1&asins=A,B,C", runId);
  assert.equal(next.get("project"), "p1");
  assert.equal(next.get("asins"), "A,B,C");
  assert.equal(vocRunIdFromSearch(next), runId);
});

test("refresh observation reads run and report without submitting a second run", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (url.endsWith(`/v1/runs/${runId}`)) {
      return Response.json({
        run: { id: runId, status: "succeeded" },
        stages: [{ id: "stage-1", stage: "voc-positioning", status: "succeeded", progress: 100, lastError: null }],
      });
    }
    return Response.json({ reports: [{ id: "report-1", version: 1, status: "complete", result: { coreConclusion: { strategy: "durable" } } }] });
  };

  const observed = await observeVocRun(runId, fetchImpl);
  assert.equal(observed.report?.id, "report-1");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("network refusal becomes an actionable offline observation", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const observed = await observeVocRun(runId, fetchImpl);
  assert.equal(observed.kind, "offline");
  assert.match(observed.message, /npm run agent:dev/);
  assert.equal(observed.runId, runId);
});

test("missing VOC input is classified as waiting-input", async () => {
  const fetchImpl: typeof fetch = async () => Response.json(
    { error: { code: "VALIDATION_ERROR", message: "VOC data is unavailable for the requested ASINs", requestId: "request-1" } },
    { status: 422 },
  );

  await assert.rejects(
    () => submitVocRun(["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"], "US", fetchImpl),
    (error: unknown) => error instanceof VocRunClientError && error.kind === "waiting-input",
  );
});
