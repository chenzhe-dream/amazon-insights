import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

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

test("PostgreSQL sync job admission is atomic under identical concurrent submissions", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = "95000000-0000-4000-8000-000000000001";
  const actorId = "95000000-0000-4000-8000-000000000002";
  const submissions = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      first.admit(syncJobInput({
        jobId: randomUUID(),
        organizationId,
        actorId,
        fingerprint: "atomic-identical",
        asins: index % 2 === 0
          ? ["B0SYNC0502", "B0SYNC0501", "B0SYNC0501"]
          : ["B0SYNC0501", "B0SYNC0502"],
        createdAt: `2026-08-20T09:30:${String(index).padStart(2, "0")}.000Z`,
      })),
    ),
  );

  assert.equal(new Set(submissions.map((submission) => submission.job.jobId)).size, 1);
  assert.equal(submissions.filter((submission) => submission.disposition === "created").length, 1);
  assert.equal(submissions.filter((submission) => submission.disposition === "deduplicated").length, 19);
  assert.deepEqual(submissions[0]!.job.asins, ["B0SYNC0501", "B0SYNC0502"]);
  assert.equal(await activeJobCount(firstPool, organizationId), 1);
  assert.equal(await submissionCount(firstPool, organizationId), 20);
});

test("PostgreSQL sync job admission rejects per-user and organization backlog limits without side effects", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = "96000000-0000-4000-8000-000000000001";
  const noisyActorId = "96000000-0000-4000-8000-000000000002";

  await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "noisy-queued-a",
    asins: ["B0SYNC0601"],
  }));
  await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "noisy-queued-b",
    asins: ["B0SYNC0602"],
  }));
  await assert.rejects(
    first.admit(syncJobInput({
      organizationId,
      actorId: noisyActorId,
      fingerprint: "noisy-queued-c",
      asins: ["B0SYNC0603"],
    })),
    /queued sync job limit/i,
  );
  assert.equal(await activeJobCount(firstPool, organizationId), 2);
  assert.equal(await submissionCount(firstPool, organizationId), 2);

  for (let index = 0; index < 98; index += 1) {
    await first.admit(syncJobInput({
      organizationId,
      actorId: `96000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      fingerprint: `org-backlog-${index}`,
      asins: [`B0SYNC${String(700 + index).padStart(4, "0")}`],
      createdAt: `2026-08-20T09:${String(31 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    }));
  }
  await assert.rejects(
    first.admit(syncJobInput({
      organizationId,
      actorId: "96000000-0000-4000-8000-000000009999",
      fingerprint: "org-backlog-overflow",
      asins: ["B0SYNC0999"],
    })),
    /organization sync job backlog/i,
  );
  assert.equal(await activeJobCount(firstPool, organizationId), 100);
  assert.equal(await submissionCount(firstPool, organizationId), 100);
});

