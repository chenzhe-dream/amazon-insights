import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { z } from "zod";

import type { AgentRunRepository } from "../../server/db/agent-run-repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import {
  AgentRunPersistenceError,
  AgentRunReplayError,
  AuditedSkillRunner,
  type AuditedSkillExecutionContext,
} from "../../server/runtime/agent-run-service";
import {
  ModelBudgetCoordinator,
  StaticModelBudgetLimitProvider,
} from "../../server/runtime/model-budget-coordinator";
import type {
  ModelProvider,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "../../server/runtime/model-provider";
import { ModelProviderError } from "../../server/runtime/model-provider";
import { WorkerTaskError } from "../../server/runtime/retry-policy";
import {
  SkillRunner,
  type SkillExecutionRequest,
} from "../../server/runtime/skill-runner";
import { SkillRegistry } from "../../server/skills/registry";

const now = "2026-08-15T08:00:00.000Z";
const leaseOwnerId = "audited-worker";
const inputSchema = z
  .object({
    asins: z.array(z.string()),
    themes: z.array(z.object({ name: z.string(), mentions: z.number() }).strict()),
  })
  .strict();
const outputSchema = z.object({ summary: z.string() }).strict();
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

class FakeProvider implements ModelProvider {
  readonly requests: StructuredGenerationRequest<unknown>[] = [];

  constructor(
    private readonly generate: (
      request: StructuredGenerationRequest<unknown>,
      attempt: number,
    ) => Promise<StructuredGenerationResult<unknown>> = async () => ({
      value: { summary: "durable private conclusion" },
      responseId: "resp_audited_1",
      inputTokens: 80,
      outputTokens: 20,
    }),
  ) {}

  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    this.requests.push(request as StructuredGenerationRequest<unknown>);
    return (await this.generate(
      request as StructuredGenerationRequest<unknown>,
      this.requests.length,
    )) as StructuredGenerationResult<T>;
  }
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "audited-skill-run-"));
  return { directory, databasePath: join(directory, "agent.sqlite") };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, timeoutMs = 2_000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Audited Skill test synchronization timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function seedActiveExecution(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  databasePath: string,
) {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobAttemptId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createUser({
    id: userId,
    organizationId,
    email: `${userId}@example.com`,
    displayName: "Audited run test",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Audited run test",
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
    idempotencyScope: `audited:${runId}`,
    idempotencyKey: "create",
    createdAt: now,
    updatedAt: now,
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
    createdAt: now,
    updatedAt: now,
  });
  await repository.enqueueJob({
    id: jobAttemptId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
  });
  const claimed = await repository.claimNextJob({
    ownerId: leaseOwnerId,
    claimedAt: now,
    leaseDurationMs: 60_000,
  });
  assert.equal(claimed?.id, jobAttemptId);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO data_snapshots
       (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
        sources_json, payload_json, content_hash, created_at)
       VALUES (?, ?, '1.0.0', 'US', ?, ?, ?, '{}', ?, ?)`,
    )
    .run(
      snapshotId,
      runId,
      JSON.stringify(["B0ABC12345", "B0DEF67890", "B0GHI13579"]),
      now,
      JSON.stringify([
        {
          type: "repository-data",
          reference: "fixture",
          capturedAt: now,
          checksum: "a".repeat(64),
        },
      ]),
      "b".repeat(64),
      now,
    );
  database.close();
  return {
    organizationId,
    projectId,
    runId,
    stageId,
    jobAttemptId,
    snapshotId,
    leaseGeneration: claimed!.leaseGeneration,
  };
}

function executionRequest(
  snapshotId: string,
  overrides: Partial<SkillExecutionRequest<Input, Output>> = {},
): SkillExecutionRequest<Input, Output> {
  return {
    skill: { id: "define-amazon-voc-positioning", version: "1.0.0" },
    inputContract: {
      name: "VocPositioningInput@1.0.0",
      schema: inputSchema,
      allowedFields: ["asins", "themes"],
    },
    outputContract: {
      name: "VocPositioningOutput@1.0.0",
      schema: outputSchema,
    },
    input: {
      asins: ["B000000001", "B000000002", "B000000003"],
      themes: [{ name: "private customer review", mentions: 12 }],
    },
    snapshotIds: [snapshotId],
    model: {
      name: "configured-test-model",
      estimatedInputTokens: 200,
      maxOutputTokens: 100,
      timeoutMs: 1_000,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
      },
    },
    ...overrides,
  };
}

async function createHarness(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  provider: FakeProvider,
  logs: unknown[] = [],
  auditRepository: AgentRunRepository = repository as unknown as AgentRunRepository,
  clockStartMs = Date.parse(now),
) {
  const registry = await SkillRegistry.open(path.resolve("skills-src"));
  let tick = clockStartMs;
  const clock = () => new Date((tick += 10));
  const runner = new SkillRunner({
    registry,
    provider,
    providerName: "fake",
    budgetCoordinator: new ModelBudgetCoordinator({
      repository,
      limitProvider: new StaticModelBudgetLimitProvider({
        call: { maxTokens: 10_000, maxCostMicros: 10_000 },
        run: { maxTokens: 10_000, maxCostMicros: 10_000 },
        organizationUtcDay: { maxTokens: 10_000, maxCostMicros: 10_000 },
      }),
      clock,
      createId: randomUUID,
    }),
    sleep: async () => {},
    now: () => tick,
  });
  return new AuditedSkillRunner({
    skillRunner: runner,
    repository: auditRepository,
    clock,
    createId: randomUUID,
    logger: (entry) => logs.push(entry),
  });
}

function auditContext(
  subject: Awaited<ReturnType<typeof seedActiveExecution>>,
): AuditedSkillExecutionContext {
  return {
    organizationId: subject.organizationId,
    runId: subject.runId,
    projectId: subject.projectId,
    stageId: subject.stageId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    dataCutoffAt: now,
  };
}

test("successful audit survives restart, replays without provider, and conflicts on drift", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const provider = new FakeProvider();
  const logs: unknown[] = [];
  const service = await createHarness(sqlite, provider, logs);
  const request = executionRequest(subject.snapshotId);

  const first = await service.run(request, auditContext(subject));
  assert.equal(provider.requests.length, 1);
  assert.equal(first.replayed, false);
  assert.equal(first.agentRun.validationStatus, "passed");
  assert.equal(first.agentRun.usageCompleteness, "complete");
  assert.equal(first.agentRun.estimatedCostMicros, 120);
  sqlite.close();

  const reopened = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    reopened.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const replayService = await createHarness(reopened, provider, logs);
  const replay = await replayService.run(request, auditContext(subject));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, first.value);
  assert.equal(provider.requests.length, 1);

  await assert.rejects(
    replayService.run(
      executionRequest(subject.snapshotId, {
        input: {
          ...(request.input as Input),
          themes: [{ name: "changed input", mentions: 12 }],
        },
      }),
      auditContext(subject),
    ),
    /execution identity|conflict/i,
  );
  await assert.rejects(
    replayService.run(
      executionRequest(subject.snapshotId, {
        model: {
          ...request.model,
          pricing: {
            ...request.model.pricing,
            outputUsdPerMillionTokens: 3,
          },
        },
      }),
      auditContext(subject),
    ),
    /execution identity|conflict/i,
  );
  assert.equal(provider.requests.length, 1);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /private customer review|durable private conclusion/);
  assert.match(serializedLogs, /contentHash|recordCount|estimatedCostMicros/);
});

test("concurrent AuditedSkillRunner calls share one claim and one provider dispatch", async (t) => {
  const temporary = temporaryDatabase();
  const firstRepository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  const subject = await seedActiveExecution(firstRepository, temporary.databasePath);
  const secondRepository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    secondRepository.close();
    firstRepository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const provider = new FakeProvider(async () => {
    await providerGate;
    return {
      value: { summary: "single durable winner" },
      responseId: "resp_single_claim",
      inputTokens: 80,
      outputTokens: 20,
    };
  });
  const owner = await createHarness(firstRepository, provider);
  const observerBegan = deferred();
  const releaseObserverBegin = deferred();
  const observerRepository = new Proxy(
    secondRepository as unknown as AgentRunRepository,
    {
      get(target, property, receiver) {
        if (property === "beginAgentRun") {
          return async (...args: Parameters<AgentRunRepository["beginAgentRun"]>) => {
            const result = await target.beginAgentRun(...args);
            if (result.claimStatus === "observing") {
              observerBegan.resolve();
              await releaseObserverBegin.promise;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    },
  );
  const observer = await createHarness(
    secondRepository,
    provider,
    [],
    observerRepository,
  );
  const request = executionRequest(subject.snapshotId);
  const first = owner.run(request, auditContext(subject));
  while (provider.requests.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const second = observer.run(request, auditContext(subject));
  await within(observerBegan.promise);

  try {
    assert.equal(provider.requests.length, 1);
  } finally {
    releaseObserverBegin.resolve();
    releaseProvider();
  }
  const results = await Promise.all([first, second]);
  assert.equal(provider.requests.length, 1);
  assert.equal(results.every((result) => result.agentRun.validationStatus === "passed"), true);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
});

test("observer after ledger settle waits for the claim owner to finalize passed", async (t) => {
  const temporary = temporaryDatabase();
  const firstRepository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  const subject = await seedActiveExecution(firstRepository, temporary.databasePath);
  const secondRepository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    secondRepository.close();
    firstRepository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const provider = new FakeProvider();
  const finalizeReached = deferred();
  const releaseFinalize = deferred();
  const delayedFinalizeRepository = new Proxy(
    firstRepository as unknown as AgentRunRepository,
    {
      get(target, property, receiver) {
        if (property === "finalizeAgentRun") {
          return async (...args: Parameters<AgentRunRepository["finalizeAgentRun"]>) => {
            finalizeReached.resolve();
            await releaseFinalize.promise;
            return target.finalizeAgentRun(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    },
  );
  const observerBegan = deferred();
  const observingRepository = new Proxy(
    secondRepository as unknown as AgentRunRepository,
    {
      get(target, property, receiver) {
        if (property === "beginAgentRun") {
          return async (...args: Parameters<AgentRunRepository["beginAgentRun"]>) => {
            const result = await target.beginAgentRun(...args);
            if (result.claimStatus === "observing") observerBegan.resolve();
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    },
  );
  const owner = await createHarness(
    firstRepository,
    provider,
    [],
    delayedFinalizeRepository,
  );
  const observer = await createHarness(
    secondRepository,
    provider,
    [],
    observingRepository,
  );
  const request = executionRequest(subject.snapshotId);
  const first = owner.run(request, auditContext(subject));
  await within(finalizeReached.promise);
  const second = observer.run(request, auditContext(subject));

  try {
    await within(observerBegan.promise);
    assert.equal(provider.requests.length, 1);
  } finally {
    releaseFinalize.resolve();
  }
  const results = await Promise.all([first, second]);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(results.every((result) => result.agentRun.validationStatus === "passed"), true);
});

test("terminal replay revalidates saved output through the current caller schema", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const provider = new FakeProvider();
  const service = await createHarness(sqlite, provider);
  await service.run(executionRequest(subject.snapshotId), auditContext(subject));
  const currentSchema = z
    .object({ summary: z.string().refine((value) => value === "new-only") })
    .strict();
  const changedRuntimeContract = executionRequest(subject.snapshotId, {
    outputContract: {
      name: "VocPositioningOutput@1.0.0",
      schema: currentSchema,
    } as never,
  });

  await assert.rejects(
    service.run(changedRuntimeContract, auditContext(subject)),
    AgentRunReplayError,
  );
  assert.equal(provider.requests.length, 1);
});

test("provider failure persists safe partial usage and metadata-only logs", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const logs: unknown[] = [];
  const provider = new FakeProvider(async () => {
    throw new ModelProviderError(
      "permanent",
      "Bearer sk-secret full provider response and customer review",
    );
  });
  const service = await createHarness(sqlite, provider, logs);
  const unsafeIdentifiers = executionRequest(subject.snapshotId);
  unsafeIdentifiers.model.name = "sk-secret-model";

  await assert.rejects(
    service.run(unsafeIdentifiers, auditContext(subject)),
    /model provider request failed/i,
  );
  const [failed] = await (sqlite as unknown as AgentRunRepository).listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(failed.validationStatus, "failed");
  assert.equal(failed.usageCompleteness, "partial");
  assert.deepEqual(failed.terminalMetadata, {
    kind: "failed",
    classification: "upstream-permanent",
  });
  assert.equal(failed.inputTokens, 200);
  assert.equal(failed.outputTokens, 100);
  assert.equal(failed.estimatedCostMicros, 400);
  assert.deepEqual(failed.error, {
    code: "UPSTREAM_PERMANENT",
    message: "Model provider request failed",
    requestId: `agent-run:${failed.id}`,
    retryable: false,
  });
  const serialized = JSON.stringify({ failed: failed.error, logs });
  assert.doesNotMatch(serialized, /Bearer|sk-secret|customer review|provider response/);
  assert.match(serialized, /upstream-permanent|estimatedCostMicros/);
  await assert.rejects(
    service.run(unsafeIdentifiers, auditContext(subject)),
    (error: unknown) =>
      error instanceof WorkerTaskError &&
      error.category === "upstream-permanent" &&
      error.message === "Model provider request failed",
  );
  assert.equal(provider.requests.length, 1);
});

test("terminal cancellation replay restores WorkerTaskError cancelled semantics", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const provider = new FakeProvider(async () => {
    throw new ModelProviderError("aborted", "unsafe provider cancellation text");
  });
  const service = await createHarness(sqlite, provider);
  const request = executionRequest(subject.snapshotId);
  await assert.rejects(service.run(request, auditContext(subject)), /aborted/i);
  const [cancelled] = await (sqlite as unknown as AgentRunRepository).listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.terminalMetadata, { kind: "cancelled" });

  await assert.rejects(
    service.run(request, auditContext(subject)),
    (error: unknown) =>
      error instanceof WorkerTaskError &&
      error.category === "cancelled" &&
      error.message === "Skill execution was cancelled",
  );
  assert.equal(provider.requests.length, 1);
});

test("passed audit remains partial when an earlier dispatched retry has no usage", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const provider = new FakeProvider(async (_request, attempt) => {
    if (attempt === 1) {
      throw new ModelProviderError("transient", "usage unavailable");
    }
    return {
      value: { summary: "eventual success" },
      responseId: "resp_partial_success",
      inputTokens: 80,
      outputTokens: 20,
    };
  });
  const service = await createHarness(sqlite, provider);

  const result = await service.run(
    executionRequest(subject.snapshotId),
    auditContext(subject),
  );
  assert.equal(result.agentRun.validationStatus, "passed");
  assert.equal(result.agentRun.usageCompleteness, "partial");
  assert.equal(result.agentRun.inputTokens, 280);
  assert.equal(result.agentRun.outputTokens, 120);
  assert.equal(result.agentRun.estimatedCostMicros, 520);
  assert.deepEqual(
    result.agentRun.attempts.map((attempt) => ({
      accounting: attempt.accounting,
      classification: attempt.errorClassification,
      kind: attempt.kind,
    })),
    [
      {
        accounting: "projected",
        classification: "upstream-temporary",
        kind: "initial",
      },
      {
        accounting: "settled",
        classification: null,
        kind: "transient-retry",
      },
    ],
  );
});

test("pre-dispatch budget failure persists unavailable usage without fabricated zeroes", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const provider = new FakeProvider();
  const service = await createHarness(sqlite, provider);
  const oversized = executionRequest(subject.snapshotId);
  oversized.model.estimatedInputTokens = 10_000;
  oversized.model.maxOutputTokens = 1;

  await assert.rejects(
    service.run(oversized, auditContext(subject)),
    /budget exceeded/i,
  );
  assert.equal(provider.requests.length, 0);
  const [failed] = await (sqlite as unknown as AgentRunRepository).listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(failed.status, "budget-exceeded");
  assert.equal(failed.usageCompleteness, "unavailable");
  assert.equal(failed.inputTokens, null);
  assert.equal(failed.outputTokens, null);
  assert.equal(failed.estimatedCostMicros, null);
  assert.equal(failed.attemptCount, 0);
  assert.deepEqual(failed.terminalMetadata, {
    kind: "budget-exceeded",
    scope: "call",
    metric: "tokens",
    used: 0,
    projected: 10_001,
    limit: 10_000,
  });
  await assert.rejects(
    service.run(oversized, auditContext(subject)),
    (error: unknown) =>
      error instanceof BudgetExceededError &&
      error.scope === "call" &&
      error.metric === "tokens" &&
      error.used === 0 &&
      error.projected === 10_001 &&
      error.limit === 10_000,
  );
  assert.equal(provider.requests.length, 0);
});

test("finalize failure never repeats the provider call and restart recovers ledger usage", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  const subject = await seedActiveExecution(sqlite, temporary.databasePath);
  const provider = new FakeProvider();
  const base = sqlite as unknown as AgentRunRepository;
  let failFinalize = true;
  const flaky = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "finalizeAgentRun") {
        return async (...args: Parameters<AgentRunRepository["finalizeAgentRun"]>) => {
          if (failFinalize) {
            failFinalize = false;
            throw new Error("database contains sk-secret customer payload");
          }
          return target.finalizeAgentRun(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const firstService = await createHarness(sqlite, provider, [], flaky);
  await assert.rejects(
    firstService.run(executionRequest(subject.snapshotId), auditContext(subject)),
    AgentRunPersistenceError,
  );
  assert.equal(provider.requests.length, 1);
  sqlite.close();

  const reopened = openSqliteAgentRepository({ path: temporary.databasePath, busyTimeoutMs: 5_000 });
  t.after(() => {
    reopened.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const recovery = await createHarness(
    reopened,
    provider,
    [],
    reopened as unknown as AgentRunRepository,
    Date.parse(now) + 31_000,
  );
  await assert.rejects(
    recovery.run(executionRequest(subject.snapshotId), auditContext(subject)),
    AgentRunPersistenceError,
  );
  assert.equal(provider.requests.length, 1);
  const [failed] = await (reopened as unknown as AgentRunRepository).listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(failed.validationStatus, "failed");
  assert.equal(failed.usageCompleteness, "complete");
  assert.equal(failed.model.responseId, "resp_audited_1");
  assert.equal(failed.attempts[0]?.errorClassification, "unavailable");
  assert.doesNotMatch(JSON.stringify(failed.error), /sk-secret|customer payload/);
});
