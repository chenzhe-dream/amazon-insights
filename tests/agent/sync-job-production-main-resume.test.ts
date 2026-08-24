import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const JOB_ID = "production-main-resume-fixture";
const PENDING_ASIN = "B0PENDING01";
const EMPTY_ASIN = "B0EMPTY0001";
const READY_ASIN = "B0READY0001";
const MANUAL_ASIN = "B0MANUAL001";
const ASINS = [PENDING_ASIN, EMPTY_ASIN, READY_ASIN, MANUAL_ASIN];
const PREFLIGHT_ASINS = ["B0GAP00001", "B0GAP00002", "B0GAP00003"];
const PREFLIGHT_JOB_ID = "production-preflight-partial-fixture";
const MIXED_PREFLIGHT_ASINS = ["B0MIS00001", "B0READY0002"];
const MIXED_PREFLIGHT_JOB_ID = "production-preflight-mixed-asin-fixture";

test("production main runs persisted resume targets despite stale ready build placeholders", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sync-production-main-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeStaleReadyProject(projectRoot);
  await writeResumeJob(projectRoot);

  const provider = await fakeProvider();
  t.after(provider.close);
  const binDirectory = await writeFakeNpm(projectRoot);
  const runnerPath = join(process.cwd(), "scripts", "run-asin-sync-job.mjs");
  const result = await execFileAsync(process.execPath, [runnerPath, JOB_ID], {
    cwd: projectRoot,
    env: safeChildEnvironment(binDirectory, {
      AGENT_VOC_LOCAL_FAKE: "1",
      FAKE_PROVIDER_ENDPOINT: provider.endpoint,
    }),
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });

  const persisted = JSON.parse(await readFile(join(projectRoot, "data", "sync-jobs", `${JOB_ID}.json`), "utf8"));
  assert.doesNotMatch(result.stderr, /\[error\]/);
  assert.match(result.stdout, /\[job\] keywords:sync/);
  assert.equal(provider.requests(), 1);
  assert.equal(persisted.asinProgress[PENDING_ASIN].keywords.status, "ready");
  assert.equal(persisted.asinProgress[EMPTY_ASIN].keywords.status, "upstream-empty");
  assert.equal(persisted.asinProgress[READY_ASIN].keywords.status, "ready");
  assert.equal(persisted.asinProgress[MANUAL_ASIN].keywords.status, "manual");
  assert.equal(persisted.stages.find((stage: { id: string }) => stage.id === "keywords")?.status, "partial");
});

test("production main skips preflight-unavailable catalog while continuing available providers", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sync-production-preflight-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeEmptyProject(projectRoot);
  await writePreflightPartialJob(projectRoot);

  const callsFile = join(projectRoot, "provider-calls.jsonl");
  const binDirectory = await writeRecordingFakeNpm(projectRoot);
  const runnerPath = join(process.cwd(), "scripts", "run-asin-sync-job.mjs");
  const result = await execFileAsync(process.execPath, [runnerPath, PREFLIGHT_JOB_ID], {
    cwd: projectRoot,
    env: safeChildEnvironment(binDirectory, {
      AGENT_VOC_LOCAL_FAKE: "1",
      FAKE_CALLS_FILE: callsFile,
    }),
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });

  const calls = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const persisted = JSON.parse(await readFile(join(projectRoot, "data", "sync-jobs", `${PREFLIGHT_JOB_ID}.json`), "utf8"));

  assert.doesNotMatch(result.stderr, /\[error\]/);
  assert.equal(calls.filter(call => call.connector === "sellerSprite").length, 0);
  assert.ok(calls.some(call => call.connector === "sif"));
  assert.ok(calls.some(call => call.connector === "sorftime"));
  for (const asin of PREFLIGHT_ASINS) {
    assert.equal(persisted.asinProgress[asin].catalog.status, "connector-failed");
    assert.equal(persisted.asinProgress[asin].catalog.reason, "SellerSprite 数据源不可用，本阶段已跳过。");
  }
  assert.equal(persisted.status, "completed-with-gaps");
  assert.equal(persisted.stages.find((stage: { id: string }) => stage.id === "catalog")?.status, "partial");
});

