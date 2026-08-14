import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import type { AgentRepository } from "../../server/db/repository";

const repositoryModuleUrl = new URL(
  "../../server/db/sqlite-repository.ts",
  import.meta.url,
);

async function loadRepositoryModule() {
  return import(repositoryModuleUrl.href);
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-sqlite-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedQueuedJob(
  repository: AgentRepository,
  suffix: string,
) {
  const createdAt = "2026-08-14T08:00:00.000Z";
  const userId = `20000000-0000-4000-8000-0000000000${suffix}1`;
  const organizationId = `20000000-0000-4000-8000-0000000000${suffix}2`;
  const projectId = `20000000-0000-4000-8000-0000000000${suffix}3`;
  const runId = `20000000-0000-4000-8000-0000000000${suffix}4`;
  const stageId = `20000000-0000-4000-8000-0000000000${suffix}5`;
  const jobId = `20000000-0000-4000-8000-0000000000${suffix}6`;

  await repository.createUser({
    id: userId,
    organizationId,
    email: `worker-${suffix}@example.com`,
    displayName: "Worker test",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Lease test",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: createdAt,
    idempotencyScope: `lease-test:${suffix}`,
    idempotencyKey: "create",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createRunStage({
    id: stageId,
    runId,
    stage: "voc-positioning",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  });
  await repository.enqueueJob({
    id: jobId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
  });

  return { jobId, stageId };
}

function runClaimWorker(
  path: string,
  ownerId: string,
  barrier: SharedArrayBuffer,
) {
  return new Promise<Record<string, unknown> | null>((resolve, reject) => {
    let result: Record<string, unknown> | null | undefined;
    const worker = new Worker(
      new URL("./helpers/sqlite-claim-worker.ts", import.meta.url),
      {
        workerData: { path, ownerId, barrier },
        execArgv: ["--import", "tsx", "--conditions=react-server"],
      },
    );
    worker.once("message", (message) => {
      result = message as Record<string, unknown> | null;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`claim worker exited with ${code}`));
      } else if (result === undefined) {
        reject(new Error("claim worker exited without a result"));
      } else {
        resolve(result);
      }
    });
  });
}

function runOpenWorker(path: string, barrier: SharedArrayBuffer) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let result: Record<string, unknown> | undefined;
    const worker = new Worker(
      new URL("./helpers/sqlite-open-worker.ts", import.meta.url),
      {
        workerData: { path, barrier },
        execArgv: ["--import", "tsx", "--conditions=react-server"],
      },
    );
    worker.once("message", (message) => {
      result = message as Record<string, unknown>;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`open worker exited with ${code}`));
      } else if (result === undefined) {
        reject(new Error("open worker exited without a result"));
      } else {
        resolve(result);
      }
    });
  });
}

