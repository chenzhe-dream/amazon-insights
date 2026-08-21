import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import {
  SyncJobLeaseLostError,
  SyncJobQueueUnavailableError,
  type SyncJobRepository,
} from "../../server/db/sync-job-repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-20T09:00:00.000Z";
const LATER = "2026-08-20T09:00:01.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("PostgreSQL sync jobs survive restart and deduplicate only inside tenant scope", async () => {
  const { first, second } = await createRepositories();
  const input = syncJobInput({
    organizationId: "91000000-0000-4000-8000-000000000001",
    projectId: "91000000-0000-4000-8000-000000000002",
    runId: "91000000-0000-4000-8000-000000000003",
    fingerprint: "same-request",
    asins: ["B0SYNC0001", "B0SYNC0002"],
  });

  const created = await first.admit(input);
  assert.equal(created.disposition, "created");

  const deduplicated = await second.admit({
    ...input,
    jobId: randomUUID(),
    asins: [...input.asins].reverse(),
  });
  assert.equal(deduplicated.disposition, "deduplicated");
  assert.equal(deduplicated.job.jobId, created.job.jobId);
  assert.deepEqual(deduplicated.job.asins, input.asins);

  const otherTenant = await second.admit({
    ...input,
    jobId: randomUUID(),
    organizationId: "91000000-0000-4000-8000-000000000099",
  });
  assert.equal(otherTenant.disposition, "created");
  assert.notEqual(otherTenant.job.jobId, created.job.jobId);
});

