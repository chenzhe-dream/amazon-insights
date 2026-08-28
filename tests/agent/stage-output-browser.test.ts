import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createStageOutputOwner, type StageOutputScope } from "../../app/lib/stage-output-browser";
import type { ProjectableSyncStage, StageOutputProjection } from "../../shared/agent-contracts";

const scope: StageOutputScope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000002",
  runId: "10000000-0000-4000-8000-000000000003",
  jobId: "job-1",
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
}

function contentHash(stage: ProjectableSyncStage, branch: { data: unknown } | { gap: unknown }) {
  return createHash("sha256").update(JSON.stringify(canonicalize({ stage, ...branch }))).digest("hex");
}

function projection(stage: ProjectableSyncStage, jobVersion: number, outputVersion: number, data: Record<string, unknown> = {}): StageOutputProjection {
  const branch = stage === "keywords"
    ? { analysisByAsin: data, enrichmentByKeyword: {} }
    : stage === "reviews"
      ? { analysisByAsin: data, ratingByAsin: {} }
      : stage === "sales_trend" ? { trendByAsin: data }
        : stage === "fba" ? { feeByAsin: data }
          : stage === "listing" ? { contentByAsin: data }
            : stage === "category" ? { trendByNode: data }
              : { listingByAsin: data, monthlyByAsin: {} };
  return {
    jobId: scope.jobId, projectId: scope.projectId, runId: scope.runId,
    stage, stageStatus: "done", jobVersion, outputVersion,
    contentHash: contentHash(stage, { data: branch }),
    updatedAt: "2026-08-25T09:00:00.000Z", data: branch,
  } as StageOutputProjection;
}

function job(jobVersion: number, statuses: Partial<Record<ProjectableSyncStage, string>>) {
  return {
    jobId: scope.jobId,
    jobVersion,
    stages: Object.entries(statuses).map(([id, status]) => ({ id, status })),
  } as Parameters<ReturnType<typeof createStageOutputOwner>["observeJob"]>[0];
}

test("owner fetches only terminal transitions or higher job versions", () => {
  const owner = createStageOutputOwner(scope);
  assert.deepEqual(owner.observeJob(job(7, { keywords: "running" })), []);
  assert.deepEqual(owner.observeJob(job(7, { keywords: "done" })), ["keywords"]);
  assert.deepEqual(owner.observeJob(job(7, { keywords: "done" })), ["keywords"], "an unaccepted response is retried by the next job poll");
  assert.equal(owner.accept("keywords", projection("keywords", 7, 1)).kind, "applied");
  assert.deepEqual(owner.observeJob(job(7, { keywords: "done" })), []);
  assert.deepEqual(owner.observeJob(job(8, { keywords: "done" })), ["keywords"]);
});

test("owner strictly rejects foreign, future, malformed, and hash-invalid responses", () => {
  const owner = createStageOutputOwner(scope);
  owner.observeJob(job(6, { keywords: "done" }));
  assert.equal(owner.accept("keywords", projection("keywords", 6, 1, { accepted: true })).kind, "applied");
  const accepted = owner.snapshot().keywords;
  owner.observeJob(job(8, { keywords: "done" }));
  assert.equal(owner.accept("keywords", { ...projection("keywords", 7, 1), jobId: "foreign-job" }).kind, "retryable-missing");
  assert.equal(owner.accept("keywords", { ...projection("keywords", 8, 2), projectId: "10000000-0000-4000-8000-000000000099" }).kind, "retryable-missing");
  assert.equal(owner.accept("keywords", { ...projection("keywords", 9, 2) }).kind, "missing-output");
  assert.strictEqual(owner.snapshot().keywords, accepted);
});

