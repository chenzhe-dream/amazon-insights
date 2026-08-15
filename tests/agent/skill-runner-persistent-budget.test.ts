import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { z } from "zod";

import {
  ModelBudgetReservationConflictError,
  type ModelBudgetLimits,
} from "../../server/db/model-budget-repository";
import { openSqliteAgentRepository as openSqliteAgentRepositoryBase } from "../../server/db/sqlite-repository";
import { BudgetExceededError } from "../../server/runtime/budget-policy";
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
import { OpenAIProvider } from "../../server/runtime/openai-provider";
import {
  SkillRunner,
  SkillRuntimeError,
  type SkillExecutionContext,
  type SkillExecutionRequest,
  type SkillModelBudgetCoordinator,
} from "../../server/runtime/skill-runner";
import { SkillRegistry } from "../../server/skills/registry";
import { JobAttemptWorkerLoop } from "../../server/runtime/worker-loop";

const inputSchema = z
  .object({
    asins: z.array(z.string()),
    themes: z.array(
      z.object({ name: z.string(), mentions: z.number() }).strict(),
    ),
  })
  .strict();
const outputSchema = z.object({ summary: z.string() }).strict();
type Output = z.infer<typeof outputSchema>;
type Input = z.infer<typeof inputSchema>;

const createdAt = "2026-08-14T08:00:00.000Z";

function openSqliteAgentRepository(
  options: Parameters<typeof openSqliteAgentRepositoryBase>[0],
) {
  return openSqliteAgentRepositoryBase({
    ...options,
    nowProvider: options.nowProvider ?? (() => new Date(createdAt)),
  });
}

class FakeProvider implements ModelProvider {
  readonly requests: StructuredGenerationRequest<unknown>[] = [];