async function waitForWorkers(barrier: Int32Array, count: number) {
  const deadline = Date.now() + 5_000;
  while (Atomics.load(barrier, 0) < count) {
    if (Date.now() >= deadline) throw new Error("claim worker barrier timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("SQLite migrations are recorded once and connection safety is enabled", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();

  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  assert.deepEqual(first.getConnectionDiagnostics(), {
    foreignKeys: true,
    journalMode: "wal",
    busyTimeoutMs: 5_000,
  });
  assert.deepEqual(first.listAppliedMigrations(), [
    {
      version: 1,
      name: "agent_runtime",
      checksum: first.listAppliedMigrations()[0]?.checksum,
    },
  ]);
  assert.match(first.listAppliedMigrations()[0]?.checksum ?? "", /^[a-f0-9]{64}$/);
  const inspector = new DatabaseSync(path, { readOnly: true });
  const tableNames = (
    inspector
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
  assert.deepEqual(
    [
      "users",
      "sessions",
      "projects",
      "analysis_runs",
      "run_stages",
      "job_attempts",
      "data_snapshots",
      "skill_versions",
      "agent_runs",
      "analysis_reports",
      "connector_status",
      "audit_events",
    ].filter((name) => !tableNames.includes(name)),
    [],
  );
  assert.deepEqual(inspector.prepare("PRAGMA foreign_key_check").all(), []);
  inspector.close();
  first.close();

  const reopened = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(reopened.listAppliedMigrations().length, 1);
  assert.deepEqual(reopened.getConnectionDiagnostics(), {
    foreignKeys: true,
    journalMode: "wal",
    busyTimeoutMs: 5_000,
  });
});

test("separate worker threads can concurrently migrate a fresh database", async (t) => {
  const { directory, path } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const opens = [runOpenWorker(path, shared), runOpenWorker(path, shared)];
  await Promise.race([
    waitForWorkers(barrier, 2),
    Promise.all(opens).then(() => {
      throw new Error("open workers exited before reaching the barrier");
    }),
  ]);
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, 2);

  const results = await Promise.all(opens);
  for (const result of results) {
    assert.deepEqual(result.diagnostics, {
      foreignKeys: true,
      journalMode: "wal",
      busyTimeoutMs: 5_000,
    });
    assert.equal((result.migrations as unknown[]).length, 1);
  }

  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    Number(
      (
        inspector
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  assert.deepEqual(inspector.prepare("PRAGMA foreign_key_check").all(), []);
  inspector.close();
});

test("reopening rejects a changed migration checksum without leaking the file", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  repository.close();

  const tamper = new DatabaseSync(path);
  tamper
    .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
    .run("0".repeat(64));
  tamper.close();

  assert.throws(
    () => openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 }),
    /does not match its source file/i,
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
});

test("repository transactions roll back fully and enforce foreign keys", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const user = {
    id: "10000000-0000-4000-8000-000000000101",
    organizationId: "10000000-0000-4000-8000-000000000102",
    email: "member@example.com",
    displayName: "Member",
    role: "member" as const,
    status: "active" as const,
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
  };

  await assert.rejects(
    repository.transaction(async (transaction: AgentRepository) => {
      await transaction.createUser(user);
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(await repository.findUserById(user.id), null);

  await assert.rejects(
    repository.createProject({
      id: "10000000-0000-4000-8000-000000000103",
      organizationId: user.organizationId,
      name: "Missing owner",
      marketplace: "US",
      asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
      createdBy: user.id,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }),
    /foreign key constraint failed/i,
  );
  await repository.createUser(user);
  await assert.rejects(
    repository.createProject({
      id: "10000000-0000-4000-8000-000000000104",
      organizationId: user.organizationId,
      name: "Invalid marketplace",
      marketplace: "USA",
      asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
      createdBy: user.id,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }),
    /check constraint failed/i,
  );
});

test("analysis run creation is idempotent within its database scope", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createdAt = "2026-08-14T08:00:00.000Z";
  const userId = "10000000-0000-4000-8000-000000000111";
  const organizationId = "10000000-0000-4000-8000-000000000112";
  const projectId = "10000000-0000-4000-8000-000000000113";
  await repository.createUser({
    id: userId,
    organizationId,
    email: "creator@example.com",
    displayName: "Creator",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Scooter competitors",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt,
    updatedAt: createdAt,
  });

  const first = await repository.createAnalysisRun({
    id: "10000000-0000-4000-8000-000000000114",
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: createdAt,
    idempotencyScope: `project:${projectId}:create-run`,
    idempotencyKey: "browser-request-1",
    createdAt,
    updatedAt: createdAt,
  });
  const repeated = await repository.createAnalysisRun({
    ...first,
    id: "10000000-0000-4000-8000-000000000115",
  });

  assert.equal(repeated.id, first.id);
  assert.deepEqual(await repository.listAnalysisRuns(projectId), [first]);
});

test("concurrent run creation is idempotent across SQLite connections", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const second = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createdAt = "2026-08-14T08:00:00.000Z";
  const userId = "10000000-0000-4000-8000-000000000121";
  const organizationId = "10000000-0000-4000-8000-000000000122";
  const projectId = "10000000-0000-4000-8000-000000000123";
  await first.createUser({
    id: userId,
    organizationId,
    email: "concurrent@example.com",
    displayName: "Concurrent creator",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await first.createProject({
    id: projectId,
    organizationId,
    name: "Concurrent idempotency",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt,
    updatedAt: createdAt,
  });
  const common = {
    projectId,
    mode: "existing-data" as const,
    status: "queued" as const,
    createdBy: userId,
    dataCutoffAt: createdAt,
    idempotencyScope: `project:${projectId}:create-run`,
    idempotencyKey: "concurrent-request",
    createdAt,
    updatedAt: createdAt,
  };

  const [left, right] = await Promise.all([
    first.createAnalysisRun({
      ...common,
      id: "10000000-0000-4000-8000-000000000124",
    }),
    second.createAnalysisRun({
      ...common,
      id: "10000000-0000-4000-8000-000000000125",
    }),
  ]);

  assert.equal(left.id, right.id);
  assert.equal((await first.listAnalysisRuns(projectId)).length, 1);
});

test("two SQLite connections cannot both claim the same queued job", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const second = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedQueuedJob(first, "21");

  const claimedAt = "2026-08-14T08:00:01.000Z";
  const [firstClaim, secondClaim] = await Promise.all([
    first.claimNextJob({ ownerId: "worker-a", claimedAt, leaseDurationMs: 30_000 }),
    second.claimNextJob({ ownerId: "worker-b", claimedAt, leaseDurationMs: 30_000 }),
  ]);

  const winners = [firstClaim, secondClaim].filter((claim) => claim !== null);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.attemptNumber, 1);
  assert.match(winners[0]?.leasedBy ?? "", /^worker-[ab]$/);
});

test("a fenced lease release immediately requeues the same attempt", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { jobId, stageId } = await seedQueuedJob(repository, "71");
  const claimed = await repository.claimNextJob({
    ownerId: "stopping-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    repository.releaseJobLease({
      jobId,
      ownerId: "other-worker",
      leaseGeneration: claimed!.leaseGeneration,
      releasedAt: "2026-08-14T08:00:01.100Z",
    }),
    /lease owner/i,
  );
  await assert.rejects(
    repository.releaseJobLease({
      jobId,
      ownerId: "stopping-worker",
      leaseGeneration: claimed!.leaseGeneration - 1,
      releasedAt: "2026-08-14T08:00:01.100Z",
    }),
    /lease owner/i,
  );

  const released = await repository.releaseJobLease({
    jobId,
    ownerId: "stopping-worker",
    leaseGeneration: claimed!.leaseGeneration,
    releasedAt: "2026-08-14T08:00:01.100Z",
  });
  assert.equal(released.status, "queued");
  assert.equal(released.leasedBy, null);
  assert.equal(released.leaseExpiresAt, null);
  const releasedStage = await repository.findRunStage(stageId);
  assert.equal(releasedStage?.status, "queued");
  assert.equal(releasedStage?.attemptCount, 1);

  const replacement = await repository.claimNextJob({
    ownerId: "replacement-worker",
    claimedAt: "2026-08-14T08:00:01.100Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(replacement?.id, jobId);
  assert.equal(replacement?.attemptNumber, 1);
  assert.equal(replacement?.leaseGeneration, claimed!.leaseGeneration + 1);
  assert.equal((await repository.listJobAttempts(stageId)).length, 1);
});

test("separate worker-thread connections atomically compete for one lease", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const setup = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedQueuedJob(setup, "51");
  setup.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const claims = [
    runClaimWorker(path, "thread-a", shared),
    runClaimWorker(path, "thread-b", shared),
  ];
  await Promise.race([
    waitForWorkers(barrier, 2),
    Promise.all(claims).then(() => {
      throw new Error("claim workers exited before reaching the barrier");
    }),
  ]);
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, 2);

  const results = await Promise.all(claims);
  const winners = results.filter((claim) => claim !== null);
  assert.equal(winners.length, 1);
  assert.match(String(winners[0]?.leasedBy), /^thread-[ab]$/);
});

