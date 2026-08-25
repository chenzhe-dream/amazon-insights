import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumeWebReloadRequest,
  createWebReloadTarget,
  readPendingWebReloadRequests,
  readWebReloadPublication,
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
  artifactId: "a".repeat(64),
  buildCompletedAt: "2026-08-22T00:00:00.000Z",
  target,
});

function publicationReference(written) {
  return {
    jobId: request.jobId,
    requestId: written.id,
    artifactId: request.artifactId,
    requestedAt: request.buildCompletedAt,
  };
}

test("reload requests are atomically written with a bounded versioned safe payload", async () => {
  await withSpool(async (spoolDir) => {
    await writeWebReloadRequest(request, { spoolDir });

    const pending = await readPendingWebReloadRequests({ spoolDir });
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].payload, { version: 2, ...request });

    const serialized = await readFile(pending[0].path, "utf8");
    assert.doesNotMatch(serialized, /command|environment|secret|token|database|url/i);
    assert.doesNotMatch(pending[0].path, /\.tmp-/);
  });
});

test("artifact identity is validated and contributes to the request hash", async () => {
  await withSpool(async (spoolDir) => {
    const first = await writeWebReloadRequest(request, { spoolDir });
    const second = await writeWebReloadRequest({ ...request, artifactId: "b".repeat(64) }, { spoolDir });

    assert.notEqual(first.id, second.id);
    await assert.rejects(
      writeWebReloadRequest({ ...request, artifactId: "not-an-artifact" }, { spoolDir }),
      /Invalid Web artifact identity/,
    );
  });
});

test("publication status follows the authoritative spool transition", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    const reference = publicationReference(written);

    assert.deepEqual(await readWebReloadPublication(reference, { spoolDir }), {
      status: "pending",
      requestId: written.id,
      artifactId: request.artifactId,
      requestedAt: request.buildCompletedAt,
    });

    await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => undefined,
    });
    const applied = await readWebReloadPublication(reference, { spoolDir });
    assert.equal(applied.status, "applied");
    assert.equal(applied.artifactId, request.artifactId);
    assert.match(applied.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("reader rescans when a request is renamed between lookup and stable read", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    const pendingPath = written.path;
    const processingDir = path.join(spoolDir, "processing");
    const processingPath = path.join(processingDir, `${written.id}-${"b".repeat(36)}.json`);
    const originalStat = fs.stat;
    const originalReaddir = fs.readdir;
    let releaseProcessingScan;
    const processingScan = new Promise((resolve) => { releaseProcessingScan = resolve; });
    let moved = false;
    fs.readdir = async (directory, ...args) => {
      if (directory === processingDir) await processingScan;
      return originalReaddir(directory, ...args);
    };
    fs.stat = async (file, ...args) => {
      const stats = await originalStat(file, ...args);
      if (!moved && file === pendingPath) {
        moved = true;
        await rename(pendingPath, processingPath);
        releaseProcessingScan();
      }
      return stats;
    };
    try {
      assert.deepEqual(await readWebReloadPublication(publicationReference(written), { spoolDir }), {
        status: "pending",
        requestId: written.id,
        artifactId: request.artifactId,
        requestedAt: request.buildCompletedAt,
      });
      assert.equal(moved, true);
    } finally {
      fs.stat = originalStat;
      fs.readdir = originalReaddir;
    }
  });
});

test("ambiguous terminal and in-flight spool states fail closed", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    const serialized = await readFile(written.path, "utf8");
    await rename(written.path, path.join(spoolDir, "applied", `${written.id}.json`));
    await writeFile(path.join(spoolDir, "failed", `${written.id}.json`), serialized);
    assert.equal((await readWebReloadPublication(publicationReference(written), { spoolDir })).status, "failed");
  });

  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    const serialized = await readFile(written.path, "utf8");
    await rename(written.path, path.join(spoolDir, "applied", `${written.id}.json`));
    await writeFile(path.join(spoolDir, "processing", `${written.id}-${"c".repeat(36)}.json`), serialized);
    assert.equal((await readWebReloadPublication(publicationReference(written), { spoolDir })).status, "failed");
  });
});

test("reader rejects payload splices with mismatched request IDs or requested times", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    await writeFile(
      path.join(spoolDir, "applied", `${written.id}.json`),
      JSON.stringify({ ...written.payload, target: { ...target, webHost: "localhost" } }),
    );
    await rm(written.path);
    assert.equal((await readWebReloadPublication(publicationReference(written), { spoolDir })).status, "failed");
  });

  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    await writeFile(
      path.join(spoolDir, "applied", `${written.id}.json`),
      JSON.stringify({ ...written.payload, buildCompletedAt: "2026-08-22T00:00:01.000Z" }),
    );
    await rm(written.path);
    assert.equal((await readWebReloadPublication(publicationReference(written), { spoolDir })).status, "failed");
  });
});

test("failed, duplicate, and malformed spool states are closed publication results", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    const reference = publicationReference(written);
    const options = {
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => { throw new Error("replacement failed"); },
    };

    assert.equal((await consumeWebReloadRequest(options)).status, "failed");
    const failed = await readWebReloadPublication(reference, { spoolDir });
    assert.equal(failed.status, "failed");
    assert.equal(failed.code, "WEB_PUBLICATION_FAILED");
    assert.match(failed.failedAt, /^\d{4}-\d{2}-\d{2}T/);

    await writeWebReloadRequest(request, { spoolDir });
    assert.equal((await consumeWebReloadRequest(options)).status, "duplicate");
    assert.equal((await readWebReloadPublication(reference, { spoolDir })).status, "failed");

    await writeFile(path.join(spoolDir, "applied", `${written.id}.json`), "{invalid");
    assert.equal((await readWebReloadPublication(reference, { spoolDir })).status, "failed");
  });
});

test("publication references reject malformed identities", async () => {
  await withSpool(async (spoolDir) => {
    await assert.rejects(
      readWebReloadPublication({
        jobId: request.jobId,
        requestId: "invalid",
        artifactId: request.artifactId,
        requestedAt: request.buildCompletedAt,
      }, { spoolDir }),
      /Invalid Web publication reference/,
    );
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
