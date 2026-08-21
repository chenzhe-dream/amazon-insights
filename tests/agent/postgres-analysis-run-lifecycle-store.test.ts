import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { PostgresAnalysisRunLifecycleStore } from "../../server/db/postgres/analysis-run-lifecycle-store";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { PostgresJobStore } from "../../server/db/postgres/job-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import type { AgentRepository, RunStageRecord } from "../../server/db/repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const now = "2026-08-19T08:00:00.000Z";
const later = "2026-08-19T08:00:01.000Z";
const actorId = "71000000-0000-4000-8000-000000000001";
const organizationId = "71000000-0000-4000-8000-000000000002";
const projectId = "71000000-0000-4000-8000-000000000003";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

interface RepositoryBundle {
  pool: Pool;
  queries: PostgresQueryContext;
  repository: AgentRepository;
}

async function freshRepository(t: test.TestContext): Promise<RepositoryBundle> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const queries = new PostgresQueryContext(pool);
  const core = new PostgresCoreStore(queries);
  const jobs = new PostgresJobStore(queries);
  const lifecycle = new PostgresAnalysisRunLifecycleStore(queries);
  const repository: AgentRepository = {
    transaction<T>(
      operation: (repository: AgentRepository) => Promise<T>,
    ): Promise<T> {
      return queries.transaction(() => operation(repository));
    },
    createInitialAdmin: core.createInitialAdmin.bind(core),
    findAuthenticationUserByEmail:
      core.findAuthenticationUserByEmail.bind(core),
    createSession: core.createSession.bind(core),
    findActiveSessionPrincipalByTokenHash:
      core.findActiveSessionPrincipalByTokenHash.bind(core),
    revokeSessionByTokenHash: core.revokeSessionByTokenHash.bind(core),
    revokeUserSessions: core.revokeUserSessions.bind(core),
    createUser: core.createUser.bind(core),
    findUserById: core.findUserById.bind(core),
    createProject: core.createProject.bind(core),
    findProjectById: core.findProjectById.bind(core),
    createAnalysisRunOnce: core.createAnalysisRunOnce.bind(core),
    createAnalysisRun: core.createAnalysisRun.bind(core),
    findAnalysisRun: core.findAnalysisRun.bind(core),
    listAnalysisRuns: core.listAnalysisRuns.bind(core),
    createRunStage: core.createRunStage.bind(core),
    findRunStage: core.findRunStage.bind(core),
    listRunStages: core.listRunStages.bind(core),
    enqueueJob: jobs.enqueueJob.bind(jobs),
    claimNextJob: jobs.claimNextJob.bind(jobs),
    renewJobLease: jobs.renewJobLease.bind(jobs),
    releaseJobLease: jobs.releaseJobLease.bind(jobs),
    completeJob: jobs.completeJob.bind(jobs),
    failJob: jobs.failJob.bind(jobs),
    listJobAttempts: jobs.listJobAttempts.bind(jobs),
    cancelAnalysisRun: lifecycle.cancelAnalysisRun.bind(lifecycle),
    retryFailedRunStage: lifecycle.retryFailedRunStage.bind(lifecycle),
    resumeWaitingInputRunStage:
      lifecycle.resumeWaitingInputRunStage.bind(lifecycle),
  };
  t.after(async () => {
    await queries.close();
  });
  await seedProject(repository);
  return { pool, queries, repository };
}

