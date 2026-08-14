import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ModelBudgetLimits } from "../../server/db/model-budget-repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import { ModelBudgetCoordinator } from "../../server/runtime/model-budget-coordinator";

const initialTime = "2026-08-14T08:00:00.000Z";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-budget-coordinator-"));
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
    displayName: `Coordinator ${suffix}`,
    role: "member",
    status: "active",
    createdAt: initialTime,
    updatedAt: initialTime,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: `Coordinator ${suffix}`,
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt: initialTime,
    updatedAt: initialTime,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "running",
    createdBy: userId,
    dataCutoffAt: initialTime,
    idempotencyScope: `coordinator:${suffix}`,
    idempotencyKey: "create",
    createdAt: initialTime,
    updatedAt: initialTime,
  });
  return { organizationId, projectId, runId };
}

function budgetLimits(
  maxTokens = 1_000,
  maxCostMicros = 1_000,
): ModelBudgetLimits {
  return {
    call: { maxTokens, maxCostMicros },
    run: { maxTokens, maxCostMicros },
    organizationUtcDay: { maxTokens, maxCostMicros },
  };
}

function coordinator(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  options: {
    limits?: ModelBudgetLimits;
    now?: { value: string };
    idPrefix?: string;
    leaseDurationMs?: number;
  } = {},
) {
  const now = options.now ?? { value: initialTime };
  let sequence = 0;
  return new ModelBudgetCoordinator({
    repository,
    limitProvider: {
      getLimits: () => structuredClone(options.limits ?? budgetLimits()),
    },
    clock: () => new Date(now.value),
    createId: () => `${options.idPrefix ?? "reservation"}-${++sequence}`,
    reservationLeaseMs: options.leaseDurationMs ?? 60_000,
  });
}

function projected(inputTokens = 40, outputTokens = 60, costMicros = 100) {
  return { inputTokens, outputTokens, costMicros };
}

test("limits, usage, organization, and UTC day come only from trusted server dependencies", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "trusted-config");
  const limits = budgetLimits();
  limits.call.maxTokens = 99;
  const ledger = coordinator(repository, { limits });

  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "untrusted-overrides",
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(),
      limits: budgetLimits(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      usage: { tokens: 0, costMicros: 0 },
      organizationId: "attacker-org",
      utcDay: "2099-01-01",
    } as never),
    (error: unknown) =>
      error instanceof BudgetExceededError && error.scope === "call",
  );

  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM model_budget_reservations").get() as { count: number }).count,
    0,
  );
  inspector.close();
});

test("dispatch is idempotent, never times out, and cannot be released", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "dispatch");
  const now = { value: initialTime };
  const limits = budgetLimits(100, 100);
  const ledger = coordinator(repository, { limits, now, leaseDurationMs: 1_000 });
  const reserved = await ledger.reserve({
    idempotencyKey: "dispatch-1",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });

  const dispatched = await ledger.dispatch(reserved.id);
  assert.equal(dispatched.state, "dispatched");
  assert.deepEqual(await ledger.dispatch(reserved.id), dispatched);
  now.value = "2026-08-14T08:10:00.000Z";
  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "dispatch-2",
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(0, 1, 0),
    }),
    BudgetExceededError,
  );
  await assert.rejects(ledger.release(reserved.id), /state/i);
});

test("settlement is CAS-idempotent, replaces projected usage, and records overages", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "settle");
  const limits = budgetLimits(120, 120);
  const ledger = coordinator(repository, { limits });
  const reserved = await ledger.reserve({
    idempotencyKey: "settle-1",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(20, 30, 50),
  });
  const dispatched = await ledger.dispatch(reserved.id);
  const actual = projected(60, 60, 120);

  const settled = await ledger.settle(dispatched.id, actual);
  assert.equal(settled.state, "settled");
  assert.deepEqual(settled.actual, actual);
  assert.deepEqual(await ledger.settle(dispatched.id, actual), settled);
  await assert.rejects(
    ledger.settle(dispatched.id, { ...actual, costMicros: 119 }),
    /conflict/i,
  );
  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "settle-2",
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(0, 1, 0),
    }),
    BudgetExceededError,
  );
});

test("reserved can settle directly or release idempotently but released cannot dispatch or settle", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "release");
  const ledger = coordinator(repository);
  const direct = await ledger.reserve({
    idempotencyKey: "direct-settle",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(10, 10, 20),
  });
  assert.equal((await ledger.settle(direct.id, projected(5, 5, 10))).state, "settled");

  const releasable = await ledger.reserve({
    idempotencyKey: "release-before-dispatch",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(10, 10, 20),
  });
  const released = await ledger.release(releasable.id);
  assert.equal(released.state, "released");
  assert.deepEqual(await ledger.release(releasable.id), released);
  await assert.rejects(ledger.dispatch(releasable.id), /state/i);
  await assert.rejects(
    ledger.settle(releasable.id, projected(1, 1, 2)),
    /state/i,
  );
});

