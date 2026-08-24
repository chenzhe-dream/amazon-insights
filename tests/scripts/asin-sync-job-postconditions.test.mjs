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

test("release runner has no image remarks AI activation path", async () => {
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /image-remarks:sync|hasOpenAiKey|asinsNeedingImageRemarksSync|readImageRemarkStatuses/);
  assert.doesNotMatch(source, /shouldRunSyncStage\(job, "image_remarks"\)/);
});

test("disabled image remarks preserve ready results and leave missing results explicitly manual", () => {
  assert.equal(typeof runner.markImageRemarksDisabledForRelease, "function");
  const modules = [];
  const stages = [];
  const result = runner.markImageRemarksDisabledForRelease("job-1", [asin, "B0C4XRN399"], {
    readReadiness: () => ({
      items: [
        { asin, imageRemarks: "ready" },
        { asin: "B0C4XRN399", imageRemarks: "missing" },
      ],
    }),
    markModule: (...args) => modules.push(args),
    updateStage: (...args) => stages.push(args),
    now: () => "2026-08-24T12:00:00.000Z",
  });

  assert.deepEqual(result, { readyAsins: [asin], pendingAsins: ["B0C4XRN399"] });
  assert.deepEqual(modules.map(([, targetAsin, stageId, patch]) => ({ targetAsin, stageId, patch })), [
    { targetAsin: asin, stageId: "image_remarks", patch: { status: "ready", reason: null } },
    {
      targetAsin: "B0C4XRN399",
      stageId: "image_remarks",
      patch: { status: "manual", reason: "图片 AI 分析在本次发布中已停用，待分析" },
    },
  ]);
  assert.deepEqual(stages, [["job-1", "image_remarks", {
    status: "skipped",
    detail: "本次发布已停用图片 AI 分析；已有备注保持不变，缺失备注待后续分析。",
    completedAt: "2026-08-24T12:00:00.000Z",
  }]]);
});

test("image disablement runs only after build handling and base-ready publication", async () => {
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  const build = main.indexOf('shouldRunSyncStage(job, "build")');
  const baseReady = main.indexOf("markSyncJobBaseReady(jobId)");
  const disabled = main.indexOf("markImageRemarksDisabledForRelease(jobId, asins)");
  assert.ok(build >= 0 && build < baseReady);
  assert.ok(baseReady < disabled);
});