test("production main records an unavailable stage only for ASINs still missing that stage", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sync-production-preflight-mixed-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeMixedKeywordProject(projectRoot);
  await writeMixedAsinPreflightPartialJob(projectRoot);

  const callsFile = join(projectRoot, "provider-calls.jsonl");
  const binDirectory = await writeRecordingFakeNpm(projectRoot);
  const runnerPath = join(process.cwd(), "scripts", "run-asin-sync-job.mjs");
  await execFileAsync(process.execPath, [runnerPath, MIXED_PREFLIGHT_JOB_ID], {
    cwd: projectRoot,
    env: safeChildEnvironment(binDirectory, {
      AGENT_VOC_LOCAL_FAKE: "1",
      FAKE_CALLS_FILE: callsFile,
    }),
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });

  const persisted = JSON.parse(await readFile(
    join(projectRoot, "data", "sync-jobs", `${MIXED_PREFLIGHT_JOB_ID}.json`),
    "utf8",
  ));
  assert.equal(persisted.asinProgress[MIXED_PREFLIGHT_ASINS[0]].keywords.status, "connector-failed");
  assert.equal(persisted.asinProgress[MIXED_PREFLIGHT_ASINS[1]].keywords.status, "ready");
  assert.equal(persisted.asinProgress[MIXED_PREFLIGHT_ASINS[1]].keywords.reason, null);
});

test("production main stops invoking a degraded connector while other connectors continue", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sync-production-degradation-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeEmptyProject(projectRoot);
  await writeFirstRunJob(projectRoot, "production-runtime-degradation-fixture");

  const callsFile = join(projectRoot, "provider-calls.jsonl");
  const binDirectory = await writeDegradingFakeNpm(projectRoot);
  const runnerPath = join(process.cwd(), "scripts", "run-asin-sync-job.mjs");
  await execFileAsync(process.execPath, [runnerPath, "production-runtime-degradation-fixture"], {
    cwd: projectRoot,
    env: safeChildEnvironment(binDirectory, {
      AGENT_VOC_LOCAL_FAKE: "1",
      FAKE_CALLS_FILE: callsFile,
    }),
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });

  const calls = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const persisted = JSON.parse(await readFile(
    join(projectRoot, "data", "sync-jobs", "production-runtime-degradation-fixture.json"),
    "utf8",
  ));

  assert.equal(calls.filter(call => call.connector === "sorftime").length, 1);
  assert.ok(calls.some(call => call.connector === "sif" && call.stage === "traffic"));
  assert.deepEqual(persisted.providerDegraded, [{
    connector: "sorftime",
    failureKind: "connection",
    causeCode: "CONNECTION_REFUSED",
  }]);
  assert.equal(persisted.status, "completed-with-gaps");
});

