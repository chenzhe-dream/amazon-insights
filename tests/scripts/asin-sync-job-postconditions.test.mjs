import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as runner from "../../scripts/run-asin-sync-job.mjs";

const {
  applyPersistedStagePostcondition,
  createSorftimeVariantInvocation,
  diagnosticStatusesByAsin,
  finalizeCachedStage,
  finalizeProcessedStageCohort,
  runCatalogStage,
} = runner;

test("category diagnostics preserve ready siblings while classifying bounded failures", () => {
  assert.deepEqual(diagnosticStatusesByAsin(
    ["B074QLWRDQ", "B096LRXPBW", "B0BTM28F9N"],
    [
      { asin: "B074QLWRDQ", failureKind: "timeout", causeCode: "CONNECT_TIMEOUT" },
      { asin: "B096LRXPBW", failureKind: "schema", causeCode: "MCP_SCHEMA" },
    ],
  ), {
    B074QLWRDQ: "timeout",
    B096LRXPBW: "connector-failed",
  });
});

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

test("Sorftime variant stage invokes the Sorftime builder with the Sorftime ASIN scope", () => {
  const calls = [];
  const providers = {
    run(input) {
      calls.push(input);
      return { succeeded: true, diagnostics: [], statusesByAsin: {} };
    },
  };
  const asins = ["B074QLWRDQ", "B096LRXPBW", "B0BTM28F9N"];

  providers.run(createSorftimeVariantInvocation(asins, "US"));

  assert.deepEqual(calls, [{
    connector: "sorftime",
    stage: "child_sales",
    asins,
    label: "variant:sorftime:sync",
    command: "npm",
    args: ["run", "variant:sorftime:sync"],
    env: { SORFTIME_ASINS: asins.join(","), SORFTIME_MARKETPLACE: "US" },
  }]);
  assert.equal("SELLERSPRITE_ASINS" in calls[0].env, false);
});

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

test("cached projectable data uses the audited projection path instead of an unbacked skip", () => {
  const calls = [];
  const result = finalizeCachedStage("job-1", "sales_trend", [asin], {
    finalizeProjectable: (...args) => {
      calls.push(["project", ...args]);
      return { status: "done", missingAsins: [] };
    },
    markProgress: (...args) => calls.push(["progress", ...args]),
    updateStage: (...args) => calls.push(["stage", ...args]),
  });

  assert.deepEqual(result, { status: "done", missingAsins: [] });
  assert.deepEqual(calls, [["project", "job-1", "sales_trend", [asin]]]);
});

test("cached child sales uses the audited projection path instead of an unbacked skip", () => {
  const calls = [];
  const result = finalizeCachedStage("job-1", "child_sales", [asin], {
    finalizeProjectable: (...args) => {
      calls.push(["project", ...args]);
      return { status: "done", missingAsins: [] };
    },
    markProgress: (...args) => calls.push(["progress", ...args]),
    updateStage: (...args) => calls.push(["stage", ...args]),
    now: () => "2026-08-27T15:00:00.000Z",
  });

  assert.deepEqual(result, { status: "done", missingAsins: [] });
  assert.deepEqual(calls, [["project", "job-1", "child_sales", [asin]]]);
});

test("mixed six-ASIN projectable stages reconcile the pending subset and every cached ASIN before projection", () => {
  const asins = [
    "B0MIXED001", "B0MIXED002", "B0MIXED003",
    "B0MIXED004", "B0MIXED005", "B0MIXED006",
  ];
  const pendingAsins = [asins[1], asins[4]];
  const cachedAsins = [asins[0], asins[2], asins[3]];
  const projectableStages = ["keywords", "reviews", "sales_trend", "fba", "listing", "category"];

  for (const stageId of projectableStages) {
    const calls = [];
    const result = finalizeProcessedStageCohort("job-mixed", stageId, pendingAsins, asins, {
      initialJob: {
        jobId: "job-mixed",
        asinProgress: Object.fromEntries(asins.map(asin => [asin, {
          [stageId]: {
            status: asin === asins[5] ? "upstream-empty" : "pending",
          },
        }])),
      },
      commandSucceeded: false,
      resultStatusesByAsin: {
        [pendingAsins[0]]: "ready",
        [pendingAsins[1]]: "connector-failed",
      },
      finalizeProjectable: (jobId, candidateStageId, candidateAsins, options) => {
        calls.push([jobId, candidateStageId, candidateAsins, options]);
        return calls.length === 1
          ? { status: "active", missingAsins: [pendingAsins[1]] }
          : { status: "partial", missingAsins: [] };
      },
    });

    assert.deepEqual(result, { status: "partial", missingAsins: [] });
    assert.deepEqual(calls, [
      ["job-mixed", stageId, pendingAsins, {
        commandSucceeded: false,
        resultStatusesByAsin: {
          [pendingAsins[0]]: "ready",
          [pendingAsins[1]]: "connector-failed",
        },
      }],
      ["job-mixed", stageId, cachedAsins, {
        commandSucceeded: true,
        gapReasonCode: "CONNECTOR_FAILED",
      }],
    ]);
  }
});

