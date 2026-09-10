import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as runner from "../../scripts/run-asin-sync-job.mjs";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";

const {
  applyPersistedStagePostcondition,
  createSorftimeVariantInvocation,
  diagnosticStatusesByAsin,
  finalizeCachedStage,
  finalizeProcessedStageCohort,
  projectFinalStageHashes,
  runCatalogPhase,
  runCatalogStage,
  sifKeywordSchemaDiagnostics,
} = runner;

test("real optional XYDC launcher preserves the safe missing coordination root diagnostic", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "xydc-launcher-diagnostic-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const warnings = [];
  t.mock.method(console, "error", value => warnings.push(value));
  const result = await runner.runOptionalXydcVariantEnrichment({
    asins: ["B0TEST0001"], marketplace: "US",
    env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: "test", AGENT_FORMAL_WORKTREE_ROOT: "",
      AGENT_DATA_ROOT: path.join(temporary, "data"), AGENT_RUNTIME_ROOT: path.join(temporary, "runtime"),
      AGENT_DATABASE_URL: "postgresql://fixture@127.0.0.1:1/fixture", DATABASE_URL: "postgresql://fixture@127.0.0.1:1/fixture",
      XYDC_FIXTURE_PATH: "", XYDC_MCP_TOKEN: "fixture-token", XYDC_COORDINATION_ROOT: "", XYDC_MCP_URL: "http://127.0.0.1:1/mcp" },
  });
  assert.deepEqual(result, { succeeded: false });
  assert.deepEqual(warnings, ["[warn] optional XYDC collection stopped: XYDC_COORDINATION_ROOT_REQUIRED"]);
});

