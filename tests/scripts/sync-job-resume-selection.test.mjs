import assert from "node:assert/strict";
import test from "node:test";

import {
  asinsForSyncStage,
  shouldRunSyncStage,
} from "../../scripts/run-asin-sync-job.mjs";

test("repair runner selects only explicitly resumed stages", () => {
  const repairJob = { resumeStages: ["keywords", "reviews"] };
  assert.equal(shouldRunSyncStage(repairJob, "keywords"), true);
  assert.equal(shouldRunSyncStage(repairJob, "reviews"), true);
  assert.equal(shouldRunSyncStage(repairJob, "catalog"), false);
  assert.equal(shouldRunSyncStage(repairJob, "build"), false);
  assert.equal(shouldRunSyncStage({}, "catalog"), true);
});

test("repair runner preserves successful ASIN results inside a partial stage", () => {
  const job = {
    resumeStages: ["keywords"],
    asinProgress: {
      B0SYNC0901: { keywords: { status: "ready" } },
      B0SYNC0902: { keywords: { status: "connector-failed" } },
      B0SYNC0903: { keywords: { status: "upstream-empty" } },
    },
  };
  assert.deepEqual(
    asinsForSyncStage(job, "keywords", ["B0SYNC0901", "B0SYNC0902", "B0SYNC0903"]),
    ["B0SYNC0902"],
  );
  assert.deepEqual(asinsForSyncStage({}, "keywords", ["B0SYNC0901"]), ["B0SYNC0901"]);
});
