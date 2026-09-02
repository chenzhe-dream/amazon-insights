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

test("image publication recovery keeps image remarks before build", () => {
  const repairJob = { resumeStages: ["image_remarks", "build"] };
  const automaticStages = [
    "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
    "fba", "listing", "category", "traffic", "image_remarks", "build",
  ];

  assert.deepEqual(
    automaticStages.filter((stageId) => shouldRunSyncStage(repairJob, stageId)),
    ["image_remarks", "build"],
  );
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

test("explicit resume selects persisted failures even when build readiness is stale", () => {
  const requestedAsins = [
    "B0PENDING01",
    "B0FAILED001",
    "B0TIMEOUT01",
    "B0EMPTY0001",
    "B0READY0001",
    "B0MANUAL001",
  ];
  const job = {
    resumeStages: ["keywords"],
    asinProgress: {
      B0PENDING01: { keywords: { status: "pending", reason: "LEGACY_UNVERIFIED" } },
      B0FAILED001: { keywords: { status: "connector-failed" } },
      B0TIMEOUT01: { keywords: { status: "timeout" } },
      B0EMPTY0001: { keywords: { status: "upstream-empty", reason: "PROVIDER_SCHEMA_VALID_EMPTY" } },
      B0READY0001: { keywords: { status: "ready" } },
      B0MANUAL001: { keywords: { status: "manual" } },
    },
  };

  assert.deepEqual(
    asinsForSyncStage(job, "keywords", [], requestedAsins),
    ["B0PENDING01", "B0FAILED001", "B0TIMEOUT01"],
  );
  assert.deepEqual(asinsForSyncStage(job, "reviews", requestedAsins, requestedAsins), []);
  assert.deepEqual(asinsForSyncStage({}, "keywords", ["B0READY0001"], requestedAsins), ["B0READY0001"]);
});
