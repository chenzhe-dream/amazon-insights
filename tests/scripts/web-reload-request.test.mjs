import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumeWebReloadRequest,
  createWebReloadTarget,
  readPendingWebReloadRequests,
  writeWebReloadRequest,
} from "../../scripts/lib/web-reload-request.mjs";

async function withSpool(run) {
  const spoolDir = await mkdtemp(path.join(os.tmpdir(), "web-reload-request-"));
  try {
    await run(spoolDir);
  } finally {
    await rm(spoolDir, { recursive: true, force: true });
  }
}

const worktree = path.resolve("C:/isolated/worktree");
const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
const request = Object.freeze({
  jobId: "job-safe-123",
  buildCompletedAt: "2026-08-22T00:00:00.000Z",
  target,
});

test("reload requests are atomically written with a bounded versioned safe payload", async () => {
  await withSpool(async (spoolDir) => {
    await writeWebReloadRequest(request, { spoolDir });

    const pending = await readPendingWebReloadRequests({ spoolDir });
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].payload, { version: 1, ...request });

    const serialized = await readFile(pending[0].path, "utf8");
    assert.doesNotMatch(serialized, /command|environment|secret|token|database|url/i);
    assert.doesNotMatch(pending[0].path, /\.tmp-/);
  });
});

test("valid request is consumed once and archived without applying a duplicate", async () => {
  await withSpool(async (spoolDir) => {
    await writeWebReloadRequest(request, { spoolDir });
    let applications = 0;
    const options = {
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => { applications += 1; },
    };

    assert.equal((await consumeWebReloadRequest(options)).status, "applied");
    await writeWebReloadRequest(request, { spoolDir });
    assert.equal((await consumeWebReloadRequest(options)).status, "duplicate");
    assert.equal(applications, 1);
    assert.equal((await readdir(path.join(spoolDir, "pending"))).length, 0);
    assert.equal((await readdir(path.join(spoolDir, "applied"))).length, 1);
  });
});

test("invalid, stale, and failed requests are archived without execution", async () => {
  await withSpool(async (spoolDir) => {
    await writeWebReloadRequest({ ...request, target: { ...target, worktreeId: "0".repeat(64) } }, { spoolDir });
    let applications = 0;
    const invalid = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      apply: async () => { applications += 1; },
    });
    assert.equal(invalid.status, "invalid");

    await writeWebReloadRequest({ ...request, buildCompletedAt: "2020-01-01T00:00:00.000Z" }, { spoolDir });
    const stale = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      maxAgeMs: 1_000,
      apply: async () => { applications += 1; },
    });
    assert.equal(stale.status, "invalid");

    await writeWebReloadRequest(request, { spoolDir });
    const failed = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => { applications += 1; throw new Error("replacement failed"); },
    });
    assert.equal(failed.status, "failed");
    assert.equal(applications, 1);
    assert.ok((await readdir(path.join(spoolDir, "failed"))).length >= 3);
  });
});

test("malformed requests are archived without retaining their untrusted body", async () => {
  await withSpool(async (spoolDir) => {
    const pendingDir = path.join(spoolDir, "pending");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(path.join(pendingDir, `${"a".repeat(64)}.json`), "{not-json: secret-value}");

    const result = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      apply: async () => assert.fail("malformed requests must not execute"),
    });

    assert.equal(result.status, "invalid");
    const archives = await readdir(path.join(spoolDir, "failed"));
    const archived = await readFile(path.join(spoolDir, "failed", archives[0]), "utf8");
    assert.doesNotMatch(archived, /secret-value/);
  });
});
