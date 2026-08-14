import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRepository } from "../../server/db/repository";
import { openSqliteAgentRepository as openSqliteAgentRepositoryBase } from "../../server/db/sqlite-repository";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import {
  JobAttemptWorkerLoop,
  type WorkerLogSummary,
} from "../../server/runtime/worker-loop";
import {
  WORKER_ERROR_CATEGORIES,
  WorkerTaskError,
  classifyWorkerError,
  computeRetryDelayMs,
} from "../../server/runtime/retry-policy";

const repositoryNow = "2026-08-14T08:00:01.000Z";

function openSqliteAgentRepository(
  options: Parameters<typeof openSqliteAgentRepositoryBase>[0],
) {
  return openSqliteAgentRepositoryBase({
    ...options,
    nowProvider: options.nowProvider ?? (() => new Date(repositoryNow)),
  });
}

class ManualClock {
  #nowMs = Date.parse("2026-08-14T08:00:01.000Z");
  #sleepers: Array<{
    dueAt: number;
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  now = () => new Date(this.#nowMs).toISOString();

  sleep = (durationMs: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const sleeper = {
        dueAt: this.#nowMs + durationMs,
        resolve: () => undefined,
        reject,
        signal,
        onAbort: () => undefined,
      };
      sleeper.resolve = () => {
        signal.removeEventListener("abort", sleeper.onAbort);
        resolve();
      };
      sleeper.onAbort = () => {
        this.#sleepers = this.#sleepers.filter((entry) => entry !== sleeper);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", sleeper.onAbort, { once: true });
      this.#sleepers.push(sleeper);
    });

  advance(durationMs: number) {
    this.#nowMs += durationMs;
    const due = this.#sleepers.filter((sleeper) => sleeper.dueAt <= this.#nowMs);
    this.#sleepers = this.#sleepers.filter(
      (sleeper) => sleeper.dueAt > this.#nowMs,
    );
    for (const sleeper of due) sleeper.resolve();
  }

