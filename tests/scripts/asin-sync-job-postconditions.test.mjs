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

test("image postcondition projects the job candidate without reading global remarks", () => {
  const imageUrl = "https://images.test/job-owned.jpg";
  const imageRemarksData = {
    remarksByAsin: { [asin]: [{ remark: "Owned", imageUrl }] },
    outcomesByAsin: { [asin]: [{ status: "ready" }] },
  };
  let committed;
  applyPersistedStagePostcondition("job-owned", "image_remarks", [asin], {
    imageRemarksData,
    readReadiness: () => ({ items: [{ asin, imageRemarks: "ready" }], missingAsins: [], ready: true }),
    markModule: () => undefined,
    readJob: () => ({ asins: [asin], asinProgress: { [asin]: { image_remarks: { status: "ready" } } } }),
    commitStage: (_jobId, input) => { committed = input.output; },
    projectOutput: (stage, asins, options) => projectStageOutput(stage, asins, {
      ...options, readExport: () => { throw new Error("global remarks read"); },
    }),
  });
  assert.equal(committed.data.remarksByAsin[asin][0].imageUrl, imageUrl);
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
  assert.match(source, /imageRemarkScheduling\(job, imageStageJob, asins/);
  assert.match(source, /if \(imageSchedule\.shouldRun\)/);
  assert.match(source, /args: \["run", "image-remarks:sync"\]/);
  assert.match(source, /dispatchImageProcess = async \(readyAsins\)/);
  assert.match(source, /REMARK_ASINS: readyAsins\.join\(","\)/);
  assert.match(source, /AGENT_SYNC_IMAGE_CAPTURE_ASINS: galleryReadyAsins\.join\(","\)/);
  assert.match(source, /ready\.filter\(asin => imageAsins\.includes\(asin\)\)/);
  assert.match(source, /readImageRemarkCandidate\(imageCandidateFile, \{ job: persistedImageJob, asins: galleryReadyAsins \}\)/);
  assert.match(source, /partitionImageListingInput\(persistedImageJob, asins\)/);
  assert.match(source, /AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1"/);
  assert.match(source, /resultStatusesByAsin: scopedImageStatuses/);
  assert.match(source, /readImageRemarkCandidate\(imageCandidateFile/);
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
  const image = main.indexOf('imageRemarkScheduling(job, imageStageJob, asins');
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

test("sequential traffic completion retains earlier ready data and unprojected failure status", () => {
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
    { asin: asins[1], causeCode: "CONNECTOR_FAILED" },
    { asin: asins[2], causeCode: "UPSTREAM_EMPTY" },
  ].sort((a, b) => a.asin.localeCompare(b.asin)));
  assert.equal(job.asinProgress[asins[0]].traffic.status, "ready");
  assert.deepEqual(job.outputs[0].data.listingByAsin, { [asins[0]]: { total: 7, natural: 5, advertising: 2 } });
});

import { imageCandidateReadiness, imageCandidateResultStatuses, validatePersistedImageStageOutput } from '../../scripts/lib/image-remark-job-candidate.mjs';
test('actual runner image finalizer preserves nine cached families and five recovered target notes when one slot fails',()=>{
  for(const cachedState of ['pending','ready']) {
  const asins=Array.from({length:10},(_,i)=>`B00000000${i}`);const target=asins[9];
  const scope={organizationId:'org',projectId:'project',runId:'run'};
  const listing=Object.fromEntries(asins.map(a=>[a,{status:'ready',galleryImages:Array.from({length:6},(_,i)=>`https://images.test/${a}/${i}`)}]));
  for(const a of asins.slice(0,5)) listing[a].galleryImages.push(`https://images.test/${a}/PKplay-button-video`);
  const notes=a=>listing[a].galleryImages.map(imageUrl=>({remark:`saved ${imageUrl}`,imageUrl}));
  const previousData={remarksByAsin:Object.fromEntries(asins.slice(0,9).map(a=>[a,notes(a)])),outcomesByAsin:Object.fromEntries(asins.slice(0,9).map(a=>[a,listing[a].galleryImages.map(url=>url.includes('PKplay-button')?null:{status:'ready'})]))};
  const initialJob={jobId:'mixed-image-job',asins,scope,asinProgress:Object.fromEntries(asins.map(a=>[a,{image_remarks:{status:a===target?'pending':cachedState}}])),outputs:[projectStageOutput('listing',asins,{...scope,readExport:()=>listing}),projectStageOutput('image_remarks',asins,{...scope,stageStatus:'partial',dataAsins:asins.slice(0,9),imageRemarksData:previousData})]};
  const current=structuredClone(initialJob);
  const candidate={remarksByAsin:{[target]:notes(target).map((n,i)=>i===4?null:n)},outcomesByAsin:{[target]:Array.from({length:6},(_,i)=>i===4?{status:'connector-failed',body:'injected-secret',diagnostic:{stage:'response-output',httpStatus:200,errorClass:'invalid-output',token:'injected-secret'}}:{status:'ready'})}};
  let committed;
  finalizeProcessedStageCohort(current.jobId,'image_remarks',[target],asins,{
    initialJob,commandSucceeded:false,imageRemarksData:candidate,
    readReadiness:(_stage,cohort)=>imageCandidateReadiness(candidate,listing,cohort),
    resultStatusesByAsin:imageCandidateResultStatuses(candidate,listing,[target]),
    readJob:()=>current,
    markModule:(_job,a,_stage,patch)=>{current.asinProgress[a].image_remarks=patch;},
    commitStage:(_job,input)=>{committed=input.output;current.outputs=current.outputs.filter(o=>o.stage!=='image_remarks').concat(committed);},
    projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,...scope,readExport:()=>{throw Error('global cache forbidden');}}),
  });
  assert.equal(committed.stageStatus,'partial');
  assert.equal(Object.keys(committed.data.remarksByAsin).length,10);
  assert.equal(Object.values(committed.data.outcomesByAsin).flat().filter(o=>o?.status==='ready').length,59);
  assert.equal(Object.values(committed.data.remarksByAsin).flat().filter(Boolean).length,64);
  assert.equal(Object.values(committed.data.outcomesByAsin).flat().filter(o=>o===null).length,5);
  for(const a of asins.slice(0,9)){assert.equal(current.asinProgress[a].image_remarks.status,'ready');assert.deepEqual(committed.data.remarksByAsin[a],previousData.remarksByAsin[a]);}
  assert.equal(current.asinProgress[target].image_remarks.status,'connector-failed');
  assert.equal(committed.data.outcomesByAsin[target][4].status,'connector-failed');
  assert.equal(committed.gap.items?.find(item=>item.asin===target)?.causeCode,'CONNECTOR_FAILED');
  assert.deepEqual(committed.data.outcomesByAsin[target][4].diagnostic,{stage:'response-output',httpStatus:200,errorClass:'invalid-output'});
  assert.equal(JSON.stringify(committed.data.outcomesByAsin).includes('injected-secret'),false);
  assert.doesNotThrow(()=>validatePersistedImageStageOutput(current,committed));
  for(const fault of ['hash','scope']) {
    const invalid=structuredClone(initialJob);
    if(fault==='hash')invalid.outputs[1].contentHash='0'.repeat(64);
    else invalid.outputs[1].runId='wrong-run';
    assert.throws(()=>finalizeProcessedStageCohort(invalid.jobId,'image_remarks',[target],asins,{
      initialJob:invalid,imageRemarksData:candidate,readJob:()=>invalid,
      markModule:()=>{throw Error('must reject source before progress writes');},
      commitStage:()=>{throw Error('must reject source before output writes');},
    }),fault==='hash'?/hash mismatch/:/scope mismatch/);
  }
  }
});

test('actual runner sales partial postcondition retains three successful metrics and failed rank evidence',()=>{
  const asins=Array.from({length:10},(_,i)=>`B00000000${i}`);const target=asins[9];
  const points=Array.from({length:11},(_,i)=>({month:`2026-${String(i+1).padStart(2,'0')}`,value:i+1}));
  const fetchedAt='2026-10-12T12:20:00.000Z';
  const partial={asin:target,marketplace:'US',status:'error',fetchedAt,volume:points,amount:points,price:points,rank:[],fieldFetchedAt:{volume:'2026-10-01',amount:fetchedAt,price:fetchedAt},observationOutcomes:{rank:{category:'request-failed',fetchedAt}},observationErrors:{rank:'request-failed'}};
  const records=Object.fromEntries(asins.map(a=>[a,a===target?partial:{asin:a,marketplace:'US',status:'ready',fetchedAt,volume:points,amount:points,price:points,rank:points}]));
  const initialJob={jobId:'mixed-sales-job',asins,asinProgress:Object.fromEntries(asins.map(a=>[a,{sales_trend:{status:a===target?'pending':'ready'}}])),outputs:[]};
  const current=structuredClone(initialJob);let committed;
  finalizeProcessedStageCohort(current.jobId,'sales_trend',[target],asins,{
    initialJob,commandSucceeded:false,resultStatusesByAsin:{[target]:'connector-failed'},
    diagnostics:[{asin:target,stage:'sales_trend',causeCode:'CONNECTOR_FAILED',operation:'product_trend',boundary:'tool-content'}],
    readReadiness:(_stage,cohort)=>({items:cohort.map(asin=>({asin,sales:asin===target?'missing':'ready'})),ready:false,missingAsins:[target]}),
    readJob:()=>current,markModule:(_job,a,_stage,patch)=>{current.asinProgress[a].sales_trend=patch;},
    commitStage:(_job,input)=>{committed=input.output;},
    projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,readExport:()=>records}),
  });
  assert.equal(committed.stageStatus,'partial');
  assert.deepEqual(committed.data.trendByAsin[target],partial);
  for(const metric of ['volume','amount','price'])assert.equal(committed.data.trendByAsin[target][metric].length,11);
  assert.deepEqual(committed.data.trendByAsin[target].rank,[]);
  assert.equal(committed.gap.items.find(item=>item.asin===target).causeCode,'CONNECTOR_FAILED');
  assert.equal(Object.keys(committed.data.trendByAsin).length,10);
});

