import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { createAgentService } from "../../server/agent-service";
import { CONSERVATIVE_CONCURRENCY_PROFILE } from "../../server/concurrency/concurrency-policy";
import type {
  ConcurrencyControlRepository,
} from "../../server/db/concurrency-control-repository";
import { UnavailableConcurrencyControlRepository } from "../../server/db/concurrency-control-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { SyncJobLease, SyncJobRepository } from "../../server/db/sync-job-repository";
import { SyncJobDispatcher } from "../../server/runtime/sync-job-dispatcher";
import { SyncJobWorkerHandler } from "../../server/services/sync-job-worker-handler";
import {
  SifTrafficSnapshotTaskError,
  type SifTrafficShapeDiagnostic,
} from "../../server/services/sif-traffic-snapshot-task";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-22T01:00:00.000Z";
const origin = "http://127.0.0.1:31900";
const proxyToken = "sync-dispatcher-proxy-token";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("six dispatcher loops never exceed four active jobs and create mirrors only after lease claim", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "sync-dispatcher-mirrors-"));
  const releases: Array<() => void> = [];
  const launched: SyncJobLease[] = [];
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    runner: async (lease) => {
      const running = await store.findById(lease.job.jobId);
      assert.equal(running?.status, "running");
      assert.equal(running?.leasedBy, lease.job.leasedBy);
      launched.push(lease);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: "completed", message: `completed ${lease.job.jobId}` };
    },
  });
  const dispatcher = new SyncJobDispatcher({
    syncJobs: store,
    handler,
    workerIdPrefix: "six-loop",
    loopCount: 6,
    leaseMs: 30_000,
    wholeJobLimit: 4,
    idleDelayMs: 10,
  });

  try {
    for (let index = 0; index < 6; index += 1) {
      await store.admit(syncJobInput({
        actorId: `99000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        fingerprint: `six-loop-${index}`,
        asins: [`B0TASK3${String(index).padStart(3, "0")}`],
        createdAt: `2026-08-22T01:00:0${index}.000Z`,
      }));
    }

    dispatcher.start();
    await waitFor(() => launched.length === 4);

    assert.equal(await activeRunningCount(pool), 4);
    assert.equal(launched.length, 4);
    for (const lease of launched) {
      const mirror = JSON.parse(
        await readFile(join(mirrorDir, `${lease.job.jobId}.json`), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(mirror.jobId, lease.job.jobId);
      assert.equal("leasedBy" in mirror, false);
      assert.equal("leaseGeneration" in mirror, false);
    }
  } finally {
    for (const release of releases) release();
    await dispatcher.stop();
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("restart recovery fences expired workers, launches one reclaimed runner, and treats lease generation only as fencing", async () => {
  const { store, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "sync-recovery-mirrors-"));
  const oldRelease = deferred<void>();
  const launched: Array<{ workerId: string; generation: number }> = [];
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    maxAttempts: 2,
    runner: async (lease, context) => {
      launched.push({
        workerId: context.workerId,
        generation: lease.leaseGeneration,
      });
      if (context.workerId === "old-worker") {
        await context.writeMirror({
          status: "running",
          message: "old worker active",
          currentStageId: "catalog",
          stages: lease.job.stages.map((stage) =>
            stage.id === "catalog" ? { ...stage, status: "active" } : stage,
          ),
        });
        await oldRelease.promise;
        return { status: "completed", message: "stale worker completed" };
      }
      await context.writeMirror({
        status: "completed",
        message: "replacement completed",
        currentStageId: "catalog",
        stages: lease.job.stages.map((stage) =>
          stage.id === "catalog" ? { ...stage, status: "active" } : stage,
        ),
      });
      return { status: "completed", message: "replacement completed" };
    },
  });

  try {
    const admitted = await store.admit(syncJobInput({
      fingerprint: "restart-reclaim",
      asins: ["B0TASK3100"],
    }));
    const oldLease = await store.claimNext({
      workerId: "old-worker",
      leaseMs: 5,
      wholeJobLimit: 4,
      claimedAt: NOW,
    });
    assert.equal(oldLease?.job.jobId, admitted.job.jobId);
    const oldRun = handler.handle(oldLease!);
    await waitFor(() => launched.some((entry) => entry.workerId === "old-worker"));

    const replacementLease = await store.claimNext({
      workerId: "replacement-worker",
      leaseMs: 30_000,
      wholeJobLimit: 4,
      claimedAt: "2026-08-22T01:00:01.000Z",
    });
    assert.equal(replacementLease?.job.jobId, admitted.job.jobId);
    assert.equal(replacementLease?.leaseGeneration, oldLease!.leaseGeneration + 1);
    await handler.handle(replacementLease!);
    oldRelease.resolve();
    await oldRun;

    const completed = await store.findById(admitted.job.jobId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.message, "replacement completed");
    assert.equal(
      completed?.stages.some((stage) => stage.status === "active" || stage.status === "running"),
      false,
    );
    assert.deepEqual(
      launched.filter((entry) => entry.workerId === "replacement-worker"),
      [{ workerId: "replacement-worker", generation: replacementLease!.leaseGeneration }],
    );

    const exhausted = await store.admit(syncJobInput({
      fingerprint: "exhausted-reclaim",
      asins: ["B0TASK3101"],
      createdAt: "2026-08-22T01:00:02.000Z",
    }));
    const attemptOne = await store.claimNext({
      workerId: "attempt-one",
      leaseMs: 5,
      wholeJobLimit: 4,
      claimedAt: "2026-08-22T01:00:02.000Z",
    });
    assert.equal(attemptOne?.job.jobId, exhausted.job.jobId);
    const attemptTwo = await store.claimNext({
      workerId: "attempt-two",
      leaseMs: 5,
      wholeJobLimit: 4,
      claimedAt: "2026-08-22T01:00:03.000Z",
    });
    assert.equal(attemptTwo?.leaseGeneration, 2);
    const attemptThree = await store.claimNext({
      workerId: "attempt-three",
      leaseMs: 30_000,
      wholeJobLimit: 4,
      claimedAt: "2026-08-22T01:00:04.000Z",
    });
    assert.equal(attemptThree?.leaseGeneration, 3);
    await handler.handle(attemptThree!);
    assert.deepEqual(launched.at(-1), {
      workerId: "attempt-three",
      generation: 3,
    });
    assert.equal((await store.findById(exhausted.job.jobId))?.status, "completed");
  } finally {
    oldRelease.resolve();
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("terminal mirror reconciliation persists every stage even when the runner finishes between polls", async () => {
  const { store, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "sync-terminal-mirror-"));
  const stages = [
    {
      id: "queue",
      label: "Queued",
      kind: "auto" as const,
      status: "active",
      estimatedSeconds: 1,
    },
    {
      id: "catalog",
      label: "Catalog",
      kind: "auto" as const,
      status: "pending",
      estimatedSeconds: 30,
    },
    {
      id: "build",
      label: "Build",
      kind: "auto" as const,
      status: "pending",
      estimatedSeconds: 30,
    },
  ];
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      await context.writeMirror({
        status: "completed",
        message: "mirror complete",
        currentStageId: "build",
        stages: [
          { ...stages[0], status: "done", completedAt: "2026-08-22T01:01:00.000Z" },
          { ...stages[1], status: "skipped", completedAt: "2026-08-22T01:01:01.000Z" },
          { ...stages[2], status: "done", completedAt: "2026-08-22T01:01:02.000Z" },
        ],
      });
      return { status: "completed", message: "mirror complete" };
    },
  });

  try {
    const admitted = await store.admit(syncJobInput({
      fingerprint: "full-stage-terminal-mirror",
      asins: ["B0TASK3200"],
      stages,
    }));
    const lease = await store.claimNext({
      workerId: "full-stage-worker",
      leaseMs: 30_000,
      wholeJobLimit: 4,
      claimedAt: NOW,
    });

    await handler.handle(lease!);

    const completed = await store.findById(admitted.job.jobId);
    assert.deepEqual(
      completed?.stages.map((stage) => [stage.id, stage.status, stage.completedAt]),
      [
        ["queue", "done", "2026-08-22T01:01:00.000Z"],
        ["catalog", "skipped", "2026-08-22T01:01:01.000Z"],
        ["build", "done", "2026-08-22T01:01:02.000Z"],
      ],
    );
    assert.equal(
      completed?.stages.some((stage) =>
        ["active", "running", "pending"].includes(stage.status)
      ),
      false,
    );
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("canonical dispatcher snapshots traffic before the detached sync runner and closes its run", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "canonical-sync-run-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const events: string[] = [];
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Canonical owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Canonical', 'US', '["B0TASK3300"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `canonical:${projectId}:B0TASK3300`,
    asins: ["B0TASK3300"],
    canonicalRun: { runId, stageId: randomUUID(), dataCutoffAt: NOW },
  }));
  for (let generation = 1; generation < 4; generation += 1) {
    const expired = await store.claimNext({
      workerId: `expired-canonical-worker-${generation}`,
      leaseMs: 5,
      wholeJobLimit: 4,
      claimedAt: new Date(Date.parse(NOW) + generation * 1_000).toISOString(),
    });
    assert.equal(expired?.leaseGeneration, generation);
  }
  const lease = await store.claimNext({
    workerId: "canonical-dispatcher-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: new Date(Date.parse(NOW) + 4_000).toISOString(),
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  assert.equal(lease?.leaseGeneration, 4);
  assert.deepEqual((await pool.query(
    "SELECT attempt_count FROM run_stages WHERE run_id = $1",
    [runId],
  )).rows, [{ attempt_count: 0 }]);
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString();
    })(),
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun(scope) {
        events.push("traffic-snapshot");
        assert.deepEqual(scope, {
          actorId,
          organizationId,
          projectId,
          runId,
          marketplace: "US",
          asins: ["B0TASK3300"],
        });
      },
    },
    runner: async () => {
      events.push("detached-runner");
      return { status: "completed", message: "completed" };
    },
  });

  try {
    await handler.handle(lease!);
    assert.deepEqual(events, ["traffic-snapshot", "detached-runner"]);
    assert.equal((await pool.query<{ status: string }>(
      "SELECT status FROM analysis_runs WHERE id = $1",
      [runId],
    )).rows[0]?.status, "succeeded");
    assert.deepEqual((await pool.query(
      "SELECT stage, status, attempt_count FROM run_stages WHERE run_id = $1",
      [runId],
    )).rows, [{ stage: "traffic-analysis", status: "succeeded", attempt_count: 1 }]);
    const completed = await store.findById(admitted.job.jobId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.dynamicSnapshot, "ready");
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("canonical traffic uses its persisted attempt count and closes the owned lifecycle at the real limit", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "canonical-sync-attempt-limit-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const events: string[] = [];
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Attempt owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Attempt limit', 'US', '["B0TASK3301"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `canonical-attempt-limit:${projectId}`,
    asins: ["B0TASK3301"],
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
  }));
  await pool.query(
    "UPDATE run_stages SET attempt_count = 2 WHERE id = $1",
    [stageId],
  );
  const lease = await store.claimNext({
    workerId: "canonical-attempt-limit-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    maxAttempts: 2,
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun() {
        events.push("traffic-snapshot");
      },
    },
    runner: async () => {
      events.push("detached-runner");
      return { status: "completed" };
    },
  });

  try {
    await handler.handle(lease!);
    assert.deepEqual(events, []);
    assert.deepEqual((await pool.query(
      "SELECT status, attempt_count, last_error_json FROM run_stages WHERE id = $1",
      [stageId],
    )).rows, [{
      status: "failed",
      attempt_count: 2,
      last_error_json: {
        diagnosticsVersion: "1",
        code: "SYNC_JOB_ATTEMPTS_EXHAUSTED",
      },
    }]);
    assert.deepEqual((await pool.query(
      "SELECT status FROM analysis_runs WHERE id = $1",
      [runId],
    )).rows, [{ status: "failed" }]);
    assert.deepEqual((await pool.query(
      "SELECT status, error ->> 'code' AS code FROM sync_jobs WHERE job_id = $1",
      [admitted.job.jobId],
    )).rows, [{ status: "failed", code: "SYNC_JOB_ATTEMPTS_EXHAUSTED" }]);
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("resumed canonical dispatcher closes the original traffic run and stage", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "resumed-canonical-sync-run-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES
       ($1, $3, $4, 'Canonical owner', 'member', 'active', $6, $6),
       ($2, $3, $5, 'Resume admin', 'admin', 'active', $6, $6)`,
    [
      actorId,
      adminId,
      organizationId,
      `${actorId}@example.test`,
      `${adminId}@example.test`,
      NOW,
    ],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Resumed canonical', 'US', '["B0TASK3340"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    jobId,
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `resumed-canonical:${projectId}:B0TASK3340`,
    asins: ["B0TASK3340"],
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
    stages: [
      { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 0 },
      { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "traffic", label: "Traffic", kind: "auto", status: "partial", estimatedSeconds: 1 },
    ],
    currentStageId: "traffic",
  }));
  const firstLease = await store.claimNext({
    workerId: "resumed-canonical-first",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(firstLease?.job.jobId, admitted.job.jobId);
  const firstHandler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun() {
        throw new Error("synthetic snapshot outage");
      },
    },
    runner: async () => ({ status: "completed-with-gaps", message: "traffic missing" }),
  });

  try {
    await firstHandler.handle(firstLease!);
    assert.deepEqual((await pool.query(
      "SELECT status FROM analysis_runs WHERE id = $1",
      [runId],
    )).rows, [{ status: "failed" }]);
    const resumed = await store.resume({
      jobId,
      organizationId,
      actorId: adminId,
      resumedAt: "2026-08-22T01:00:10.000Z",
    });
    assert.equal(resumed?.disposition, "resumed");
    assert.equal(resumed?.job.jobId, jobId);
    assert.equal(resumed?.job.runId, runId);
    assert.equal(resumed?.job.actorId, actorId);
    const resumedLease = await store.claimNext({
      workerId: "resumed-canonical-second",
      leaseMs: 30_000,
      wholeJobLimit: 4,
      claimedAt: "2026-08-22T01:00:11.000Z",
    });
    assert.equal(resumedLease?.job.jobId, jobId);
    let snapshots = 0;
    const resumedHandler = new SyncJobWorkerHandler({
      syncJobs: store,
      mirrorDirectory: mirrorDir,
      heartbeatIntervalMs: 60_000,
      progressPollMs: 60_000,
      dynamicTrafficSnapshotAdapter: {
        async createForAuthorizedRun(scope) {
          snapshots += 1;
          assert.equal(scope.runId, runId);
        },
      },
      runner: async () => ({ status: "completed", message: "traffic restored" }),
    });
    await resumedHandler.handle(resumedLease!);

    assert.equal(snapshots, 1);
    assert.equal((await store.findById(jobId))?.status, "completed");
    assert.deepEqual((await pool.query(
      "SELECT id, status FROM analysis_runs WHERE project_id = $1",
      [projectId],
    )).rows, [{ id: runId, status: "succeeded" }]);
    assert.deepEqual((await pool.query(
      "SELECT id, stage, status FROM run_stages WHERE run_id = $1",
      [runId],
    )).rows, [{ id: stageId, stage: "traffic-analysis", status: "succeeded" }]);
    assert.equal((await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM sync_jobs WHERE organization_id = $1",
      [organizationId],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM job_attempts WHERE stage_id = $1",
      [stageId],
    )).rows[0]?.count, 0);
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("canonical traffic partial persists only safe SIF asin, operation, and reason code", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "canonical-sync-traffic-diagnostic-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const asins = ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"];
  const shapeDiagnostic: SifTrafficShapeDiagnostic = {
    kind: "monthly-trend",
    candidateType: "object" as const,
    fields: {
      dates: { present: true, type: "array" as const, arrayLength: 6 },
      nfScore: { present: false, type: "missing" as const },
      adScore: { present: false, type: "missing" as const },
      nf: { present: true, type: "array" as const, arrayLength: 6 },
      ad: { present: true, type: "array" as const, arrayLength: 6 },
      data_notice: { present: true, type: "string" as const },
      fetchedAt: { present: true, type: "string" as const, dateOnlyValid: true },
    },
    coreLengthMismatch: null,
    firstInvalid: {
      field: "root" as const,
      index: null,
      reason: "unknown-shape" as const,
    },
  };
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Traffic diagnostic owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Traffic diagnostic', 'US', $3, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify(asins), actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `canonical-diagnostic:${projectId}`,
    asins,
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
  }));
  const lease = await store.claimNext({
    workerId: "canonical-diagnostic-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun() {
        throw new SifTrafficSnapshotTaskError(
          "B088LPLNPK",
          "ops_get_asin_traffic_trend",
          shapeDiagnostic,
        );
      },
    },
    runner: async () => ({ status: "completed", message: "completed" }),
  });

  try {
    await handler.handle(lease!);
    const rows = (await pool.query(
      "SELECT status, last_error_json FROM run_stages WHERE id = $1",
      [stageId],
    )).rows;
    assert.equal(rows[0]?.status, "partial");
    const persisted = rows[0]?.last_error_json;
    assert.deepEqual({
      code: persisted?.code,
      category: persisted?.category,
      asin: persisted?.asin,
      operation: persisted?.operation,
      reasonCode: persisted?.reasonCode,
    }, {
      code: "SYNC_TRAFFIC_SNAPSHOT_FAILED",
      category: "data-quality",
      asin: "B088LPLNPK",
      operation: "ops_get_asin_traffic_trend",
      reasonCode: "SIF_TRAFFIC_SCHEMA_INVALID",
    });
    assert.deepEqual(persisted?.shapeDiagnostic, shapeDiagnostic);
    assert.equal((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM data_snapshots WHERE run_id = $1",
      [runId],
    )).rows[0]?.count, "0");
    assert.equal((await store.findById(admitted.job.jobId))?.status, "completed");
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("canonical traffic partial copies only the bounded listing overview diagnostic union", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "canonical-sync-overview-diagnostic-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const asins = ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"];
  const shapeDiagnostic = {
    kind: "listing-overview",
    candidateType: "object",
    fields: {
      overview: { present: true, type: "object" },
      ad: { present: true, type: "object" },
      recommend: { present: true, type: "object" },
      total: { present: true, type: "number" },
      data_notice: { present: false, type: "missing" },
      "overview.nf": { present: true, type: "object" },
      "overview.ad": { present: true, type: "object" },
      "overview.nf.score": { present: true, type: "number" },
      "overview.nf.ratio": { present: true, type: "number" },
      "overview.ad.score": { present: true, type: "number" },
      "overview.ad.ratio": { present: true, type: "number" },
    },
    firstInvalid: { field: "overview.ad.ratio", reason: "negative" },
  } as const;
  const overviewShapeDiagnostic = shapeDiagnostic as unknown as SifTrafficShapeDiagnostic;
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Traffic overview diagnostic owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Traffic overview diagnostic', 'US', $3, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify(asins), actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `canonical-overview-diagnostic:${projectId}`,
    asins,
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
  }));
  const lease = await store.claimNext({
    workerId: "canonical-overview-diagnostic-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun() {
        const error = new SifTrafficSnapshotTaskError(
          "B088LPLNPK",
          "ops_get_listing_traffic_overview",
          overviewShapeDiagnostic,
        );
        throw error;
      },
    },
    runner: async () => ({ status: "completed", message: "completed" }),
  });

  try {
    await handler.handle(lease!);
    const persisted = (await pool.query(
      "SELECT last_error_json FROM run_stages WHERE id = $1",
      [stageId],
    )).rows[0]?.last_error_json;
    assert.deepEqual(persisted?.shapeDiagnostic, shapeDiagnostic);
    assert.equal((await store.findById(admitted.job.jobId))?.status, "completed");
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("canonical worker persists primitive and object monthly point diagnostics through PostgreSQL", async () => {
  const scenarios = [
    {
      asin: "B07ZPGD8YR",
      firstInvalid: { field: "nfScore", index: 0, reason: "type", point: { type: "string" } },
    },
    {
      asin: "B0G5N593D6",
      firstInvalid: { field: "adScore", index: 0, reason: "negative", point: { type: "object", score: { present: true, type: "number" } } },
    },
  ] as const;
  for (const scenario of scenarios) {
    const { persisted, status } = await persistMonthlyPointDiagnosticForTest(
      scenario.asin,
      scenario.firstInvalid,
    );
    assert.equal(status, "completed", scenario.asin);
    assert.deepEqual(persisted?.shapeDiagnostic, monthlyDiagnosticWithPoint(scenario.firstInvalid), scenario.asin);
    assert.deepEqual({
      code: persisted?.code,
      category: persisted?.category,
      asin: persisted?.asin,
      operation: persisted?.operation,
      reasonCode: persisted?.reasonCode,
    }, {
      code: "SYNC_TRAFFIC_SNAPSHOT_FAILED",
      category: "data-quality",
      asin: scenario.asin,
      operation: "ops_get_asin_traffic_trend",
      reasonCode: "SIF_TRAFFIC_SCHEMA_INVALID",
    }, scenario.asin);
  }
});

test("canonical worker omits tampered monthly points while preserving the fixed stage error", async () => {
  const sentinel = "monthly-point-tampered-secret-sentinel";
  const scenarios: ReadonlyArray<Readonly<{
    name: string;
    tamper(shape: Record<string, unknown>): void;
  }>> = [
    { name: "point missing type", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "missing" }; } },
    { name: "point null type", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "null" }; } },
    { name: "point excess key", tamper: (shape) => { ((shape.firstInvalid as Record<string, unknown>).point as Record<string, unknown>).extra = sentinel; } },
    { name: "object wrong keys", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "object", private: sentinel }; } },
    { name: "score presence mismatch", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "object", score: { present: false, type: "number" } }; } },
    { name: "score type mismatch", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "object", score: { present: true, type: sentinel } }; } },
    { name: "score extra", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "object", score: { present: true, type: "string", private: sentinel } }; } },
    { name: "wrong field", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).field = "dates"; } },
    { name: "wrong index", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).index = 1; } },
    { name: "wrong reason", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).reason = "length-mismatch"; } },
    { name: "primitive semantic correlation", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).reason = "negative"; } },
    { name: "object scalar semantic correlation", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "object", score: { present: true, type: "string" } }; (shape.firstInvalid as Record<string, unknown>).reason = "negative"; } },
    { name: "object number semantic correlation", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).point = { type: "object", score: { present: true, type: "number" } }; } },
    { name: "secret injection", tamper: (shape) => { (shape.firstInvalid as Record<string, unknown>).privateProviderCredential = sentinel; } },
  ];
  for (const scenario of scenarios) {
    const { persisted, status } = await persistMonthlyPointDiagnosticForTest(
      "B088LPLNPK",
      { field: "nfScore", index: 0, reason: "type", point: { type: "string" } },
      scenario.tamper,
    );
    assert.equal(status, "completed", scenario.name);
    assert.equal(persisted?.shapeDiagnostic, undefined, scenario.name);
    assert.deepEqual({
      code: persisted?.code,
      category: persisted?.category,
      asin: persisted?.asin,
      operation: persisted?.operation,
      reasonCode: persisted?.reasonCode,
    }, {
      code: "SYNC_TRAFFIC_SNAPSHOT_FAILED",
      category: "data-quality",
      asin: "B088LPLNPK",
      operation: "ops_get_asin_traffic_trend",
      reasonCode: "SIF_TRAFFIC_SCHEMA_INVALID",
    }, scenario.name);
    assert.doesNotMatch(JSON.stringify(persisted), /monthly-point-tampered-secret-sentinel|body|credential|header|authorization/i, scenario.name);
  }
});