  get pendingSleeps() {
    return this.#sleepers.length;
  }
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function repositoryWithOverrides(
  repository: AgentRepository,
  overrides: Partial<AgentRepository>,
): AgentRepository {
  return new Proxy(repository, {
    get(target, property) {
      const override = overrides[property as keyof AgentRepository];
      if (override) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedJob(repository: AgentRepository, maxAttempts = 3) {
  const createdAt = "2026-08-14T08:00:00.000Z";
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();

  await repository.createUser({
    id: userId,
    organizationId,
    email: `${userId}@example.com`,
    displayName: "Worker test",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Worker test",
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
    idempotencyScope: `worker:${runId}`,
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
    maxAttempts,
    availableAt: createdAt,
    createdAt,
  });
  return { jobId, organizationId, projectId, runId, stageId, userId };
}

function worker(
  repository: AgentRepository,
  ownerId: string,
  handler: ConstructorParameters<typeof JobAttemptWorkerLoop>[0]["handler"],
) {
  return new JobAttemptWorkerLoop({
    repository,
    ownerId,
    handler,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
  });
}

test("worker errors use a closed classification and retry only explicit temporary failures", () => {
  assert.deepEqual(WORKER_ERROR_CATEGORIES, [
    "validation",
    "configuration",
    "authentication",
    "rate-limit",
    "upstream-temporary",
    "upstream-permanent",
    "data-quality",
    "model-output",
    "infrastructure",
    "cancelled",
  ]);

  for (const category of WORKER_ERROR_CATEGORIES) {
    const classified = classifyWorkerError(
      new WorkerTaskError(category, "safe summary"),
    );
    assert.equal(classified.category, category);
    assert.equal(
      classified.retryable,
      category === "rate-limit" || category === "upstream-temporary",
    );
    assert.equal(classified.message, "safe summary");
  }

  assert.deepEqual(classifyWorkerError(new Error("untrusted details")), {
    category: "infrastructure",
    retryable: false,
    message: "Unhandled worker task failure",
  });
});

test("retry delay is exponential, jitter-injectable, and capped", () => {
  const policy = {
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 250,
    jitterRatio: 0.5,
  } as const;

  assert.equal(computeRetryDelayMs(policy, 1, () => 0), 50);
  assert.equal(computeRetryDelayMs(policy, 2, () => 0.5), 200);
  assert.equal(computeRetryDelayMs(policy, 3, () => 1), 250);
});

test("worker construction rejects an unbounded retry policy", () => {
  const repository = {} as AgentRepository;
  assert.throws(
    () =>
      new JobAttemptWorkerLoop({
        repository,
        ownerId: "invalid-worker",
        handler: async () => ({ status: "succeeded" }),
        leaseDurationMs: 10_000,
        heartbeatIntervalMs: 1_000,
        pollIntervalMs: 100,
        stopTimeoutMs: 1_000,
        retryPolicy: {
          maxAttempts: Number.POSITIVE_INFINITY,
          initialDelayMs: 100,
          maxDelayMs: 1_000,
          jitterRatio: 0,
        },
      }),
    /maxAttempts/,
  );
});

test("two polling workers execute one durable lease only once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-concurrency-"));
  const path = join(directory, "agent.sqlite");
  const firstRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  const secondRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    firstRepository.close();
    secondRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(firstRepository);
  let executions = 0;
  const handler = async () => {
    executions += 1;
    return { status: "succeeded" as const };
  };

  const processed = await Promise.all([
    worker(firstRepository, "worker-a", handler).runOnce(),
    worker(secondRepository, "worker-b", handler).runOnce(),
  ]);

  assert.deepEqual(processed.sort(), [false, true]);
  assert.equal(executions, 1);
  assert.equal((await firstRepository.findRunStage(stageId))?.status, "succeeded");
});

test("stop during an in-flight claim releases the lease without invoking the handler", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-claim-stop-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  let claimEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    claimEntered = resolve;
  });
  const delayedRepository = repositoryWithOverrides(repository, {
    claimNextJob: async (input) => {
      const claimed = await repository.claimNextJob(input);
      claimEntered();
      await claimGate;
      return claimed;
    },
  });
  let executions = 0;
  const loop = worker(delayedRepository, "stopping-claimer", async () => {
    executions += 1;
    return { status: "succeeded" };
  });

  const processing = loop.runOnce();
  await entered;
  const stopping = loop.stop();
  releaseClaim();
  await Promise.all([processing, stopping]);

  assert.equal(executions, 0);
  const released = (await repository.listJobAttempts(stageId))[0];
  assert.equal(released?.status, "queued");
  assert.equal(released?.leasedBy, null);

  let replacementExecutions = 0;
  const replacement = worker(repository, "replacement-claimer", async () => {
    replacementExecutions += 1;
    return { status: "succeeded" };
  });
  assert.equal(await replacement.runOnce(), true);
  assert.equal(replacementExecutions, 1);
  assert.equal((await repository.listJobAttempts(stageId)).length, 1);
});

test("concurrent runOnce calls on one worker execute handlers serially", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-single-flight-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedJob(repository);
  await seedJob(repository);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let activeHandlers = 0;
  let maximumActiveHandlers = 0;
  let executions = 0;
  const loop = worker(repository, "single-flight-worker", async () => {
    executions += 1;
    activeHandlers += 1;
    maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
    if (executions === 1) {
      firstStarted();
      await firstGate;
    }
    activeHandlers -= 1;
    return { status: "succeeded" };
  });

  const first = loop.runOnce();
  const second = loop.runOnce();
  await started;
  await flushAsyncWork();
  assert.equal(maximumActiveHandlers, 1);
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(executions, 2);
  assert.equal(maximumActiveHandlers, 1);
});

