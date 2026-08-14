import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ModelBudgetLimits } from "../../server/db/model-budget-repository";
import { openSqliteAgentRepository as openSqliteAgentRepositoryBase } from "../../server/db/sqlite-repository";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import {
  ModelBudgetCoordinator,
  StaticModelBudgetLimitProvider,
} from "../../server/runtime/model-budget-coordinator";

const initialTime = "2026-08-14T08:00:00.000Z";
let repositoryClock = { value: initialTime };

function openSqliteAgentRepository(
  options: Parameters<typeof openSqliteAgentRepositoryBase>[0],
) {
  return openSqliteAgentRepositoryBase({
    ...options,
    nowProvider: options.nowProvider ?? (() => new Date(repositoryClock.value)),
  });
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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
    onLimitContext?: (context: unknown) => void;
  } = {},
) {
  const now = options.now ?? { value: initialTime };
  repositoryClock = now;
  let sequence = 0;
  return new ModelBudgetCoordinator({
    repository,
    limitProvider: {
      getLimits: (context: unknown) => {
        options.onLimitContext?.(context);
        return structuredClone(options.limits ?? budgetLimits());
      },
    },
    clock: () => new Date(now.value),
    createId: () => `${options.idPrefix ?? "reservation"}-${++sequence}`,
    reservationLeaseMs: options.leaseDurationMs ?? 60_000,
  });
}

function projected(inputTokens = 40, outputTokens = 60, costMicros = 100) {
  return { inputTokens, outputTokens, costMicros };
}

test("static server limit configuration is strict, cloned, and immutable", () => {
  const configured = budgetLimits(123, 456);
  const provider = new StaticModelBudgetLimitProvider(configured);
  configured.call.maxTokens = 999;

  const first = provider.getLimits({
    runId: "run-static",
    projectId: "project-static",
    organizationId: "organization-static",
    requestFingerprint: fingerprint("static"),
  });
  const second = provider.getLimits({
    runId: "run-static",
    projectId: "project-static",
    organizationId: "organization-static",
    requestFingerprint: fingerprint("static"),
  });

  assert.deepEqual(first, budgetLimits(123, 456));
  assert.deepEqual(second, first);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.call), true);
  assert.throws(() => {
    first.call.maxTokens = 1;
  }, TypeError);
});

test("static server limit configuration rejects missing, unknown, and invalid values", () => {
  const valid = budgetLimits();
  const invalidConfigurations: unknown[] = [
    null,
    {},
    { ...valid, unexpected: true },
    { ...valid, call: { maxTokens: 1 } },
    { ...valid, call: { ...valid.call, unexpected: true } },
  ];
  for (const invalid of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    invalidConfigurations.push({
      ...valid,
      organizationUtcDay: {
        ...valid.organizationUtcDay,
        maxCostMicros: invalid,
      },
    });
  }

  for (const invalid of invalidConfigurations) {
    assert.throws(
      () => new StaticModelBudgetLimitProvider(invalid),
      /model budget limits/i,
    );
  }

  assert.doesNotThrow(
    () => new StaticModelBudgetLimitProvider(budgetLimits(0, 0)),
  );
});

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
  let limitContext: unknown;
  const ledger = coordinator(repository, {
    limits,
    onLimitContext: (context) => {
      limitContext = context;
    },
  });

  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "untrusted-overrides",
      requestFingerprint: fingerprint("untrusted-overrides"),
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

  assert.deepEqual(limitContext, {
    runId: subject.runId,
    projectId: subject.projectId,
    organizationId: subject.organizationId,
    requestFingerprint: fingerprint("untrusted-overrides"),
  });

  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM model_budget_reservations").get() as { count: number }).count,
    0,
  );
  inspector.close();
});

test("subject preflight fails before organization policy lookup", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const valid = await seedRun(repository, "preflight");
  let limitCalls = 0;
  const ledger = coordinator(repository, {
    onLimitContext: () => {
      limitCalls += 1;
    },
  });

  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "preflight-missing",
      requestFingerprint: fingerprint("preflight-missing"),
      runId: "missing-run",
      projectId: valid.projectId,
      projected: projected(),
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "BUDGET_SUBJECT_NOT_FOUND" &&
      !error.message.includes("missing-run") &&
      !error.message.includes(valid.projectId),
  );
  assert.equal(limitCalls, 0);
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
    requestFingerprint: fingerprint("dispatch-1"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });

  const dispatched = await ledger.dispatch(reserved.id);
  assert.equal(dispatched.transitioned, true);
  assert.equal(dispatched.reservation.state, "dispatched");
  const replay = await ledger.dispatch(reserved.id);
  assert.equal(replay.transitioned, false);
  assert.deepEqual(replay.reservation, dispatched.reservation);
  now.value = "2026-08-14T08:10:00.000Z";
  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "dispatch-2",
      requestFingerprint: fingerprint("dispatch-2"),
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(0, 1, 0),
    }),
    BudgetExceededError,
  );
  await assert.rejects(ledger.release(reserved.id), /state/i);
});

