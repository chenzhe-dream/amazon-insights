import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelVocRun,
  observeVocRun,
  retryVocStage,
  searchWithVocRunId,
  submitVocRun,
  vocRunIdFromSearch,
  VocRunClientError,
  waitForVocRun,
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
    return Response.json({ reports: [{ id: "report-1", stage: "voc-positioning", version: 1, status: "complete", result: { coreConclusion: { strategy: "durable" } } }] });
  };

  const observed = await observeVocRun(runId, fetchImpl);
  assert.equal(observed.report?.id, "report-1");
  assert.deepEqual(observed.reports.map((report) => report.id), ["report-1"]);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("a sync-only run without voc-positioning is not started and never active", async () => {
  const observed = await observeVocRun(runId, async (input) => String(input).endsWith("/reports")
    ? Response.json({ reports: [] })
    : Response.json({ stages: [{ stage: "traffic-analysis", status: "partial" }] }));

  assert.equal(observed.kind, "not-started");
  assert.equal(observed.stage, null);
});

test("a succeeded VOC stage without a persisted report is failed, not active", async () => {
  const observed = await observeVocRun(runId, async (input) => String(input).endsWith("/reports")
    ? Response.json({ reports: [] })
    : Response.json({ stages: [{ stage: "voc-positioning", status: "succeeded" }] }));

  assert.equal(observed.kind, "failed");
  assert.match(observed.message, /报告/);
});

test("polling publishes each durable stage observation and preserves report history order", async () => {
  let reads = 0;
  const published: Array<{ status: unknown; progress: unknown }> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith(`/v1/runs/${runId}`)) {
      reads += 1;
      return Response.json({
        stages: [{
          stage: "voc-positioning",
          status: reads === 1 ? "running" : "succeeded",
          progress: reads === 1 ? 35 : 100,
          lastError: null,
        }],
      });
    }
    return Response.json({ reports: reads === 1 ? [] : [
      { id: "report-v2", stage: "voc-positioning", version: 2, status: "complete", result: { coreConclusion: { strategy: "v2" } } },
      { id: "report-v1", stage: "voc-positioning", version: 1, status: "complete", result: { coreConclusion: { strategy: "v1" } } },
    ] });
  };

  const observed = await waitForVocRun(runId, {
    attempts: 2,
    intervalMs: 0,
    sleep: async () => undefined,
    fetchImpl,
    onObservation: (value) => published.push({
      status: value.stage?.status,
      progress: value.stage?.progress,
    }),
  });

  assert.deepEqual(published, [
    { status: "running", progress: 35 },
    { status: "succeeded", progress: 100 },
  ]);
  assert.equal(observed.report?.id, "report-v2");
  assert.deepEqual(observed.reports.map((report) => report.version), [2, 1]);
});

test("a traffic report cannot make a failed VOC stage appear succeeded", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith(`/v1/runs/${runId}`)) {
      return Response.json({
        stages: [{ stage: "voc-positioning", status: "failed", progress: 100, lastError: null }],
      });
    }
    return Response.json({ reports: [{
      id: "traffic-report",
      stage: "traffic-analysis",
      version: 1,
      status: "complete",
      result: { conclusion: "traffic" },
    }] });
  };

  const observed = await observeVocRun(runId, fetchImpl);

  assert.equal(observed.kind, "failed");
  assert.equal(observed.report, null);
  assert.deepEqual(observed.reports.map((report) => report.stage), ["traffic-analysis"]);
});

test("cancel and retry post only to the current run then re-observe it", async () => {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : null });
    if ((init?.method ?? "GET") === "POST") return Response.json({ run: { id: runId } });
    if (url.endsWith(`/reports`)) return Response.json({ reports: [] });
    return Response.json({ stages: [{ stage: "voc-positioning", status: "running", progress: 25, lastError: null }] });
  };

  await cancelVocRun(runId, fetchImpl);
  await retryVocStage(runId, undefined, fetchImpl);

  assert.deepEqual(calls, [
    { method: "POST", url: `/v1/runs/${runId}/cancel`, body: "{}" },
    { method: "GET", url: `/v1/runs/${runId}`, body: null },
    { method: "GET", url: `/v1/runs/${runId}/reports`, body: null },
    { method: "POST", url: `/v1/runs/${runId}/stages/voc-positioning/retry`, body: "{}" },
    { method: "GET", url: `/v1/runs/${runId}`, body: null },
    { method: "GET", url: `/v1/runs/${runId}/reports`, body: null },
  ]);
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