  constructor(
    private readonly generate: (
      request: StructuredGenerationRequest<unknown>,
      attempt: number,
    ) => Promise<StructuredGenerationResult<unknown>> = async () => ({
      value: { summary: "persistent budget result" },
      responseId: "resp_persistent_1",
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

function temporaryDatabase(prefix = "skill-runner-budget-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, "agent.sqlite") };
}

async function seedSubject(
  repository: ReturnType<typeof openSqliteAgentRepository>,
) {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobAttemptId = randomUUID();
  await repository.createUser({
    id: userId,
    organizationId,
    email: `${userId}@example.com`,
    displayName: "Persistent budget test",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Persistent budget test",
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
    status: "running",
    createdBy: userId,
    dataCutoffAt: createdAt,
    idempotencyScope: `skill-budget:${runId}`,
    idempotencyKey: "create",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createRunStage({
    id: stageId,
    runId,
    stage: "traffic-analysis",
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
    id: jobAttemptId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
  });
  const claimed = await repository.claimNextJob({
    ownerId: "budget-fixture",
    claimedAt: createdAt,
    leaseDurationMs: 60_000,
  });
  assert.equal(claimed?.id, jobAttemptId);
  await repository.completeJob({
    jobId: jobAttemptId,
    ownerId: "budget-fixture",
    leaseGeneration: claimed!.leaseGeneration,
    completedAt: createdAt,
  });
  return { organizationId, projectId, runId, stageId, jobAttemptId };
}

function limits(
  maxTokens = 1_000_000,
  maxCostMicros = 1_000_000,
): ModelBudgetLimits {
  return {
    call: { maxTokens, maxCostMicros },
    run: { maxTokens, maxCostMicros },
    organizationUtcDay: { maxTokens, maxCostMicros },
  };
}

function request(
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
      themes: [{ name: "raw-private-theme", mentions: 12 }],
    },
    snapshotIds: ["33333333-3333-4333-8333-333333333333"],
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

function context(
  subject: { runId: string; projectId: string; jobAttemptId: string },
  jobAttemptId: string = subject.jobAttemptId,
): SkillExecutionContext {
  return {
    runId: subject.runId as SkillExecutionContext["runId"],
    projectId: subject.projectId as SkillExecutionContext["projectId"],
    jobAttemptId: jobAttemptId as SkillExecutionContext["jobAttemptId"],
  };
}

async function runner(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  provider: ModelProvider,
  configuredLimits = limits(),
  options: {
    coordinator?: SkillModelBudgetCoordinator;
    logger?: (value: unknown) => void;
  } = {},
) {
  const registry = await SkillRegistry.open(path.resolve("skills-src"));
  return new SkillRunner({
    registry,
    provider,
    providerName: "fake",
    budgetCoordinator:
      options.coordinator ??
      new ModelBudgetCoordinator({
        repository,
        limitProvider: new StaticModelBudgetLimitProvider(configuredLimits),
        clock: () => new Date(createdAt),
        createId: randomUUID,
      }),
    sleep: async () => {},
    logger: options.logger,
  });
}

for (const scope of ["call", "run", "organizationUtcDay"] as const) {
  for (const metric of ["tokens", "costMicros"] as const) {
    test(`${scope} ${metric} exhaustion fences the provider with the exact budget error`, async (t) => {
      const temporary = temporaryDatabase();
      const repository = openSqliteAgentRepository({
        path: temporary.databasePath,
        busyTimeoutMs: 5_000,
      });
      t.after(() => {
        repository.close();
        rmSync(temporary.directory, { recursive: true, force: true });
      });
      const subject = await seedSubject(repository);
      const configured = limits();
      if (metric === "tokens") configured[scope].maxTokens = 299;
      else configured[scope].maxCostMicros = 399;
      const provider = new FakeProvider();
      const skillRunner = await runner(repository, provider, configured);

      await assert.rejects(
        skillRunner.run(request(), context(subject)),
        (error: unknown) =>
          error instanceof BudgetExceededError &&
          error.scope === (scope === "organizationUtcDay" ? "daily" : scope) &&
          error.metric === metric,
      );
      assert.equal(provider.requests.length, 0);
    });
  }
}

for (const state of ["reserved", "dispatched", "settled"] as const) {
  test(`persisted ${state} usage survives repository restart and blocks a new request`, async (t) => {
    const temporary = temporaryDatabase();
    const first = openSqliteAgentRepository({
      path: temporary.databasePath,
      busyTimeoutMs: 5_000,
    });
    const subject = await seedSubject(first);
    const configured = limits(300, 400);
    const firstCoordinator = new ModelBudgetCoordinator({
      repository: first,
      limitProvider: new StaticModelBudgetLimitProvider(configured),
      clock: () => new Date(createdAt),
      createId: randomUUID,
    });
    const reservation = await firstCoordinator.reserve({
      idempotencyKey: `${state}-existing`,
      requestFingerprint: "a".repeat(64),
      runId: subject.runId,
      projectId: subject.projectId,
      projected: { inputTokens: 200, outputTokens: 100, costMicros: 400 },
    });
    if (state === "dispatched") await firstCoordinator.dispatch(reservation.id);
    if (state === "settled") {
      await firstCoordinator.settle(reservation.id, {
        inputTokens: 200,
        outputTokens: 100,
        costMicros: 400,
      });
    }
    first.close();

    const reopened = openSqliteAgentRepository({
      path: temporary.databasePath,
      busyTimeoutMs: 5_000,
    });
    t.after(() => {
      reopened.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const provider = new FakeProvider();
    const skillRunner = await runner(reopened, provider, configured);

    await assert.rejects(
      skillRunner.run(request(), context(subject)),
      (error: unknown) =>
        error instanceof BudgetExceededError && error.scope === "run",
    );
    assert.equal(provider.requests.length, 0);
  });
}

test("two runners and SQLite connections grant exactly one provider dispatch", async (t) => {
  const temporary = temporaryDatabase();
  const first = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  const second = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    first.close();
    second.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(first);
  const provider = new FakeProvider();
  const left = await runner(first, provider);
  const right = await runner(second, provider);
  const executionContext = context(subject);

  const results = await Promise.allSettled([
    left.run(request(), executionContext),
    right.run(request(), executionContext),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(provider.requests.length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.reason instanceof SkillRuntimeError);
  assert.equal(rejected.reason.code, "PROVIDER_ERROR");
  assert.doesNotMatch(rejected.reason.message, new RegExp(subject.runId));
});

test("initial, two transient retries, and format repair have distinct persistent accounting", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const provider = new FakeProvider(async (_request, attempt) => {
    if (attempt === 1) {
      throw new ModelProviderError("transient", "billed transient", {
        usage: {
          responseId: "resp_transient_1",
          inputTokens: 10,
          outputTokens: 5,
        },
      });
    }
    if (attempt === 2) {
      throw new ModelProviderError("transient", "unknown usage transient");
    }
    if (attempt === 3) {
      return {
        value: { wrong: "shape" },
        responseId: "resp_invalid_3",
        inputTokens: 20,
        outputTokens: 10,
      };
    }
    return {
      value: { summary: "repaired" },
      responseId: "resp_repaired_4",
      inputTokens: 30,
      outputTokens: 15,
    };
  });
  const skillRunner = await runner(repository, provider);

  const result = await skillRunner.run(request(), context(subject));

  assert.equal(provider.requests.length, 4);
  assert.equal(result.record.attemptCount, 4);
  assert.equal(result.record.inputTokens, 60);
  assert.equal(result.record.outputTokens, 30);
  assert.equal(result.record.estimatedCostMicros, 120);
  assert.equal(result.record.estimatedCostUsd, 0.00012);
  assert.deepEqual(result.record.attempts, [
    {
      ordinal: 0,
      kind: "initial",
      transientRetryCount: 0,
      formatRepair: false,
      accounting: "settled",
      errorClassification: "upstream-temporary",
    },
    {
      ordinal: 1,
      kind: "transient-retry",
      transientRetryCount: 1,
      formatRepair: false,
      accounting: "unavailable",
      errorClassification: "upstream-temporary",
    },
    {
      ordinal: 2,
      kind: "transient-retry",
      transientRetryCount: 2,
      formatRepair: false,
      accounting: "settled",
      errorClassification: "model-output",
    },
    {
      ordinal: 3,
      kind: "format-repair",
      transientRetryCount: 2,
      formatRepair: true,
      accounting: "settled",
      errorClassification: null,
    },
  ]);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  const rows = inspector
    .prepare(
      `SELECT idempotency_key, request_fingerprint, state,
              projected_input_tokens, projected_output_tokens,
              actual_input_tokens, actual_output_tokens, actual_cost_micros,
              job_attempt_id, request_ordinal, attempt_kind,
              transient_retry_count, format_repair
       FROM model_budget_reservations ORDER BY created_at, rowid`,
    )
    .all() as Array<Record<string, unknown>>;
  inspector.close();
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.idempotency_key)).size, 4);
  assert.equal(new Set(rows.map((row) => row.request_fingerprint)).size, 4);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["settled", "dispatched", "settled", "settled"],
  );
  assert.deepEqual(
    rows.map((row) => [row.actual_input_tokens, row.actual_output_tokens]),
    [
      [10, 5],
      [null, null],
      [20, 10],
      [30, 15],
    ],
  );
  assert.deepEqual(
    rows.map((row) => [
      row.job_attempt_id,
      row.request_ordinal,
      row.attempt_kind,
      row.transient_retry_count,
      row.format_repair,
    ]),
    [
      [subject.jobAttemptId, 0, "initial", 0, 0],
      [subject.jobAttemptId, 1, "transient-retry", 1, 0],
      [subject.jobAttemptId, 2, "transient-retry", 2, 0],
      [subject.jobAttemptId, 3, "format-repair", 2, 1],
    ],
  );
});

test("transient retry inside format repair keeps both identity dimensions", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const provider = new FakeProvider(async (_request, attempt) => {
    if (attempt === 1) {
      return {
        value: { wrong: true },
        responseId: "resp_repair_source",
        inputTokens: 10,
        outputTokens: 5,
      };
    }
    if (attempt === 2) {
      throw new ModelProviderError("transient", "repair retry unavailable");
    }
    return {
      value: { summary: "repair retry succeeded" },
      responseId: "resp_repair_retry",
      inputTokens: 20,
      outputTokens: 10,
    };
  });
  const skillRunner = await runner(repository, provider);

  const result = await skillRunner.run(request(), context(subject));

  assert.deepEqual(
    result.record.attempts.map(({ ordinal, kind, transientRetryCount, formatRepair }) => ({
      ordinal,
      kind,
      transientRetryCount,
      formatRepair,
    })),
    [
      { ordinal: 0, kind: "initial", transientRetryCount: 0, formatRepair: false },
      { ordinal: 1, kind: "format-repair", transientRetryCount: 0, formatRepair: true },
      { ordinal: 2, kind: "transient-retry", transientRetryCount: 1, formatRepair: true },
    ],
  );
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  const rows = inspector
    .prepare(
      `SELECT request_ordinal, attempt_kind, transient_retry_count, format_repair
       FROM model_budget_reservations ORDER BY request_ordinal`,
    )
    .all() as Array<Record<string, unknown>>;
  inspector.close();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { request_ordinal: 0, attempt_kind: "initial", transient_retry_count: 0, format_repair: 0 },
    { request_ordinal: 1, attempt_kind: "format-repair", transient_retry_count: 0, format_repair: 1 },
    { request_ordinal: 2, attempt_kind: "transient-retry", transient_retry_count: 1, format_repair: 1 },
  ]);
});

test("legacy caller-supplied budget is rejected and never reaches provider or storage", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const provider = new FakeProvider();
  const skillRunner = await runner(repository, provider);
  const legacy = {
    ...request(),
    budget: {
      limits: { attacker: "unlimited" },
      usage: { attacker: 0 },
    },
  } as never;

  await assert.rejects(
    skillRunner.run(legacy, context(subject)),
    (error: unknown) =>
      error instanceof SkillRuntimeError &&
      error.code === "CONFIGURATION_ERROR" &&
      /legacy budget/i.test(error.message),
  );
  assert.equal(provider.requests.length, 0);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  assert.equal(
    (
      inspector
        .prepare("SELECT COUNT(*) AS count FROM model_budget_reservations")
        .get() as { count: number }
    ).count,
    0,
  );
  inspector.close();
});

class TracingCoordinator implements SkillModelBudgetCoordinator {
  constructor(
    private readonly inner: ModelBudgetCoordinator,
    private readonly events: string[],
    private readonly options: {
      failSettlement?: boolean;
      afterReserve?: () => void;
    } = {},
  ) {}