test("canonical worker rejects malformed SIF diagnostic union values without persisting sentinels", async () => {
  const privateDiagnosticSentinel = "private-invalid-diagnostic-sentinel";
  const overviewDiagnostic = {
    kind: "listing-overview",
    candidateType: "object",
    fields: {
      overview: { present: true, type: "object" },
      ad: { present: true, type: "object" },
      recommend: { present: true, type: "object" },
      total: { present: true, type: "number" },
      data_notice: { present: false, type: "missing" },
      "overview.nf": { present: true, type: "object" },
      "overview.ad": { present: true, type: "object" },
      "overview.nf.score": { present: true, type: "number" },
      "overview.nf.ratio": { present: true, type: "number" },
      "overview.ad.score": { present: true, type: "number" },
      "overview.ad.ratio": { present: true, type: "number" },
    },
    firstInvalid: { field: "overview.ad.ratio", reason: "negative" },
  } as const;
  const monthlyDiagnostic: SifTrafficShapeDiagnostic = {
    kind: "monthly-trend",
    candidateType: "object",
    fields: {
      dates: { present: true, type: "array", arrayLength: 1 },
      nfScore: { present: true, type: "array", arrayLength: 1 },
      adScore: { present: true, type: "array", arrayLength: 1 },
      nf: { present: false, type: "missing" },
      ad: { present: false, type: "missing" },
      data_notice: { present: false, type: "missing" },
      fetchedAt: { present: false, type: "missing", dateOnlyValid: false },
    },
    coreLengthMismatch: null,
    firstInvalid: { field: "root", index: null, reason: "unknown-shape" },
  };
  const scenarios: Array<{
    name: string;
    diagnostic: SifTrafficShapeDiagnostic;
    tamper(shape: Record<string, unknown>): void;
  }> = [
    {
      name: "candidate type",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => { shape.candidateType = privateDiagnosticSentinel; },
    },
    {
      name: "nested field type",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => {
        (shape.fields as Record<string, Record<string, unknown>>)["overview.nf"].type = privateDiagnosticSentinel;
      },
    },
    {
      name: "nested field presence",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => {
        (shape.fields as Record<string, Record<string, unknown>>).total.present = privateDiagnosticSentinel;
      },
    },
    {
      name: "first invalid field",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => {
        (shape.firstInvalid as Record<string, unknown>).field = privateDiagnosticSentinel;
      },
    },
    {
      name: "first invalid reason",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => {
        (shape.firstInvalid as Record<string, unknown>).reason = privateDiagnosticSentinel;
      },
    },
    {
      name: "monthly numeric bound",
      diagnostic: monthlyDiagnostic,
      tamper: (shape) => {
        (shape.fields as Record<string, Record<string, unknown>>).dates.arrayLength = Number.POSITIVE_INFINITY;
      },
    },
    {
      name: "negative monthly numeric bound",
      diagnostic: monthlyDiagnostic,
      tamper: (shape) => {
        (shape.firstInvalid as Record<string, unknown>).index = -1;
      },
    },
    {
      name: "unsafe monthly numeric bound",
      diagnostic: monthlyDiagnostic,
      tamper: (shape) => {
        (shape.fields as Record<string, Record<string, unknown>>).dates.arrayLength = Number.MAX_SAFE_INTEGER + 1;
      },
    },
    {
      name: "unknown diagnostic property",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => { shape.private_provider_body = privateDiagnosticSentinel; },
    },
    {
      name: "unknown kind",
      diagnostic: overviewDiagnostic as unknown as SifTrafficShapeDiagnostic,
      tamper: (shape) => { shape.kind = privateDiagnosticSentinel; },
    },
  ];

  for (const scenario of scenarios) {
    const { persisted, status } = await persistCanonicalTrafficDiagnosticForTest(
      scenario.diagnostic,
      scenario.tamper,
    );
    assert.equal(status, "completed", scenario.name);
    assert.equal(persisted?.shapeDiagnostic, undefined, scenario.name);
    assert.deepEqual({
      code: persisted?.code,
      category: persisted?.category,
      asin: persisted?.asin,
      operation: persisted?.operation,
      reasonCode: persisted?.reasonCode,
    }, {
      code: "SYNC_TRAFFIC_SNAPSHOT_FAILED",
      category: "data-quality",
      asin: "B088LPLNPK",
      operation: "ops_get_listing_traffic_overview",
      reasonCode: "SIF_TRAFFIC_SCHEMA_INVALID",
    }, scenario.name);
    assert.doesNotMatch(JSON.stringify(persisted), /private-invalid-diagnostic-sentinel|body|credential|header|authorization/i, scenario.name);
  }
});

