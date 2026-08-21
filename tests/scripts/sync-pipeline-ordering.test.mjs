import assert from "node:assert/strict";
import test from "node:test";

import { BASE_COHORT_STAGE_IDS, trafficIsTerminalBeforeImageRemarks } from "../../scripts/run-asin-sync-job.mjs";

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