test("two independent coordinators grant dispatch authority exactly once", async (t) => {
  const { directory, path } = temporaryDatabase();
  const first = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const second = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(first, "dispatch-authority");
  const left = coordinator(first, { idPrefix: "dispatch-left" });
  const right = coordinator(second, { idPrefix: "dispatch-right" });
  const reserved = await left.reserve({
    idempotencyKey: "dispatch-authority",
    requestFingerprint: fingerprint("dispatch-authority"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });

  const results = await Promise.all([
    left.dispatch(reserved.id),
    right.dispatch(reserved.id),
  ]);

  assert.equal(results.filter((result) => result.transitioned).length, 1);
  assert.equal(
    results.filter(
      (result) =>
        !result.transitioned && result.reservation.state === "dispatched",
    ).length,
    1,
  );
});

test("direct dispatch after lease expiry persists release and grants no authority", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "direct-expiry");
  const now = { value: initialTime };
  const ledger = coordinator(repository, { now, leaseDurationMs: 1_000 });
  const reserved = await ledger.reserve({
    idempotencyKey: "direct-expiry",
    requestFingerprint: fingerprint("direct-expiry"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });
  now.value = "2026-08-14T08:00:01.000Z";

  const dispatch = await ledger.dispatch(reserved.id);
  assert.equal(dispatch.transitioned, false);
  assert.equal(dispatch.reservation.state, "released");
  assert.equal(dispatch.reservation.releasedAt, now.value);

  const replay = await ledger.reserve({
    idempotencyKey: "direct-expiry",
    requestFingerprint: fingerprint("direct-expiry"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });
  assert.equal(replay.state, "released");
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
    requestFingerprint: fingerprint("settle-1"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(20, 30, 50),
  });
  const dispatched = await ledger.dispatch(reserved.id);
  const actual = projected(60, 60, 120);

  const settled = await ledger.settle(dispatched.reservation.id, actual);
  assert.equal(settled.transitioned, true);
  assert.equal(settled.reservation.state, "settled");
  assert.deepEqual(settled.reservation.actual, actual);
  const settledReplay = await ledger.settle(dispatched.reservation.id, actual);
  assert.equal(settledReplay.transitioned, false);
  assert.deepEqual(settledReplay.reservation, settled.reservation);
  await assert.rejects(
    ledger.settle(dispatched.reservation.id, { ...actual, costMicros: 119 }),
    /conflict/i,
  );
  await assert.rejects(
    ledger.reserve({
      idempotencyKey: "settle-2",
      requestFingerprint: fingerprint("settle-2"),
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
    requestFingerprint: fingerprint("direct-settle"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(10, 10, 20),
  });
  const directSettlement = await ledger.settle(direct.id, projected(5, 5, 10));
  assert.equal(directSettlement.transitioned, true);
  assert.equal(directSettlement.reservation.state, "settled");

  const releasable = await ledger.reserve({
    idempotencyKey: "release-before-dispatch",
    requestFingerprint: fingerprint("release-before-dispatch"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(10, 10, 20),
  });
  const released = await ledger.release(releasable.id);
  assert.equal(released.transitioned, true);
  assert.equal(released.reservation.state, "released");
  const releaseReplay = await ledger.release(releasable.id);
  assert.equal(releaseReplay.transitioned, false);
  assert.deepEqual(releaseReplay.reservation, released.reservation);
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
    requestFingerprint: fingerprint("expired-reserved"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  });
  now.value = "2026-08-14T08:00:02.000Z";

  const replacement = await ledger.reserve({
    idempotencyKey: "replacement",
    requestFingerprint: fingerprint("replacement"),
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
    requestFingerprint: fingerprint("utc-day-one"),
    runId: dayOneRun.runId,
    projectId: dayOneRun.projectId,
    projected: projected(),
  });
  await ledger.settle(dayOne.id, projected());

  now.value = "2026-08-15T00:00:00.000Z";
  const dayTwo = await ledger.reserve({
    idempotencyKey: "utc-day-two",
    requestFingerprint: fingerprint("utc-day-two"),
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
      requestFingerprint: fingerprint("race-left"),
      runId: subject.runId,
      projectId: subject.projectId,
      projected: projected(30, 30, 60),
    }),
    right.reserve({
      idempotencyKey: "race-right",
      requestFingerprint: fingerprint("race-right"),
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
    requestFingerprint: fingerprint("transition-race"),
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
    requestFingerprint: fingerprint("same-provider-request"),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: projected(),
  };
  const first = await ledger.reserve(request);
  now.value = "2026-08-15T00:00:00.000Z";

  const expiredReplay = await ledger.reserve(request);
  assert.equal(expiredReplay.id, first.id);
  assert.equal(expiredReplay.state, "released");
  await assert.rejects(
    ledger.reserve({
      ...request,
      projected: { ...request.projected, outputTokens: 61 },
    }),
    /conflict/i,
  );
  await assert.rejects(
    ledger.reserve({
      ...request,
      requestFingerprint: fingerprint("different-request-content"),
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
    requestFingerprint: fingerprint("invalid-actual"),
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
        requestFingerprint: fingerprint(`invalid-limit-${invalid}`),
        runId: subject.runId,
        projectId: subject.projectId,
        projected: projected(),
      }),
      /invalid budget/i,
    );
    await assert.rejects(
      coordinator(repository).reserve({
        idempotencyKey: `invalid-count-${invalid}`,
        requestFingerprint: fingerprint(`invalid-count-${invalid}`),
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
      requestFingerprint: fingerprint("invalid-clock"),
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