test("stop settles a direct runOnce and prevents a queued runOnce claim", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-one-shot-stop-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedJob(repository);
  await seedJob(repository);
  const clock = new ManualClock();
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  let executions = 0;
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "one-shot-stop-worker",
    handler: ({ signal }) =>
      new Promise((resolve) => {
        executions += 1;
        handlerStarted();
        signal.addEventListener(
          "abort",
          () => resolve({ status: "succeeded" }),
          { once: true },
        );
      }),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  let firstSettled = false;
  const first = loop.runOnce().finally(() => {
    firstSettled = true;
  });
  const queued = loop.runOnce();
  await started;
  await loop.stop();

  assert.equal(firstSettled, true);
  assert.equal(await first, true);
  assert.equal(await queued, false);
  assert.equal(executions, 1);
  assert.equal(clock.pendingSleeps, 0);
});

test("heartbeat renews the active lease with its fencing generation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-heartbeat-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  const clock = new ManualClock();
  let releaseHandler!: () => void;
  const handlerFinished = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  let claimedGeneration = 0;
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "heartbeat-worker",
    handler: async ({ job }) => {
      claimedGeneration = job.leaseGeneration;
      handlerStarted();
      await handlerFinished;
      return { status: "succeeded" };
    },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  const processing = loop.runOnce();
  await started;
  const initial = (await repository.listJobAttempts(stageId))[0];
  assert.equal(initial?.leaseExpiresAt, "2026-08-14T08:00:11.000Z");

  clock.advance(1_000);
  await flushAsyncWork();
  const renewed = (await repository.listJobAttempts(stageId))[0];
  assert.equal(renewed?.leaseGeneration, claimedGeneration);
  assert.equal(renewed?.leaseExpiresAt, "2026-08-14T08:00:12.000Z");

  releaseHandler();
  assert.equal(await processing, true);
  assert.equal(clock.pendingSleeps, 0);
});

test("a lost heartbeat lease aborts the handler and fences final state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-lost-lease-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  const clock = new ManualClock();
  let completionCalls = 0;
  const fencedRepository = repositoryWithOverrides(repository, {
    renewJobLease: async () => {
      throw new Error("lease generation changed");
    },
    completeJob: async (input) => {
      completionCalls += 1;
      return repository.completeJob(input);
    },
  });
  let handlerAborted = false;
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const loop = new JobAttemptWorkerLoop({
    repository: fencedRepository,
    ownerId: "stale-worker",
    handler: ({ signal }) =>
      new Promise((resolve, reject) => {
        handlerStarted();
        signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  const processing = loop.runOnce();
  await started;
  clock.advance(1_000);
  await flushAsyncWork();

  assert.equal(await processing, true);
  assert.equal(handlerAborted, true);
  assert.equal(completionCalls, 0);
  assert.equal((await repository.listJobAttempts(stageId))[0]?.status, "running");
  assert.equal(clock.pendingSleeps, 0);
});

test("an explicit temporary failure retries after bounded persisted backoff", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-retry-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  const clock = new ManualClock();
  let executions = 0;
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "retry-worker",
    handler: async () => {
      executions += 1;
      if (executions === 1) {
        throw new WorkerTaskError(
          "upstream-temporary",
          "provider temporarily unavailable",
        );
      }
      return { status: "succeeded" };
    },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.5,
    },
    random: () => 0.5,
    clock,
  });

  assert.equal(await loop.runOnce(), true);
  const failed = (await repository.listJobAttempts(stageId))[0];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.retryable, true);
  assert.equal(failed?.availableAt, "2026-08-14T08:00:01.100Z");
  assert.equal((await repository.findRunStage(stageId))?.status, "queued");
  assert.equal(await loop.runOnce(), false);

  clock.advance(100);
  assert.equal(await loop.runOnce(), true);
  assert.equal(executions, 2);
  assert.deepEqual(
    (await repository.listJobAttempts(stageId)).map((attempt) => attempt.status),
    ["failed", "succeeded"],
  );
  assert.equal((await repository.findRunStage(stageId))?.status, "succeeded");
});

