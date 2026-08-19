import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import type {
  ModelBudgetLedgerRepository as BudgetRepository,
} from "../../server/db/model-budget-repository";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import { openSqliteAgentRepository as openSqliteAgentRepositoryBase } from "../../server/db/sqlite-repository";

const now = "2026-08-14T08:00:00.000Z";
const leaseExpiresAt = "2026-08-14T08:01:00.000Z";

function openSqliteAgentRepository(
  options: Parameters<typeof openSqliteAgentRepositoryBase>[0],
) {
  return openSqliteAgentRepositoryBase({
    ...options,
    nowProvider: options.nowProvider ?? (() => new Date(now)),
  });
}

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

type BudgetWorkerResult =
  | { ok: true; threadId: number; value: Record<string, unknown> }
  | {
      ok: false;
      threadId: number;
      error: { name: string; code?: string; scope?: string; metric?: string };
    };

interface BudgetWorkerTask {
  worker: Worker;
  threadId: number;
  result: Promise<BudgetWorkerResult>;
  exited: Promise<number>;
  isSettled(): boolean;
}

function runBudgetWorker(
  path: string,
  barrier: SharedArrayBuffer,
  request:
    | {
        operation: "reserve";
        input: Parameters<BudgetRepository["reserveModelBudget"]>[0];
      }
    | {
        operation: "dispatch";
        input: Parameters<BudgetRepository["dispatchModelBudget"]>[0];
      },
  options: { barrierTimeoutMs?: number } = {},
) {
  const worker = new Worker(
    new URL("./helpers/sqlite-model-budget-worker.ts", import.meta.url),
    {
      workerData: {
        path,
        barrier,
        barrierTimeoutMs: options.barrierTimeoutMs ?? 10_000,
        repositoryNow: now,
        ...request,
      },
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  const spawnedThreadId = worker.threadId;
  let settled = false;
  let finish!: (result: BudgetWorkerResult) => void;
  const result = new Promise<BudgetWorkerResult>((resolve) => {
    finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });
  const exited = new Promise<number>((resolve) => {
    worker.once("exit", (code) => {
      finish({
        ok: false,
        threadId: spawnedThreadId,
        error: {
          name: "ModelBudgetWorkerExitError",
          code: "MODEL_BUDGET_WORKER_EXIT",
        },
      });
      resolve(code);
    });
  });
  worker.once("message", (message) => finish(message as BudgetWorkerResult));
  worker.once("error", () =>
    finish({
      ok: false,
      threadId: spawnedThreadId,
      error: {
        name: "ModelBudgetWorkerError",
        code: "MODEL_BUDGET_WORKER_ERROR",
      },
    }),
  );
  return {
    worker,
    threadId: spawnedThreadId,
    result,
    exited,
    isSettled: () => settled,
  } satisfies BudgetWorkerTask;
}

async function releaseBudgetWorkerBarrier(
  workers: readonly BudgetWorkerTask[],
  barrier: Int32Array,
  readyTimeoutMs = 5_000,
) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Atomics.load(barrier, 0) < workers.length) {
    if (workers.some((worker) => worker.isSettled())) {
      throw new Error("model budget workers exited before reaching the barrier");
    }
    if (Date.now() >= deadline) {
      throw new Error("model budget worker barrier timed out");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, workers.length);
}

async function cleanupBudgetWorkers(
  workers: readonly BudgetWorkerTask[],
  barrier: Int32Array,
) {
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, workers.length);
  await Promise.allSettled(
    workers.map((task) =>
      task.worker.threadId === -1 ? undefined : task.worker.terminate(),
    ),
  );
  await Promise.all(workers.map((task) => task.exited));
  await Promise.all(workers.map((task) => task.result));
}