test("production main keeps MCP_SCHEMA local for SIF, Sorftime, and SellerSprite", async (t) => {
  const cases = [
    {
      connector: "sif", stage: "keywords", laterConnector: "sif", laterStage: "traffic",
      readyStages: ["keywords", "traffic"],
    },
    {
      connector: "sorftime", stage: "reviews", laterConnector: "sorftime", laterStage: "sales_trend",
      readyStages: ["reviews", "sales_trend"],
    },
    {
      connector: "sellerSprite", stage: "catalog", laterConnector: "sellerSprite", laterStage: "catalog",
      readyStages: ["catalog"],
    },
  ];

  for (const fixture of cases) {
    const projectRoot = await mkdtemp(join(tmpdir(), `sync-production-schema-${fixture.connector}-`));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    await writeEmptyProject(projectRoot);
    const jobId = `production-schema-${fixture.connector}-fixture`;
    await writeFirstRunJob(projectRoot, jobId);

    const callsFile = join(projectRoot, "provider-calls.jsonl");
    const schemaMarker = join(projectRoot, "schema-marker");
    const binDirectory = await writeSchemaLocalFakeNpm(projectRoot);
    const runnerPath = join(process.cwd(), "scripts", "run-asin-sync-job.mjs");
    await execFileAsync(process.execPath, [runnerPath, jobId], {
      cwd: projectRoot,
      env: safeChildEnvironment(binDirectory, {
        AGENT_VOC_LOCAL_FAKE: "1",
        FAKE_CALLS_FILE: callsFile,
        FAKE_SCHEMA_CONNECTOR: fixture.connector,
        FAKE_SCHEMA_STAGE: fixture.stage,
        FAKE_SCHEMA_MARKER: schemaMarker,
        FAKE_PROJECT_ROOT: projectRoot,
        FAKE_READY_ASIN: PREFLIGHT_ASINS[1],
      }),
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });

    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const persisted = JSON.parse(await readFile(join(projectRoot, "data", "sync-jobs", `${jobId}.json`), "utf8"));

    assert.deepEqual(persisted.providerDegraded, [], fixture.connector);
    assert.deepEqual(persisted.diagnostics, [{
      connector: fixture.connector,
      stage: fixture.stage,
      asin: PREFLIGHT_ASINS[0],
      failureKind: "schema",
      causeCode: "MCP_SCHEMA",
    }], fixture.connector);
    assert.equal(persisted.asinProgress[PREFLIGHT_ASINS[0]][fixture.stage].status, "connector-failed", fixture.connector);
    for (const stage of fixture.readyStages) {
      const progress = persisted.asinProgress[PREFLIGHT_ASINS[1]][stage];
      assert.equal(progress.status, "ready", `${fixture.connector}:${stage}:status`);
      assert.equal(progress.reason, null, `${fixture.connector}:${stage}:reason`);
      assert.match(progress.updatedAt, /^\d{4}-\d{2}-\d{2}T/, `${fixture.connector}:${stage}:updatedAt`);
    }
    assert.ok(calls.some(call =>
      call.connector === fixture.laterConnector
      && call.stage === fixture.laterStage
      && call.asins.split(",").includes(PREFLIGHT_ASINS[1])
    ), fixture.connector);
    assert.deepEqual(
      persisted.diagnostics.filter((diagnostic: { asin: string }) => diagnostic.asin === PREFLIGHT_ASINS[1]),
      [],
      fixture.connector,
    );
  }
});

async function writeStaleReadyProject(projectRoot: string) {
  const appDirectory = join(projectRoot, "app");
  await mkdir(appDirectory, { recursive: true });
  await writeFile(
    join(appDirectory, "competitor-data.ts"),
    `export const competitors = ${JSON.stringify(ASINS.map((asin) => ({ asin })), null, 2)};\n`,
    "utf8",
  );
  await writeExport(appDirectory, "sif-keyword-analysis-data.ts", "sifKeywordAnalysisData", readyRecords());
  await writeExport(appDirectory, "sorftime-review-analysis-data.ts", "sorftimeReviewAnalysisData", readyRecords());
  await writeExport(appDirectory, "sorftime-sales-trend-data.ts", "sorftimeSalesTrendData", Object.fromEntries(
    ASINS.map((asin) => [asin, { status: "ready", volume: [{ month: "2026-08", value: 1 }] }]),
  ));
  await writeExport(appDirectory, "sorftime-child-sales-data.ts", "sorftimeChildSales30d", Object.fromEntries(
    ASINS.map((asin) => [asin, [{ sales: 1 }]]),
  ));
  await writeExport(appDirectory, "sorftime-price-strategy-data.ts", "sorftimePriceStrategies", Object.fromEntries(
    ASINS.map((asin) => [asin, { anchor: 1 }]),
  ));
  await writeExport(appDirectory, "sorftime-fba-fee-data.ts", "sorftimeFbaFeeData", Object.fromEntries(
    ASINS.map((asin) => [asin, { status: "ready", fbaFee: 1 }]),
  ));
  await writeExport(appDirectory, "sorftime-category-trend-data.ts", "sorftimeCategoryTrendData", {
    fixture: { status: "ready", asins: ASINS },
  });
}

