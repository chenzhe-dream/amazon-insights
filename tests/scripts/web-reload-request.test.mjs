import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumeWebReloadRequest,
  createWebReloadTarget,
  readActiveWebReloadRequests,
  readPendingWebReloadRequests,
  readWebReloadPublication,
  writeWebReloadRequest,
  writeWebReloadRequestSync,
} from "../../scripts/lib/web-reload-request.mjs";
import {
  commitWebPublicationControl,
} from "../../scripts/lib/web-publication-control.mjs";

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
  jobVersion: 9,
  artifactId: "a".repeat(64),
  stageContentHashes: Object.freeze({
    category: "b".repeat(64),
    keywords: "c".repeat(64),
  }),
  buildCompletedAt: "2026-08-22T00:00:00.000Z",
  target,
});

function publicationReference(written) {
  return {
    jobId: request.jobId,
    requestId: written.id,
    artifactId: request.artifactId,
    jobVersion: request.jobVersion,
    stageContentHashes: request.stageContentHashes,
    requestedAt: request.buildCompletedAt,
  };
}

test("reload requests are atomically written with a bounded versioned safe payload", async () => {
  await withSpool(async (spoolDir) => {
    await writeWebReloadRequest(request, { spoolDir });

    const pending = await readPendingWebReloadRequests({ spoolDir });
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].payload, { version: 3, ...request });

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
    const nextVersion = await writeWebReloadRequest({ ...request, jobVersion: 10 }, { spoolDir });
    const nextHashes = await writeWebReloadRequest({
      ...request,
      stageContentHashes: { ...request.stageContentHashes, category: "d".repeat(64) },
    }, { spoolDir });
    assert.notEqual(first.id, nextVersion.id);
    assert.notEqual(first.id, nextHashes.id);
    await assert.rejects(
      writeWebReloadRequest({ ...request, artifactId: "not-an-artifact" }, { spoolDir }),
      /Invalid Web artifact identity/,
    );
  });
});

function alexaRequest(generation, artifact = String(generation % 10).repeat(64)) {
  return {
    ...request,
    jobId: `manual-alexa-voc-g${generation}-${artifact.slice(0, 24)}`,
    jobVersion: generation,
    artifactId: artifact,
    stageContentHashes: { alexa_voc: String((generation + 1) % 10).repeat(64) },
    stream: { id: "alexa_voc", generation, epoch: 7 },
  };
}

test("Alexa v4 binds generation job identity and the sole alexa_voc stage while v3 stays compatible", async () => {
  await withSpool(async (spoolDir) => {
    for (const malformed of [
      { ...alexaRequest(3), jobVersion: 4 },
      { ...alexaRequest(3), jobId: "manual-alexa-voc-g3-wrong" },
      { ...alexaRequest(3), stageContentHashes: { keywords: "a".repeat(64) } },
      { ...alexaRequest(3), stageContentHashes: { alexa_voc: "a".repeat(64), keywords: "b".repeat(64) } },
    ]) {
      assert.throws(() => writeWebReloadRequestSync(malformed, { spoolDir }), /Invalid Alexa reload binding/);
    }
    assert.doesNotThrow(() => writeWebReloadRequestSync(request, { spoolDir }));
  });
});

test("manual Alexa stage hashes are accepted while unknown stages are rejected", async () => {
  await withSpool(async (spoolDir) => {
    const alexaStageContentHashes = { alexa_voc: "d".repeat(64) };
    const written = await writeWebReloadRequest({
      ...request,
      stageContentHashes: alexaStageContentHashes,
    }, { spoolDir });
    assert.deepEqual(written.payload.stageContentHashes, alexaStageContentHashes);

    await assert.rejects(
      writeWebReloadRequest({
        ...request,
        stageContentHashes: { unknown_stage: "d".repeat(64) },
      }, { spoolDir }),
      /Invalid reload request/,
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
    const malformed = await readWebReloadPublication(reference, { spoolDir });
    assert.equal(malformed.status, "failed");
    assert.equal(malformed.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
  });
});

test("active reload scan returns every valid pending and processing artifact", async () => {
  await withSpool(async (spoolDir) => {
    const processing = await writeWebReloadRequest(request, { spoolDir });
    const pending = await writeWebReloadRequest({ ...request, artifactId: "b".repeat(64) }, { spoolDir });
    await mkdir(path.join(spoolDir, "processing"), { recursive: true });
    await rename(
      processing.path,
      path.join(spoolDir, "processing", `${processing.id}-${"c".repeat(36)}.json`),
    );

    const active = await readActiveWebReloadRequests({ spoolDir });
    assert.deepEqual(active.map(({ artifactId }) => artifactId).sort(), [
      processing.payload.artifactId,
      pending.payload.artifactId,
    ].sort());
  });
});

test("a supervisor content mismatch acknowledgement preserves the fixed publication code", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    const mismatch = new Error("candidate manifest is stale");
    mismatch.code = "WEB_PUBLICATION_CONTENT_MISMATCH";

    assert.equal((await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => { throw mismatch; },
    })).status, "failed");

    const failed = await readWebReloadPublication(publicationReference(written), { spoolDir });
    assert.equal(failed.status, "failed");
    assert.equal(failed.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
  });
});

test("an applied acknowledgement cannot carry a failure marker", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    await writeFile(
      path.join(spoolDir, "applied", `${written.id}.json`),
      JSON.stringify({ ...written.payload, failureCode: "WEB_PUBLICATION_CONTENT_MISMATCH" }),
    );
    await rm(written.path);

    const result = await readWebReloadPublication(publicationReference(written), { spoolDir });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
  });
});

