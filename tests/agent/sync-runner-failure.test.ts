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
  const secretSentinel = "sync-secret-sentinel-123456789";
  const fakeBin = mkdtempSync(path.join(tmpdir(), "sync-fake-npm-"));
  const fakeNpm = process.platform === "win32" ? path.join(fakeBin, "npm.cmd") : path.join(fakeBin, "npm");
  const originalPath = process.env.PATH;
  const originalEnv = Object.fromEntries(
    ["AGENT_VOC_LOCAL_FAKE", "ALEXA_AUTO", "SELLERSPRITE_SECRET_KEY", "SIF_MCP_SECRET", "SORFTIME_MCP_KEY"]
      .map(key => [key, process.env[key]]),
  );
  let jobId: string | undefined;

  if (process.platform === "win32") {
    writeFileSync(
      fakeNpm,
      `@if "%SELLERSPRITE_SECRET_KEY%|%SIF_MCP_SECRET%|%SORFTIME_MCP_KEY%"=="${secretSentinel}|test-only|test-only" echo connector-env-match=yes\r\n@echo synthetic-catalog-stdout secret-key: %SELLERSPRITE_SECRET_KEY%\r\n@echo synthetic-catalog-stderr Authorization: Bearer %SELLERSPRITE_SECRET_KEY% 1>&2\r\n@exit /b 23\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nif [ "$SELLERSPRITE_SECRET_KEY|$SIF_MCP_SECRET|$SORFTIME_MCP_KEY" = "${secretSentinel}|test-only|test-only" ]; then echo connector-env-match=yes; fi\necho "synthetic-catalog-stdout secret-key: $SELLERSPRITE_SECRET_KEY"\necho "synthetic-catalog-stderr Authorization: Bearer $SELLERSPRITE_SECRET_KEY" >&2\nexit 23\n`,
      { mode: 0o755 },
    );
  }

  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    process.env.AGENT_VOC_LOCAL_FAKE = "1";
    process.env.ALEXA_AUTO = "0";
    process.env.SELLERSPRITE_SECRET_KEY = secretSentinel;
    process.env.SIF_MCP_SECRET = "test-only";
    process.env.SORFTIME_MCP_KEY = "test-only";

    const started = await startAsinSyncJob(["ZZZZZZZZZ1"], "US");
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
    assert.doesNotMatch(JSON.stringify(job), new RegExp(secretSentinel));
    assert.match(job.message, /\[REDACTED\]/);
    assert.match(log, /synthetic-catalog-stdout/);
    assert.match(log, /synthetic-catalog-stderr/);
    assert.match(log, /connector-env-match=yes/);
    assert.doesNotMatch(log, new RegExp(secretSentinel));
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
