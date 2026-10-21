import assert from "node:assert/strict";
import test from "node:test";

import {
  asinsForSyncStage,
  markPreflightUnavailableStages,
  shouldRunSyncStage,
} from "../../scripts/run-asin-sync-job.mjs";

test("build-only recovery leaves every persisted partial-stage ASIN outcome unchanged", () => {
  const asins = ["B0C6FP6LMY", "B0DLB22T15", "B0DQCF6ZVZ", "B0F5NRLWB6", "B0FJ4T6V2C", "B0FPXDD2D4", "B0GHQW7GYY"];
  const states = ["ready", "upstream-empty", "upstream-empty", "upstream-empty", "connector-failed", "upstream-empty", "ready"];
  const job = { asins, resumeStages: ["build"], stages: [{ id: "reviews", status: "partial", detail: "2 ready, 4 empty, 1 failed" },
    { id: "keywords", status: "partial" }], asinProgress: Object.fromEntries(asins.map((asin, index) =>
    [asin, { reviews: { status: states[index], reason: "persisted outcome", updatedAt: "2026-10-21T07:00:41.364Z" },
      keywords: { status: index === 0 ? "ready" : "timeout" } }])) };
  const original = structuredClone(job);
  let reads = 0;
  markPreflightUnavailableStages("build-recovery", job, {
    readStatuses: () => { reads++; return asins.map(asin => ({ asin, reviews: "pending", keywords: "pending" })); },
    markModule: (_id, asin, stage, patch) => { job.asinProgress[asin][stage] = patch; },
  });
  assert.deepEqual(job, original, "mutable cache readiness cannot rewrite immutable collection outcomes");
  assert.equal(reads, 0, "excluded collection stages need no cache inspection");
});

test("preflight still marks genuinely unavailable selected stages and initial jobs", () => {
  const job = { asins: ["B0C6FP6LMY"], stages: [
    { id: "reviews", status: "partial", detail: "Review connector unavailable" },
    { id: "keywords", status: "partial", detail: "Keyword connector unavailable" },
  ] };
  for (const resumeStages of [undefined, ["keywords"]]) {
    const calls = [];
    markPreflightUnavailableStages("preflight-job", { ...job, ...(resumeStages ? { resumeStages } : {}) }, {
      readStatuses: () => [{ asin: job.asins[0], reviews: "pending", keywords: "pending" }],
      markModule: (_id, asin, stage, patch) => calls.push({ asin, stage, ...patch }),
    });
    assert.deepEqual(calls.map(call => call.stage), resumeStages ?? ["reviews", "keywords"]);
    assert.ok(calls.every(call => call.status === "connector-failed" && call.reason.endsWith("unavailable")));
  }
});

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

test("build publication recovery reuses provider outputs and selects only build", () => {
  const repairJob = { resumeStages: ["build"] };
  const automaticStages = [
    "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
    "fba", "listing", "category", "traffic", "image_remarks", "build",
  ];

  assert.deepEqual(
    automaticStages.filter((stageId) => shouldRunSyncStage(repairJob, stageId)),
    ["build"],
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