test("a non-v3 terminal acknowledgement has the fixed content mismatch code", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    await writeFile(
      path.join(spoolDir, "applied", `${written.id}.json`),
      JSON.stringify({ ...written.payload, version: 2 }),
    );
    await rm(written.path);

    const result = await readWebReloadPublication(publicationReference(written), { spoolDir });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
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

test("Alexa stream coalesces pending generations and durable high-water prevents rollback", async () => {
  await withSpool(async (spoolDir) => {
    const first = writeWebReloadRequestSync(alexaRequest(1), { spoolDir });
    const recoveredProcessing = path.join(
      spoolDir,
      "processing",
      `${first.id}-00000000-0000-4000-8000-000000000001.json`,
    );
    await rename(first.path, recoveredProcessing);
    const second = writeWebReloadRequestSync(alexaRequest(2), { spoolDir });
    assert.equal((await readPendingWebReloadRequests({ spoolDir })).length, 1);
    assert.equal(JSON.parse(await readFile(second.path, "utf8")).stream.generation, 2);

    const applied = [];
    const options = {
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async (payload, control) => {
        applied.push(payload.stream.generation);
        await control.commitHighWater();
      },
    };
    assert.equal((await consumeWebReloadRequest(options)).status, "applied");
    assert.deepEqual(applied, [2]);
    assert.equal((await consumeWebReloadRequest(options)).status, "superseded");
    assert.deepEqual(applied, [2]);

    writeWebReloadRequestSync(alexaRequest(1, "8".repeat(64)), { spoolDir });
    assert.equal((await consumeWebReloadRequest(options)).status, "superseded");
    assert.deepEqual(applied, [2]);
  });
});

test("a post-commit child exit cannot downgrade the durable current to a failed request", async () => {
  await withSpool(async (spoolDir) => {
    await writeWebReloadRequest(request, { spoolDir });
    let applications = 0;
    const options = {
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async (_payload, control) => {
        applications += 1;
        await control.commitHighWater();
        throw new Error("child exited immediately after durable commit");
      },
    };
    assert.equal((await consumeWebReloadRequest(options)).status, "applied");
    assert.equal((await readdir(path.join(spoolDir, "applied"))).length, 1);
    assert.equal((await readdir(path.join(spoolDir, "failed"))).length, 0);

    await writeWebReloadRequest(request, { spoolDir });
    assert.equal((await consumeWebReloadRequest(options)).status, "duplicate");
    assert.equal(applications, 1);
  });
});

test("an exact high-water generation recovered after bootstrap is archived as applied", async () => {
  await withSpool(async (spoolDir) => {
    const payload = alexaRequest(6, "6".repeat(64));
    await commitWebPublicationControl({
      controlPath: path.join(spoolDir, "current-known-good.json"),
      payload,
      requestId: "f".repeat(64),
      now: () => new Date("2026-08-22T00:00:30.000Z"),
    });
    writeWebReloadRequestSync(payload, { spoolDir });
    let applications = 0;
    const result = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => { applications += 1; },
    });
    assert.equal(result.status, "duplicate");
    assert.equal(applications, 0);
    assert.equal((await readdir(path.join(spoolDir, "applied"))).length, 1);
    assert.equal((await readdir(path.join(spoolDir, "failed"))).length, 0);
  });
});

test("same Alexa generation with a different artifact fails closed after high-water", async () => {
  await withSpool(async (spoolDir) => {
    writeWebReloadRequestSync(alexaRequest(4, "4".repeat(64)), { spoolDir });
    let applications = 0;
    const options = {
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async (_payload, control) => { applications += 1; await control.commitHighWater(); },
    };
    assert.equal((await consumeWebReloadRequest(options)).status, "applied");
    writeWebReloadRequestSync(alexaRequest(4, "5".repeat(64)), { spoolDir });
    assert.equal((await consumeWebReloadRequest(options)).status, "failed");
    assert.equal(applications, 1);
  });
});

test("simultaneous same-generation Alexa conflicts are all quarantined before any apply", async () => {
  await withSpool(async (spoolDir) => {
    writeWebReloadRequestSync(alexaRequest(6, "6".repeat(64)), { spoolDir });
    writeWebReloadRequestSync(alexaRequest(6, "7".repeat(64)), { spoolDir });
    let applications = 0;
    const result = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async () => { applications += 1; },
    });
    assert.equal(result.status, "failed");
    assert.equal(applications, 0);
    assert.equal((await readdir(path.join(spoolDir, "pending"))).length, 0);
    assert.equal((await readdir(path.join(spoolDir, "processing"))).length, 0);
    assert.equal((await readdir(path.join(spoolDir, "failed"))).length, 2);
  });
});

test("an older v3 request is scheduled fairly ahead of a newer Alexa stream head", async () => {
  await withSpool(async (spoolDir) => {
    writeWebReloadRequestSync({
      ...alexaRequest(1), buildCompletedAt: "2026-08-22T00:00:30.000Z",
    }, { spoolDir });
    writeWebReloadRequestSync(request, { spoolDir });
    const applied = [];
    const result = await consumeWebReloadRequest({
      spoolDir,
      expectedTarget: target,
      now: () => new Date("2026-08-22T00:01:00.000Z"),
      apply: async (payload) => { applied.push(payload.jobId); },
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(applied, [request.jobId]);
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