async function awaitBudgetWorkerResult(
  task: BudgetWorkerTask,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.result,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("model budget worker result timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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

test("separate worker threads atomically admit only one combined budget reservation", async () => {
  const { directory, path } = temporaryDatabase();
  const setup = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const subject = await seedRun(setup, "worker-reserve");
  setup.close();

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const configured = limits(100, 100);
  const workers: BudgetWorkerTask[] = [];
  let inspector: DatabaseSync | undefined;
  try {
    for (const suffix of ["a", "b"]) {
      workers.push(
        runBudgetWorker(path, shared, {
          operation: "reserve",
          input: reservationInput(subject, {
            id: `worker-reservation-${suffix}`,
            idempotencyKey: `worker-provider-request-${suffix}`,
            requestFingerprint: fingerprint(`worker-provider-request-${suffix}`),
            projected: { inputTokens: 30, outputTokens: 30, costMicros: 60 },
            limits: configured,
          }),
        }),
      );
    }
    await releaseBudgetWorkerBarrier(workers, barrier);
    const results = await Promise.all(workers.map((worker) => worker.result));
    await Promise.all(workers.map((worker) => worker.exited));

    assert.equal(new Set(results.map((result) => result.threadId)).size, 2);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const rejected = results.find((result) => !result.ok);
    assert.deepEqual(rejected && !rejected.ok ? rejected.error : null, {
      name: "BudgetExceededError",
      code: "BUDGET_EXCEEDED",
      scope: "run",
      metric: "tokens",
    });

    inspector = new DatabaseSync(path, { readOnly: true });
    const occupied = inspector
      .prepare(
        `SELECT COUNT(*) AS count,
                SUM(projected_input_tokens + projected_output_tokens) AS tokens,
                SUM(projected_cost_micros) AS cost_micros
         FROM model_budget_reservations WHERE state <> 'released'`,
      )
      .get() as { count: number; tokens: number; cost_micros: number };
    assert.equal(occupied.count, 1);
    assert.equal(occupied.tokens, 60);
    assert.equal(occupied.cost_micros, 60);
  } finally {
    await cleanupBudgetWorkers(workers, barrier);
    inspector?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("separate worker threads grant dispatch authority exactly once", async () => {
  const { directory, path } = temporaryDatabase();
  const setup = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const subject = await seedRun(setup, "worker-dispatch");
  const reserved = await asBudgetRepository(setup).reserveModelBudget(
    reservationInput(subject, {
      id: "worker-dispatch-reservation",
      idempotencyKey: "worker-dispatch-request",
      requestFingerprint: fingerprint("worker-dispatch-request"),
    }),
  );
  setup.close();

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const workers: BudgetWorkerTask[] = [];
  let inspector: DatabaseSync | undefined;
  try {
    for (let index = 0; index < 2; index += 1) {
      workers.push(
        runBudgetWorker(path, shared, {
          operation: "dispatch",
          input: {
            reservationId: reserved.reservation.id,
            transitionedAt: "2026-08-14T08:00:01.000Z",
          },
        }),
      );
    }
    await releaseBudgetWorkerBarrier(workers, barrier);
    const results = await Promise.all(workers.map((worker) => worker.result));
    await Promise.all(workers.map((worker) => worker.exited));

    assert.equal(new Set(results.map((result) => result.threadId)).size, 2);
    assert.equal(results.every((result) => result.ok), true);
    const authority = results.map((result) => {
      assert.equal(result.ok, true);
      return (result as Extract<BudgetWorkerResult, { ok: true }>).value
        .transitioned;
    });
    assert.equal(authority.filter((transitioned) => transitioned === true).length, 1);
    assert.equal(authority.filter((transitioned) => transitioned === false).length, 1);

    inspector = new DatabaseSync(path, { readOnly: true });
    const final = inspector
      .prepare(
        `SELECT state, dispatched_at
         FROM model_budget_reservations WHERE id = ?`,
      )
      .get(reserved.reservation.id) as {
      state: string;
      dispatched_at: string | null;
    };
    assert.equal(final.state, "dispatched");
    assert.equal(final.dispatched_at, "2026-08-14T08:00:01.000Z");
  } finally {
    await cleanupBudgetWorkers(workers, barrier);
    inspector?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a model budget worker exits with a structured failure when its barrier times out", async () => {
  const { directory, path } = temporaryDatabase();
  const setup = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const subject = await seedRun(setup, "worker-timeout");
  setup.close();
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const workers: BudgetWorkerTask[] = [];

  try {
    const worker = runBudgetWorker(
      path,
      shared,
      { operation: "reserve", input: reservationInput(subject) },
      { barrierTimeoutMs: 25 },
    );
    workers.push(worker);
    const outcome = await awaitBudgetWorkerResult(worker, 2_000);
    assert.deepEqual(outcome, {
      ok: false,
      threadId: worker.threadId,
      error: {
        name: "ModelBudgetWorkerBarrierTimeoutError",
        code: "MODEL_BUDGET_WORKER_BARRIER_TIMEOUT",
      },
    });
  } finally {
    await cleanupBudgetWorkers(workers, barrier);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a parent barrier deadline releases and terminates every waiting worker", async () => {
  const { directory, path } = temporaryDatabase();
  const setup = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const subject = await seedRun(setup, "parent-barrier-timeout");
  setup.close();
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  Atomics.store(barrier, 0, -10);
  const workers: BudgetWorkerTask[] = [];
  let allExited = false;

  try {
    workers.push(
      runBudgetWorker(
        path,
        shared,
        { operation: "reserve", input: reservationInput(subject) },
        { barrierTimeoutMs: 1_000 },
      ),
    );
    const startedAt = Date.now();
    await assert.rejects(
      releaseBudgetWorkerBarrier(workers, barrier, 25),
      /barrier timed out/i,
    );
    assert.equal(Date.now() - startedAt < 500, true);
  } finally {
    await cleanupBudgetWorkers(workers, barrier);
    allExited = workers.every((worker) => worker.worker.threadId === -1);
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(allExited, true);
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

test("legacy budget TTL and UTC day use one transaction-entry instant", async (t) => {
  const { directory, path } = temporaryDatabase();
  let repositoryNow = "2026-08-14T23:59:59.900Z";
  const repository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(repositoryNow),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "fresh-budget-time");
  const budget = asBudgetRepository(repository);

  let releaseQueue!: () => void;
  let entered!: () => void;
  const queueReleased = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const transactionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocker = repository.transaction(async () => {
    entered();
    await queueReleased;
  });
  await transactionEntered;
  const crossingMidnight = budget.reserveModelBudget(
    reservationInput(subject, {
      id: "fresh-day-reservation",
      idempotencyKey: "fresh-day-reservation",
      requestFingerprint: fingerprint("fresh-day-reservation"),
      reservedAt: "2026-08-14T23:59:59.950Z",
      leaseExpiresAt: "2026-08-15T00:05:00.000Z",
    }),
  );
  repositoryNow = "2026-08-15T00:00:00.100Z";
  releaseQueue();
  await blocker;
  const midnight = await crossingMidnight;
  assert.equal(midnight.reservation.utcDay, "2026-08-15");
  const dayInspector = new DatabaseSync(path, { readOnly: true });
  const dayCounts = dayInspector
    .prepare(
      `SELECT utc_day, COUNT(*) AS count FROM model_budget_reservations
       WHERE id = ? GROUP BY utc_day`,
    )
    .all(midnight.reservation.id) as Array<{ utc_day: string; count: number }>;
  dayInspector.close();
  assert.equal(dayCounts.length, 1);
  assert.equal(dayCounts[0]?.utc_day, "2026-08-15");
  assert.equal(dayCounts[0]?.count, 1);

  repositoryNow = "2026-08-15T00:06:00.000Z";
  await assert.rejects(
    budget.reserveModelBudget(
      reservationInput(subject, {
        id: "already-expired-new-reservation",
        idempotencyKey: "already-expired-new-reservation",
        requestFingerprint: fingerprint("already-expired-new-reservation"),
        reservedAt: "2026-08-15T00:00:30.000Z",
        leaseExpiresAt: "2026-08-15T00:05:30.000Z",
      }),
    ),
    /lease|expired/i,
  );

  const fresh = await budget.reserveModelBudget(
    reservationInput(subject, {
      id: "fresh-after-cleanup",
      idempotencyKey: "fresh-after-cleanup",
      requestFingerprint: fingerprint("fresh-after-cleanup"),
      reservedAt: "2026-08-15T00:00:40.000Z",
      leaseExpiresAt: "2026-08-15T00:07:00.000Z",
    }),
  );
  const directSettle = await budget.reserveModelBudget(
    reservationInput(subject, {
      id: "fresh-direct-settle",
      idempotencyKey: "fresh-direct-settle",
      requestFingerprint: fingerprint("fresh-direct-settle"),
      reservedAt: "2026-08-15T00:00:50.000Z",
      leaseExpiresAt: "2026-08-15T00:07:00.000Z",
    }),
  );
  const inspector = new DatabaseSync(path, { readOnly: true });
  const expired = inspector
    .prepare("SELECT state FROM model_budget_reservations WHERE id = ?")
    .get(midnight.reservation.id) as { state: string };
  const rejectedCount = inspector
    .prepare(
      "SELECT COUNT(*) AS count FROM model_budget_reservations WHERE id = 'already-expired-new-reservation'",
    )
    .get() as { count: number };
  inspector.close();
  assert.equal(expired.state, "released");
  assert.equal(rejectedCount.count, 0);

  repositoryNow = "2026-08-15T00:08:00.000Z";
  const dispatch = await budget.dispatchModelBudget({
    reservationId: fresh.reservation.id,
    transitionedAt: "2026-08-15T00:06:30.000Z",
  });
  assert.equal(dispatch.transitioned, false);
  assert.equal(dispatch.reservation.state, "released");
  await assert.rejects(
    budget.settleModelBudget({
      reservationId: directSettle.reservation.id,
      transitionedAt: "2026-08-15T00:06:40.000Z",
      actual: { inputTokens: 8, outputTokens: 4, costMicros: 16 },
    }),
    /state/i,
  );
  const settleInspector = new DatabaseSync(path, { readOnly: true });
  const expiredSettle = settleInspector
    .prepare("SELECT state FROM model_budget_reservations WHERE id = ?")
    .get(directSettle.reservation.id) as { state: string };
  settleInspector.close();
  assert.equal(expiredSettle.state, "reserved");
});

test("every legacy budget write reads one clock and clock failure rolls back", async (t) => {
  const { directory, path } = temporaryDatabase();
  let clockCalls = 0;
  let clockFailure = false;
  const repository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
    nowProvider: () => {
      clockCalls += 1;
      if (clockFailure) throw new Error("injected repository clock failure");
      return new Date("2026-08-14T08:00:00.000Z");
    },
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedRun(repository, "clock-once");
  const budget = asBudgetRepository(repository);
  const reserve = async (suffix: string) => {
    const before = clockCalls;
    const result = await budget.reserveModelBudget(
      reservationInput(subject, {
        id: `clock-once-${suffix}`,
        idempotencyKey: `clock-once-${suffix}`,
        requestFingerprint: fingerprint(`clock-once-${suffix}`),
      }),
    );
    assert.equal(clockCalls - before, 1);
    return result.reservation;
  };
  const dispatched = await reserve("dispatch");
  const settled = await reserve("settle");
  const released = await reserve("release");

  for (const operation of [
    () =>
      budget.dispatchModelBudget({
        reservationId: dispatched.id,
        transitionedAt: "2026-08-14T08:00:00.100Z",
      }),
    () =>
      budget.settleModelBudget({
        reservationId: settled.id,
        transitionedAt: "2026-08-14T08:00:00.200Z",
        actual: { inputTokens: 8, outputTokens: 4, costMicros: 16 },
      }),
    () =>
      budget.releaseModelBudget({
        reservationId: released.id,
        transitionedAt: "2026-08-14T08:00:00.300Z",
      }),
  ]) {
    const before = clockCalls;
    await operation();
    assert.equal(clockCalls - before, 1);
  }

  const rollbackDispatch = await reserve("rollback-dispatch");
  const rollbackSettle = await reserve("rollback-settle");
  const rollbackRelease = await reserve("rollback-release");
  for (const operation of [
    () =>
      budget.dispatchModelBudget({
        reservationId: rollbackDispatch.id,
        transitionedAt: "2026-08-14T08:00:00.400Z",
      }),
    () =>
      budget.settleModelBudget({
        reservationId: rollbackSettle.id,
        transitionedAt: "2026-08-14T08:00:00.500Z",
        actual: { inputTokens: 8, outputTokens: 4, costMicros: 16 },
      }),
    () =>
      budget.releaseModelBudget({
        reservationId: rollbackRelease.id,
        transitionedAt: "2026-08-14T08:00:00.600Z",
      }),
  ]) {
    clockFailure = true;
    await assert.rejects(operation(), /clock failure/i);
    clockFailure = false;
  }
  clockFailure = true;
  await assert.rejects(
    budget.reserveModelBudget(
      reservationInput(subject, {
        id: "clock-once-rollback-reserve",
        idempotencyKey: "clock-once-rollback-reserve",
        requestFingerprint: fingerprint("clock-once-rollback-reserve"),
      }),
    ),
    /clock failure/i,
  );
  clockFailure = false;
  const inspector = new DatabaseSync(path, { readOnly: true });
  const unchanged = inspector
    .prepare(
      `SELECT state FROM model_budget_reservations
       WHERE id IN (?, ?, ?) ORDER BY id`,
    )
    .all(
      rollbackDispatch.id,
      rollbackSettle.id,
      rollbackRelease.id,
    ) as Array<{ state: string }>;
  const absentReserve = inspector
    .prepare(
      "SELECT COUNT(*) AS count FROM model_budget_reservations WHERE id = 'clock-once-rollback-reserve'",
    )
    .get() as { count: number };
  inspector.close();
  assert.deepEqual(unchanged.map((row) => row.state), [
    "reserved",
    "reserved",
    "reserved",
  ]);
  assert.equal(absentReserve.count, 0);
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