test('image cohort keeps explicit processed failure status and ignores sibling status injection',()=>{
  for(const [failure,cause] of [['connector-failed','CONNECTOR_FAILED'],['timeout','CONNECT_TIMEOUT']]) {
    const cached='B000000001';const target='B000000002';const asins=[cached,target];
    const scope={organizationId:'org',projectId:'project',runId:'run'};
    const listing=Object.fromEntries(asins.map(a=>[a,{status:'ready',galleryImages:[`https://images.test/${a}`]}]));
    const data={remarksByAsin:{[cached]:[{remark:'Keep cached',imageUrl:listing[cached].galleryImages[0]}]},outcomesByAsin:{[cached]:[{status:'ready'}]}};
    const initialJob={jobId:'failed-image-job',asins,scope,asinProgress:Object.fromEntries(asins.map(a=>[a,{image_remarks:{status:'pending'}}])),outputs:[projectStageOutput('listing',asins,{...scope,readExport:()=>listing}),projectStageOutput('image_remarks',asins,{...scope,stageStatus:'partial',dataAsins:[cached],imageRemarksData:data})]};
    const current=structuredClone(initialJob);let committed;
    finalizeProcessedStageCohort(current.jobId,'image_remarks',[target],asins,{
      initialJob,commandSucceeded:false,imageRemarksData:{remarksByAsin:{},outcomesByAsin:{}},
      resultStatusesByAsin:{[target]:failure,[cached]:'timeout',B000000003:'timeout'},
      readJob:()=>current,markModule:(_job,a,_stage,patch)=>{current.asinProgress[a].image_remarks=patch;},
      commitStage:(_job,input)=>{committed=input.output;},
      projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,...scope,readExport:()=>{throw Error('global cache forbidden');}}),
    });
    assert.equal(current.asinProgress[target].image_remarks.status,failure);
    assert.equal(current.asinProgress[cached].image_remarks.status,'ready');
    assert.equal(committed.gap.items?.find(item=>item.asin===target)?.causeCode,cause);
    assert.deepEqual(committed.data.remarksByAsin[cached],data.remarksByAsin[cached]);
    assert.equal(committed.gap.items?.some(item=>item.asin===cached),false);
    assert.doesNotThrow(()=>validatePersistedImageStageOutput(current,committed));
  }
});

