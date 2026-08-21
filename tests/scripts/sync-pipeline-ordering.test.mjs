import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_COHORT_STAGE_IDS,
  executeAsinStage,
  trafficIsTerminalBeforeImageRemarks,
} from "../../scripts/run-asin-sync-job.mjs";

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