test("temporary failures stop at the lower persisted or policy attempt limit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-retry-limit-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository, 5);
  const clock = new ManualClock();
  let executions = 0;
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "finite-retry-worker",
    handler: async () => {
      executions += 1;
      throw new WorkerTaskError("rate-limit", "Provider rate limited");
    },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  assert.equal(await loop.runOnce(), true);
  clock.advance(100);
  assert.equal(await loop.runOnce(), true);
  clock.advance(10_000);
  assert.equal(await loop.runOnce(), false);

  const attempts = await repository.listJobAttempts(stageId);
  assert.equal(executions, 2);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.retryable, false);
  assert.equal((await repository.findRunStage(stageId))?.status, "failed");
});

test("manual retry starts a fresh bounded automatic retry cycle after restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-manual-cycle-"));
  const path = join(directory, "agent.sqlite");
  const beforeRestart = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const { organizationId, runId, stageId, userId } =
    await seedJob(beforeRestart, 3);
  const clock = new ManualClock();
  let executions = 0;
  const temporaryHandler = async () => {
    executions += 1;
    throw new WorkerTaskError("upstream-temporary", "Provider unavailable");
  };
  const retryPolicy = {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
  } as const;
  const originalCycle = new JobAttemptWorkerLoop({
    repository: beforeRestart,
    ownerId: "original-cycle-worker",
    handler: temporaryHandler,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy,
    clock,
  });

  assert.equal(await originalCycle.runOnce(), true);
  clock.advance(100);
  assert.equal(await originalCycle.runOnce(), true);
  clock.advance(200);
  assert.equal(await originalCycle.runOnce(), true);
  assert.equal(executions, 3);

  await new AnalysisRunService({
    repository: beforeRestart,
    executionContext: { actorId: userId, organizationId },
    now: clock.now,
    createId: randomUUID,
  }).retryStage(runId, "voc-positioning");
  beforeRestart.close();

  const afterRestart = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    afterRestart.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const manualCycle = new JobAttemptWorkerLoop({
    repository: afterRestart,
    ownerId: "manual-cycle-worker",
    handler: temporaryHandler,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy,
    clock,
  });

  assert.equal(await manualCycle.runOnce(), true);
  clock.advance(100);
  assert.equal(await manualCycle.runOnce(), true);
  clock.advance(200);
  assert.equal(await manualCycle.runOnce(), true);
  clock.advance(10_000);
  assert.equal(await manualCycle.runOnce(), false);

  const attempts = await afterRestart.listJobAttempts(stageId);
  assert.equal(executions, 6);
  assert.deepEqual(
    attempts.map(({ retryCycleStartAttempt }) => retryCycleStartAttempt),
    [1, 1, 1, 4, 4, 4],
  );
  assert.deepEqual(
    attempts.map(({ attemptNumber, status }) => ({ attemptNumber, status })),
    [1, 2, 3, 4, 5, 6].map((attemptNumber) => ({
      attemptNumber,
      status: "failed",
    })),
  );
  assert.equal(attempts.at(-1)?.retryable, false);
  assert.equal((await afterRestart.findRunStage(stageId))?.status, "failed");
});

