import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumeWebReloadRequest,
  createWebReloadTarget,
  writeWebReloadRequest,
} from "../../scripts/lib/web-reload-request.mjs";
import { SyncPublicationStatusService } from "../../server/services/sync-publication-status-service";
import { publishWebBuild } from "../../scripts/run-asin-sync-job.mjs";
import type { SyncJobLease, SyncJobRepository } from "../../server/db/sync-job-repository";
import { SyncJobWorkerHandler } from "../../server/services/sync-job-worker-handler";
import { SyncJobService } from "../../server/services/sync-job-service";

const consumeReload = consumeWebReloadRequest as (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
const publish = publishWebBuild as (jobId: string, options: Record<string, unknown>) => Promise<void>;

const artifactId = "a".repeat(64);
const keywordHash = "b".repeat(64);
const categoryHash = "c".repeat(64);
const requestedAt = "2026-08-25T10:00:00.000Z";

async function withPublication(
  run: (fixture: {
    jobId: string;
    requestId: string;
    mirrorDirectory: string;
    spoolDirectory: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-publication-reconciliation-"));
  const mirrorDirectory = path.join(root, "sync-jobs");
  const spoolDirectory = path.join(root, "reload");
  const jobId = "job-reconcile-1";
  const target = createWebReloadTarget({ worktree: root, webHost: "127.0.0.1", webPort: 43123 });
  const stageContentHashes = { keywords: keywordHash, category: categoryHash } as const;
  try {
    await mkdir(mirrorDirectory, { recursive: true });
    const written = await writeWebReloadRequest({
      jobId,
      jobVersion: 9,
      artifactId,
      stageContentHashes,
      buildCompletedAt: requestedAt,
      target,
    }, { spoolDir: spoolDirectory });
    await writeFile(path.join(mirrorDirectory, `${jobId}.json`), JSON.stringify({
      jobId,
      jobVersion: 9,
      outputs: [
        { stage: "keywords", contentHash: keywordHash },
        { stage: "category", contentHash: categoryHash },
      ],
      publication: {
        generation: 1,
        requestId: written.id,
        artifactId,
        jobVersion: 9,
        stageContentHashes,
        requestedAt,
      },
    }));
    await consumeReload({
      spoolDir: spoolDirectory,
      expectedTarget: target,
      now: () => new Date("2026-08-25T10:01:00.000Z"),
      apply: async () => undefined,
    });
    await run({ jobId, requestId: written.id, mirrorDirectory, spoolDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("publication applies only when acknowledgement matches the current persisted version and hashes", async () => {
  await withPublication(async ({ jobId, requestId, mirrorDirectory, spoolDirectory }) => {
    const service = new SyncPublicationStatusService({ mirrorDirectory, spoolDirectory });
    const result = await service.read(jobId, {
      jobVersion: 9,
      stageContentHashes: { keywords: keywordHash, category: categoryHash },
    });

    assert.equal(result.status, "applied");
    assert.equal(result.requestId, requestId);

    const stale = await service.read(jobId, {
      jobVersion: 10,
      stageContentHashes: { keywords: keywordHash, category: categoryHash },
    });
    assert.equal(stale.status, "failed");
    if (stale.status === "failed") assert.equal(stale.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
  });
});

test("publication refuses a missing or mismatched displayed module", async () => {
  await withPublication(async ({ jobId, requestId, mirrorDirectory, spoolDirectory }) => {
    const service = new SyncPublicationStatusService({ mirrorDirectory, spoolDirectory });
    const result = await service.read(jobId, {
      jobVersion: 9,
      stageContentHashes: { keywords: keywordHash },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.requestId, requestId);
    assert.equal(result.artifactId, artifactId);
    assert.equal(result.requestedAt, requestedAt);
    assert.match(result.failedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
  });
});

test("publication current view is read from the authenticated canonical job scope", async () => {
  const organizationId = "99000000-0000-4000-8000-000000000099";
  const projectId = "88000000-0000-4000-8000-000000000088";
  const runId = "77000000-0000-4000-8000-000000000077";
  const job = {
    jobId: "job-current-view", organizationId, projectId, runId, actorId: null,
    fingerprint: "current-view", asins: ["B0TEST0001"], marketplace: "US" as const,
    status: "completed" as const, message: "Completed", currentStageId: "build",
    stages: [
      { id: "keywords", label: "Keywords", kind: "auto" as const, status: "done", estimatedSeconds: 1 },
      { id: "category", label: "Category", kind: "auto" as const, status: "done", estimatedSeconds: 1 },
    ],
    asinProgress: {}, leasedBy: null, leaseGeneration: 1, jobVersion: 14,
    leaseExpiresAt: null, error: null, createdAt: requestedAt, updatedAt: requestedAt,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0001"] },
  };
  const outputs = new Map([
    ["keywords", { jobId: job.jobId, projectId, runId, stage: "keywords", stageStatus: "done", jobVersion: 10, outputVersion: 1, contentHash: keywordHash, updatedAt: requestedAt, data: { analysisByAsin: {}, enrichmentByKeyword: {} } }],
    ["category", { jobId: job.jobId, projectId, runId, stage: "category", stageStatus: "done", jobVersion: 14, outputVersion: 1, contentHash: categoryHash, updatedAt: requestedAt, data: { trendByNode: {} } }],
  ]);
  const repository = {
    async findById(jobId: string) { return jobId === job.jobId ? job : null; },
    async readStageOutput(input: { stage: string }) { return outputs.get(input.stage) ?? null; },
  } as unknown as SyncJobRepository;
  const service = new SyncJobService(repository, { bypassProviderReadiness: true });

  assert.deepEqual(await service.readPublicationView(job.jobId, organizationId), {
    jobVersion: 14,
    stageContentHashes: { category: categoryHash, keywords: keywordHash },
  });
  assert.equal(await service.readPublicationView(job.jobId, "99000000-0000-4000-8000-000000000098"), null);
});

test("the final build is refused before execution when a persisted ready projection is stale", async () => {
  let builds = 0;
  let manifests = 0;
  const job = {
    jobId: "job-reconcile-1",
    jobVersion: 9,
    asins: ["B0TEST0001"],
    stages: [{ id: "keywords", status: "done" }],
    outputs: [{ stage: "keywords", stageStatus: "done", contentHash: keywordHash }],
    persistedStageContentHashes: { keywords: keywordHash },
  };

  await assert.rejects(
    () => publish(job.jobId, {
      readJob: () => job,
      projectOutput: () => ({ contentHash: categoryHash }),
      createArtifactId: () => artifactId,
      build: () => { builds += 1; },
      writeManifest: async () => { manifests += 1; },
    }),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "WEB_PUBLICATION_CONTENT_MISMATCH",
  );

  assert.equal(builds, 0);
  assert.equal(manifests, 0);
});

test("the final build is refused when worker persistence has not acknowledged the projection set", async () => {
  let builds = 0;
  const job = {
    jobId: "job-unacknowledged",
    jobVersion: 9,
    asins: ["B0TEST0001"],
    stages: [{ id: "keywords", status: "done" }],
    outputs: [{ stage: "keywords", stageStatus: "done", contentHash: keywordHash, updatedAt: requestedAt }],
  };

  await assert.rejects(() => publish(job.jobId, {
    readJob: () => job,
    projectOutput: () => ({ contentHash: keywordHash }),
    build: () => { builds += 1; },
  }), (error: unknown) => error instanceof Error &&
    (error as Error & { code?: string }).code === "WEB_PUBLICATION_CONTENT_MISMATCH");
  assert.equal(builds, 0);
});

test("the exact persisted identity is bound to both the final manifest and reload request", async () => {
  const job = {
    jobId: "job-reconcile-1",
    jobVersion: 9,
    asins: ["B0TEST0001"],
    stages: [{ id: "keywords", status: "done" }],
    outputs: [{ stage: "keywords", stageStatus: "done", contentHash: keywordHash, updatedAt: requestedAt }],
    persistedStageContentHashes: { keywords: keywordHash },
    publication: { generation: 2 },
  };
  const writes: Record<string, unknown>[] = [];
  await publish(job.jobId, {
    worktree: "isolated-worktree",
    spoolDir: "isolated-spool",
    readJob: () => job,
    projectOutput: () => ({ contentHash: keywordHash }),
    createArtifactId: () => artifactId,
    build: () => undefined,
    writeManifest: async (input: Record<string, unknown>) => { writes.push({ kind: "manifest", ...input }); },
    completeBuildStage: () => undefined,
    now: () => requestedAt,
    configuredTarget: () => ({ worktreeId: "d".repeat(64), webHost: "127.0.0.1", webPort: 43123 }),
    writeReloadRequest: async (input: Record<string, unknown>) => {
      writes.push({ kind: "reload", ...input });
      return { id: "e".repeat(64) };
    },
    patchJob: () => undefined,
  });

  for (const write of writes) {
    assert.equal(write.jobId, job.jobId);
    assert.equal(write.jobVersion, job.jobVersion);
    assert.deepEqual(write.stageContentHashes, { keywords: keywordHash });
  }
});

async function mirrorsFor(
  job: SyncJobLease["job"],
  progressJob: SyncJobLease["job"] = job,
  runnerPatch?: Record<string, unknown>,
  persistedOutputs: Readonly<Record<string, Record<string, unknown>>> = {},
): Promise<{ initial: Record<string, unknown>; final: Record<string, unknown> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-publication-worker-"));
  const repository = {
    async heartbeat() { return job; },
    async recordProgress() { return progressJob; },
    async readStageOutput(input: { stage: string }) { return persistedOutputs[input.stage] ?? null; },
    async complete() { return job; },
    async fail() { return job; },
  } as unknown as SyncJobRepository;
  const lease: SyncJobLease = { job, leaseGeneration: 1 };
  let initial: Record<string, unknown> | null = null;
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory: directory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      initial = JSON.parse(await readFile(context.mirrorPath, "utf8")) as Record<string, unknown>;
      if (runnerPatch) await context.writeMirror(runnerPatch);
      return { status: "completed" };
    },
  });
  try {
    await handler.handle(lease);
    assert.ok(initial);
    const final = JSON.parse(await readFile(path.join(directory, `${job.jobId}.json`), "utf8")) as Record<string, unknown>;
    return { initial, final };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a resumed scoped worker seeds the runner mirror with the current persisted projection set", async () => {
  const organizationId = "99000000-0000-4000-8000-000000000099";
  const projectId = "88000000-0000-4000-8000-000000000088";
  const runId = "77000000-0000-4000-8000-000000000077";
  const job = {
    jobId: "job-resumed-version", organizationId, projectId, runId, actorId: null,
    fingerprint: "resumed-version", asins: ["B0TEST0001"], marketplace: "US" as const,
    status: "running" as const, message: "Running", currentStageId: "build",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto" as const, status: "done", estimatedSeconds: 1 }],
    asinProgress: {}, leasedBy: "worker-version", leaseGeneration: 1, jobVersion: 13,
    leaseExpiresAt: null, error: null, createdAt: requestedAt, updatedAt: requestedAt,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0001"] },
  };
  const output = {
    jobId: job.jobId, projectId, runId, stage: "keywords", stageStatus: "done",
    jobVersion: 13, outputVersion: 2, contentHash: keywordHash, updatedAt: requestedAt,
    data: { analysisByAsin: {}, enrichmentByKeyword: {} },
  };
  const mirrors = await mirrorsFor(job, job, undefined, { keywords: output });

  assert.deepEqual(mirrors.initial.persistedStageContentHashes, { keywords: keywordHash });
  assert.deepEqual(mirrors.initial.outputs, [{
    organizationId, projectId, runId, stage: "keywords", stageStatus: "done",
    contentHash: keywordHash, updatedAt: requestedAt,
    data: output.data,
  }]);
});

test("a canonical scoped worker writes the exact leased jobVersion into the initial runner mirror", async () => {
  const organizationId = "99000000-0000-4000-8000-000000000099";
  const projectId = "88000000-0000-4000-8000-000000000088";
  const runId = "77000000-0000-4000-8000-000000000077";
  const job = {
    jobId: "job-canonical-version",
    organizationId,
    projectId,
    runId,
    actorId: null,
    fingerprint: "canonical-version",
    asins: ["B0TEST0001"],
    marketplace: "US" as const,
    status: "running" as const,
    message: "Running",
    currentStageId: "keywords",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto" as const, status: "active", estimatedSeconds: 1 }],
    asinProgress: {},
    leasedBy: "worker-version",
    leaseGeneration: 1,
    jobVersion: 13,
    leaseExpiresAt: null,
    error: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0001"] },
  };
  const progressJob = { ...job, jobVersion: 14 };
  const mirrors = await mirrorsFor(job, progressJob, {
    currentStageId: "keywords",
    stages: [{ ...job.stages[0], status: "done", completedAt: requestedAt }],
    outputs: [{
      organizationId, projectId, runId, stage: "keywords", stageStatus: "done",
      contentHash: keywordHash, updatedAt: requestedAt,
      data: { analysisByAsin: {}, enrichmentByKeyword: {} },
    }],
  });
  assert.equal(mirrors.initial.jobVersion, 13);
  assert.equal(mirrors.final.jobVersion, 14);
  assert.deepEqual(mirrors.final.persistedStageContentHashes, { keywords: keywordHash });
});

test("a stale progress acknowledgement cannot move the scoped mirror jobVersion backwards", async () => {
  const organizationId = "99000000-0000-4000-8000-000000000099";
  const projectId = "88000000-0000-4000-8000-000000000088";
  const runId = "77000000-0000-4000-8000-000000000077";
  const job = {
    jobId: "job-stale-version", organizationId, projectId, runId, actorId: null,
    fingerprint: "stale-version", asins: ["B0TEST0001"], marketplace: "US" as const,
    status: "running" as const, message: "Running", currentStageId: "keywords",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto" as const, status: "active", estimatedSeconds: 1 }],
    asinProgress: {}, leasedBy: "worker-version", leaseGeneration: 1, jobVersion: 13,
    leaseExpiresAt: null, error: null, createdAt: requestedAt, updatedAt: requestedAt,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0001"] },
  };
  const mirrors = await mirrorsFor(job, { ...job, jobVersion: 12 });
  assert.equal(mirrors.final.jobVersion, 13);
});

test("an unscoped worker mirror does not invent a publication jobVersion", async () => {
  const job = {
    jobId: "job-unscoped-version",
    organizationId: "99000000-0000-4000-8000-000000000099",
    projectId: null,
    runId: null,
    actorId: null,
    fingerprint: "unscoped-version",
    asins: ["B0TEST0001"],
    marketplace: "US" as const,
    status: "running" as const,
    message: "Running",
    currentStageId: "catalog",
    stages: [{ id: "catalog", label: "Catalog", kind: "auto" as const, status: "active", estimatedSeconds: 1 }],
    asinProgress: {},
    leasedBy: "worker-version",
    leaseGeneration: 1,
    jobVersion: 13,
    leaseExpiresAt: null,
    error: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    scope: {
      organizationId: "99000000-0000-4000-8000-000000000099",
      projectId: null,
      runId: null,
      marketplace: "US" as const,
      asins: ["B0TEST0001"],
    },
  };

  const mirrors = await mirrorsFor(job, { ...job, jobVersion: 14 });
  assert.equal("jobVersion" in mirrors.initial, false);
  assert.equal("jobVersion" in mirrors.final, false);
});