test('fresh cached-only image stage defers early projection and schedules capture without model analysis',()=>{
  const asins=['B000000001','B000000002'];
  const scope={organizationId:'org',projectId:'project',runId:'run'};
  const listing=Object.fromEntries(asins.map(a=>[a,{status:'ready',galleryImages:[`https://images.test/${a}`]}]));
  const job={jobId:'fresh-cached-only',asins,scope,stages:[{id:'image_remarks',status:'pending',repairAsins:[]}],asinProgress:Object.fromEntries(asins.map(a=>[a,{image_remarks:{status:'pending'},traffic:{status:'ready'}}])),outputs:[projectStageOutput('listing',asins,{...scope,readExport:()=>listing})]};
  const finalized=[];
  runner.finalizeRepairCachedStages(job.jobId,job,(...args)=>finalized.push(args));
  assert.deepEqual(finalized,[]);
  const plan=runner.imageRemarkScheduling(job,job,asins);
  assert.deepEqual(plan.analysisAsins,[]);assert.equal(plan.captureNeeded,true);assert.equal(plan.shouldRun,true);
  const partialStage=structuredClone(job);partialStage.stages[0].status='partial';
  const captureOnly=runner.imageRemarkScheduling(partialStage,partialStage,asins);assert.equal(captureOnly.shouldRun,true);assert.deepEqual(captureOnly.analysisAsins,[]);
  const unfinished=structuredClone(job);unfinished.asinProgress[asins[0]].traffic.status='pending';
  assert.equal(runner.imageRemarkScheduling(unfinished,unfinished,asins).shouldRun,false);
  const resumed=structuredClone(job);resumed.resumeStages=['sales_trend'];
  assert.equal(runner.imageRemarkScheduling(resumed,resumed,asins).shouldRun,false);
  const noGalleries=structuredClone(job);noGalleries.outputs=[projectStageOutput('listing',asins,{...scope,stageStatus:'partial',dataAsins:[],readExport:()=>listing})];
  assert.equal(runner.imageRemarkScheduling(noGalleries,noGalleries,asins).shouldRun,true);
  noGalleries.asinProgress[asins[0]].traffic.status='pending';
  assert.equal(runner.imageRemarkScheduling(noGalleries,noGalleries,asins).shouldRun,false);
  const corrupted=structuredClone(job);corrupted.outputs[0].contentHash='0'.repeat(64);
  assert.throws(()=>runner.imageRemarkScheduling(corrupted,corrupted,asins),/hash mismatch/);
  const failedRefresh=structuredClone(job);failedRefresh.stages[0].repairAsins=[asins[1]];failedRefresh.stages[0].imageAction='refresh';failedRefresh.asinProgress[asins[1]].listing={status:'connector-failed'};failedRefresh.asinProgress[asins[1]].image_remarks.status='connector-failed';
  failedRefresh.outputs[0]=projectStageOutput('listing',asins,{...scope,stageStatus:'partial',dataAsins:[asins[0]],readExport:()=>listing});
  failedRefresh.outputs.push(projectStageOutput('image_remarks',asins,{...scope,stageStatus:'partial',dataAsins:[],imageRemarksData:{remarksByAsin:{},outcomesByAsin:{}}}));
  const refreshed=runner.imageRemarkScheduling(job,failedRefresh,asins);
  assert.deepEqual(refreshed.analysisAsins,[]);assert.equal(refreshed.captureNeeded,true);assert.equal(refreshed.shouldRun,true);
});