test("manual retry uses the lower persisted or worker retry-cycle limit", async (t) => {
  const cases = [
    { suffix: "persisted", persistedLimit: 2, policyLimit: 5, executions: 2 },
    { suffix: "policy", persistedLimit: 3, policyLimit: 2, executions: 2 },
  ] as const;

  for (const item of cases) {
    const directory = mkdtempSync(
      join(tmpdir(), `worker-loop-cycle-${item.suffix}-`),
    );
    const repository = openSqliteAgentRepository({
      path: join(directory, "agent.sqlite"),
      busyTimeoutMs: 5_000,
    });
    t.after(() => {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const { runId, stageId } = await seedJob(repository, 1);
    const original = await repository.claimNextJob({
      ownerId: `exhaust-${item.suffix}`,
      claimedAt: "2026-08-14T08:00:01.000Z",
      leaseDurationMs: 10_000,
    });
    await repository.failJob({
      jobId: original!.id,
      ownerId: original!.leasedBy!,
      leaseGeneration: original!.leaseGeneration,
      failedAt: "2026-08-14T08:00:01.000Z",
      retryable: false,
      retryAt: null,
      error: { classification: "upstream-temporary", message: "Exhausted" },
    });
    const retried = await repository.retryFailedRunStage({
      runId,
      stageId,
      staleStageIds: [],
      jobId: randomUUID(),
      retriedAt: "2026-08-14T08:00:01.000Z",
      maxAutomaticAttempts: item.persistedLimit,
    });
    assert.equal(retried?.attempt.retryCycleStartAttempt, 2);
    assert.equal(
      retried?.attempt.maxAttempts,
      2 + item.persistedLimit - 1,
    );

    const clock = new ManualClock();
    let executions = 0;
    const loop = new JobAttemptWorkerLoop({
      repository,
      ownerId: `cycle-${item.suffix}`,
      handler: async () => {
        executions += 1;
        throw new WorkerTaskError("upstream-temporary", "Still unavailable");
      },
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 1_000,
      pollIntervalMs: 100,
      stopTimeoutMs: 1_000,
      retryPolicy: {
        maxAttempts: item.policyLimit,
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      clock,
    });

    for (let attempt = 0; attempt < item.executions; attempt += 1) {
      assert.equal(await loop.runOnce(), true);
      clock.advance(100 * 2 ** attempt);
    }
    clock.advance(10_000);
    assert.equal(await loop.runOnce(), false);
    assert.equal(executions, item.executions);
    assert.equal(
      (await repository.listJobAttempts(stageId)).length,
      1 + item.executions,
    );
  }
});

test("a replacement worker recovers an expired persisted lease after reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-recovery-"));
  const path = join(directory, "agent.sqlite");
  const beforeRestart = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const { stageId } = await seedJob(beforeRestart);
  const oldLease = await beforeRestart.claimNextJob({
    ownerId: "old-process",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 1_000,
  });
  beforeRestart.close();

  const afterRestart = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    afterRestart.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const clock = new ManualClock();
  clock.advance(1_001);
  let recoveredAttempt = 0;
  const loop = new JobAttemptWorkerLoop({
    repository: afterRestart,
    ownerId: "replacement-process",
    handler: async ({ job }) => {
      recoveredAttempt = job.attemptNumber;
      assert.ok(job.leaseGeneration > (oldLease?.leaseGeneration ?? 0));
      return { status: "succeeded" };
    },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  assert.equal(await loop.runOnce(), true);
  assert.equal(recoveredAttempt, 2);
  assert.deepEqual(
    (await afterRestart.listJobAttempts(stageId)).map((attempt) => attempt.status),
    ["failed", "succeeded"],
  );
});

test("an expired final lease closes the stage instead of leaving it running", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-final-lease-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository, 1);
  await repository.claimNextJob({
    ownerId: "lost-final-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 1_000,
  });
  const clock = new ManualClock();
  clock.advance(1_001);
  const replacement = new JobAttemptWorkerLoop({
    repository,
    ownerId: "replacement-worker",
    handler: async () => ({ status: "succeeded" }),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  assert.equal(await replacement.runOnce(), false);
  const stage = await repository.findRunStage(stageId);
  assert.equal(stage?.status, "failed");
  assert.equal(stage?.completedAt, "2026-08-14T08:00:02.001Z");
  assert.equal(stage?.lastError?.classification, "infrastructure");
});

test("waiting-input pauses the stage without ordinary automatic retry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-waiting-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  const clock = new ManualClock();
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "waiting-worker",
    handler: async () => ({
      status: "waiting-input",
      error: {
        category: "authentication",
        message: "Connector credentials are required",
      },
    }),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  assert.equal(await loop.runOnce(), true);
  assert.equal((await repository.findRunStage(stageId))?.status, "waiting-input");
  assert.equal((await repository.listJobAttempts(stageId))[0]?.retryable, false);
  clock.advance(60_000);
  assert.equal(await loop.runOnce(), false);
});

test("an existing budget policy result pauses as budget-exceeded without retry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-budget-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  const loop = worker(repository, "budget-worker", async () => {
    throw new BudgetExceededError("run", "tokens", 900, 200, 1_000);
  });

  assert.equal(await loop.runOnce(), true);
  assert.equal(
    (await repository.findRunStage(stageId))?.status,
    "budget-exceeded",
  );
  assert.equal((await repository.listJobAttempts(stageId))[0]?.retryable, false);
  assert.equal(await loop.runOnce(), false);
});