test("explicit generic run snapshots traffic without mutating generic lifecycle", async () => {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "generic-sync-run-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const trafficStageId = randomUUID();
  const attemptId = randomUUID();
  const events: string[] = [];
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Generic owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Generic', 'US', '["B0TASK3350"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, 'existing-data', 'queued', $3, $4, $5, 'generic-run', $4, $4)`,
    [runId, projectId, actorId, NOW, `generic:${projectId}`],
  );
  const stages = [
    [trafficStageId, "traffic-analysis", "queued"],
    [randomUUID(), "voc-positioning", "queued"],
    [randomUUID(), "product-definition", "waiting-input"],
  ] as const;
  for (const [stageId, stage, status] of stages) {
    await pool.query(
      `INSERT INTO run_stages
         (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, 0, $5, $5)`,
      [stageId, runId, stage, status, NOW],
    );
  }
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, status, available_at, created_at, updated_at)
     VALUES ($1, $2, 1, 'queued', $3, $3, $3)`,
    [attemptId, trafficStageId, NOW],
  );
  const genericRunBefore = await genericLifecycleSnapshot(pool, runId);
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `generic-sync:${projectId}:B0TASK3350`,
    asins: ["B0TASK3350"],
  }));
  const lease = await store.claimNext({
    workerId: "generic-dispatcher-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun(scope) {
        events.push("traffic-snapshot");
        assert.equal(scope.runId, runId);
      },
    },
    runner: async () => {
      events.push("detached-runner");
      return { status: "completed", message: "completed" };
    },
  });

  try {
    await handler.handle(lease!);
    assert.deepEqual(events, ["traffic-snapshot", "detached-runner"]);
    assert.deepEqual(await genericLifecycleSnapshot(pool, runId), genericRunBefore);
    assert.equal((await store.findById(admitted.job.jobId))?.status, "completed");
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("progress timer errors are caught, settle the worker safely, and do not leak unhandled rejections or timer callbacks", async () => {
  const { store, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "sync-timer-error-"));
  const releaseRunner = deferred<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  let progressCalls = 0;
  const faultyStore = bindRepositoryProxy(store, {
    async recordProgress() {
      progressCalls += 1;
      throw new Error("transient postgres progress failure");
    },
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: faultyStore,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 5,
    runner: async (_lease, context) => {
      await context.writeMirror({
        status: "running",
        message: "timer should fail first",
        currentStageId: "catalog",
      });
      await releaseRunner.promise;
      return { status: "completed", message: "runner released too late" };
    },
  });

  process.on("unhandledRejection", onUnhandled);
  try {
    const admitted = await store.admit(syncJobInput({
      fingerprint: "timer-error",
      asins: ["B0TASK3201"],
    }));
    const lease = await store.claimNext({
      workerId: "timer-error-worker",
      leaseMs: 30_000,
      wholeJobLimit: 4,
      claimedAt: NOW,
    });

    const handlePromise = handler.handle(lease!);
    await waitFor(() => progressCalls > 0);
    const outcome = await Promise.race([
      handlePromise.then(() => "resolved" as const),
      delay(750).then(() => "timeout" as const),
    ]);
    releaseRunner.resolve();

    assert.equal(outcome, "resolved");
    assert.equal(unhandled.length, 0);
    assert.equal((await store.findById(admitted.job.jobId))?.status, "failed");
    const callsAfterExit = progressCalls;
    await delay(30);
    assert.equal(progressCalls, callsAfterExit);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    releaseRunner.resolve();
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
});

test("Agent Service production dispatcher injects concurrency control and applies a current whole-job downgrade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dispatcher-downgrade-"));
  const path = join(directory, "agent.sqlite");
  const sqliteRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  const claimInputs: Array<Parameters<SyncJobRepository["claimNext"]>[0]> = [];
  let policyLookups = 0;
  const syncJobs = {
    async claimNext(input: Parameters<SyncJobRepository["claimNext"]>[0]) {
      claimInputs.push(input);
      return null;
    },
  } as unknown as SyncJobRepository;
  const concurrencyControl = fakeConcurrencyControl({
    async getEffectivePolicy(organizationId: string) {
      policyLookups += 1;
      assert.equal(organizationId, "*");
      return CONSERVATIVE_CONCURRENCY_PROFILE;
    },
  });
  const repository = Object.assign(sqliteRepository, {
    syncJobs,
    concurrencyControl,
  });
  const service = await createAgentService({
    env: agentServiceEnv(path),
    repository,
  });

  try {
    await service.start({ host: "127.0.0.1", port: 0 });
    await waitFor(() => claimInputs.length > 0);

    assert.ok(policyLookups > 0);
    assert.equal(Math.max(...claimInputs.map((input) => input.wholeJobLimit)), 2);
  } finally {
    await service.stop();
    sqliteRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent Service production dispatcher fails closed without claiming when concurrency control is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dispatcher-unavailable-"));
  const path = join(directory, "agent.sqlite");
  const sqliteRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  let claimCalls = 0;
  const syncJobs = {
    async claimNext() {
      claimCalls += 1;
      return null;
    },
  } as unknown as SyncJobRepository;
  const repository = Object.assign(sqliteRepository, {
    syncJobs,
    concurrencyControl: new UnavailableConcurrencyControlRepository(),
  });
  const service = await createAgentService({
    env: agentServiceEnv(path),
    repository,
  });

  try {
    await service.start({ host: "127.0.0.1", port: 0 });
    await delay(50);

    assert.equal(claimCalls, 0);
  } finally {
    await service.stop();
    sqliteRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function persistCanonicalTrafficDiagnosticForTest(
  diagnostic: SifTrafficShapeDiagnostic,
  tamper: (shape: Record<string, unknown>) => void,
  options: Readonly<{
    asin?: string;
    operation?: ConstructorParameters<typeof SifTrafficSnapshotTaskError>[1];
    injectedDiagnostic?: Record<string, unknown>;
  }> = {},
): Promise<Readonly<{
  persisted: Record<string, unknown> | undefined;
  status: string | undefined;
}>> {
  const { store, pool, close } = await createRepository();
  const mirrorDir = await mkdtemp(join(tmpdir(), "canonical-invalid-diagnostic-"));
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const asins = ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"];
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Traffic diagnostic boundary owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Traffic diagnostic boundary', 'US', $3, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify(asins), actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `canonical-invalid-diagnostic:${projectId}`,
    asins,
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
  }));
  const lease = await store.claimNext({
    workerId: "canonical-invalid-diagnostic-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: store,
    mirrorDirectory: mirrorDir,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    dynamicTrafficSnapshotAdapter: {
      async createForAuthorizedRun() {
        const error = new SifTrafficSnapshotTaskError(
          options.asin ?? "B088LPLNPK",
          options.operation ?? "ops_get_listing_traffic_overview",
          diagnostic,
        );
        if (options.injectedDiagnostic) {
          Reflect.set(error, "shapeDiagnostic", options.injectedDiagnostic);
        }
        tamper(Reflect.get(error, "shapeDiagnostic") as Record<string, unknown>);
        throw error;
      },
    },
    runner: async () => ({ status: "completed", message: "completed" }),
  });

  try {
    await handler.handle(lease!);
    const persisted = (await pool.query<Record<string, unknown>>(
      "SELECT last_error_json FROM run_stages WHERE id = $1",
      [stageId],
    )).rows[0]?.last_error_json as Record<string, unknown> | undefined;
    return {
      persisted,
      status: (await store.findById(admitted.job.jobId))?.status,
    };
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
    await close();
  }
}