async function seedProject(repository: AgentRepository) {
  await repository.createUser({
    id: actorId,
    organizationId,
    email: "pg-lifecycle@example.com",
    displayName: "PG lifecycle",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "PostgreSQL lifecycle",
    marketplace: "US",
    asins: ["B0PG000001", "B0PG000002", "B0PG000003"],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
}

async function createRunWithStages(
  repository: AgentRepository,
  suffix: string,
  statuses: Partial<Record<RunStageRecord["stage"], RunStageRecord["status"]>>,
) {
  const runId = `72000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: now,
    idempotencyScope: `pg-lifecycle:${suffix}`,
    idempotencyKey: "seed",
    createdAt: now,
    updatedAt: now,
  });
  const stageIds = {} as Record<RunStageRecord["stage"], string>;
  for (const [index, stage] of ([
    "traffic-analysis",
    "voc-positioning",
    "product-definition",
  ] as const).entries()) {
    const status = statuses[stage] ?? "queued";
    const id = `73000000-0000-4000-8000-${`${Number(suffix) * 10 + index}`.padStart(12, "0")}`;
    stageIds[stage] = id;
    await repository.createRunStage({
      id,
      runId,
      stage,
      status,
      progress: status === "succeeded" ? 100 : 0,
      attemptCount: status === "succeeded" ? 1 : 0,
      startedAt: status === "succeeded" ? now : null,
      completedAt: status === "succeeded" ? now : null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { runId, stageIds };
}

test("PostgreSQL lifecycle cancels atomically and fences active work", async (t) => {
  const { repository } = await freshRepository(t);
  const seeded = await createRunWithStages(repository, "1", {
    "traffic-analysis": "succeeded",
  });
  await repository.enqueueJob({
    id: "74000000-0000-4000-8000-000000000001",
    stageId: seeded.stageIds["voc-positioning"],
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
  });
  const claimed = await repository.claimNextJob({
    ownerId: "pg-canceller",
    claimedAt: later,
    leaseDurationMs: 30_000,
  });

  const cancelled = await repository.cancelAnalysisRun({
    runId: seeded.runId,
    cancelledAt: "2026-08-19T08:00:02.000Z",
    error: {
      code: "CANCELLED",
      message: "Run was cancelled",
      requestId: "cancel-request",
    },
  });
  const repeated = await repository.cancelAnalysisRun({
    runId: seeded.runId,
    cancelledAt: "2026-08-19T08:00:03.000Z",
    error: {
      code: "CANCELLED",
      message: "Run was cancelled again",
      requestId: "repeat-cancel-request",
    },
  });

  assert.equal(cancelled?.status, "cancelled");
  assert.deepEqual(repeated, cancelled);
  assert.deepEqual(
    (await repository.listRunStages(seeded.runId)).map(({ stage, status }) => ({
      stage,
      status,
    })),
    [
      { stage: "traffic-analysis", status: "succeeded" },
      { stage: "voc-positioning", status: "cancelled" },
      { stage: "product-definition", status: "cancelled" },
    ],
  );
  assert.equal(
    (await repository.listJobAttempts(seeded.stageIds["voc-positioning"]))[0]
      ?.status,
    "cancelled",
  );
  await assert.rejects(
    repository.completeJob({
      jobId: claimed!.id,
      ownerId: "pg-canceller",
      leaseGeneration: claimed!.leaseGeneration,
      completedAt: "2026-08-19T08:00:04.000Z",
    }),
  );
});

test("PostgreSQL lifecycle retries with stale downstream and one logical cycle per caller", async (t) => {
  const { repository } = await freshRepository(t);
  const seeded = await createRunWithStages(repository, "2", {
    "traffic-analysis": "succeeded",
    "product-definition": "succeeded",
  });
  await repository.enqueueJob({
    id: "74000000-0000-4000-8000-000000000002",
    stageId: seeded.stageIds["voc-positioning"],
    attemptNumber: 1,
    maxAttempts: 1,
    availableAt: now,
    createdAt: now,
  });
  const claimed = await repository.claimNextJob({
    ownerId: "pg-failing-worker",
    claimedAt: later,
    leaseDurationMs: 30_000,
  });
  await repository.failJob({
    jobId: claimed!.id,
    ownerId: "pg-failing-worker",
    leaseGeneration: claimed!.leaseGeneration,
    failedAt: "2026-08-19T08:00:02.000Z",
    retryable: false,
    retryAt: null,
    error: { classification: "upstream-permanent", message: "failed" },
  });

  const retry = await repository.retryFailedRunStage({
    runId: seeded.runId,
    stageId: seeded.stageIds["voc-positioning"],
    staleStageIds: [seeded.stageIds["product-definition"]],
    jobId: "74000000-0000-4000-8000-000000000003",
    retriedAt: "2026-08-19T08:00:03.000Z",
    maxAutomaticAttempts: 3,
  });
  assert.equal(retry?.stage.status, "queued");
  assert.equal(retry?.attempt.attemptNumber, 2);
  assert.notEqual(
    retry?.attempt.logicalExecutionCycleId,
    (await repository.listJobAttempts(seeded.stageIds["voc-positioning"]))[0]
      ?.logicalExecutionCycleId,
  );
  assert.deepEqual(
    (await repository.listRunStages(seeded.runId)).map(({ stage, status }) => ({
      stage,
      status,
    })),
    [
      { stage: "traffic-analysis", status: "succeeded" },
      { stage: "voc-positioning", status: "queued" },
      { stage: "product-definition", status: "stale" },
    ],
  );
  assert.equal((await repository.findAnalysisRun(seeded.runId))?.status, "running");
  assert.equal(
    await repository.retryFailedRunStage({
      runId: seeded.runId,
      stageId: seeded.stageIds["voc-positioning"],
      staleStageIds: [],
      jobId: "74000000-0000-4000-8000-000000000004",
      retriedAt: "2026-08-19T08:00:04.000Z",
      maxAutomaticAttempts: 3,
    }),
    null,
  );
});

test("PostgreSQL lifecycle resumes waiting VOC input on the same failed attempt", async (t) => {
  const { repository } = await freshRepository(t);
  const seeded = await createRunWithStages(repository, "3", {
    "voc-positioning": "waiting-input",
  });
  await repository.enqueueJob({
    id: "74000000-0000-4000-8000-000000000005",
    stageId: seeded.stageIds["voc-positioning"],
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
  });
  const claimed = await repository.claimNextJob({
    ownerId: "pg-waiting-worker",
    claimedAt: later,
    leaseDurationMs: 30_000,
  });
  await repository.failJob({
    jobId: claimed!.id,
    ownerId: "pg-waiting-worker",
    leaseGeneration: claimed!.leaseGeneration,
    failedAt: "2026-08-19T08:00:02.000Z",
    retryable: false,
    retryAt: null,
    stageStatus: "waiting-input",
    error: { classification: "authentication", message: "manual input" },
  });

  const resumed = await repository.resumeWaitingInputRunStage({
    runId: seeded.runId,
    stageId: seeded.stageIds["voc-positioning"],
    resumedAt: "2026-08-19T08:00:03.000Z",
  });

  assert.equal(resumed?.stage.status, "queued");
  assert.equal(resumed?.attempt.id, claimed!.id);
  assert.equal(resumed?.attempt.status, "queued");
  assert.equal((await repository.findAnalysisRun(seeded.runId))?.status, "queued");
});