test("a cancelled task reaches cancelled without automatic retry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-cancelled-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  const loop = worker(repository, "cancelled-worker", async () => {
    throw new WorkerTaskError("cancelled", "Task was cancelled");
  });

  assert.equal(await loop.runOnce(), true);
  assert.equal((await repository.findRunStage(stageId))?.status, "cancelled");
  const attempt = (await repository.listJobAttempts(stageId))[0];
  assert.equal(attempt?.status, "cancelled");
  assert.equal(attempt?.retryable, false);
  assert.equal(await loop.runOnce(), false);
});

test("worker logs contain correlation summaries but no task error content", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-logging-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { jobId, runId, stageId } = await seedJob(repository);
  const entries: Array<{ metadata: WorkerLogSummary; event: string }> = [];
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "logging-worker",
    handler: async () => {
      throw new WorkerTaskError(
        "upstream-permanent",
        "Bearer should-never-appear with full output",
      );
    },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock: new ManualClock(),
    logger: {
      info(metadata, event) {
        entries.push({ metadata, event });
      },
    },
  });

  await loop.runOnce();

  assert.deepEqual(entries, [
    {
      event: "worker job settled",
      metadata: {
        runId,
        stageId,
        stage: "voc-positioning",
        attemptId: jobId,
        attemptNumber: 1,
        classification: "upstream-permanent",
        outcome: "failed",
        durationMs: 0,
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /Bearer|full output|should-never/);
});

test("invalid handler outcomes fail safely without completing or leaking raw values", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-invalid-outcome-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const jobs = [
    await seedJob(repository),
    await seedJob(repository),
    await seedJob(repository),
  ];
  const invalidOutcomes: unknown[] = [
    undefined,
    { status: "unknown", secret: "Bearer unknown-secret" },
    { status: "succeeded", cancel: true, secret: "Bearer control-secret" },
  ];
  const entries: Array<{ metadata: WorkerLogSummary; event: string }> = [];
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "invalid-outcome-worker",
    handler: async () => invalidOutcomes.shift(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock: new ManualClock(),
    logger: {
      info(metadata, event) {
        entries.push({ metadata, event });
      },
    },
  });

  assert.deepEqual(
    await Promise.all([loop.runOnce(), loop.runOnce(), loop.runOnce()]),
    [true, true, true],
  );
  for (const { stageId } of jobs) {
    assert.equal((await repository.findRunStage(stageId))?.status, "failed");
    const attempt = (await repository.listJobAttempts(stageId))[0];
    assert.equal(attempt?.status, "failed");
    assert.deepEqual(attempt?.error, {
      classification: "model-output",
      message: "Worker handler returned an invalid outcome",
    });
  }
  assert.equal(entries.length, 3);
  assert.ok(
    entries.every(
      ({ metadata }) =>
        metadata.classification === "model-output" &&
        metadata.outcome === "failed",
    ),
  );
  assert.doesNotMatch(JSON.stringify(entries), /Bearer|secret|cancel/);
});