function legacyMonthlyDiagnostic(): SifTrafficShapeDiagnostic {
  return {
    kind: "monthly-trend",
    candidateType: "object",
    fields: {
      dates: { present: true, type: "array", arrayLength: 1 },
      nfScore: { present: true, type: "array", arrayLength: 1 },
      adScore: { present: true, type: "array", arrayLength: 1 },
      nf: { present: false, type: "missing" },
      ad: { present: false, type: "missing" },
      data_notice: { present: false, type: "missing" },
      fetchedAt: { present: false, type: "missing", dateOnlyValid: false },
    },
    coreLengthMismatch: null,
    firstInvalid: { field: "root", index: null, reason: "unknown-shape" },
  };
}

function monthlyDiagnosticWithPoint(
  firstInvalid: Record<string, unknown>,
): Record<string, unknown> {
  const diagnostic = legacyMonthlyDiagnostic();
  return {
    ...diagnostic,
    firstInvalid: { ...firstInvalid },
  };
}

function persistMonthlyPointDiagnosticForTest(
  asin: string,
  firstInvalid: Record<string, unknown>,
  tamper: (shape: Record<string, unknown>) => void = () => undefined,
) {
  return persistCanonicalTrafficDiagnosticForTest(
    legacyMonthlyDiagnostic(),
    tamper,
    {
      asin,
      operation: "ops_get_asin_traffic_trend",
      injectedDiagnostic: monthlyDiagnosticWithPoint(firstInvalid),
    },
  );
}