  async reserve(input: Parameters<ModelBudgetCoordinator["reserve"]>[0]) {
    this.events.push("reserve");
    const reservation = await this.inner.reserve(input);
    this.options.afterReserve?.();
    return reservation;
  }

  async dispatch(reservationId: string) {
    this.events.push("dispatch");
    return this.inner.dispatch(reservationId);
  }

  async release(reservationId: string) {
    this.events.push("release");
    return this.inner.release(reservationId);
  }

  async settle(
    reservationId: string,
    actual: Parameters<ModelBudgetCoordinator["settle"]>[1],
  ) {
    this.events.push("settle");
    if (this.options.failSettlement) {
      throw new Error("database secret must not leak");
    }
    return this.inner.settle(reservationId, actual);
  }
}

test("success is settled before output validation creates a format repair", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const events: string[] = [];
  const inner = new ModelBudgetCoordinator({
    repository,
    limitProvider: new StaticModelBudgetLimitProvider(limits()),
    clock: () => new Date(createdAt),
    createId: randomUUID,
  });
  const provider = new FakeProvider(async (_request, attempt) => {
    events.push(`provider-${attempt}`);
    return {
      value: attempt === 1 ? { wrong: true } : { summary: "repaired" },
      responseId: `resp_order_${attempt}`,
      inputTokens: 10,
      outputTokens: 5,
    };
  });
  const skillRunner = await runner(repository, provider, limits(), {
    coordinator: new TracingCoordinator(inner, events),
  });

  await skillRunner.run(request(), context(subject));

  assert.deepEqual(events, [
    "reserve",
    "dispatch",
    "provider-1",
    "settle",
    "reserve",
    "dispatch",
    "provider-2",
    "settle",
  ]);
});

