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
