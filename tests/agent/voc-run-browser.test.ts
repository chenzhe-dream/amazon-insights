import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelVocRun,
  baseSyncRunIdFromSearch,
  clearVocRunFromSearch,
  observeVocRun,
  retryVocStage,
  searchWithVocRunId,
  submitVocRun,
  vocRunIdFromSearch,
  VocRunClientError,
  waitForVocRun,
} from "../../app/lib/voc-run-browser";

const runId = "11111111-1111-4111-8111-111111111111";
const baseRunId = "22222222-2222-4222-8222-222222222222";

test("restored VOC polling stops publishing and fetching when its view is abandoned", async () => {
  const controller = new AbortController();
  let reads = 0, published = 0;
  await waitForVocRun(runId, { signal: controller.signal, attempts: 3, intervalMs: 0,
    fetchImpl: async (input) => { reads++; return String(input).endsWith("/reports") ? Response.json({ reports: [] }) : Response.json({ stages: [{ stage: "voc-positioning", status: "queued" }] }); },
    sleep: async () => { controller.abort(); }, onObservation: () => { published++; },
  });
  assert.equal(reads, 2);
  assert.equal(published, 1);
});

test("queue timeout remains a Chinese failure even when a historical report exists", async () => {
  const observed = await observeVocRun(runId, async (input) => String(input).endsWith("/reports")
    ? Response.json({ reports: [{ id: "old", stage: "voc-positioning" }] })
    : Response.json({ stages: [{ stage: "voc-positioning", status: "failed", lastError: { code: "QUEUE_TIMEOUT", message: "raw English" } }] }));
  assert.equal(observed.kind, "failed");
  assert.equal(observed.message, "VOC 排队超时，已停止自动重试，请稍后手动重试。");
  assert.equal(observed.report?.id, "old");
});

test("VOC run identity round-trips through its dedicated URL key without dropping base sync identity", () => {
  const next = searchWithVocRunId(`?project=p1&asins=A,B,C&run=${baseRunId}`, runId);
  assert.equal(next.get("project"), "p1");
  assert.equal(next.get("asins"), "A,B,C");
  assert.equal(next.get("run"), baseRunId);
  assert.equal(next.get("vocRun"), runId);
  assert.equal(baseSyncRunIdFromSearch(next), baseRunId);
  assert.equal(vocRunIdFromSearch(next), runId);
});

test("base run never restores a VOC identity, while dedicated vocRun does", () => {
  assert.equal(vocRunIdFromSearch(new URLSearchParams(`run=${baseRunId}`)), null);
  const refreshed = new URLSearchParams(`run=${baseRunId}&vocRun=${runId}`);
  assert.equal(vocRunIdFromSearch(refreshed), runId);
  assert.equal(baseSyncRunIdFromSearch(refreshed), baseRunId);
  assert.equal(baseSyncRunIdFromSearch(new URLSearchParams(`vocRun=${runId}`)), null);
});

test("clearing a VOC run preserves the base sync run", () => {
  const cleared = clearVocRunFromSearch(`run=${baseRunId}&vocRun=${runId}&project=p1`);
  assert.equal(cleared.get("run"), baseRunId);
  assert.equal(cleared.get("vocRun"), null);
  assert.equal(cleared.get("project"), "p1");
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

test("a VOC stage without a status is failed and does not keep polling", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    return String(input).endsWith("/reports")
      ? Response.json({ reports: [] })
      : Response.json({ stages: [{ stage: "voc-positioning" }] });
  };

  const observed = await waitForVocRun(runId, {
    attempts: 2,
    intervalMs: 0,
    sleep: async () => undefined,
    fetchImpl,
  });

  assert.equal(observed.kind, "failed");
  assert.deepEqual(calls, [
    { method: "GET", url: `/v1/runs/${runId}` },
    { method: "GET", url: `/v1/runs/${runId}/reports` },
  ]);
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

test("default polling observes a run longer than the legacy fifteen-second window to terminal state", async () => {
  let observations = 0;
  let sleeps = 0;
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    methods.push(init?.method ?? "GET");
    if (String(input).endsWith(`/reports`)) {
      return Response.json({ reports: [] });
    }
    observations += 1;
    return Response.json({
      stages: [{
        stage: "voc-positioning",
        status: observations <= 62 ? "running" : "failed",
        progress: observations <= 62 ? 50 : 100,
        lastError: null,
      }],
    });
  };

  const observed = await waitForVocRun(runId, {
    sleep: async () => { sleeps += 1; },
    fetchImpl,
  });

  assert.equal(observed.kind, "failed");
  assert.equal(observations, 63);
  assert.equal(sleeps, 62);
  assert.ok(methods.every((method) => method === "GET"));
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