test("settlement failure prevents retry or repair and returns a safe runtime failure", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const events: string[] = [];
  const inner = new ModelBudgetCoordinator({
    repository,
    limitProvider: new StaticModelBudgetLimitProvider(limits()),
    clock: () => new Date(createdAt),
    createId: randomUUID,
  });
  const provider = new FakeProvider(async () => {
    events.push("provider");
    return {
      value: { wrong: true },
      responseId: "resp_settle_failure",
      inputTokens: 10,
      outputTokens: 5,
    };
  });
  const skillRunner = await runner(repository, provider, limits(), {
    coordinator: new TracingCoordinator(inner, events, {
      failSettlement: true,
    }),
  });

  await assert.rejects(
    skillRunner.run(request(), context(subject)),
    (error: unknown) =>
      error instanceof SkillRuntimeError &&
      error.code === "PROVIDER_ERROR" &&
      error.message === "Model request budget coordination failed" &&
      !error.message.includes("database secret"),
  );
  assert.deepEqual(events, ["reserve", "dispatch", "provider", "settle"]);
  assert.equal(provider.requests.length, 1);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  assert.equal(
    (
      inspector
        .prepare("SELECT state FROM model_budget_reservations")
        .get() as { state: string }
    ).state,
    "dispatched",
  );
  inspector.close();
});

