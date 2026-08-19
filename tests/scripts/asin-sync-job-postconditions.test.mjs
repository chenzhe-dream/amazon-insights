import assert from "node:assert/strict";
import test from "node:test";

import { applyPersistedStagePostcondition } from "../../scripts/run-asin-sync-job.mjs";

const asin = "B0C4XRN398";
const base = {
  asin,
  inCatalog: true,
  keywords: "ready",
  reviews: "ready",
  sales: "missing",
  childSales: "ready",
  priceStrategy: "ready",
  fba: "ready",
  listing: "ready",
  imageRemarks: "missing",
  category: "ready",
  traffic: "ready",
  voc: "missing",
};

function harness(item, options = {}) {
  const modules = [];
  const stages = [];
  const result = applyPersistedStagePostcondition("job-1", options.stageId ?? "sales_trend", [asin], {
    commandSucceeded: options.commandSucceeded ?? true,
    unavailableReason: options.unavailableReason ?? null,
    readReadiness: stageId => ({
      items: [item],
      ready: stageId === "catalog" ? item.inCatalog : item[options.field ?? "sales"] === "ready",
      missingAsins: stageId === "catalog" || item[options.field ?? "sales"] === "ready" ? [] : [asin],
    }),
    markModule: (...args) => modules.push(args),
    updateStage: (...args) => stages.push(args),
    now: () => "2026-08-19T12:00:00.000Z",
  });
  return { result, modules, stages };
}

test("zero exit plus empty persisted sales fails its own stage", () => {
  const { result, modules, stages } = harness(base);
  assert.deepEqual(result, { status: "failed", missingAsins: [asin] });
  assert.deepEqual(modules, [["job-1", asin, "sales_trend", "missing"]]);
  assert.equal(stages[0][2].status, "failed");
  assert.match(stages[0][2].detail, /1\/1 个 ASIN/);
});

test("zero exit plus incomplete image remarks fails image_remarks only", () => {
  const { result, modules } = harness(base, { stageId: "image_remarks", field: "imageRemarks" });
  assert.equal(result.status, "failed");
  assert.deepEqual(modules, [["job-1", asin, "image_remarks", "missing"]]);
});

test("canonical ready data completes and records the same stage key", () => {
  const { result, modules, stages } = harness({ ...base, sales: "ready" });
  assert.deepEqual(result, { status: "done", missingAsins: [] });
  assert.deepEqual(modules, [["job-1", asin, "sales_trend", "ready"]]);
  assert.equal(stages[0][2].status, "done");
});

test("a failed command cannot become done and only explicit unavailability skips", () => {
  assert.equal(harness({ ...base, sales: "ready" }, { commandSucceeded: false }).result.status, "failed");
  assert.equal(harness(base, { unavailableReason: "图像分析未配置" }).result.status, "skipped");
});