test("expired leases are recovered as a new attempt and reject the old owner", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { jobId, stageId } = await seedQueuedJob(repository, "31");

  const oldClaim = await repository.claimNextJob({
    ownerId: "old-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 1_000,
  });
  assert.equal(oldClaim?.id, jobId);
  assert.equal(
    await repository.claimNextJob({
      ownerId: "new-worker",
      claimedAt: "2026-08-14T08:00:01.999Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );

  const recovered = await repository.claimNextJob({
    ownerId: "new-worker",
    claimedAt: "2026-08-14T08:00:02.001Z",
    leaseDurationMs: 1_000,
  });
  assert.equal(recovered?.attemptNumber, 2);
  assert.equal(recovered?.leasedBy, "new-worker");

  await assert.rejects(
    repository.renewJobLease({
      jobId,
      ownerId: "old-worker",
      leaseGeneration: oldClaim!.leaseGeneration,
      renewedAt: "2026-08-14T08:00:02.100Z",
      leaseDurationMs: 1_000,
    }),
    /lease owner/i,
  );
  await assert.rejects(
    repository.completeJob({
      jobId,
      ownerId: "old-worker",
      leaseGeneration: oldClaim!.leaseGeneration,
      completedAt: "2026-08-14T08:00:02.100Z",
    }),
    /lease owner/i,
  );

  const renewed = await repository.renewJobLease({
    jobId: recovered!.id,
    ownerId: "new-worker",
    leaseGeneration: recovered!.leaseGeneration,
    renewedAt: "2026-08-14T08:00:02.100Z",
    leaseDurationMs: 2_000,
  });
  assert.equal(renewed.leaseExpiresAt, "2026-08-14T08:00:04.100Z");
  assert.equal(
    (
      await repository.completeJob({
        jobId: recovered!.id,
        ownerId: "new-worker",
        leaseGeneration: recovered!.leaseGeneration,
        completedAt: "2026-08-14T08:00:03.000Z",
      })
    ).status,
    "succeeded",
  );
  assert.equal((await repository.listJobAttempts(stageId)).length, 2);
});

test("an expired lease is recoverable after the Agent Service reopens", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const beforeRestart = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  await seedQueuedJob(beforeRestart, "61");
  await beforeRestart.claimNextJob({
    ownerId: "stopped-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 1_000,
  });
  beforeRestart.close();

  const afterRestart = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    afterRestart.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const recovered = await afterRestart.claimNextJob({
    ownerId: "replacement-worker",
    claimedAt: "2026-08-14T08:00:02.001Z",
    leaseDurationMs: 1_000,
  });

  assert.equal(recovered?.attemptNumber, 2);
  assert.equal(recovered?.leasedBy, "replacement-worker");
});

test("retryable failures respect backoff and lease ownership", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { jobId } = await seedQueuedJob(repository, "41");
  const activeLease = await repository.claimNextJob({
    ownerId: "worker-a",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 30_000,
  });
  assert.ok(activeLease);

  await assert.rejects(
    repository.failJob({
      jobId,
      ownerId: "worker-b",
      leaseGeneration: activeLease.leaseGeneration,
      failedAt: "2026-08-14T08:00:02.000Z",
      retryable: true,
      retryAt: "2026-08-14T08:00:05.000Z",
      error: { code: "UPSTREAM_TEMPORARY", message: "retry later" },
    }),
    /lease owner/i,
  );
  await repository.failJob({
    jobId,
    ownerId: "worker-a",
    leaseGeneration: activeLease.leaseGeneration,
    failedAt: "2026-08-14T08:00:02.000Z",
    retryable: true,
    retryAt: "2026-08-14T08:00:05.000Z",
    error: { code: "UPSTREAM_TEMPORARY", message: "retry later" },
  });

  assert.equal(
    await repository.claimNextJob({
      ownerId: "worker-b",
      claimedAt: "2026-08-14T08:00:04.999Z",
      leaseDurationMs: 30_000,
    }),
    null,
  );
  const retried = await repository.claimNextJob({
    ownerId: "worker-b",
    claimedAt: "2026-08-14T08:00:05.000Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(retried?.attemptNumber, 2);
  assert.equal(retried?.leasedBy, "worker-b");
});

test("lease generation fences stale workers when an owner id is reused", async (t) => {
  const { openSqliteAgentRepository } = await loadRepositoryModule();
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function recover(suffix: string) {
    await seedQueuedJob(repository, suffix);
    const first = await repository.claimNextJob({
      ownerId: "reused-worker",
      claimedAt: "2026-08-14T08:00:01.000Z",
      leaseDurationMs: 1_000,
    });
    const current = await repository.claimNextJob({
      ownerId: "reused-worker",
      claimedAt: "2026-08-14T08:00:02.001Z",
      leaseDurationMs: 5_000,
    });
    assert.ok(first);
    assert.ok(current);
    assert.ok(current.leaseGeneration > first.leaseGeneration);
    return { first, current };
  }

  const renewLease = await recover("71");
  await assert.rejects(
    repository.renewJobLease({
      jobId: renewLease.current.id,
      ownerId: "reused-worker",
      leaseGeneration: renewLease.first.leaseGeneration,
      renewedAt: "2026-08-14T08:00:03.000Z",
      leaseDurationMs: 5_000,
    }),
    /lease owner or generation/i,
  );
  await repository.renewJobLease({
    jobId: renewLease.current.id,
    ownerId: "reused-worker",
    leaseGeneration: renewLease.current.leaseGeneration,
    renewedAt: "2026-08-14T08:00:03.000Z",
    leaseDurationMs: 5_000,
  });

  const completeLease = await recover("72");
  await assert.rejects(
    repository.completeJob({
      jobId: completeLease.current.id,
      ownerId: "reused-worker",
      leaseGeneration: completeLease.first.leaseGeneration,
      completedAt: "2026-08-14T08:00:03.000Z",
    }),
    /lease owner or generation/i,
  );
  assert.equal(
    (
      await repository.completeJob({
        jobId: completeLease.current.id,
        ownerId: "reused-worker",
        leaseGeneration: completeLease.current.leaseGeneration,
        completedAt: "2026-08-14T08:00:03.000Z",
      })
    ).status,
    "succeeded",
  );

  const failLease = await recover("73");
  const failure = {
    failedAt: "2026-08-14T08:00:03.000Z",
    retryable: false,
    retryAt: null,
    error: { code: "PERMANENT", message: "stop" },
  };
  await assert.rejects(
    repository.failJob({
      jobId: failLease.current.id,
      ownerId: "reused-worker",
      leaseGeneration: failLease.first.leaseGeneration,
      ...failure,
    }),
    /lease owner or generation/i,
  );
  assert.equal(
    (
      await repository.failJob({
        jobId: failLease.current.id,
        ownerId: "reused-worker",
        leaseGeneration: failLease.current.leaseGeneration,
        ...failure,
      })
    ).status,
    "failed",
  );
});