for (const kind of ["permanent", "transient"] as const) {
  test(`${kind} provider error without usage remains conservatively dispatched`, async (t) => {
    const temporary = temporaryDatabase();
    const repository = openSqliteAgentRepository({
      path: temporary.databasePath,
      busyTimeoutMs: 5_000,
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedSubject(repository);
    const provider = new FakeProvider(async () => {
      throw new ModelProviderError(kind, "untrusted provider details");
    });
    const configured = limits();
    if (kind === "transient") {
      configured.run.maxTokens = 300;
    }
    const skillRunner = await runner(repository, provider, configured);

    await assert.rejects(skillRunner.run(request(), context(subject)));

    assert.equal(provider.requests.length, 1);
    const inspector = new DatabaseSync(temporary.databasePath, {
      readOnly: true,
    });
    const states = inspector
      .prepare("SELECT state FROM model_budget_reservations ORDER BY rowid")
      .all() as Array<{ state: string }>;
    inspector.close();
    assert.deepEqual(states.map((row) => row.state), ["dispatched"]);
  });
}

test("timeout without usage remains dispatched and is never released", { timeout: 1_000 }, async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const provider = new FakeProvider(async () => await new Promise(() => {}));
  const skillRunner = await runner(repository, provider);
  const timedRequest = request();
  timedRequest.model.timeoutMs = 20;

  await assert.rejects(
    skillRunner.run(timedRequest, context(subject)),
    (error: unknown) =>
      error instanceof SkillRuntimeError && error.code === "TIMEOUT",
  );
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  assert.equal(
    (
      inspector
        .prepare("SELECT state FROM model_budget_reservations")
        .get() as { state: string }
    ).state,
    "dispatched",
  );
  inspector.close();
});

test("untrusted abort during provider execution is infrastructure, not user cancellation", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const controller = new AbortController();
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider = new FakeProvider(
    async (providerRequest) =>
      await new Promise((_resolve, reject) => {
        started();
        providerRequest.signal?.addEventListener(
          "abort",
          () => reject(new ModelProviderError("aborted", "provider aborted")),
          { once: true },
        );
      }),
  );
  const skillRunner = await runner(repository, provider);
  const pending = skillRunner.run(
    request({ signal: controller.signal }),
    context(subject),
  );
  await providerStarted;
  controller.abort("run-cancelled");

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof SkillRuntimeError && error.code === "INTERRUPTED",
  );
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  assert.equal(
    (
      inspector
        .prepare("SELECT state FROM model_budget_reservations")
        .get() as { state: string }
    ).state,
    "dispatched",
  );
  inspector.close();
});