async function createRepository() {
  const schema = `task3_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  return {
    pool,
    store: new PostgresSyncJobStore(new PostgresQueryContext(pool)),
    close: async () => {
      await pool.end();
    },
  };
}

async function activeRunningCount(pool: Pool) {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM sync_jobs WHERE status = 'running'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function genericLifecycleSnapshot(pool: Pool, runId: string) {
  const run = (await pool.query(
    `SELECT id, project_id, status, updated_at
       FROM analysis_runs WHERE id = $1`,
    [runId],
  )).rows;
  const stages = (await pool.query(
    `SELECT id, stage, status, progress, attempt_count, started_at, completed_at,
            last_error_json, updated_at
       FROM run_stages WHERE run_id = $1 ORDER BY stage`,
    [runId],
  )).rows;
  const attempts = (await pool.query(
    `SELECT attempt.id, attempt.stage_id, attempt.status, attempt.attempt_number,
            attempt.lease_generation, attempt.started_at, attempt.completed_at,
            attempt.error_json, attempt.updated_at
       FROM job_attempts attempt
       JOIN run_stages stage ON stage.id = attempt.stage_id
      WHERE stage.run_id = $1 ORDER BY attempt.id`,
    [runId],
  )).rows;
  return { run, stages, attempts };
}

function syncJobInput(
  overrides: Partial<Parameters<SyncJobRepository["admit"]>[0]>,
): Parameters<SyncJobRepository["admit"]>[0] {
  return {
    jobId: randomUUID(),
    organizationId: "99000000-0000-4000-8000-000000000099",
    projectId: null,
    runId: null,
    actorId: randomUUID(),
    fingerprint: randomUUID(),
    asins: ["B0TASK3000"],
    marketplace: "US",
    createdAt: NOW,
    stages: [
      {
        id: "queue",
        label: "Queued",
        kind: "auto",
        status: "active",
        estimatedSeconds: 1,
      },
      {
        id: "catalog",
        label: "Catalog",
        kind: "auto",
        status: "pending",
        estimatedSeconds: 30,
      },
    ],
    currentStageId: "queue",
    message: "Queued",
    ...overrides,
  };
}

function bindRepositoryProxy(
  store: SyncJobRepository,
  overrides: Partial<SyncJobRepository>,
): SyncJobRepository {
  return new Proxy(store, {
    get(target, property) {
      const overridden = overrides[property as keyof SyncJobRepository];
      if (overridden) return overridden;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function agentServiceEnv(path: string) {
  return {
    AGENT_SQLITE_PATH: path,
    AGENT_SQLITE_BUSY_TIMEOUT_MS: "5000",
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: origin,
  };
}

function fakeConcurrencyControl(
  overrides: Partial<ConcurrencyControlRepository>,
): ConcurrencyControlRepository {
  return {
    getEffectivePolicy: async () => CONSERVATIVE_CONCURRENCY_PROFILE,
    acquirePermit: async () => {
      throw new Error("unexpected permit acquisition");
    },
    heartbeatPermit: async () => {
      throw new Error("unexpected permit heartbeat");
    },
    releasePermit: async () => {
      throw new Error("unexpected permit release");
    },
    recordPhysicalAttempt: async () => {
      throw new Error("unexpected physical attempt");
    },
    cancelUndispatchedPhysicalAttempt: async () => {
      throw new Error("unexpected physical attempt cancellation");
    },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
