import assert from "node:assert/strict";
import test from "node:test";

import { ASIN_SYNC_STAGE_IDS, isAsinStageReady } from "../../scripts/lib/asin-data-status.mjs";
import { createAsinProgress } from "../../scripts/lib/sync-job-store.mjs";
import { markPersistedStageProgress } from "../../scripts/run-asin-sync-job.mjs";

const asin = "B0C4XRN398";
const readyItem = {
  asin,
  inCatalog: true,
  keywords: "ready",
  reviews: "ready",
  sales: "ready",
  childSales: "ready",
  priceStrategy: "ready",
  fba: "ready",
  listing: "ready",
  imageRemarks: "ready",
  category: "ready",
  traffic: "ready",
  voc: "missing",
};

test("new ASIN progress contains only canonical stage keys", () => {
  const progress = createAsinProgress([asin]);
  assert.deepEqual(Object.keys(progress[asin]), ASIN_SYNC_STAGE_IDS);
  assert.ok(Object.values(progress[asin]).every(status => status === "pending"));
  assert.equal(isAsinStageReady(readyItem, "sales_trend"), true);
  assert.equal(isAsinStageReady({ ...readyItem, sales: "missing" }, "sales_trend"), false);
});

test("persisted-ready skipped stages leave no canonical pending residue", () => {
  const progress = createAsinProgress([asin]);
  const markModule = (_jobId, currentAsin, stageId, status) => {
    progress[currentAsin][stageId] = status;
  };
  const readReadiness = stageId => ({
    items: [readyItem],
    ready: true,
    missingAsins: [],
    stageId,
  });

  for (const stageId of ASIN_SYNC_STAGE_IDS.filter(stageId => stageId !== "alexa_voc")) {
    markPersistedStageProgress("job-1", stageId, [asin], { readReadiness, markModule });
  }

  assert.ok(
    ASIN_SYNC_STAGE_IDS
      .filter(stageId => stageId !== "alexa_voc")
      .every(stageId => progress[asin][stageId] === "ready"),
  );
  assert.equal(progress[asin].alexa_voc, "pending");
  assert.equal(Object.hasOwn(progress[asin], "sales"), false);
  assert.equal(Object.hasOwn(progress[asin], "imageRemarks"), false);
  assert.equal(Object.hasOwn(progress[asin], "voc"), false);
});
