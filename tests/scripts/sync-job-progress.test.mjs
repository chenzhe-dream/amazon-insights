import assert from "node:assert/strict";
import test from "node:test";

import { ASIN_SYNC_STAGE_IDS, isAsinStageReady } from "../../scripts/lib/asin-data-status.mjs";
import {
  ASIN_MODULE_STATUSES,
  aggregateAsinModuleStatuses,
  createAsinProgress,
  deriveFinalSyncJobStatus,
} from "../../scripts/lib/sync-job-store.mjs";
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

test("new ASIN progress contains only canonical stage keys and safe result records", () => {
  const progress = createAsinProgress([asin]);
  assert.deepEqual(Object.keys(progress[asin]), ASIN_SYNC_STAGE_IDS);
  assert.ok(Object.values(progress[asin]).every(result =>
    Object.keys(result).every(key => ["status", "reason", "updatedAt"].includes(key))
      && (result.status === "pending" || result.status === "manual")
      && typeof result.updatedAt === "string",
  ));
  assert.deepEqual(ASIN_MODULE_STATUSES, [
    "ready", "upstream-empty", "timeout", "connector-failed", "pending", "manual",
  ]);
  assert.equal(progress[asin].alexa_voc.status, "manual");
  assert.equal(isAsinStageReady(readyItem, "sales_trend"), true);
  assert.equal(isAsinStageReady({ ...readyItem, sales: "missing" }, "sales_trend"), false);
});

test("persisted-ready skipped stages leave no canonical pending residue", () => {
  const progress = createAsinProgress([asin]);
  const markModule = (_jobId, currentAsin, stageId, result) => {
    progress[currentAsin][stageId] = { ...result, updatedAt: "2026-08-22T00:00:00.000Z" };
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
      .every(stageId => progress[asin][stageId].status === "ready"),
  );
  assert.equal(progress[asin].alexa_voc.status, "manual");
  assert.equal(Object.hasOwn(progress[asin], "sales"), false);
  assert.equal(Object.hasOwn(progress[asin], "imageRemarks"), false);
  assert.equal(Object.hasOwn(progress[asin], "voc"), false);
});

test("local gaps aggregate as partial and end completed-with-gaps while manual Alexa stays manual", () => {
  assert.equal(aggregateAsinModuleStatuses(["ready", "connector-failed"]), "partial");
  assert.equal(aggregateAsinModuleStatuses(["manual", "manual"]), "manual");
  assert.equal(aggregateAsinModuleStatuses(["pending", "ready"]), "active");
  assert.equal(deriveFinalSyncJobStatus({
    [asin]: { catalog: { status: "ready" }, alexa_voc: { status: "manual" } },
    B0C4XRN399: { catalog: { status: "connector-failed" }, alexa_voc: { status: "manual" } },
  }), "completed-with-gaps");
});
