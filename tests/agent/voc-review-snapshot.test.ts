import assert from "node:assert/strict";
import test from "node:test";
import { selectVerifiedReviewSnapshot } from "../../app/lib/voc-review-snapshot";
import type { StageOutputEntry } from "../../app/lib/stage-output-browser";

function verified(version: number, stageStatus = "done"): StageOutputEntry {
  return { projectId: "project", runId: "run", jobId: "job", stage: "reviews", stageStatus,
    jobVersion: version, outputVersion: version, contentHash: `hash-${version}`, updatedAt: "2026-09-10T00:00:00Z",
    data: { analysisByAsin: {}, ratingByAsin: {} },
    ...(stageStatus === "partial" ? { gap: { state: "partial", reasonCode: "UPSTREAM_EMPTY" } } : {}),
  } as StageOutputEntry;
}

test("loading and a missing read preserve the same-scope verified snapshot", () => {
  const current = verified(12);
  assert.equal(selectVerifiedReviewSnapshot(current, undefined), current);
  assert.equal(selectVerifiedReviewSnapshot(current, { stage: "reviews", stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }), current);
});

test("a fresh reader cannot roll back the same-scope output version or replace an equal version with conflicting content", () => {
  const current = verified(12);
  assert.equal(selectVerifiedReviewSnapshot(current, verified(11)), current);
  assert.equal(selectVerifiedReviewSnapshot(current, { ...verified(12), contentHash: "conflict" } as StageOutputEntry), current);
  const next = verified(13);
  assert.equal(selectVerifiedReviewSnapshot(current, next), next);
});

test("a cleared owner never uses a different project's retained entry", () => {
  const current = verified(12);
  const incoming = { ...verified(13), projectId: "different" } as StageOutputEntry;
  assert.equal(selectVerifiedReviewSnapshot(current, incoming), current);
  assert.equal(selectVerifiedReviewSnapshot(undefined, incoming), incoming);
});

test("a verified partial result survives read failure and can be replaced by newer verified success", () => {
  const current = verified(12, "partial");
  assert.equal(selectVerifiedReviewSnapshot(current, undefined), current);
  const next = verified(13);
  assert.equal(selectVerifiedReviewSnapshot(current, next), next);
});
