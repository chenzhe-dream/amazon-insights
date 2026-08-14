import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  ModelBudgetLedgerRepository as BudgetRepository,
} from "../../server/db/model-budget-repository";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const now = "2026-08-14T08:00:00.000Z";
const leaseExpiresAt = "2026-08-14T08:01:00.000Z";

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-budget-ledger-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedRun(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  suffix: string,
  organizationId = `org-${suffix}`,
) {
  const userId = `user-${suffix}`;
  const projectId = `project-${suffix}`;
  const runId = `run-${suffix}`;
  await repository.createUser({
    id: userId,
    organizationId,
    email: `${suffix}@example.com`,
    displayName: `Budget ${suffix}`,
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: `Budget ${suffix}`,
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "running",
    createdBy: userId,
    dataCutoffAt: now,
    idempotencyScope: `budget:${suffix}`,
    idempotencyKey: "create",
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId, projectId, runId };
}

function limits(maxTokens = 1_000, maxCostMicros = 1_000) {
  const value = { maxTokens, maxCostMicros };
  return {
    call: { ...value },
    run: { ...value },
    organizationUtcDay: { ...value },
  };
}

function reservationInput(
  subject: { projectId: string; runId: string },
  overrides: Partial<Parameters<BudgetRepository["reserveModelBudget"]>[0]> = {},
) {
  return {
    id: "reservation-1",
    idempotencyKey: "provider-request-1",
    requestFingerprint: fingerprint("provider-request-1"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 40, outputTokens: 60, costMicros: 100 },
    limits: limits(),
    reservedAt: now,
    leaseExpiresAt,
    ...overrides,
  };
}

function asBudgetRepository(repository: ReturnType<typeof openSqliteAgentRepository>) {
  return repository as unknown as BudgetRepository;
}

test("call token or integer-micros exhaustion rejects without inserting a reservation", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "call-limit");
  const budgetRepository = asBudgetRepository(repository);

  for (const [id, constrained] of [
    ["token", { call: { maxTokens: 99, maxCostMicros: 1_000 } }],
    ["cost", { call: { maxTokens: 1_000, maxCostMicros: 99 } }],
  ] as const) {
    const configured = limits();
    configured.call = constrained.call;
    await assert.rejects(
      budgetRepository.reserveModelBudget(
        reservationInput(subject, {
          id: `reservation-${id}`,
          idempotencyKey: `provider-request-${id}`,
          limits: configured,
        }),
      ),
      (error: unknown) =>
        error instanceof BudgetExceededError && error.scope === "call",
    );
  }

  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM model_budget_reservations").get() as { count: number }).count,
    0,
  );
  inspector.close();
});

test("a projected request exactly equal to every token and micros limit is allowed", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "equal-limit");

  const result = await asBudgetRepository(repository).reserveModelBudget(
    reservationInput(subject, { limits: limits(100, 100) }),
  );

  assert.equal(result.created, true);
  assert.equal(result.reservation.organizationId, subject.organizationId);
  assert.equal(result.reservation.state, "reserved");
});