test("a heartbeat timer failure aborts pending work without settling the durable lease", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-heartbeat-error-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { stageId } = await seedJob(repository);
  let completeCalls = 0;
  let failCalls = 0;
  const observedRepository = repositoryWithOverrides(repository, {
    completeJob: async (input) => {
      completeCalls += 1;
      return repository.completeJob(input);
    },
    failJob: async (input) => {
      failCalls += 1;
      return repository.failJob(input);
    },
  });
  let sleepCalls = 0;
  let pendingSleeps = 0;
  let rejectHeartbeat!: (error: Error) => void;
  const clock = {
    now: () => "2026-08-14T08:00:01.000Z",
    sleep: (_durationMs: number, signal: AbortSignal) => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectHeartbeat = reject;
        });
      }
      return new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        pendingSleeps += 1;
        signal.addEventListener(
          "abort",
          () => {
            pendingSleeps -= 1;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    },
  };
  const entries: Array<{ metadata: WorkerLogSummary; event: string }> = [];
  let handlerSignal: AbortSignal | undefined;
  let handlerAborted = false;
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const loop = new JobAttemptWorkerLoop({
    repository: observedRepository,
    ownerId: "heartbeat-error-worker",
    handler: ({ signal }) =>
      new Promise((resolve) => {
        handlerSignal = signal;
        handlerStarted();
        signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
            resolve({ status: "succeeded" });
          },
          { once: true },
        );
      }),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
    logger: {
      info(metadata, event) {
        entries.push({ metadata, event });
      },
    },
  });

  const processing = loop.runOnce();
  await started;
  rejectHeartbeat(new Error("Bearer heartbeat-internal-secret"));
  const settledPromptly = await Promise.race([
    processing.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  if (!settledPromptly) await loop.stop();

  assert.equal(settledPromptly, true);
  assert.equal(await processing, true);
  assert.equal(handlerAborted, true);
  assert.equal(handlerSignal?.aborted, true);
  assert.equal(completeCalls, 0);
  assert.equal(failCalls, 0);
  assert.equal((await repository.listJobAttempts(stageId))[0]?.status, "running");
  assert.equal((await repository.findRunStage(stageId))?.status, "running");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.metadata.classification, "infrastructure");
  assert.equal(entries[0]?.metadata.outcome, "lease-lost");
  assert.doesNotMatch(JSON.stringify(entries), /Bearer|heartbeat-internal-secret/);
  await loop.stop();
  assert.equal(pendingSleeps, 0);
});

test("graceful stop aborts active work, claims nothing new, and clears worker sleeps", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-stop-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await seedJob(repository);
  const second = await seedJob(repository);
  const clock = new ManualClock();
  let executions = 0;
  let handlerAborted = false;
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "stopping-worker",
    handler: ({ signal }) =>
      new Promise((resolve) => {
        executions += 1;
        handlerStarted();
        signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
            resolve({ status: "succeeded" });
          },
          { once: true },
        );
      }),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  loop.start();
  await started;
  await loop.stop();

  assert.equal(executions, 1);
  assert.equal(handlerAborted, true);
  const attempts = [
    ...(await repository.listJobAttempts(first.stageId)),
    ...(await repository.listJobAttempts(second.stageId)),
  ];
  assert.deepEqual(
    attempts.map((attempt) => attempt.status).sort(),
    ["queued", "running"],
  );
  assert.equal(clock.pendingSleeps, 0);
  assert.equal(await loop.runOnce(), false);
});

test("stop remains bounded when a handler ignores its abort signal", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "worker-loop-bounded-stop-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedJob(repository);
  const clock = new ManualClock();
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "bounded-stop-worker",
    handler: () => {
      handlerStarted();
      return new Promise(() => undefined);
    },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock,
  });

  loop.start();
  await started;
  const stoppedBeforeNextTurn = await Promise.race([
    loop.stop().then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);

  assert.equal(stoppedBeforeNextTurn, true);
  assert.equal(clock.pendingSleeps, 0);
});
