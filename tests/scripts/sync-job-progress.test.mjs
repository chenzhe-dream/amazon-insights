import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ASIN_SYNC_STAGE_IDS, isAsinStageReady } from "../../scripts/lib/asin-data-status.mjs";
import {
  ASIN_MODULE_STATUSES,
  aggregateAsinModuleStatuses,
  reconcileStageStatus,
  createAsinProgress,
  createSyncJobStore,
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

test("stage aggregation remains partial regardless of whether a failed ASIN is recorded before or after a ready ASIN", () => {
  for (const statuses of [
    ["connector-failed", "ready"],
    ["ready", "connector-failed"],
  ]) {
    const job = {
      asins: ["BAD", "GOOD"],
      asinProgress: {
        BAD: { traffic: { status: statuses[0] } },
        GOOD: { traffic: { status: statuses[1] } },
      },
    };
    const patch = reconcileStageStatus(job, "traffic");
    assert.equal(job.asinProgress.BAD.traffic.status, statuses[0]);
    assert.equal(job.asinProgress.GOOD.traffic.status, statuses[1]);
    assert.equal(patch.status, "partial");
  }
  assert.equal(reconcileStageStatus({
    asins: ["ONE", "TWO"],
    asinProgress: { ONE: { traffic: { status: "ready" } }, TWO: { traffic: { status: "ready" } } },
  }, "traffic").status, "done");
});

test("local admission estimates image work from pending static slots with the shared 4/120 policy", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "image-remark-local-eta-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createSyncJobStore({ directory });
  const job = store.createSyncJob({
    asins: [asin],
    mcpAsinCount: 0,
    imageRemarksCount: 3,
  });
  const stage = job.stages.find(item => item.id === "image_remarks");
  assert.equal(stage.estimatedSeconds, 135);
  assert.equal(stage.detail, "最多同时分析 4 张图片 · 单图上限 120 秒");
});