test("settled actual usage replaces projected while active and dispatched stay conservative", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const subject = await seedRun(repository, "accounting");
  repository.close();

  const database = new DatabaseSync(path);
  const insert = database.prepare(
    `INSERT INTO model_budget_reservations (
       id, idempotency_key, request_fingerprint, run_id, project_id,
       organization_id, utc_day, state,
       projected_input_tokens, projected_output_tokens, projected_cost_micros,
       actual_input_tokens, actual_output_tokens, actual_cost_micros,
       lease_expires_at, created_at, updated_at, dispatched_at, settled_at, released_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("settled", "settled", fingerprint("settled"), subject.runId, subject.projectId, subject.organizationId, "2026-08-14", "settled", 400, 100, 500, 50, 20, 70, null, now, now, null, now, null);
  insert.run("reserved", "reserved", fingerprint("reserved"), subject.runId, subject.projectId, subject.organizationId, "2026-08-14", "reserved", 20, 10, 30, null, null, null, leaseExpiresAt, now, now, null, null, null);
  insert.run("dispatched", "dispatched", fingerprint("dispatched"), subject.runId, subject.projectId, subject.organizationId, "2026-08-14", "dispatched", 30, 10, 40, null, null, null, null, now, now, now, null, null);
  insert.run("released", "released", fingerprint("released"), subject.runId, subject.projectId, subject.organizationId, "2026-08-14", "released", 50, 50, 100, null, null, null, null, now, now, null, null, now);
  database.close();

  const reopened = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const usage = await asBudgetRepository(reopened).getModelBudgetUsage({
    runId: subject.runId,
    projectId: subject.projectId,
    asOf: now,
  });

  assert.deepEqual(usage.run, { tokens: 140, costMicros: 140 });
  assert.deepEqual(usage.organizationUtcDay, { tokens: 140, costMicros: 140 });
});

test("organization usage is partitioned by server-supplied UTC day and survives restart", async (t) => {
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const subject = await seedRun(first, "restart");
  await asBudgetRepository(first).reserveModelBudget(
    reservationInput(subject, {
      leaseExpiresAt: "2026-08-16T00:00:00.000Z",
    }),
  );
  first.close();

  const reopened = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const dayOne = await asBudgetRepository(reopened).getModelBudgetUsage({
    runId: subject.runId,
    projectId: subject.projectId,
    asOf: now,
  });
  const dayTwo = await asBudgetRepository(reopened).getModelBudgetUsage({
    runId: subject.runId,
    projectId: subject.projectId,
    asOf: "2026-08-15T00:00:00.000Z",
  });

  assert.deepEqual(dayOne.organizationUtcDay, { tokens: 100, costMicros: 100 });
  assert.deepEqual(dayTwo.organizationUtcDay, { tokens: 0, costMicros: 0 });
  assert.deepEqual(dayTwo.run, { tokens: 100, costMicros: 100 });
});

test("two SQLite connections atomically compete for one remaining run and organization allowance", async (t) => {
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const second = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(first, "concurrent");
  const configured = limits(100, 100);

  const results = await Promise.allSettled([
    asBudgetRepository(first).reserveModelBudget(
      reservationInput(subject, {
        id: "reservation-a",
        idempotencyKey: "provider-request-a",
        projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
        limits: configured,
      }),
    ),
    asBudgetRepository(second).reserveModelBudget(
      reservationInput(subject, {
        id: "reservation-b",
        idempotencyKey: "provider-request-b",
        projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
        limits: configured,
      }),
    ),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  assert.equal(rejected?.reason instanceof BudgetExceededError, true);
  const usage = await asBudgetRepository(first).getModelBudgetUsage({
    runId: subject.runId,
    projectId: subject.projectId,
    asOf: now,
  });
  assert.deepEqual(usage.run, { tokens: 60, costMicros: 60 });
});

test("reservation idempotency returns the same row and rejects parameter conflicts", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "idempotent");
  const budgetRepository = asBudgetRepository(repository);
  const input = reservationInput(subject);

  const first = await budgetRepository.reserveModelBudget(input);
  const repeated = await budgetRepository.reserveModelBudget({
    ...input,
    id: "ignored-retry-id",
    reservedAt: "2026-08-14T08:00:30.000Z",
    leaseExpiresAt: "2026-08-14T08:01:30.000Z",
  });
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.reservation, first.reservation);

  await assert.rejects(
    budgetRepository.reserveModelBudget({
      ...input,
      projected: { ...input.projected, costMicros: 101 },
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "BUDGET_RESERVATION_CONFLICT" &&
      !error.message.includes(subject.runId),
  );

  await assert.rejects(
    budgetRepository.reserveModelBudget({
      ...input,
      requestFingerprint: fingerprint("different-model-request"),
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "BUDGET_RESERVATION_CONFLICT",
  );
});

test("idempotency keys are scoped to a validated run and cannot leak cross-subject occupancy", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await seedRun(repository, "key-scope-first");
  const second = await seedRun(repository, "key-scope-second");
  const budgetRepository = asBudgetRepository(repository);

  const firstResult = await budgetRepository.reserveModelBudget(
    reservationInput(first, {
      id: "scope-first",
      idempotencyKey: "shared-key",
      requestFingerprint: fingerprint("first-request"),
    }),
  );
  const secondResult = await budgetRepository.reserveModelBudget(
    reservationInput(second, {
      id: "scope-second",
      idempotencyKey: "shared-key",
      requestFingerprint: fingerprint("second-request"),
    }),
  );

  assert.equal(firstResult.created, true);
  assert.equal(secondResult.created, true);
  assert.notEqual(firstResult.reservation.id, secondResult.reservation.id);

  await assert.rejects(
    budgetRepository.reserveModelBudget(
      reservationInput(
        { runId: "missing-run", projectId: first.projectId },
        {
          id: "scope-missing",
          idempotencyKey: "shared-key",
          requestFingerprint: fingerprint("missing-request"),
        },
      ),
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "BUDGET_SUBJECT_NOT_FOUND",
  );
});

test("storage derives UTC day and rejects non-canonical sortable timestamps", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "canonical-time");
  const budgetRepository = asBudgetRepository(repository);

  const created = await budgetRepository.reserveModelBudget({
    ...reservationInput(subject, {
      id: "derived-day",
      idempotencyKey: "derived-day",
      requestFingerprint: fingerprint("derived-day"),
      reservedAt: "2026-08-14T23:59:59.999Z",
      leaseExpiresAt: "2026-08-15T00:01:00.000Z",
    }),
    utcDay: "2099-01-01",
  } as Parameters<BudgetRepository["reserveModelBudget"]>[0]);
  assert.equal(created.reservation.utcDay, "2026-08-14");

  await assert.rejects(
    budgetRepository.reserveModelBudget(
      reservationInput(subject, {
        id: "offset-time",
        idempotencyKey: "offset-time",
        requestFingerprint: fingerprint("offset-time"),
        reservedAt: "2026-08-14T16:00:00.000+08:00",
      }),
    ),
    /timestamp/i,
  );
  await assert.rejects(
    budgetRepository.getModelBudgetUsage({
      runId: subject.runId,
      projectId: subject.projectId,
      asOf: "2026-08-14T08:00:00Z",
    } as Parameters<BudgetRepository["getModelBudgetUsage"]>[0]),
    /timestamp/i,
  );
});

test("zero projected tokens never creates a provider-callable reservation", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "zero-projected");
  const zeroLimits = limits(0, 0);

  await assert.rejects(
    asBudgetRepository(repository).reserveModelBudget(
      reservationInput(subject, {
        id: "zero-limit",
        idempotencyKey: "zero-limit",
        requestFingerprint: fingerprint("zero-limit"),
        projected: { inputTokens: 1, outputTokens: 0, costMicros: 0 },
        limits: zeroLimits,
      }),
    ),
    (error: unknown) =>
      error instanceof BudgetExceededError && error.scope === "call",
  );
  await assert.rejects(
    asBudgetRepository(repository).reserveModelBudget(
      reservationInput(subject, {
        id: "zero-projected",
        idempotencyKey: "zero-projected",
        requestFingerprint: fingerprint("zero-projected"),
        projected: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        limits: zeroLimits,
      }),
    ),
    /projected.*tokens/i,
  );
  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM model_budget_reservations").get() as { count: number }).count,
    0,
  );
  inspector.close();
});

test("invalid safe-integer inputs and missing or inconsistent ownership fail safely", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "validation");
  const other = await seedRun(repository, "other");
  const budgetRepository = asBudgetRepository(repository);

  for (const invalidFingerprint of [
    "a".repeat(63),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
  ]) {
    await assert.rejects(
      budgetRepository.reserveModelBudget(
        reservationInput(subject, {
          id: `invalid-fingerprint-${invalidFingerprint.length}`,
          idempotencyKey: `invalid-fingerprint-${invalidFingerprint}`,
          requestFingerprint: invalidFingerprint,
        }),
      ),
      /fingerprint/i,
    );
  }

  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      budgetRepository.reserveModelBudget(
        reservationInput(subject, {
          projected: { inputTokens: invalid, outputTokens: 1, costMicros: 1 },
        }),
      ),
      /invalid budget/i,
    );
    const configured = limits();
    configured.run.maxCostMicros = invalid;
    await assert.rejects(
      budgetRepository.reserveModelBudget(
        reservationInput(subject, {
          idempotencyKey: `invalid-limit-${invalid}`,
          limits: configured,
        }),
      ),
      /invalid budget/i,
    );
  }

  for (const ownership of [
    { runId: "missing-run", projectId: subject.projectId },
    { runId: subject.runId, projectId: other.projectId },
  ]) {
    await assert.rejects(
      budgetRepository.reserveModelBudget(
        reservationInput(ownership, {
          id: `ownership-${ownership.runId}`,
          idempotencyKey: `ownership-${ownership.runId}`,
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "BUDGET_SUBJECT_NOT_FOUND" &&
        !error.message.includes(ownership.runId) &&
        !error.message.includes(ownership.projectId),
    );
  }
});