test("mixed cached category finalization preserves its explicit terminal failure contract", () => {
  const calls = [];
  const result = finalizeProcessedStageCohort("job-category", "category", ["B0PENDING1"], [
    "B0PENDING1", "B0CACHED01",
  ], {
    initialJob: {
      jobId: "job-category",
      asinProgress: {
        B0PENDING1: { category: { status: "pending" } },
        B0CACHED01: { category: { status: "pending" } },
      },
    },
    commandSucceeded: false,
    terminalStatus: "failed",
    gapReasonCode: "CONNECT_TIMEOUT",
    stageDetail: "category connection timed out",
    finalizeProjectable: (jobId, stageId, asins, options) => {
      calls.push([jobId, stageId, asins, options]);
      return { status: options.terminalStatus ?? "active", missingAsins: [] };
    },
  });

  assert.deepEqual(result, { status: "failed", missingAsins: [] });
  assert.deepEqual(calls[1], ["job-category", "category", ["B0CACHED01"], {
    commandSucceeded: true,
    terminalStatus: "failed",
    gapReasonCode: "CONNECT_TIMEOUT",
    stageDetail: "category connection timed out",
  }]);
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
  assert.match(source, /REMARK_ASINS: imageAsins\.join\(","\)/);
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

test("preflight Sorftime takeover skips SellerSprite and only requests missing ASINs", () => {
  const asins = ["B0TEST0001", "B0TEST0002", "B0TEST0003"];
  const catalog = new Set();
  const calls = [];
  const applied = [];
  runCatalogStage({
    asins,
    catalogPending: asins,
    marketplace: "US",
    catalogProviderPlan: {
      preferredConnectorId: "sorftime",
      unavailableConnectorIds: ["sellerSprite"],
    },
    providers: fixtureCatalogProviders({ calls, catalog, seller: "unavailable", fallback: "ready" }),
    asinsNeedingCatalog: candidates => candidates.filter(candidate => !catalog.has(candidate)),
    apply: (candidate, commandSucceeded) => applied.push({ asin: candidate, commandSucceeded }),
  });

  assert.equal(calls.filter(call => call.label === "catalog:sync").length, 0);
  assert.equal(calls.filter(call => call.label === "catalog:sorftime:sync").length, 1);
  assert.deepEqual(calls.find(call => call.label === "catalog:sorftime:sync")?.asins, asins);
  assert.deepEqual(applied, asins.map(candidate => ({ asin: candidate, commandSucceeded: true })));
});

test("valid SellerSprite catalog never invokes fallback", () => {
  const asins = ["B0TEST0001", "B0TEST0002", "B0TEST0003"];
  const catalog = new Set();
  const calls = [];
  runCatalogStage({
    asins,
    catalogPending: asins,
    marketplace: "US",
    providers: fixtureCatalogProviders({ calls, catalog, seller: "ready", fallback: "must-not-call" }),
    asinsNeedingCatalog: candidates => candidates.filter(candidate => !catalog.has(candidate)),
    apply: () => {},
  });

  assert.equal(calls.filter(call => call.label === "catalog:sync").length, asins.length);
  assert.equal(calls.some(call => call.label === "catalog:sorftime:sync"), false);
});

test("SellerSprite and Sorftime failures leave only the still-missing ASIN as a catalog gap", () => {
  const asins = ["B0TEST0001", "B0TEST0002", "B0TEST0003"];
  const catalog = new Set([asins[0], asins[2]]);
  const calls = [];
  const applied = [];
  runCatalogStage({
    asins,
    catalogPending: [asins[1]],
    marketplace: "US",
    providers: fixtureCatalogProviders({ calls, catalog, seller: "unavailable", fallback: "unavailable" }),
    asinsNeedingCatalog: candidates => candidates.filter(candidate => !catalog.has(candidate)),
    apply: (candidate, commandSucceeded) => applied.push({ asin: candidate, commandSucceeded }),
  });

  assert.equal(calls.filter(call => call.label === "catalog:sync").length, 1);
  assert.equal(calls.filter(call => call.label === "catalog:sorftime:sync").length, 1);
  assert.deepEqual(applied, [
    { asin: asins[0], commandSucceeded: true },
    { asin: asins[1], commandSucceeded: false },
    { asin: asins[2], commandSucceeded: true },
  ]);
});

function fixtureCatalogProviders({ calls, catalog, seller, fallback }) {
  return {
    run(input) {
      calls.push(input);
      if (input.label === "catalog:sync") {
        if (seller === "ready") catalog.add(input.asins[0]);
        return { succeeded: seller === "ready" };
      }
      if (input.label === "catalog:sorftime:sync") {
        assert.notEqual(fallback, "must-not-call");
        if (fallback === "ready") input.asins.forEach(candidate => catalog.add(candidate));
        return { succeeded: fallback === "ready" };
      }
      throw new Error(`unexpected command ${input.label}`);
    },
  };
}