test("untrusted abort after reserve releases it without claiming user cancellation", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const controller = new AbortController();
  const events: string[] = [];
  const inner = new ModelBudgetCoordinator({
    repository,
    limitProvider: new StaticModelBudgetLimitProvider(limits()),
    clock: () => new Date(createdAt),
    createId: randomUUID,
  });
  const provider = new FakeProvider();
  const skillRunner = await runner(repository, provider, limits(), {
    coordinator: new TracingCoordinator(inner, events, {
      afterReserve: () => controller.abort({ kind: "run-cancelled" }),
    }),
  });

  await assert.rejects(
    skillRunner.run(
      request({ signal: controller.signal }),
      context(subject),
    ),
    (error: unknown) =>
      error instanceof SkillRuntimeError && error.code === "INTERRUPTED",
  );
  assert.deepEqual(events, ["reserve", "release"]);
  assert.equal(provider.requests.length, 0);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  assert.equal(
    (
      inspector
        .prepare("SELECT state FROM model_budget_reservations")
        .get() as { state: string }
    ).state,
    "released",
  );
  inspector.close();
});

test("same JobAttempt restart replays one stable row without input or IDs in logs and without another provider call", async (t) => {
  const temporary = temporaryDatabase();
  const first = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  const subject = await seedSubject(first);
  const provider = new FakeProvider();
  const logged: unknown[] = [];
  const executionContext = context(subject);
  const firstRunner = await runner(first, provider, limits(), {
    logger: (entry) => logged.push(entry),
  });
  await firstRunner.run(request(), executionContext);
  first.close();

  const reopened = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    reopened.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const replayRunner = await runner(reopened, provider);
  await assert.rejects(
    replayRunner.run(request(), executionContext),
    (error: unknown) =>
      error instanceof SkillRuntimeError && error.code === "PROVIDER_ERROR",
  );

  assert.equal(provider.requests.length, 1);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  const rows = inspector
    .prepare(
      "SELECT idempotency_key, request_fingerprint, state FROM model_budget_reservations",
    )
    .all() as Array<Record<string, unknown>>;
  inspector.close();
  assert.equal(rows.length, 1);
  assert.match(String(rows[0].idempotency_key), /^[0-9a-f]{64}$/);
  assert.match(String(rows[0].request_fingerprint), /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify({ rows, logged });
  assert.doesNotMatch(serialized, /raw-private-theme/);
  assert.doesNotMatch(serialized, new RegExp(executionContext.jobAttemptId));
  assert.doesNotMatch(serialized, new RegExp(subject.projectId));
});

test("same job and contract name with a changed output schema conflicts before provider replay", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const provider = new FakeProvider();
  const skillRunner = await runner(repository, provider);
  const executionContext = context(subject);

  await skillRunner.run(request(), executionContext);
  const changedSchemaRequest = request({
    outputContract: {
      name: "VocPositioningOutput@1.0.0",
      schema: z
        .object({ summary: z.string(), confidence: z.number() })
        .strict() as never,
    },
  });
  await assert.rejects(
    skillRunner.run(changedSchemaRequest, executionContext),
    (error: unknown) =>
      error instanceof SkillRuntimeError &&
      error.code === "PROVIDER_ERROR" &&
      error.cause instanceof ModelBudgetReservationConflictError,
  );
  assert.equal(provider.requests.length, 1);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  const count = (
    inspector
      .prepare("SELECT COUNT(*) AS count FROM model_budget_reservations")
      .get() as { count: number }
  ).count;
  inspector.close();
  assert.equal(count, 1);
});

