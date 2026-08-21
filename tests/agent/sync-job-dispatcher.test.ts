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

test("restart recovery fences expired workers, launches one reclaimed runner, bounds exhaustion, and settles active stages", async () => {
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
    const launchCountBeforeExhaustion = launched.length;
    await handler.handle(attemptThree!);
    assert.equal(launched.length, launchCountBeforeExhaustion);
    assert.equal((await store.findById(exhausted.job.jobId))?.status, "failed");
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
