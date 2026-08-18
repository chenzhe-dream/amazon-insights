import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  ModelBudgetReservationConflictError,
  type ModelBudgetLedgerRepository,
} from "../../server/db/model-budget-repository";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresModelBudgetStore } from "../../server/db/postgres/model-budget-store";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-14T08:00:00.000Z";
const LEASE_EXPIRES_AT = "2026-08-14T08:01:00.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function limits(maxTokens = 1_000, maxCostMicros = 1_000) {
  const limit = { maxTokens, maxCostMicros };
  return {
    call: { ...limit },
    run: { ...limit },
    organizationUtcDay: { ...limit },
  };
}

async function createSchema() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const firstPool = postgres.createPool({ searchPath: schema });
  const secondPool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(firstPool);
  return { firstPool, secondPool };
}

function budgetStore(pool: Pool) {
  return new PostgresModelBudgetStore(new PostgresQueryContext(pool), {
    nowProvider: () => new Date(NOW),
  });
}

async function seedRun(pool: Pool, suffix: string) {
  const core = new PostgresCoreStore(new PostgresQueryContext(pool));
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobAttemptId = randomUUID();
  await core.createUser({
    id: userId,
    organizationId,
    email: `${suffix}@example.com`,
    displayName: "PostgreSQL budget test",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createProject({
    id: projectId,
    organizationId,
    name: "Budget test",
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
    status: "running",
    createdBy: userId,
    dataCutoffAt: NOW,
    idempotencyScope: `budget:${suffix}`,
    idempotencyKey: "create",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createRunStage({
    id: stageId,
    runId,
    stage: "voc-positioning",
    status: "running",
    progress: 1,
    attemptCount: 1,
    startedAt: NOW,
    completedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await pool.query(
    `INSERT INTO job_attempts (
       id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
       status, available_at, leased_by, lease_expires_at, lease_generation,
       retryable, created_at, updated_at
     ) VALUES ($1, $2, 1, 3, 1, 'running', $3, 'budget-worker', $4, 1,
               FALSE, $3, $3)`,
    [jobAttemptId, stageId, NOW, LEASE_EXPIRES_AT],
  );
  return { organizationId, projectId, runId, jobAttemptId };
}

function reservationInput(
  subject: { runId: string; projectId: string; jobAttemptId: string },
  overrides: Partial<Parameters<ModelBudgetLedgerRepository["reserveModelBudget"]>[0]> = {},
) {
  return {
    id: "reservation-1",
    idempotencyKey: "provider-request-1",
    requestFingerprint: fingerprint("provider-request-1"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 40, outputTokens: 60, costMicros: 100 },
    limits: limits(),
    reservedAt: NOW,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: 0,
    attemptKind: "initial" as const,
    transientRetryCount: 0,
    formatRepair: false,
    ...overrides,
  };
}

test("two PostgreSQL pools atomically enforce run and daily budget limits", async () => {
  const { firstPool, secondPool } = await createSchema();
  const subject = await seedRun(firstPool, "contention");
  const first = budgetStore(firstPool);
  const second = budgetStore(secondPool);
  const configured = limits(100, 100);

  assert.deepEqual(
    await first.resolveModelBudgetSubject({
      runId: subject.runId,
      projectId: subject.projectId,
    }),
    {
      runId: subject.runId,
      projectId: subject.projectId,
      organizationId: subject.organizationId,
    },
  );

  const results = await Promise.allSettled([
    first.reserveModelBudget(
      reservationInput(subject, {
        id: "reservation-a",
        idempotencyKey: "request-a",
        requestFingerprint: fingerprint("request-a"),
        projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
        limits: configured,
      }),
    ),
    second.reserveModelBudget(
      reservationInput(subject, {
        id: "reservation-b",
        idempotencyKey: "request-b",
        requestFingerprint: fingerprint("request-b"),
        projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
        limits: configured,
      }),
    ),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof BudgetExceededError);
  assert.equal(rejected.reason.scope, "run");
  assert.deepEqual(
    await first.getModelBudgetUsage({
      runId: subject.runId,
      projectId: subject.projectId,
      asOf: NOW,
    }),
    {
      run: { tokens: 60, costMicros: 60 },
      organizationUtcDay: { tokens: 60, costMicros: 60 },
    },
  );
});

test("reservation and dispatch are idempotent while changed payloads conflict", async () => {
  const { firstPool, secondPool } = await createSchema();
  const subject = await seedRun(firstPool, "idempotency");
  const first = budgetStore(firstPool);
  const second = budgetStore(secondPool);
  const input = reservationInput(subject);
  const created = await first.reserveModelBudget(input);
  const replayed = await second.reserveModelBudget({
    ...input,
    id: "ignored-replay-id",
    reservedAt: "2026-08-14T08:00:10.000Z",
    leaseExpiresAt: "2026-08-14T08:01:10.000Z",
  });
  assert.equal(created.created, true);
  assert.equal(replayed.created, false);
  assert.deepEqual(replayed.reservation, created.reservation);
  await assert.rejects(
    second.reserveModelBudget({
      ...input,
      projected: { ...input.projected, costMicros: 101 },
    }),
    ModelBudgetReservationConflictError,
  );

  const transitions = await Promise.all([
    first.dispatchModelBudget({
      reservationId: created.reservation.id,
      transitionedAt: "2026-08-14T08:00:20.000Z",
    }),
    second.dispatchModelBudget({
      reservationId: created.reservation.id,
      transitionedAt: "2026-08-14T08:00:20.000Z",
    }),
  ]);
  assert.deepEqual(
    transitions.map(({ transitioned }) => transitioned).sort(),
    [false, true],
  );

  const provenance = await firstPool.query<{
    job_attempt_id: string;
    request_ordinal: number;
    attempt_kind: string;
    transient_retry_count: number;
    format_repair: boolean;
  }>(
    `SELECT job_attempt_id, request_ordinal, attempt_kind,
            transient_retry_count, format_repair
       FROM model_budget_reservations WHERE id = $1`,
    [created.reservation.id],
  );
  assert.deepEqual(provenance.rows[0], {
    job_attempt_id: subject.jobAttemptId,
    request_ordinal: 0,
    attempt_kind: "initial",
    transient_retry_count: 0,
    format_repair: false,
  });
  await assert.rejects(
    firstPool.query(
      `UPDATE model_budget_reservations
          SET job_attempt_id = NULL, request_ordinal = NULL,
              attempt_kind = NULL, transient_retry_count = NULL,
              format_repair = NULL
        WHERE id = $1`,
      [created.reservation.id],
    ),
    /provenance is immutable/i,
  );
});

test("settle replaces projected usage and release restores allowance after rollback", async () => {
  const { firstPool } = await createSchema();
  const subject = await seedRun(firstPool, "settle-release");
  const store = budgetStore(firstPool);
  const settled = await store.reserveModelBudget(reservationInput(subject));
  const firstSettle = await store.settleModelBudget({
    reservationId: settled.reservation.id,
    transitionedAt: "2026-08-14T08:00:20.000Z",
    actual: { inputTokens: 10, outputTokens: 20, costMicros: 30 },
    responseId: "response-1",
  });
  assert.equal(firstSettle.transitioned, true);
  assert.equal(
    (
      await store.settleModelBudget({
        reservationId: settled.reservation.id,
        transitionedAt: "2026-08-14T08:00:21.000Z",
        actual: { inputTokens: 10, outputTokens: 20, costMicros: 30 },
        responseId: "response-1",
      })
    ).transitioned,
    false,
  );
  await assert.rejects(
    store.settleModelBudget({
      reservationId: settled.reservation.id,
      transitionedAt: "2026-08-14T08:00:22.000Z",
      actual: { inputTokens: 10, outputTokens: 21, costMicros: 30 },
      responseId: "response-1",
    }),
    ModelBudgetReservationConflictError,
  );
  assert.deepEqual(
    await store.getModelBudgetUsage({
      runId: subject.runId,
      projectId: subject.projectId,
      asOf: "2026-08-14T08:00:30.000Z",
    }),
    {
      run: { tokens: 30, costMicros: 30 },
      organizationUtcDay: { tokens: 30, costMicros: 30 },
    },
  );

  const released = await store.reserveModelBudget(
    reservationInput(subject, {
      id: "reservation-release",
      idempotencyKey: "request-release",
      requestFingerprint: fingerprint("request-release"),
      projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
      limits: limits(100, 100),
      requestOrdinal: 1,
      attemptKind: "transient-retry",
      transientRetryCount: 1,
    }),
  );
  assert.equal(
    (
      await store.releaseModelBudget({
        reservationId: released.reservation.id,
        transitionedAt: "2026-08-14T08:00:40.000Z",
      })
    ).transitioned,
    true,
  );
  const replacement = await store.reserveModelBudget(
    reservationInput(subject, {
      id: "reservation-replacement",
      idempotencyKey: "request-replacement",
      requestFingerprint: fingerprint("request-replacement"),
      projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
      limits: limits(100, 100),
      requestOrdinal: 2,
      attemptKind: "transient-retry",
      transientRetryCount: 2,
      reservedAt: "2026-08-14T08:00:41.000Z",
      leaseExpiresAt: "2026-08-14T08:01:41.000Z",
    }),
  );
  assert.equal(replacement.created, true);
});