test("owner versions monotonically, preserves verified success over later gaps, and clears all scope state", () => {
  const owner = createStageOutputOwner(scope);
  const success = projection("listing", 4, 1, { B0TEST0001: { title: "verified" } });
  owner.observeJob(job(4, { listing: "done" }));
  assert.equal(owner.accept("listing", success).kind, "applied");
  const verifiedSnapshot = owner.snapshot();
  assert.equal(owner.accept("listing", success).kind, "resolved-unchanged");
  const gap = {
    jobId: scope.jobId, projectId: scope.projectId, runId: scope.runId,
    stage: "listing", stageStatus: "failed", jobVersion: 5, outputVersion: 2,
    gap: { state: "failed", reasonCode: "CONNECTOR_FAILED" },
    contentHash: contentHash("listing", { gap: { state: "failed", reasonCode: "CONNECTOR_FAILED" } }),
    updatedAt: "2026-08-25T09:01:00.000Z",
  } satisfies StageOutputProjection;
  owner.observeJob(job(5, { listing: "failed" }));
  assert.equal(owner.accept("listing", gap).kind, "applied");
  assert.strictEqual(owner.snapshot(), verifiedSnapshot, "a later gap cannot rerender or cover verified content");
  assert.deepEqual(owner.observeJob(job(5, { listing: "failed" })), []);
  owner.clear();
  assert.deepEqual(owner.snapshot(), {});
  assert.deepEqual(owner.observeJob(job(5, { listing: "failed" })), ["listing"]);
});

test("owner exposes a verified fixed gap until successful data arrives", () => {
  const owner = createStageOutputOwner(scope);
  const gapBranch = { state: "partial", reasonCode: "UPSTREAM_EMPTY" } as const;
  const gap = {
    jobId: scope.jobId, projectId: scope.projectId, runId: scope.runId,
    stage: "category", stageStatus: "partial", jobVersion: 2, outputVersion: 1,
    gap: gapBranch, contentHash: contentHash("category", { gap: gapBranch }),
    updatedAt: "2026-08-25T09:01:00.000Z",
  } satisfies StageOutputProjection;
  owner.observeJob(job(2, { category: "partial" }));
  assert.equal(owner.accept("category", gap).kind, "applied");
  const visibleGap = owner.snapshot().category;
  assert.ok(visibleGap && visibleGap.stageStatus !== "done");
  assert.deepEqual(visibleGap.gap, gapBranch);
  owner.observeJob(job(3, { category: "done" }));
  assert.equal(owner.accept("category", projection("category", 3, 2, { node1: { status: "ready" } })).kind, "applied");
  assert.equal(owner.snapshot().category?.stageStatus, "done");
});

test("owner distinguishes all four outcomes and caps permanent misses at three", () => {
  const owner = createStageOutputOwner(scope);
  const terminal = job(9, { keywords: "done" });
  assert.deepEqual(owner.observeJob(terminal), ["keywords"]);
  assert.deepEqual(owner.missing("keywords"), { kind: "retryable-missing", attempt: 1, remainingAttempts: 2 });
  assert.deepEqual(owner.missing("keywords"), { kind: "retryable-missing", attempt: 2, remainingAttempts: 1 });
  const exhausted = owner.missing("keywords");
  assert.equal(exhausted.kind, "missing-output");
  assert.equal(exhausted.attempt, 3);
  assert.equal(owner.snapshot().keywords?.stageStatus, "missing-output");
  assert.equal(owner.outputsSettled(terminal), true);
  assert.deepEqual(owner.observeJob(terminal), []);
});

test("publication-only jobVersion growth resolves unchanged", () => {
  const owner = createStageOutputOwner(scope);
  owner.observeJob(job(7, { keywords: "done" }));
  assert.equal(owner.accept("keywords", projection("keywords", 7, 1, { accepted: true })).kind, "applied");
  const verified = owner.snapshot();
  assert.deepEqual(owner.observeJob(job(8, { keywords: "done" })), ["keywords"]);
  assert.equal(owner.accept("keywords", projection("keywords", 7, 1, { accepted: true })).kind, "resolved-unchanged");
  assert.strictEqual(owner.snapshot(), verified);
  assert.deepEqual(owner.observeJob(job(8, { keywords: "done" })), []);
});

test("foreign, future, malformed, and bad-hash results use the same miss budget", () => {
  const owner = createStageOutputOwner(scope);
  owner.observeJob(job(8, { keywords: "done" }));
  assert.equal(owner.accept("keywords", { ...projection("keywords", 9, 1), jobId: "foreign" }).kind, "retryable-missing");
  assert.equal(owner.accept("keywords", { ...projection("keywords", 9, 1), contentHash: "f".repeat(64) }).kind, "retryable-missing");
  assert.equal(owner.accept("keywords", projection("keywords", 9, 1)).kind, "missing-output");
});
