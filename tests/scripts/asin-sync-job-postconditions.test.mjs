import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as runner from "../../scripts/run-asin-sync-job.mjs";

const { applyPersistedStagePostcondition } = runner;

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
    resultStatusesByAsin: options.imageStatusByAsin ?? null,
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

test("zero exit plus empty persisted sales records upstream-empty and makes its own stage partial", () => {
  const { result, modules, stages } = harness(base);
  assert.deepEqual(result, { status: "partial", missingAsins: [asin] });
  assert.equal(modules[0][3].status, "upstream-empty");
  assert.equal(stages[0][2].status, "partial");
  assert.match(stages[0][2].detail, /1\/1 个 ASIN/);
});

test("zero exit plus incomplete image remarks records image_remarks as upstream-empty only", () => {
  const { result, modules } = harness(base, { stageId: "image_remarks", field: "imageRemarks" });
  assert.equal(result.status, "partial");
  assert.equal(modules[0][3].status, "upstream-empty");
});

test("canonical ready data completes and records the same stage key", () => {
  const { result, modules, stages } = harness({ ...base, sales: "ready" });
  assert.deepEqual(result, { status: "done", missingAsins: [] });
  assert.equal(modules[0][3].status, "ready");
  assert.equal(stages[0][2].status, "done");
});

test("a failed command records a connector gap rather than erasing ready ASIN results", () => {
  const failed = harness({ ...base, sales: "ready" }, { commandSucceeded: false });
  assert.equal(failed.result.status, "partial");
  assert.equal(failed.modules[0][3].status, "ready");
  assert.equal(harness(base, { unavailableReason: "图像分析未配置" }).result.status, "partial");
});

test("machine-readable image outcomes preserve timeout and connector failure", () => {
  const timeout = harness(base, {
    stageId: "image_remarks",
    field: "imageRemarks",
    imageStatusByAsin: { [asin]: "timeout" },
  });
  const failed = harness(base, {
    stageId: "image_remarks",
    field: "imageRemarks",
    imageStatusByAsin: { [asin]: "connector-failed" },
  });
  assert.equal(timeout.modules.at(-1)[3].status, "timeout");
  assert.equal(failed.modules.at(-1)[3].status, "connector-failed");
});

test("runner import does not load local environment at module scope", async () => {
  const runner = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  const topLevel = runner.slice(0, runner.indexOf("async function main()"));
  assert.doesNotMatch(topLevel, /^loadLocalEnv\(\);$/m);
  assert.match(runner, /async function main\(\) \{\s+loadLocalEnv\(\);/);
});

test("release runner activates the image remarks child and reconciles authoritative statuses", async () => {
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  assert.match(source, /readImageRemarkStatuses/);
  assert.match(source, /runImageRemarkProcess/);
  assert.match(source, /shouldRunSyncStage\(job, "image_remarks"\)/);
  assert.match(source, /args: \["run", "image-remarks:sync"\]/);
  assert.match(source, /REMARK_ASINS: asins\.join\(","\)/);
  assert.match(source, /AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1"/);
  assert.match(source, /resultStatusesByAsin: readImageRemarkStatuses\(\)/);
});

test("release runner removes the disabled-image fallback", async () => {
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  assert.equal(runner.markImageRemarksDisabledForRelease, undefined);
  assert.doesNotMatch(source, /markImageRemarksDisabledForRelease/);
  assert.doesNotMatch(source, /图片 AI 分析在本次发布中已停用/);
});

test("image remarks run after terminal traffic and before build or publication", async () => {
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  const traffic = main.indexOf('shouldRunSyncStage(job, "traffic")');
  const image = main.indexOf('shouldRunSyncStage(job, "image_remarks")');
  const build = main.indexOf('shouldRunSyncStage(job, "build")');
  assert.ok(traffic >= 0 && traffic < image);
  assert.ok(image < build);
});