test("actual usage above projection settles exactly and blocks the next request", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const configured = limits();
  configured.run.maxTokens = 1_200;
  configured.run.maxCostMicros = 1_600;
  const provider = new FakeProvider(async () => ({
    value: { summary: "large actual" },
    responseId: "resp_large_actual",
    inputTokens: 500,
    outputTokens: 500,
  }));
  const skillRunner = await runner(repository, provider, configured);

  await skillRunner.run(request(), context(subject));
  const nextJobAttemptId = randomUUID();
  await repository.enqueueJob({
    id: nextJobAttemptId,
    stageId: subject.stageId,
    attemptNumber: 2,
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
  });
  await assert.rejects(
    skillRunner.run(request(), context(subject, nextJobAttemptId)),
    (error: unknown) =>
      error instanceof BudgetExceededError &&
      error.scope === "run" &&
      error.metric === "tokens",
  );
  assert.equal(provider.requests.length, 1);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  const row = inspector
    .prepare(
      `SELECT actual_input_tokens, actual_output_tokens, actual_cost_micros
       FROM model_budget_reservations WHERE state = 'settled'`,
    )
    .get() as Record<string, number>;
  inspector.close();
  assert.deepEqual({ ...row }, {
    actual_input_tokens: 500,
    actual_output_tokens: 500,
    actual_cost_micros: 1_500,
  });
});

test("raw OpenAI invalid JSON settles actual over-projection usage before repair admission", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const configured = limits();
  configured.run.maxTokens = 1_001;
  let providerCalls = 0;
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () => {
          providerCalls += 1;
          return {
            id: "resp_invalid_json_actual",
            status: "completed",
            error: null,
            incomplete_details: null,
            output: [
              {
                id: "msg_invalid_json_actual",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: '{"summary":',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 500,
              output_tokens: 500,
              total_tokens: 1_000,
              input_tokens_details: {
                cached_tokens: 0,
                cache_write_tokens: 0,
              },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          };
        },
      },
    } as never,
  });
  const skillRunner = await runner(repository, provider, configured);
  const tinyProjection = request();
  tinyProjection.model.estimatedInputTokens = 1;
  tinyProjection.model.maxOutputTokens = 1;

  await assert.rejects(
    skillRunner.run(tinyProjection, context(subject)),
    (error: unknown) =>
      error instanceof BudgetExceededError &&
      error.scope === "run" &&
      error.metric === "tokens",
  );
  assert.equal(providerCalls, 1);
  const inspector = new DatabaseSync(temporary.databasePath, { readOnly: true });
  const row = inspector
    .prepare(
      `SELECT state, actual_input_tokens, actual_output_tokens, actual_cost_micros
       FROM model_budget_reservations`,
    )
    .get() as Record<string, number | string>;
  inspector.close();
  assert.deepEqual({ ...row }, {
    state: "settled",
    actual_input_tokens: 500,
    actual_output_tokens: 500,
    actual_cost_micros: 1_500,
  });
});

test("WorkerLoop persists SkillRunner BudgetExceededError without retry or provider call", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedSubject(repository);
  const stageId = randomUUID();
  const jobId = randomUUID();
  await repository.createRunStage({
    id: stageId,
    runId: subject.runId,
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
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
  });
  const provider = new FakeProvider();
  const configured = limits();
  configured.call.maxTokens = 299;
  const skillRunner = await runner(repository, provider, configured);
  const loop = new JobAttemptWorkerLoop({
    repository,
    ownerId: "persistent-budget-worker",
    handler: async ({ job, signal }) => {
      await skillRunner.run(
        request({ signal }),
        context(subject, job.id),
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
  });

  assert.equal(await loop.runOnce(), true);
  const stage = await repository.findRunStage(stageId);
  const attempts = await repository.listJobAttempts(stageId);
  assert.equal(stage?.status, "budget-exceeded");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].retryable, false);
  assert.equal(provider.requests.length, 0);
  assert.equal((stage?.lastError as { scope?: string } | null)?.scope, "call");
  assert.equal(
    (stage?.lastError as { metric?: string } | null)?.metric,
    "tokens",
  );
  assert.equal(await loop.runOnce(), false);
});