test('zero-gallery runner scheduling finalizes terminal gaps without subprocess or candidate',async()=>{
  const asins=['B000000001','B000000002'];const scope={organizationId:'org',projectId:'project',runId:'run'};
  const job={jobId:'zero-gallery-job',asins,scope,stages:[{id:'image_remarks',status:'pending',repairAsins:[]}],asinProgress:{[asins[0]]:{traffic:{status:'ready'},image_remarks:{status:'pending'}},[asins[1]]:{traffic:{status:'ready'},image_remarks:{status:'connector-failed'}}},outputs:[projectStageOutput('listing',asins,{...scope,stageStatus:'partial',dataAsins:[],readExport:()=>({})})]};
  const plan=runner.imageRemarkScheduling(job,job,asins);assert.equal(plan.shouldRun,true);assert.deepEqual(plan.analysisAsins,[]);assert.deepEqual(plan.captureAsins,[]);
  const partition=await runner.runGalleryReadyImageProcess(job,asins,()=>{throw Error('zero-gallery must not launch a subprocess or candidate');});assert.equal(partition.process.succeeded,true);
  const emptyData={remarksByAsin:{},outcomesByAsin:{}};
  const statuses=imageCandidateResultStatuses(emptyData,partition.listingByAsin,asins);
  for(const asin of partition.missingAsins) {const previous=job.asinProgress[asin].image_remarks.status;if(['connector-failed','timeout'].includes(previous))statuses[asin]=previous;}
  const current=structuredClone(job);let committed;
  finalizeProcessedStageCohort(job.jobId,'image_remarks',asins,asins,{initialJob:job,commandSucceeded:partition.process.succeeded,imageRemarksData:emptyData,resultStatusesByAsin:statuses,readJob:()=>current,markModule:(_j,a,_s,patch)=>{current.asinProgress[a].image_remarks=patch;},commitStage:(_j,input)=>{committed=input.output;current.outputs.push(committed);},projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,...scope,readExport:()=>{throw Error('global projection forbidden');}})});
  assert.equal(committed.stageStatus,'partial');assert.deepEqual(committed.data,emptyData);
  assert.equal(current.asinProgress[asins[0]].image_remarks.status,'upstream-empty');assert.equal(current.asinProgress[asins[1]].image_remarks.status,'connector-failed');
  assert.deepEqual(committed.gap.items.map(i=>[i.asin,i.causeCode]),[[asins[0],'UPSTREAM_EMPTY'],[asins[1],'CONNECTOR_FAILED']]);
  assert.doesNotThrow(()=>validatePersistedImageStageOutput(current,committed));assert.equal(runner.imageRemarkScheduling(job,current,asins).shouldRun,false);
  const waiting=structuredClone(job);waiting.asinProgress[asins[0]].traffic.status='pending';assert.equal(runner.imageRemarkScheduling(waiting,waiting,asins).shouldRun,false);
  const failed=structuredClone(current);for(const asin of asins)failed.asinProgress[asin].image_remarks.status='connector-failed';
  failed.outputs=failed.outputs.filter(o=>o.stage!=='image_remarks').concat(projectStageOutput('image_remarks',asins,{...scope,stageStatus:'failed',gapReasonCode:'CONNECTOR_FAILED'}));
  assert.equal(runner.imageRemarkScheduling(job,failed,asins).shouldRun,false);
});
