import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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
import { mutateSyncJobMirror } from "../../scripts/lib/sync-job-store.mjs";
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
  let artifacts = 0;
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
    persistenceAttempts: 2,
    waitForPersistence: async () => undefined,
    createArtifactId: () => { artifacts += 1; return artifactId; },
    build: () => { builds += 1; },
  }), (error: unknown) => error instanceof Error &&
    (error as Error & { code?: string }).code === "WEB_PUBLICATION_CONTENT_MISMATCH");
  assert.equal(builds, 0);
  assert.equal(artifacts, 0);
});

test("the final build waits for the exact delayed persistence acknowledgement", async () => {
  const events: string[] = [];
  let polls = 0;
  const baseJob = {
    jobId: "job-delayed-ack", jobVersion: 13, asins: ["B0TEST0001"],
    stages: [{ id: "keywords", status: "done" }],
    outputs: [{ stage: "keywords", stageStatus: "done", contentHash: keywordHash, updatedAt: requestedAt }],
  };
  await publish(baseJob.jobId, {
    readJob: () => {
      polls += 1;
      events.push(`read:${polls}`);
      return polls < 3 ? baseJob : {
        ...baseJob,
        jobVersion: 14,
        persistedStageContentHashes: { keywords: keywordHash },
      };
    },
    projectOutput: () => ({ contentHash: keywordHash }),
    waitForPersistence: async () => { events.push("wait"); },
    persistenceAttempts: 3,
    createArtifactId: () => { events.push("artifact"); return artifactId; },
    publishArtifact: async (input: { build: () => void }) => {
      events.push("snapshot:start");
      input.build();
      events.push("snapshot:complete");
    },
    build: () => { events.push("build"); },
    completeBuildStage: () => undefined,
    configuredTarget: () => ({ worktreeId: "d".repeat(64), webHost: "127.0.0.1", webPort: 43123 }),
    writeReloadRequest: async () => ({ id: "e".repeat(64) }),
    patchJob: () => undefined,
  });

  assert.deepEqual(events, [
    "read:1", "wait", "read:2", "wait", "read:3", "artifact",
    "snapshot:start", "build", "snapshot:complete",
    "read:4",
  ]);
});