test("PostgreSQL fair claim skips actors that already have a running sync job", async () => {
  const { first, second, firstPool } = await createRepositories();
  const organizationId = "97000000-0000-4000-8000-000000000001";
  const noisyActorId = "97000000-0000-4000-8000-000000000002";
  const quietActorA = "97000000-0000-4000-8000-000000000003";
  const quietActorB = "97000000-0000-4000-8000-000000000004";
  const noisyFirst = await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "fair-noisy-first",
    asins: ["B0SYNC0801"],
    createdAt: "2026-08-20T09:40:00.000Z",
  }));
  const noisySecond = await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "fair-noisy-second",
    asins: ["B0SYNC0802"],
    createdAt: "2026-08-20T09:40:01.000Z",
  }));
  const quietFirst = await first.admit(syncJobInput({
    organizationId,
    actorId: quietActorA,
    fingerprint: "fair-quiet-first",
    asins: ["B0SYNC0803"],
    createdAt: "2026-08-20T09:40:02.000Z",
  }));
  const quietSecond = await first.admit(syncJobInput({
    organizationId,
    actorId: quietActorB,
    fingerprint: "fair-quiet-second",
    asins: ["B0SYNC0804"],
    createdAt: "2026-08-20T09:40:03.000Z",
  }));

  const claims = await Promise.all([
    first.claimNext({ workerId: "fair-a", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
    second.claimNext({ workerId: "fair-b", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
    first.claimNext({ workerId: "fair-c", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
    second.claimNext({ workerId: "fair-d", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
  ]);
  const claimedJobIds = claims.flatMap((claim) => claim?.job.jobId ?? []);

  assert.deepEqual(new Set(claimedJobIds), new Set([
    noisyFirst.job.jobId,
    quietFirst.job.jobId,
    quietSecond.job.jobId,
  ]));
  assert.equal(claimedJobIds.includes(noisySecond.job.jobId), false);
  assert.equal(await activeRunningCount(firstPool, "2026-08-20T09:41:00.000Z"), 3);
  assert.equal(await duplicateRunningActorCount(firstPool), 0);
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

test("PostgreSQL expired running reclaim still respects wholeJobLimit", async () => {
  const { first, firstPool } = await createRepositories();
  const active = await first.admit(
    syncJobInput({
      fingerprint: "active-running-capacity",
      asins: ["B0SYNC0400"],
      createdAt: "2026-08-20T09:20:00.000Z",
    }),
  );
  const expiredA = await first.admit(
    syncJobInput({
      fingerprint: "expired-running-capacity-a",
      asins: ["B0SYNC0401"],
      createdAt: "2026-08-20T09:20:01.000Z",
    }),
  );
  const expiredB = await first.admit(
    syncJobInput({
      fingerprint: "expired-running-capacity-b",
      asins: ["B0SYNC0402"],
      createdAt: "2026-08-20T09:20:02.000Z",
    }),
  );

  const activeLease = await first.claimNext({
    workerId: "capacity-active",
    leaseMs: 60_000,
    wholeJobLimit: 10,
    claimedAt: "2026-08-20T09:21:00.000Z",
  });
  assert.equal(activeLease?.job.jobId, active.job.jobId);
  assert.equal(
    (await first.claimNext({
      workerId: "capacity-expired-a",
      leaseMs: 1_000,
      wholeJobLimit: 10,
      claimedAt: "2026-08-20T09:21:00.000Z",
    }))?.job.jobId,
    expiredA.job.jobId,
  );
  assert.equal(
    (await first.claimNext({
      workerId: "capacity-expired-b",
      leaseMs: 1_000,
      wholeJobLimit: 10,
      claimedAt: "2026-08-20T09:21:00.000Z",
    }))?.job.jobId,
    expiredB.job.jobId,
  );

  assert.equal(
    await activeRunningCount(firstPool, "2026-08-20T09:21:02.000Z"),
    1,
  );
  const blocked = await first.claimNext({
    workerId: "capacity-blocked",
    leaseMs: 10_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:21:02.000Z",
  });
  assert.equal(blocked, null);
  assert.equal(
    await activeRunningCount(firstPool, "2026-08-20T09:21:02.000Z"),
    1,
  );

  const concurrentReclaims = await Promise.all([
    first.claimNext({
      workerId: "capacity-reclaim-a",
      leaseMs: 10_000,
      wholeJobLimit: 2,
      claimedAt: "2026-08-20T09:21:02.000Z",
    }),
    first.claimNext({
      workerId: "capacity-reclaim-b",
      leaseMs: 10_000,
      wholeJobLimit: 2,
      claimedAt: "2026-08-20T09:21:02.000Z",
    }),
  ]);
  const reclaimed = concurrentReclaims.filter((lease) => lease !== null);
  assert.equal(reclaimed.length, 1);
  assert.ok(
    [expiredA.job.jobId, expiredB.job.jobId].includes(reclaimed[0]!.job.jobId),
  );
  assert.equal(
    await activeRunningCount(firstPool, "2026-08-20T09:21:02.000Z"),
    2,
  );
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

async function activeJobCount(pool: Pool, organizationId: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sync_jobs
     WHERE organization_id = $1
       AND status IN ('queued', 'running')`,
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function submissionCount(pool: Pool, organizationId: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sync_job_submissions
     WHERE organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function activeRunningCount(pool: Pool, asOf: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sync_jobs
     WHERE status = 'running'
       AND lease_expires_at > $1`,
    [asOf],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function duplicateRunningActorCount(pool: Pool) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM (
       SELECT actor_id
       FROM sync_jobs
       WHERE status = 'running'
       GROUP BY actor_id
       HAVING count(*) > 1
     ) duplicate_actors`,
  );
  return Number(result.rows[0]?.count ?? 0);
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
