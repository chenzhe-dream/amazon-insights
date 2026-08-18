import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { JobLeaseLostError } from "../../server/db/repository";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { PostgresJobStore } from "../../server/db/postgres/job-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-14T08:00:00.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

async function createSchema() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const firstPool = postgres.createPool({ searchPath: schema });
  const secondPool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(firstPool);
  return { firstPool, secondPool };
}

async function seedQueuedJob(
  pool: Pool,
  suffix: string,
  maxAttempts = 3,
) {
  const core = new PostgresCoreStore(new PostgresQueryContext(pool));
  const jobs = new PostgresJobStore(new PostgresQueryContext(pool));
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();
  await core.createUser({
    id: userId,
    organizationId,
    email: `${suffix}@example.com`,
    displayName: "PostgreSQL job test",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createProject({
    id: projectId,
    organizationId,
    name: "Lease test",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: NOW,
    idempotencyScope: `job:${suffix}`,
    idempotencyKey: "create",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createRunStage({
    id: stageId,
    runId,
    stage: "voc-positioning",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await jobs.enqueueJob({
    id: jobId,
    stageId,
    attemptNumber: 1,
    maxAttempts,
    availableAt: NOW,
    createdAt: NOW,
  });
  return { jobId, runId, stageId };
}

test("two PostgreSQL pools atomically claim one queued job", async () => {
  const { firstPool, secondPool } = await createSchema();
  await seedQueuedJob(firstPool, "claim");
  const first = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const second = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const claimedAt = "2026-08-14T08:00:01.000Z";

  const claims = await Promise.all([
    first.claimNextJob({ ownerId: "worker-a", claimedAt, leaseDurationMs: 30_000 }),
    second.claimNextJob({ ownerId: "worker-b", claimedAt, leaseDurationMs: 30_000 }),
  ]);

  const winners = claims.filter((claim) => claim !== null);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.attemptNumber, 1);
  assert.match(winners[0]?.leasedBy ?? "", /^worker-[ab]$/);
  assert.match(winners[0]?.logicalExecutionCycleId ?? "", /^[0-9a-f]{64}$/);
});

test("expired leases recover with fencing, backoff, and terminal max-attempt failure", async () => {
  const { firstPool, secondPool } = await createSchema();
  const { jobId, stageId } = await seedQueuedJob(firstPool, "recovery");
  const first = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const second = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const oldClaim = await first.claimNextJob({
    ownerId: "old-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 1_000,
  });
  assert.ok(oldClaim);
  assert.equal(
    await second.claimNextJob({
      ownerId: "new-worker",
      claimedAt: "2026-08-14T08:00:01.999Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );

  const recovered = await second.claimNextJob({
    ownerId: "new-worker",
    claimedAt: "2026-08-14T08:00:02.001Z",
    leaseDurationMs: 1_000,
  });
  assert.equal(recovered?.attemptNumber, 2);
  assert.equal(recovered?.leasedBy, "new-worker");
  assert.equal(recovered?.retryCycleStartAttempt, 1);

  for (const mutation of [
    () =>
      first.renewJobLease({
        jobId,
        ownerId: "old-worker",
        leaseGeneration: oldClaim.leaseGeneration,
        renewedAt: "2026-08-14T08:00:02.100Z",
        leaseDurationMs: 1_000,
      }),
    () =>
      first.completeJob({
        jobId,
        ownerId: "old-worker",
        leaseGeneration: oldClaim.leaseGeneration,
        completedAt: "2026-08-14T08:00:02.100Z",
      }),
    () =>
      first.failJob({
        jobId,
        ownerId: "old-worker",
        leaseGeneration: oldClaim.leaseGeneration,
        failedAt: "2026-08-14T08:00:02.100Z",
        retryable: false,
        retryAt: null,
        error: { code: "STALE", message: "stale worker" },
      }),
  ]) {
    await assert.rejects(mutation, JobLeaseLostError);
  }

  const renewed = await second.renewJobLease({
    jobId: recovered!.id,
    ownerId: "new-worker",
    leaseGeneration: recovered!.leaseGeneration,
    renewedAt: "2026-08-14T08:00:02.100Z",
    leaseDurationMs: 2_000,
  });
  assert.equal(renewed.leaseExpiresAt, "2026-08-14T08:00:04.100Z");

  await second.failJob({
    jobId: recovered!.id,
    ownerId: "new-worker",
    leaseGeneration: recovered!.leaseGeneration,
    failedAt: "2026-08-14T08:00:02.500Z",
    retryable: true,
    retryAt: "2026-08-14T08:00:05.000Z",
    error: { code: "UPSTREAM_TEMPORARY", message: "retry later" },
  });
  assert.equal(
    await first.claimNextJob({
      ownerId: "last-worker",
      claimedAt: "2026-08-14T08:00:04.999Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );
  const last = await first.claimNextJob({
    ownerId: "last-worker",
    claimedAt: "2026-08-14T08:00:05.000Z",
    leaseDurationMs: 1_000,
  });
  assert.equal(last?.attemptNumber, 3);

  assert.equal(
    await second.claimNextJob({
      ownerId: "too-late",
      claimedAt: "2026-08-14T08:00:06.001Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );
  const attempts = await first.listJobAttempts(stageId);
  assert.equal(attempts.length, 3);
  assert.equal(attempts.at(-1)?.status, "failed");
  assert.equal(attempts.at(-1)?.retryable, false);
  const stage = await firstPool.query<{ status: string }>(
    "SELECT status FROM run_stages WHERE id = $1",
    [stageId],
  );
  assert.equal(stage.rows[0]?.status, "failed");
});

test("lease generation fences a reused owner after release and reclaim", async () => {
  const { firstPool, secondPool } = await createSchema();
  const { jobId } = await seedQueuedJob(firstPool, "generation");
  const first = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const second = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const initial = await first.claimNextJob({
    ownerId: "reused-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 5_000,
  });
  assert.ok(initial);
  await first.releaseJobLease({
    jobId,
    ownerId: "reused-worker",
    leaseGeneration: initial.leaseGeneration,
    releasedAt: "2026-08-14T08:00:01.100Z",
  });
  const current = await second.claimNextJob({
    ownerId: "reused-worker",
    claimedAt: "2026-08-14T08:00:01.100Z",
    leaseDurationMs: 5_000,
  });
  assert.ok(current);
  assert.equal(current.id, jobId);
  assert.ok(current.leaseGeneration > initial.leaseGeneration);
  await assert.rejects(
    first.completeJob({
      jobId,
      ownerId: "reused-worker",
      leaseGeneration: initial.leaseGeneration,
      completedAt: "2026-08-14T08:00:02.000Z",
    }),
    JobLeaseLostError,
  );
  const completed = await second.completeJob({
    jobId,
    ownerId: "reused-worker",
    leaseGeneration: current.leaseGeneration,
    completedAt: "2026-08-14T08:00:02.000Z",
  });
  assert.equal(completed.status, "succeeded");
});