test("lock-safe mirror mutations preserve final projection, publication, and highest acknowledged version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-publication-mutation-"));
  const mirrorPath = path.join(directory, "job-lock.json");
  let releaseOld!: () => void;
  const oldHeld = new Promise<void>((resolve) => { releaseOld = resolve; });
  let enteredOld!: () => void;
  const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
  try {
    await writeFile(mirrorPath, JSON.stringify({ jobId: "job-lock", jobVersion: 13 }));
    const oldPoll = mutateSyncJobMirror(mirrorPath, async (latest: Record<string, unknown>) => {
      enteredOld();
      await oldHeld;
      return { ...latest, jobVersion: 13, persistedStageContentHashes: { keywords: "a".repeat(64) } };
    });
    await oldEntered;
    const runner = mutateSyncJobMirror(mirrorPath, (latest: Record<string, unknown>) => ({
      ...latest,
      outputs: [{ stage: "keywords", contentHash: keywordHash }],
      publication: { artifactId },
    }));
    const newPoll = mutateSyncJobMirror(mirrorPath, (latest: Record<string, unknown>) => ({
      ...latest,
      jobVersion: Math.max(Number(latest.jobVersion ?? 0), 14),
      persistedStageContentHashes: { keywords: keywordHash },
    }));
    releaseOld();
    await Promise.all([oldPoll, runner, newPoll]);

    const final = JSON.parse(await readFile(mirrorPath, "utf8"));
    assert.equal(final.jobVersion, 14);
    assert.deepEqual(final.outputs, [{ stage: "keywords", contentHash: keywordHash }]);
    assert.deepEqual(final.publication, { artifactId });
    assert.deepEqual(final.persistedStageContentHashes, { keywords: keywordHash });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live mirror lock is never stolen and two reapers serialize after its owner crashes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-publication-lock-owner-"));
  const mirrorPath = path.join(directory, "job-owner.json");
  await writeFile(mirrorPath, JSON.stringify({ jobId: "job-owner", jobVersion: 13 }));
  const fixture = path.resolve("tests/fixtures/hold-interprocess-lock.mjs");
  const child = spawn(process.execPath, [fixture, `${mirrorPath}.lock`], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`lock owner did not start; pid=${child.pid}; exit=${child.exitCode}: ${stderr}`)), 5_000);
      child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`lock owner exited ${code}: ${stderr}`)); });
    });
    await assert.rejects(
      mutateSyncJobMirror(mirrorPath, (current: Record<string, unknown>) => ({ ...current, jobVersion: 14 }), {
        attempts: 3, retryMs: 1,
      }),
      /Timed out acquiring interprocess lock/,
    );
    assert.equal(child.exitCode, null);

    const crashed = once(child, "exit");
    child.kill("SIGKILL");
    await crashed;
    let active = 0;
    let maximumActive = 0;
    const reaper = (field: string) => mutateSyncJobMirror(mirrorPath, async (current: Record<string, unknown>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ...current, jobVersion: 14, [field]: true };
    });
    await Promise.all([reaper("firstReaper"), reaper("secondReaper")]);
    const recovered = JSON.parse(await readFile(mirrorPath, "utf8"));
    assert.equal(recovered.jobVersion, 14);
    assert.equal(recovered.firstReaper, true);
    assert.equal(recovered.secondReaper, true);
    assert.equal(maximumActive, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
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
  let builds = 0;
  await publish(job.jobId, {
    worktree: "isolated-worktree",
    spoolDir: "isolated-spool",
    readJob: () => job,
    projectOutput: () => ({ contentHash: keywordHash }),
    createArtifactId: () => artifactId,
    build: () => { builds += 1; },
    writeManifest: async (input: Record<string, unknown>) => { writes.push({ kind: "manifest", ...input }); },
    publishArtifact: async (input: Record<string, unknown>) => {
      (input.build as () => void)();
      await (input.writeManifest as (value: Record<string, unknown>) => Promise<void>)(input);
    },
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
  assert.equal(builds, 1);
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

test("a resumed same-hash gap waits for this worker acknowledgement before the final build", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-publication-resume-barrier-"));
  const organizationId = "99000000-0000-4000-8000-000000000099";
  const projectId = "88000000-0000-4000-8000-000000000088";
  const runId = "77000000-0000-4000-8000-000000000077";
  const job = {
    jobId: "job-resumed-same-hash", organizationId, projectId, runId, actorId: null,
    fingerprint: "resumed-same-hash", asins: ["B0TEST0001"], marketplace: "US" as const,
    status: "running" as const, message: "Resumed", currentStageId: "keywords",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto" as const, status: "pending", estimatedSeconds: 1 }],
    asinProgress: {}, leasedBy: "worker-resume", leaseGeneration: 2, jobVersion: 13,
    leaseExpiresAt: null, error: null, createdAt: requestedAt, updatedAt: requestedAt,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0001"] },
  };
  const gap = { state: "failed", reasonCode: "CONNECTOR_FAILED" } as const;
  const output = {
    organizationId, projectId, runId, stage: "keywords", stageStatus: "failed",
    contentHash: keywordHash, updatedAt: requestedAt, gap,
  };
  const mirrorPath = path.join(directory, `${job.jobId}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(mirrorPath, JSON.stringify({
    ...job,
    stages: [{ ...job.stages[0], status: "failed" }],
    outputs: [output],
    persistedStageContentHashes: { keywords: keywordHash },
    publication: { artifactId, generation: 1 },
    needsReload: true,
  }));

  let initialMirror: Record<string, unknown> | null = null;
  let builds = 0;
  let artifacts = 0;
  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
  let announceAck!: () => void;
  const ackStarted = new Promise<void>((resolve) => { announceAck = resolve; });
  let announced = false;
  const repository = {
    async heartbeat() { return job; },
    async readStageOutput() { return null; },
    async recordProgress(input: { outputs?: readonly unknown[] }) {
      if (input.outputs?.length && !announced) {
        announced = true;
        announceAck();
        await ackGate;
      }
      return { ...job, jobVersion: input.outputs?.length ? 14 : 13 };
    },
    async complete() { return job; },
    async fail() { return job; },
  } as unknown as SyncJobRepository;
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory: directory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 5,
    runner: async (_lease, context) => {
      initialMirror = JSON.parse(await readFile(context.mirrorPath, "utf8")) as Record<string, unknown>;
      await context.writeMirror({
        currentStageId: "keywords",
        stages: [{ ...job.stages[0], status: "failed" }],
        outputs: [output],
      });
      await publish(job.jobId, {
        readJob: () => JSON.parse(readFileSync(context.mirrorPath, "utf8")),
        projectOutput: () => ({ contentHash: keywordHash }),
        persistenceAttempts: 2_000,
        waitForPersistence: () => new Promise((resolve) => setTimeout(resolve, 1)),
        createArtifactId: () => { artifacts += 1; return artifactId; },
        publishArtifact: async (input: { build: () => void }) => { input.build(); },
        build: () => { builds += 1; },
        completeBuildStage: () => undefined,
        configuredTarget: () => ({ worktreeId: "d".repeat(64), webHost: "127.0.0.1", webPort: 43123 }),
        writeReloadRequest: async () => ({ id: "e".repeat(64) }),
        patchJob: () => undefined,
      });
      return { status: "completed" };
    },
  });

  const handling = handler.handle({ job, leaseGeneration: 2 });
  try {
    await ackStarted;
    assert.equal(builds, 0);
    assert.equal(artifacts, 0);
  } finally {
    releaseAck();
  }
  await handling;
  assert.ok(initialMirror);
  const capturedInitial = initialMirror as unknown as Record<string, unknown>;
  assert.deepEqual(capturedInitial.outputs, []);
  assert.deepEqual(capturedInitial.persistedStageContentHashes, {});
  assert.equal("publication" in capturedInitial, false);
  assert.equal("needsReload" in capturedInitial, false);
  assert.equal(builds, 1);
  assert.equal(artifacts, 1);
  await rm(directory, { recursive: true, force: true });
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

test("worker progress intervals serialize recordProgress acknowledgements", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sync-publication-interval-"));
  const organizationId = "99000000-0000-4000-8000-000000000099";
  const projectId = "88000000-0000-4000-8000-000000000088";
  const runId = "77000000-0000-4000-8000-000000000077";
  const job = {
    jobId: "job-serialized-poll", organizationId, projectId, runId, actorId: null,
    fingerprint: "serialized-poll", asins: ["B0TEST0001"], marketplace: "US" as const,
    status: "running" as const, message: "Running", currentStageId: "keywords",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto" as const, status: "active", estimatedSeconds: 1 }],
    asinProgress: {}, leasedBy: "worker-version", leaseGeneration: 1, jobVersion: 13,
    leaseExpiresAt: null, error: null, createdAt: requestedAt, updatedAt: requestedAt,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0001"] },
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const repository = {
    async heartbeat() { return job; },
    async recordProgress() {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        firstStarted();
        await held;
      }
      active -= 1;
      return { ...job, jobVersion: 14 };
    },
    async readStageOutput() { return null; },
    async complete() { return job; },
    async fail() { return job; },
  } as unknown as SyncJobRepository;
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory: directory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 1,
    runner: async () => {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(maximumActive, 1);
      release();
      return { status: "completed" };
    },
  });
  try {
    await handler.handle({ job, leaseGeneration: 1 });
    assert.ok(calls >= 2);
    assert.equal(maximumActive, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
