import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_COHORT_STAGE_IDS,
  executeAsinStage,
  imageRemarkRunAsins,
  shouldReactivateImageRemarks,
  shouldRunSyncStage,
  trafficIsTerminalBeforeImageRemarks,
} from "../../scripts/run-asin-sync-job.mjs";

test("a newly ready gallery reactivates an upstream-empty image stage exactly once", () => {
  assert.equal(shouldReactivateImageRemarks({
    listingStatus: "ready",
    imageRemarkStatus: "upstream-empty",
    alreadyReactivated: false,
  }), true);
  assert.equal(shouldReactivateImageRemarks({
    listingStatus: "ready",
    imageRemarkStatus: "upstream-empty",
    alreadyReactivated: true,
  }), false);
  for (const imageRemarkStatus of ["pending", "ready", "timeout", "connector-failed", "manual"]) {
    assert.equal(shouldReactivateImageRemarks({
      listingStatus: "ready",
      imageRemarkStatus,
      alreadyReactivated: false,
    }), false, imageRemarkStatus);
  }
  assert.equal(shouldReactivateImageRemarks({
    listingStatus: "missing",
    imageRemarkStatus: "upstream-empty",
    alreadyReactivated: false,
  }), false);
});

test("a partial gallery reactivation runs only pending ASINs and is not blocked by terminal peers", () => {
  const job = {
    asinProgress: {
      READY000001: { traffic: { status: "ready" }, image_remarks: { status: "ready" } },
      RETRY00001: { traffic: { status: "ready" }, image_remarks: { status: "pending" } },
      FAILED0001: { traffic: { status: "ready" }, image_remarks: { status: "connector-failed" } },
    },
  };
  assert.deepEqual(imageRemarkRunAsins(job, ["READY000001", "RETRY00001", "FAILED0001"]), ["RETRY00001"]);
});

test("base cohort is deterministic and reaches terminal traffic before image enrichment", () => {
  assert.deepEqual(BASE_COHORT_STAGE_IDS, [
    "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
    "fba", "listing", "category", "traffic",
  ]);
  assert.equal(trafficIsTerminalBeforeImageRemarks({
    traffic: { status: "ready" },
    image_remarks: { status: "pending" },
  }), true);
  assert.equal(trafficIsTerminalBeforeImageRemarks({
    traffic: { status: "pending" },
    image_remarks: { status: "pending" },
  }), false);
  for (const status of ["ready", "upstream-empty", "timeout", "connector-failed", "manual"]) {
    assert.equal(trafficIsTerminalBeforeImageRemarks({
      traffic: { status },
      image_remarks: { status: "pending" },
    }), true, status);
  }
  assert.equal(trafficIsTerminalBeforeImageRemarks({
    traffic: { status: "ready" },
    image_remarks: { status: "ready" },
  }), false);
});

test("explicit category or traffic resume never adds image remarks", () => {
  assert.equal(shouldRunSyncStage({ resumeStages: ["category"] }, "image_remarks"), false);
  assert.equal(shouldRunSyncStage({ resumeStages: ["traffic"] }, "image_remarks"), false);
  assert.equal(shouldRunSyncStage({ resumeStages: ["image_remarks"] }, "image_remarks"), true);
});

test("mixed cached and pending traffic ASINs are all terminal before image work begins", () => {
  const calls = [];
  const results = executeAsinStage({
    asins: ["CACHED", "PENDING"],
    pendingAsins: ["PENDING"],
    invoke: asin => calls.push(`run:${asin}`),
    apply: (asin, commandSucceeded) => calls.push(`${asin}:${commandSucceeded}`),
  });

  assert.deepEqual(calls, ["CACHED:true", "run:PENDING", "PENDING:true"]);
  assert.deepEqual(results, [
    { asin: "CACHED", commandSucceeded: true },
    { asin: "PENDING", commandSucceeded: true },
  ]);
});

test("one ASIN connector failure does not prevent later ASINs or stages", () => {
  const calls = [];
  executeAsinStage({
    asins: ["BAD", "GOOD"],
    pendingAsins: ["BAD", "GOOD"],
    invoke: asin => {
      calls.push(`run:${asin}`);
      if (asin === "BAD") throw new Error("connector failed");
    },
    apply: (asin, commandSucceeded) => calls.push(`${asin}:${commandSucceeded ? "ready" : "connector-failed"}`),
  });
  calls.push("later-stage");
  assert.deepEqual(calls, ["run:BAD", "BAD:connector-failed", "run:GOOD", "GOOD:ready", "later-stage"]);
});