async function writeResumeJob(projectRoot: string) {
  const directory = join(projectRoot, "data", "sync-jobs");
  await mkdir(directory, { recursive: true });
  const now = "2026-08-23T00:00:00.000Z";
  await writeFile(join(directory, `${JOB_ID}.json`), JSON.stringify({
    jobId: JOB_ID,
    asins: ASINS,
    marketplace: "US",
    status: "queued",
    message: "resume",
    currentStageId: "keywords",
    resumeStages: ["keywords"],
    stages: [{
      id: "keywords",
      label: "SIF keywords",
      kind: "auto",
      status: "pending",
      estimatedSeconds: 1,
      detail: "resume fixture",
      startedAt: null,
      completedAt: null,
    }],
    asinProgress: {
      [PENDING_ASIN]: { keywords: { status: "pending", reason: "LEGACY_UNVERIFIED", updatedAt: now } },
      [EMPTY_ASIN]: { keywords: { status: "upstream-empty", reason: "PROVIDER_SCHEMA_VALID_EMPTY", updatedAt: now } },
      [READY_ASIN]: { keywords: { status: "ready", reason: null, updatedAt: now } },
      [MANUAL_ASIN]: { keywords: { status: "manual", reason: "manual", updatedAt: now } },
    },
    createdAt: now,
    updatedAt: now,
  }, null, 2), "utf8");
}

async function writeEmptyProject(projectRoot: string) {
  const appDirectory = join(projectRoot, "app");
  await mkdir(appDirectory, { recursive: true });
  await writeFile(join(appDirectory, "competitor-data.ts"), "export const competitors = [];\n", "utf8");
}

async function writeMixedKeywordProject(projectRoot: string) {
  await writeEmptyProject(projectRoot);
  await writeExport(
    join(projectRoot, "app"),
    "sif-keyword-analysis-data.ts",
    "sifKeywordAnalysisData",
    { [MIXED_PREFLIGHT_ASINS[1]]: { status: "ready" } },
  );
}

async function writePreflightPartialJob(projectRoot: string) {
  const directory = join(projectRoot, "data", "sync-jobs");
  await mkdir(directory, { recursive: true });
  const now = "2026-08-24T00:00:00.000Z";
  await writeFile(join(directory, `${PREFLIGHT_JOB_ID}.json`), JSON.stringify({
    jobId: PREFLIGHT_JOB_ID,
    asins: PREFLIGHT_ASINS,
    marketplace: "US",
    status: "queued",
    message: "preflight partial",
    currentStageId: "queue",
    stages: runnerStages({
      catalog: {
        status: "partial",
        detail: "SellerSprite 数据源不可用，本阶段已跳过。",
        completedAt: now,
      },
    }),
    asinProgress: Object.fromEntries(PREFLIGHT_ASINS.map(asin => [asin, Object.fromEntries([
      "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category", "traffic",
    ].map(stageId => [stageId, { status: "pending", reason: null, updatedAt: now }]))])),
    createdAt: now,
    updatedAt: now,
  }, null, 2), "utf8");
}

async function writeMixedAsinPreflightPartialJob(projectRoot: string) {
  const directory = join(projectRoot, "data", "sync-jobs");
  await mkdir(directory, { recursive: true });
  const now = "2026-08-24T00:00:00.000Z";
  await writeFile(join(directory, `${MIXED_PREFLIGHT_JOB_ID}.json`), JSON.stringify({
    jobId: MIXED_PREFLIGHT_JOB_ID,
    asins: MIXED_PREFLIGHT_ASINS,
    marketplace: "US",
    status: "queued",
    message: "mixed ASIN preflight partial",
    currentStageId: "queue",
    stages: runnerStages({
      keywords: {
        status: "partial",
        detail: "SIF 数据源不可用，本阶段已跳过。",
        completedAt: now,
      },
    }),
    asinProgress: Object.fromEntries(MIXED_PREFLIGHT_ASINS.map((asin) => [asin, Object.fromEntries(
      ["catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category", "traffic"].map((stageId) => [stageId, {
        status: stageId === "keywords" && asin === MIXED_PREFLIGHT_ASINS[1] ? "ready" : "pending",
        reason: null,
        updatedAt: now,
      }]),
    )])),
    createdAt: now,
    updatedAt: now,
  }, null, 2), "utf8");
}

async function writeFirstRunJob(projectRoot: string, jobId: string) {
  const directory = join(projectRoot, "data", "sync-jobs");
  await mkdir(directory, { recursive: true });
  const now = "2026-08-24T00:00:00.000Z";
  await writeFile(join(directory, `${jobId}.json`), JSON.stringify({
    jobId,
    asins: PREFLIGHT_ASINS,
    marketplace: "US",
    status: "queued",
    message: "first run",
    currentStageId: "queue",
    stages: runnerStages(),
    asinProgress: Object.fromEntries(PREFLIGHT_ASINS.map(asin => [asin, Object.fromEntries([
      "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category", "traffic",
    ].map(stageId => [stageId, { status: "pending", reason: null, updatedAt: now }]))])),
    createdAt: now,
    updatedAt: now,
  }, null, 2), "utf8");
}