test("real optional launcher drains hostile stderr but forwards only a bounded exact allowlisted line", async t => {
  const warnings = [];
  t.mock.method(console, "error", value => warnings.push(value));
  for (const valid of [false, true]) {
    // A child-only preload injects stderr without loading env files, DB, or any provider.
    const preload = `
      const write = text => new Promise(resolve => process.stderr.write(text, resolve));
      await write('provider-secret fixture-token\\n[xydc] XYDC_UNKNOWN_SECRET\\n');
      await write('x'.repeat(131072) + '[xydc] XYDC_COORDINATION_ROOT_REQUIRED\\n');
      await write('[xydc] XYDC_COORDINATION_ROOT_REQUIRED trailing-secret\\n');
      ${valid ? "await write('[xydc] XYDC_COORD'); await new Promise(setImmediate); await write('INATION_ROOT_REQUIRED\\r\\n');" : ""}
      process.exit(1);
    `;
    // Exit the directly owned child before the CLI main can run.
    const result = await runner.runOptionalXydcVariantEnrichment({
      asins: ["B0TEST0001"], marketplace: "US",
      env: { ...process.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}` },
    });
    assert.deepEqual(result, { succeeded: false });
  }
  assert.deepEqual(warnings, ["[warn] optional XYDC collection stopped", "[warn] optional XYDC collection stopped: XYDC_COORDINATION_ROOT_REQUIRED"]);
});

test("catalog phase invokes XiYou after pending or cached catalog work and continues after its failure", async () => {
  for (const catalogPending of [["B0TEST0001"], []]) {
    const calls = [];
    let downstreamRuns = 0;
    const xydc = runCatalogPhase({
      jobId: "job-xydc",
      job: { stages: [{ id: "catalog", status: "pending" }] },
      asins: ["B0TEST0001", "B0TEST0002"],
      marketplace: "US",
      catalogPending,
      shouldRun: () => true,
      activate: () => calls.push("activate-catalog"),
      patch: () => calls.push("patch-catalog"),
      runCatalog: () => calls.push("catalog-provider"),
      finalizeCached: () => calls.push("catalog-cache"),
      runXydc: ({ asins, marketplace }) => {
        calls.push({ xydc: { asins, marketplace } });
        return { succeeded: false };
      },
    });
    downstreamRuns += 1;
    assert.deepEqual(xydc, { succeeded: false });
    const catalogCall = catalogPending.length ? "catalog-provider" : "catalog-cache";
    const xydcIndex = calls.findIndex(call => typeof call === "object" && "xydc" in call);
    assert.equal(xydcIndex, calls.length - 1);
    assert.ok(calls.indexOf(catalogCall) >= 0 && calls.indexOf(catalogCall) < xydcIndex);
    assert.equal(downstreamRuns, 1);
  }
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  assert.ok(main.indexOf("runCatalogPhase(") < main.indexOf("const needing = asinsNeedingMcpSync(asins)"));
});

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

test("mixed projectable cohorts submit processed and cached ASINs together so one partial projection retains both", () => {
  const asins = [
    "B0MIXED001", "B0MIXED002", "B0MIXED003",
    "B0MIXED004", "B0MIXED005", "B0MIXED006",
  ];
  const pendingAsins = [asins[1], asins[4]];
  const cachedAsins = [asins[0], asins[2], asins[3]];
  const projectableStages = ["keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic", "child_sales", "price_strategy", "image_remarks"];

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
        return { status: "partial", missingAsins: [pendingAsins[1], asins[5]] };
      },
    });

    assert.deepEqual(result, { status: "partial", missingAsins: [pendingAsins[1], asins[5]] });
    assert.deepEqual(calls, [
      ["job-mixed", stageId, [...pendingAsins, ...cachedAsins], {
        commandSucceeded: false,
        resultStatusesByAsin: {
          [pendingAsins[0]]: "ready",
          [pendingAsins[1]]: "connector-failed",
        },
      }],
    ]);
  }
});

test("production child sales and price strategy finalize the full mixed cohort", async () => {
  const source = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  for (const stageId of ["child_sales", "price_strategy"]) {
    const start = source.indexOf(`const ${stageId === "child_sales" ? "childAsins" : "priceAsins"}`);
    const end = source.indexOf("\n      }", start);
    const block = source.slice(start, end);
    assert.match(block, new RegExp(`finalizeProcessedStageCohort\\(jobId, "${stageId}"`));
    assert.match(block, /initialJob: job/);
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
  assert.deepEqual(calls, [["job-category", "category", ["B0PENDING1", "B0CACHED01"], {
    commandSucceeded: false,
    terminalStatus: "failed",
    gapReasonCode: "CONNECT_TIMEOUT",
    stageDetail: "category connection timed out",
  }]]);
});

test("persisted partial projection replays with the same data scope and gap items", () => {
  const requested = ["B0READY001", "B0GAP00001"];
  const gapItems = [{ asin: "B0GAP00001", causeCode: "MCP_SCHEMA" }];
  const readExport = () => ({ B0READY001: { points: [{ month: "2026-09", value: 1 }] } });
  const persisted = projectStageOutput("sales_trend", requested, {
    stageStatus: "partial",
    dataAsins: ["B0READY001"],
    gapItems,
    gapReasonCode: "MCP_SCHEMA",
    updatedAt: "2026-09-02T00:00:00.000Z",
    readExport,
  });
  const replay = (stage, asins, options) => projectStageOutput(stage, asins, { ...options, readExport });
  const job = {
    jobId: "job-replay", jobVersion: 1, asins: requested,
    stages: [{ id: "sales_trend", status: "partial" }],
    outputs: [persisted],
  };

  assert.deepEqual(projectFinalStageHashes("job-replay", job, replay), { sales_trend: persisted.contentHash });
});

test("strict SIF keyword schema records become bounded per-ASIN diagnostics", () => {
  assert.deepEqual(sifKeywordSchemaDiagnostics(["B0SCHEMA01", "B0OTHER001"], {
    B0SCHEMA01: { status: "schema-error", errorCode: "SIF_KEYWORD_SCHEMA_INVALID", statusMessage: "raw provider body must not escape" },
    B0OTHER001: { status: "error" },
  }), [{
    asin: "B0SCHEMA01",
    connector: "sif",
    stage: "keywords",
    failureKind: "schema",
    causeCode: "SIF_KEYWORD_SCHEMA_INVALID",
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

test("sequential traffic completion retains earlier ready data and earlier error reasons", () => {
  const asins = ["B09NNDX731", "B0BHHP21DP", "B0CZRBL776"];
  const job = {
    jobId: "fixture-traffic", asins,
    stages: [{ id: "traffic", status: "running" }],
    asinProgress: Object.fromEntries(asins.map(asin => [asin, { traffic: { status: "pending" } }])),
    outputs: [], diagnostics: [],
  };
  const failure = { asin: asins[1], stage: "traffic", connector: "sif", failureKind: "schema", causeCode: "MCP_SCHEMA" };
  for (const current of asins) {
    if (current === asins[1]) job.diagnostics.push(failure);
    applyPersistedStagePostcondition(job.jobId, "traffic", [current], {
      commandSucceeded: current !== asins[1],
      resultStatusesByAsin: current === asins[1] ? { [current]: "connector-failed" } : {},
      diagnostics: current === asins[1] ? [failure] : [],
      readJob: () => job,
      readReadiness: () => ({
        items: [{ ...base, asin: current, traffic: current === asins[0] ? "ready" : "missing" }],
        missingAsins: current === asins[0] ? [] : [current],
      }),
      markModule: (_id, asin, stage, patch) => { job.asinProgress[asin][stage] = patch; },
      commitStage: (_id, { stageId, stagePatch, output }) => {
        job.stages = [{ id: stageId, ...stagePatch }];
        job.outputs = [output];
      },
      projectOutput: (stage, candidates, options) => projectStageOutput(stage, candidates, {
        ...options,
        readExport: (_file, name) => name === "sifListingTrafficRawByAsin"
          ? { [asins[0]]: { overview: { total: { score: 7 }, nf: { score: 5 }, ad: { score: 2 } } } }
          : {},
      }),
    });
  }
  assert.deepEqual(job.outputs[0].gap.items, [
    { asin: asins[1], causeCode: "MCP_SCHEMA" },
    { asin: asins[2], causeCode: "UPSTREAM_EMPTY" },
  ].sort((a, b) => a.asin.localeCompare(b.asin)));
  assert.equal(job.asinProgress[asins[0]].traffic.status, "ready");
  assert.deepEqual(job.outputs[0].data.listingByAsin, { [asins[0]]: { total: 7, natural: 5, advertising: 2 } });
});