test("PostgreSQL sync jobs persist stage and module progress across repository instances", async () => {
  const { first, second } = await createRepositories();
  const admitted = await first.admit(
    syncJobInput({
      organizationId: "92000000-0000-4000-8000-000000000001",
      projectId: "92000000-0000-4000-8000-000000000002",
      runId: "92000000-0000-4000-8000-000000000003",
      fingerprint: "module-progress",
      asins: ["B0SYNC0003", "B0SYNC0004"],
    }),
  );

  const lease = await second.claimNext({
    workerId: "worker-a",
    leaseMs: 30_000,
    wholeJobLimit: 10,
    claimedAt: LATER,
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  assert.equal(lease?.leaseGeneration, 1);

  await first.recordProgress({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    recordedAt: "2026-08-20T09:00:02.000Z",
    currentStageId: "catalog",
    stage: {
      id: "catalog",
      status: "running",
      startedAt: "2026-08-20T09:00:02.000Z",
    },
    modules: [
      {
        asin: "B0SYNC0003",
        module: "catalog",
        status: "ready",
        reason: null,
        updatedAt: "2026-08-20T09:00:02.000Z",
      },
      {
        asin: "B0SYNC0004",
        module: "traffic",
        status: "connector-failed",
        reason: "SIF unavailable",
        updatedAt: "2026-08-20T09:00:03.000Z",
      },
    ],
  });

  const reopened = await second.findById(admitted.job.jobId);
  assert.equal(reopened?.currentStageId, "catalog");
  assert.equal(reopened?.stages.find((stage) => stage.id === "catalog")?.status, "running");
  assert.equal(reopened?.asinProgress.B0SYNC0003.catalog?.status, "ready");
  assert.equal(reopened?.asinProgress.B0SYNC0004.traffic?.reason, "SIF unavailable");
});

test("PostgreSQL sync job lease generation fences heartbeat and terminal writes", async () => {
  const { first } = await createRepositories();
  const admitted = await first.admit(
    syncJobInput({
      organizationId: "93000000-0000-4000-8000-000000000001",
      projectId: "93000000-0000-4000-8000-000000000002",
      runId: "93000000-0000-4000-8000-000000000003",
      fingerprint: "lease-fencing",
      asins: ["B0SYNC0005"],
    }),
  );
  const lease = await first.claimNext({
    workerId: "worker-fenced",
    leaseMs: 30_000,
    wholeJobLimit: 10,
    claimedAt: LATER,
  });

  await assert.rejects(
    first.heartbeat({
      jobId: admitted.job.jobId,
      leaseGeneration: lease!.leaseGeneration + 1,
      workerId: "worker-fenced",
      heartbeatAt: "2026-08-20T09:00:02.000Z",
      leaseMs: 30_000,
    }),
    SyncJobLeaseLostError,
  );
  await assert.rejects(
    first.complete({
      jobId: admitted.job.jobId,
      leaseGeneration: lease!.leaseGeneration + 1,
      completedAt: "2026-08-20T09:00:03.000Z",
      message: "done",
    }),
    SyncJobLeaseLostError,
  );

  const completed = await first.complete({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    completedAt: "2026-08-20T09:00:03.000Z",
    message: "done",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.leasedBy, null);
});

test("PostgreSQL sync job wholeJobLimit counts running jobs, not ASINs", async () => {
  const { first } = await createRepositories();
  const firstJob = await first.admit(
    syncJobInput({
      fingerprint: "whole-job-limit-first",
      asins: Array.from(
        { length: 10 },
        (_, index) => `B0SYNC01${String(index).padStart(2, "0")}`,
      ),
    }),
  );
  const secondJob = await first.admit(
    syncJobInput({
      fingerprint: "whole-job-limit-second",
      asins: ["B0SYNC0200"],
      createdAt: "2026-08-20T09:00:01.000Z",
    }),
  );

  const firstLease = await first.claimNext({
    workerId: "limit-worker-a",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:00.000Z",
  });
  assert.equal(firstLease?.job.jobId, firstJob.job.jobId);

  const blockedByActiveWholeJob = await first.claimNext({
    workerId: "limit-worker-b",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:00.500Z",
  });
  assert.equal(blockedByActiveWholeJob, null);

  const recoveredExpiredLease = await first.claimNext({
    workerId: "limit-worker-c",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:02.000Z",
  });
  assert.equal(recoveredExpiredLease?.job.jobId, firstJob.job.jobId);
  assert.equal(recoveredExpiredLease?.leaseGeneration, firstLease!.leaseGeneration + 1);

  await first.complete({
    jobId: firstJob.job.jobId,
    leaseGeneration: recoveredExpiredLease!.leaseGeneration,
    completedAt: "2026-08-20T09:10:03.000Z",
    message: "done",
  });
  const secondLease = await first.claimNext({
    workerId: "limit-worker-d",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:04.000Z",
  });
  assert.equal(secondLease?.job.jobId, secondJob.job.jobId);
});

test("PostgreSQL sync job reader rejects corrupt stored stage and progress JSON", async () => {
  const { first, firstPool } = await createRepositories();
  const stageCorruption = await first.admit(
    syncJobInput({
      fingerprint: "corrupt-stage-json",
      asins: ["B0SYNC0300"],
    }),
  );
  await firstPool.query(
    "UPDATE sync_jobs SET stages = $2::jsonb WHERE job_id = $1",
    [stageCorruption.job.jobId, JSON.stringify([{ id: "catalog" }])],
  );

  await assert.rejects(
    first.findById(stageCorruption.job.jobId),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "SyncJobDataError" &&
      error.message === "PostgreSQL sync job row contains invalid data",
  );

  const progressCorruption = await first.admit(
    syncJobInput({
      fingerprint: "corrupt-progress-json",
      asins: ["B0SYNC0301"],
    }),
  );
  await firstPool.query(
    "UPDATE sync_jobs SET asin_progress = $2::jsonb WHERE job_id = $1",
    [
      progressCorruption.job.jobId,
      JSON.stringify({
        B0SYNC0301: {
          catalog: {
            status: "surprising",
            reason: null,
            updatedAt: NOW,
          },
        },
      }),
    ],
  );

  await assert.rejects(
    first.findById(progressCorruption.job.jobId),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "SyncJobDataError" &&
      error.message === "PostgreSQL sync job row contains invalid data",
  );
});

test("SQLite runtime storage stays open while sync queue operations fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-sync-queue-"));
  const repository = await openRuntimeAgentRepository({
    kind: "sqlite",
    sqlite: {
      path: join(directory, "agent.sqlite"),
      busyTimeoutMs: 1_000,
    },
  });
  try {
    const user = await repository.createUser({
      id: "94000000-0000-4000-8000-000000000001",
      organizationId: "94000000-0000-4000-8000-000000000002",
      email: "sync-queue-sqlite@example.com",
      displayName: "SQLite queue boundary",
      role: "member",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.equal(user.email, "sync-queue-sqlite@example.com");

    await assert.rejects(
      repository.syncJobs.claimNext({
        workerId: "sqlite-worker",
        leaseMs: 30_000,
        wholeJobLimit: 10,
        claimedAt: LATER,
      }),
      SyncJobQueueUnavailableError,
    );
    await assert.rejects(
      repository.syncJobs.findById("sqlite-job"),
      SyncJobQueueUnavailableError,
    );
  } finally {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createRepositories() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const firstPool = postgres.createPool({ searchPath: schema });
  const secondPool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(firstPool);
  return {
    firstPool,
    first: new PostgresSyncJobStore(new PostgresQueryContext(firstPool)),
    second: new PostgresSyncJobStore(new PostgresQueryContext(secondPool)),
  };
}

function syncJobInput(
  overrides: Partial<Parameters<SyncJobRepository["admit"]>[0]>,
): Parameters<SyncJobRepository["admit"]>[0] {
  return {
    jobId: randomUUID(),
    organizationId: randomUUID(),
    projectId: null,
    runId: null,
    actorId: randomUUID(),
    fingerprint: randomUUID(),
    asins: ["B0SYNC0001"],
    marketplace: "US",
    createdAt: NOW,
    stages: [
      {
        id: "queued",
        label: "Queued",
        kind: "auto",
        status: "pending",
        estimatedSeconds: 0,
      },
      {
        id: "catalog",
        label: "Catalog",
        kind: "auto",
        status: "pending",
        estimatedSeconds: 30,
      },
    ],
    currentStageId: "queued",
    message: "Queued",
    ...overrides,
  };
}