function runnerStages(overrides: Record<string, Partial<Record<string, unknown>>> = {}) {
  return [
    "queue", "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category", "traffic", "image_remarks", "alexa_voc", "build",
  ].map((id) => ({
    id,
    label: id,
    kind: id === "alexa_voc" ? "manual" : "auto",
    status: id === "alexa_voc" ? "manual" : "pending",
    estimatedSeconds: 1,
    detail: `${id} fixture`,
    startedAt: null,
    completedAt: null,
    ...overrides[id],
  }));
}

async function writeFakeNpm(projectRoot: string) {
  const binDirectory = join(projectRoot, "bin");
  await mkdir(binDirectory, { recursive: true });
  const fakeRunner = join(binDirectory, "fake-npm.mjs");
  await writeFile(fakeRunner, `
const response = await fetch(process.env.FAKE_PROVIDER_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ stage: process.env.AGENT_SYNC_STAGE_ID, asins: process.env.SIF_ASINS }),
});
if (!response.ok) process.exitCode = 1;
`, "utf8");
  await writeFile(join(binDirectory, "npm.cmd"), `@echo off\r\n@"${process.execPath}" "${fakeRunner}" %*\r\n`, "utf8");
  const posixShim = join(binDirectory, "npm");
  await writeFile(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`, "utf8");
  await chmod(posixShim, 0o755);
  return binDirectory;
}

async function writeRecordingFakeNpm(projectRoot: string) {
  const binDirectory = join(projectRoot, "recording-bin");
  await mkdir(binDirectory, { recursive: true });
  const fakeRunner = join(binDirectory, "fake-npm.mjs");
  await writeFile(fakeRunner, `
import { appendFileSync } from "node:fs";
const connector = process.env.SELLERSPRITE_ASINS ? "sellerSprite"
  : process.env.SIF_ASINS ? "sif"
    : process.env.SORFTIME_ASINS ? "sorftime"
      : "unknown";
appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify({ connector, stage: process.env.AGENT_SYNC_STAGE_ID }) + "\\n");
`, "utf8");
  await writeFile(join(binDirectory, "npm.cmd"), `@echo off\r\n@"${process.execPath}" "${fakeRunner}" %*\r\n`, "utf8");
  const posixShim = join(binDirectory, "npm");
  await writeFile(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`, "utf8");
  await chmod(posixShim, 0o755);
  return binDirectory;
}

