import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readJob, startAsinSyncJob } from "../../app/lib/sync-server";

const root = process.cwd();

async function waitForTerminalJob(jobId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await readJob(jobId);
    if (job && ["failed", "completed"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`sync job ${jobId} did not become terminal`);
}

test("a detached command failure persists stderr and terminalizes the active stage", async () => {
  const connectorSentinels = {
    sellerSprite: "seller-secret-sentinel-123456",
    sif: "sif-secret-sentinel-234567",
    sorftime: "sorftime-secret-sentinel-345678",
  };
  const databaseSentinels = {
    agent: "postgresql://agent_user:agent-db-password-456789@db.internal:5432/app",
    compatible: "postgres://compat_user:compat-db-password-987654@compat.internal:5432/app",
  };
  const fakeBin = mkdtempSync(path.join(tmpdir(), "sync-fake-npm-"));
  const fakeNpm = process.platform === "win32" ? path.join(fakeBin, "npm.cmd") : path.join(fakeBin, "npm");
  const originalPath = process.env.PATH;
  const originalEnv = Object.fromEntries(
    ["AGENT_VOC_LOCAL_FAKE", "ALEXA_AUTO", "SELLERSPRITE_SECRET_KEY", "SIF_MCP_SECRET", "SORFTIME_MCP_KEY", "AGENT_DATABASE_URL", "DATABASE_URL"]
      .map(key => [key, process.env[key]]),
  );
  let jobId: string | undefined;

  if (process.platform === "win32") {
    writeFileSync(
      fakeNpm,
      `@if "%SELLERSPRITE_SECRET_KEY%|%SIF_MCP_SECRET%|%SORFTIME_MCP_KEY%"=="${connectorSentinels.sellerSprite}|${connectorSentinels.sif}|${connectorSentinels.sorftime}" echo connector-env-match=yes\r\n@echo synthetic-catalog-stdout raw=%SELLERSPRITE_SECRET_KEY% raw=%SIF_MCP_SECRET% raw=%SORFTIME_MCP_KEY% raw=%AGENT_DATABASE_URL% raw=%DATABASE_URL%\r\n@echo synthetic-catalog-stderr raw=%SELLERSPRITE_SECRET_KEY% raw=%SIF_MCP_SECRET% raw=%SORFTIME_MCP_KEY% raw=%AGENT_DATABASE_URL% raw=%DATABASE_URL% 1>&2\r\n@exit /b 23\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nif [ "$SELLERSPRITE_SECRET_KEY|$SIF_MCP_SECRET|$SORFTIME_MCP_KEY" = "${connectorSentinels.sellerSprite}|${connectorSentinels.sif}|${connectorSentinels.sorftime}" ]; then echo connector-env-match=yes; fi\necho "synthetic-catalog-stdout raw=$SELLERSPRITE_SECRET_KEY raw=$SIF_MCP_SECRET raw=$SORFTIME_MCP_KEY raw=$AGENT_DATABASE_URL raw=$DATABASE_URL"\necho "synthetic-catalog-stderr raw=$SELLERSPRITE_SECRET_KEY raw=$SIF_MCP_SECRET raw=$SORFTIME_MCP_KEY raw=$AGENT_DATABASE_URL raw=$DATABASE_URL" >&2\nexit 23\n`,
      { mode: 0o755 },
    );
  }

  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    process.env.AGENT_VOC_LOCAL_FAKE = "1";
    process.env.ALEXA_AUTO = "0";
    process.env.SELLERSPRITE_SECRET_KEY = connectorSentinels.sellerSprite;
    process.env.SIF_MCP_SECRET = connectorSentinels.sif;
    process.env.SORFTIME_MCP_KEY = connectorSentinels.sorftime;
    process.env.AGENT_DATABASE_URL = databaseSentinels.agent;
    process.env.DATABASE_URL = databaseSentinels.compatible;

    const started = await startAsinSyncJob({
      asins: ["ZZZZZZZZZ1"], marketplace: "US", organizationId: "test-organization",
    });
    jobId = started.job.jobId;
    const job = await waitForTerminalJob(jobId);
    const catalog = job.stages.find(stage => stage.id === "catalog");
    const log = readFileSync(path.join(root, "data", "sync-jobs", `${jobId}.log`), "utf8");

    assert.equal(job.status, "failed");
    assert.ok(job.completedAt);
    assert.equal(job.stages.some(stage => stage.status === "active"), false);
    assert.equal(catalog?.status, "failed");
    assert.ok(catalog?.completedAt);
    assert.match(job.message, /catalog:sync failed \(exit 23\)/);
    assert.match(job.message, /synthetic-catalog-stderr/);
    for (const sentinel of Object.values(connectorSentinels)) {
      assert.doesNotMatch(JSON.stringify(job), new RegExp(sentinel));
    }
    for (const sentinel of Object.values(databaseSentinels)) {
      assert.doesNotMatch(JSON.stringify(job), new RegExp(sentinel));
    }
    assert.match(job.message, /\[REDACTED\]/);
    assert.match(log, /synthetic-catalog-stdout/);
    assert.match(log, /synthetic-catalog-stderr/);
    assert.match(log, /connector-env-match=yes/);
    for (const sentinel of Object.values(connectorSentinels)) {
      assert.doesNotMatch(log, new RegExp(sentinel));
    }
    for (const sentinel of Object.values(databaseSentinels)) {
      assert.doesNotMatch(log, new RegExp(sentinel));
    }
    assert.match(log, /\[REDACTED\]/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (jobId) {
      rmSync(path.join(root, "data", "sync-jobs", `${jobId}.json`), { force: true });
      rmSync(path.join(root, "data", "sync-jobs", `${jobId}.log`), { force: true });
    }
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