test("only expired reserved rows are automatically recovered", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "expiry");
  const now = { value: initialTime };
  const ledger = coordinator(repository, {
    limits: budgetLimits(100, 100),
    now,
    leaseDurationMs: 1_000,
  });
  const expired = await ledger.reserve({
    idempotencyKey: "expired-reserved",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });
  now.value = "2026-08-14T08:00:02.000Z";

  const replacement = await ledger.reserve({
    idempotencyKey: "replacement",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });
  assert.equal(replacement.state, "reserved");
  await assert.rejects(ledger.dispatch(expired.id), /state/i);
  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT state FROM model_budget_reservations WHERE id = ?").get(expired.id) as { state: string }).state,
    "released",
  );
  inspector.close();
});

test("UTC calendar-day usage is derived from the injected clock", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const organizationId = "org-utc-boundary";
  const dayOneRun = await seedRun(repository, "utc-one", organizationId);
  const dayTwoRun = await seedRun(repository, "utc-two", organizationId);
  const now = { value: "2026-08-14T23:59:59.900Z" };
  const limits = budgetLimits(1_000, 1_000);
  limits.organizationUtcDay = { maxTokens: 100, maxCostMicros: 100 };
  const ledger = coordinator(repository, { limits, now });
  const dayOne = await ledger.reserve({
    idempotencyKey: "utc-day-one",
    runId: dayOneRun.runId,
    projectId: dayOneRun.projectId,
    projected: projected(),
  });
  await ledger.settle(dayOne.id, projected());

  now.value = "2026-08-15T00:00:00.000Z";
  const dayTwo = await ledger.reserve({
    idempotencyKey: "utc-day-two",
    runId: dayTwoRun.runId,
    projectId: dayTwoRun.projectId,
    projected: projected(),
  });

  assert.equal(dayOne.utcDay, "2026-08-14");
  assert.equal(dayTwo.utcDay, "2026-08-15");
});

test("two independent coordinators and SQLite connections admit only one combined winner", async (t) => {
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const second = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(first, "coordinator-race");
  const limits = budgetLimits(100, 100);
  const left = coordinator(first, { limits, idPrefix: "left" });
  const right = coordinator(second, { limits, idPrefix: "right" });

  const results = await Promise.allSettled([
    left.reserve({
      idempotencyKey: "race-left",
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(30, 30, 60),
    }),
    right.reserve({
      idempotencyKey: "race-right",
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(30, 30, 60),
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof BudgetExceededError,
    ).length,
    1,
  );
});

test("competing dispatch and release transitions use one cross-connection CAS winner", async (t) => {
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const second = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(first, "transition-race");
  const left = coordinator(first, { idPrefix: "transition-left" });
  const right = coordinator(second, { idPrefix: "transition-right" });
  const reserved = await left.reserve({
    idempotencyKey: "transition-race",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });

  const results = await Promise.allSettled([
    left.dispatch(reserved.id),
    right.release(reserved.id),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { code?: string }).code === "BUDGET_STATE_CONFLICT",
    ).length,
    1,
  );
});

test("idempotency is stable across retries and conflicts on changed request parameters", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "coordinator-idempotency");
  const now = { value: initialTime };
  const ledger = coordinator(repository, { now });
  const request = {
    idempotencyKey: "same-provider-request",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  };
  const first = await ledger.reserve(request);
  now.value = "2026-08-15T00:00:00.000Z";

  assert.deepEqual(await ledger.reserve(request), first);
  await assert.rejects(
    ledger.reserve({
      ...request,
      projected: { ...request.projected, outputTokens: 61 },
    }),
    /conflict/i,
  );
});

test("invalid clocks, leases, limits, and provider counts fail before persistence", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "coordinator-validation");
  const ledger = coordinator(repository);
  const unsettled = await ledger.reserve({
    idempotencyKey: "invalid-actual",
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(1, 1, 1),
  });

  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidLimits = budgetLimits();
    invalidLimits.organizationUtcDay.maxCostMicros = invalid;
    await assert.rejects(
      coordinator(repository, { limits: invalidLimits }).reserve({
        idempotencyKey: `invalid-limit-${invalid}`,
        runId: subject.runId,
        projectId: subject.projectId,
        projected: projected(),
      }),
      /invalid budget/i,
    );
    await assert.rejects(
      coordinator(repository).reserve({
        idempotencyKey: `invalid-count-${invalid}`,
        runId: subject.runId,
        projectId: subject.projectId,
        projected: projected(invalid, 1, 1),
      }),
      /invalid budget/i,
    );
    await assert.rejects(
      ledger.settle(unsettled.id, projected(1, 1, invalid)),
      /invalid budget/i,
    );
  }

  await assert.rejects(
    coordinator(repository, { now: { value: "not-a-date" } }).reserve({
      idempotencyKey: "invalid-clock",
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(),
    }),
    /clock/i,
  );
  assert.throws(
    () => coordinator(repository, { leaseDurationMs: 0 }),
    /lease/i,
  );
});