async function writeDegradingFakeNpm(projectRoot: string) {
  const binDirectory = join(projectRoot, "degrading-bin");
  await mkdir(binDirectory, { recursive: true });
  const fakeRunner = join(binDirectory, "fake-npm.mjs");
  await writeFile(fakeRunner, `
import { appendFileSync } from "node:fs";
const connector = process.env.SELLERSPRITE_ASINS ? "sellerSprite"
  : process.env.SIF_ASINS ? "sif"
    : process.env.SORFTIME_ASINS ? "sorftime"
      : "unknown";
appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify({ connector, stage: process.env.AGENT_SYNC_STAGE_ID }) + "\\n");
if (connector === "sorftime") {
  const asin = process.env.SORFTIME_ASINS.split(",")[0];
  console.error("@@provider-diagnostic@@" + JSON.stringify({
    connector: "sorftime",
    stage: process.env.AGENT_SYNC_STAGE_ID,
    asin,
    failureKind: "connection",
    causeCode: "CONNECTION_REFUSED",
  }));
  process.exitCode = 1;
}
`, "utf8");
  await writeFile(join(binDirectory, "npm.cmd"), `@echo off\r\n@"${process.execPath}" "${fakeRunner}" %*\r\n`, "utf8");
  const posixShim = join(binDirectory, "npm");
  await writeFile(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`, "utf8");
  await chmod(posixShim, 0o755);
  return binDirectory;
}

async function writeSchemaLocalFakeNpm(projectRoot: string) {
  const binDirectory = join(projectRoot, "schema-local-bin");
  await mkdir(binDirectory, { recursive: true });
  const fakeRunner = join(binDirectory, "fake-npm.mjs");
  await writeFile(fakeRunner, `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const connector = process.env.SELLERSPRITE_ASINS ? "sellerSprite"
  : process.env.SIF_ASINS ? "sif"
    : process.env.SORFTIME_ASINS ? "sorftime"
      : "unknown";
const asins = process.env.SELLERSPRITE_ASINS ?? process.env.SIF_ASINS ?? process.env.SORFTIME_ASINS ?? "";
appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify({ connector, stage: process.env.AGENT_SYNC_STAGE_ID, asins }) + "\\n");
writeReadyResult();
if (connector === process.env.FAKE_SCHEMA_CONNECTOR
  && process.env.AGENT_SYNC_STAGE_ID === process.env.FAKE_SCHEMA_STAGE
  && !existsSync(process.env.FAKE_SCHEMA_MARKER)) {
  writeFileSync(process.env.FAKE_SCHEMA_MARKER, "schema");
  console.error("@@provider-diagnostic@@" + JSON.stringify({
    connector,
    stage: process.env.AGENT_SYNC_STAGE_ID,
    asin: asins.split(",")[0],
    failureKind: "schema",
    causeCode: "MCP_SCHEMA",
  }));
  process.exitCode = 1;
}

function writeReadyResult() {
  const projectRoot = process.env.FAKE_PROJECT_ROOT;
  const readyAsin = process.env.FAKE_READY_ASIN;
  if (!projectRoot || !readyAsin || !asins.split(",").includes(readyAsin)) return;
  const appDirectory = join(projectRoot, "app");
  mkdirSync(appDirectory, { recursive: true });
  const writeExport = (fileName, exportName, value) => writeFileSync(
    join(appDirectory, fileName),
    \`export const \${exportName} = \${JSON.stringify(value)};\\n\`,
  );
  switch (process.env.AGENT_SYNC_STAGE_ID) {
    case "catalog":
      writeExport("competitor-data.ts", "competitors", [{ asin: readyAsin }]);
      break;
    case "keywords":
      writeExport("sif-keyword-analysis-data.ts", "sifKeywordAnalysisData", { [readyAsin]: { status: "ready" } });
      break;
    case "reviews":
      writeExport("sorftime-review-analysis-data.ts", "sorftimeReviewAnalysisData", { [readyAsin]: { status: "ready" } });
      break;
    case "sales_trend":
      writeExport("sorftime-sales-trend-data.ts", "sorftimeSalesTrendData", {
        [readyAsin]: { status: "ready", volume: [{ month: "2026-08", value: 1 }] },
      });
      break;
    case "traffic":
      writeExport("sif-listing-traffic-raw-data.ts", "sifListingTrafficRawByAsin", {
        [readyAsin]: { overview: { total: 1 }, structure: { chars: { dims: ["source"] } } },
      });
      break;
  }
}
`, "utf8");
  await writeFile(join(binDirectory, "npm.cmd"), `@echo off\r\n@"${process.execPath}" "${fakeRunner}" %*\r\n`, "utf8");
  const posixShim = join(binDirectory, "npm");
  await writeFile(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`, "utf8");
  await chmod(posixShim, 0o755);
  return binDirectory;
}

function safeChildEnvironment(binDirectory: string, additions: Record<string, string>) {
  const inheritedKeys = ["ComSpec", "SystemRoot", "PATHEXT", "TEMP", "TMP", "WINDIR"];
  const environment = Object.fromEntries(inheritedKeys.flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : []
  ));
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    ...environment,
    PATH: `${binDirectory}${delimiter}${inheritedPath}`,
    ...additions,
  };
}

function readyRecords() {
  return Object.fromEntries(ASINS.map((asin) => [asin, { status: "ready" }]));
}

async function writeExport(appDirectory: string, fileName: string, exportName: string, value: unknown) {
  await writeFile(join(appDirectory, fileName), `export const ${exportName} = ${JSON.stringify(value, null, 2)};\n`, "utf8");
}

async function fakeProvider() {
  let count = 0;
  const server = createServer((_request, response) => {
    count += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/fake-provider`,
    requests: () => count,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
