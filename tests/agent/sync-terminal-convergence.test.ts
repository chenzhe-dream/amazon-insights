import assert from "node:assert/strict";
import test from "node:test";
import { publicationIsSettled, syncObservationKey, terminalSyncIsQuiescent } from "../../app/lib/sync-terminal-convergence";
import type { SyncJob } from "../../app/lib/sync-progress-presentation";

const base = { jobId: "job-1", jobVersion: 8, status: "completed" } satisfies Pick<SyncJob, "jobId" | "jobVersion" | "status">;

test("publication settlement follows public GET", () => {
  assert.equal(publicationIsSettled({}), true);
  assert.equal(publicationIsSettled({ publication: { status: "not-required" } }), true);
  assert.equal(publicationIsSettled({ publication: { status: "pending", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z" } }), false);
  assert.equal(publicationIsSettled({ publication: { status: "applied", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z", appliedAt: "2026-08-25T00:00:05.000Z" } }), true);
  assert.equal(publicationIsSettled({ publication: { status: "failed", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z", failedAt: "2026-08-25T00:00:05.000Z", code: "WEB_PUBLICATION_FAILED" } }), true);
});

test("canonical observations dedupe by value and legacy does not", () => {
  assert.equal(syncObservationKey(base), syncObservationKey({ ...base }));
  assert.notEqual(syncObservationKey(base), syncObservationKey({ ...base, status: "failed" }));
  assert.equal(syncObservationKey({ ...base, jobVersion: undefined }), null);
});

test("quiescence requires terminal job, settled publication, and outputs", () => {
  assert.equal(terminalSyncIsQuiescent({ status: "running" }, true), false);
  assert.equal(terminalSyncIsQuiescent({ status: "completed" }, false), false);
  assert.equal(terminalSyncIsQuiescent({ status: "completed", publication: { status: "pending", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z" } }, true), false);
  assert.equal(terminalSyncIsQuiescent({ status: "completed-with-gaps" }, true), true);
  assert.equal(terminalSyncIsQuiescent({ status: "failed" }, true), true);
});
