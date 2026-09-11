import { z } from "zod";
import { compactVocResponseSchema } from "../../server/services/voc-compact-output";
import { OpenAIProvider } from "../../server/runtime/openai-provider";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import {
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
import { BudgetExceededError } from "../../server/runtime/budget-policy";
import { WorkerTaskError } from "../../server/runtime/retry-policy";
import {
  SkillRunner,
  SkillRuntimeError,
} from "../../server/runtime/skill-runner";
import { createTrustedExecutionAbortReason } from "../../server/runtime/execution-abort";
import {
  JobAttemptWorkerLoop,
  type WorkerClock,
} from "../../server/runtime/worker-loop";
import { SkillRegistry } from "../../server/skills/registry";
import {
  VocPositioningExecutionService,
  type VocPositioningExecutionContext,
} from "../../server/services/voc-positioning-execution-service";
import { createVocPositioningJobHandler } from "../../server/services/voc-positioning-worker-handler";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import type { VocPositioningOutput } from "../../server/domain/voc/voc-positioning-contracts";
import {
  parseVocDeterministicPreprocessingResult,
  preprocessVocSnapshot,
} from "../../server/domain/voc/preprocess-voc-snapshot";
import {
  VOC_SOURCE_REFERENCES,
  VocDataSnapshotRecordSchema,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import {
  LIGHTING_ASINS,
  SCOOTER_ASINS,
  realVocSnapshot,
  validAmazonVocInsightOutput,
} from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";
const STARTED_AT = "2026-08-16T00:00:00.000Z";
const LEASE_OWNER = "voc-execution-worker";

class FakeVocProvider<Output = VocPositioningOutput> implements ModelProvider {
  readonly requests: StructuredGenerationRequest<unknown>[] = [];

  constructor(
    readonly output: Output,
    readonly generate: (
      request: StructuredGenerationRequest<unknown>,
      attempt: number,
      output: Output,
    ) => Promise<StructuredGenerationResult<unknown>> = async (
      _request,
      _attempt,
      value,
    ) => ({
      value,
      responseId: "voc-response-1",
      inputTokens: 500,
      outputTokens: 250,
    }),
  ) {}

  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    this.requests.push(request as StructuredGenerationRequest<unknown>);
    return (await this.generate(
      request as StructuredGenerationRequest<unknown>,
      this.requests.length,
      this.output,
    )) as StructuredGenerationResult<T>;
  }
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-execution-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedExecution(
  repository: SqliteAgentRepository,
  asins: readonly string[],
  snapshotFactory: (
    asins: readonly string[],
    snapshotId: string,
    runId: string,
  ) => ReturnType<typeof realVocSnapshot> = realVocSnapshot,
  maxAttempts = 3,
) {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobAttemptId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "VOC execution actor",
    role: "admin",
    status: "active",
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "VOC execution project",
    marketplace: "US",
    asins: [...asins],
    createdBy: actorId,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "running",
    createdBy: actorId,
    dataCutoffAt: CUTOFF,
    idempotencyScope: `voc-execution:${runId}`,
    idempotencyKey: "create",
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
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
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  });
  await repository.enqueueJob({
    id: jobAttemptId,
    stageId,
    attemptNumber: 1,
    maxAttempts,
    availableAt: STARTED_AT,
    createdAt: STARTED_AT,
  });
  const job = await repository.claimNextJob({
    ownerId: LEASE_OWNER,
    claimedAt: STARTED_AT,
    leaseDurationMs: 120_000,
  });
  assert.equal(job?.id, jobAttemptId);
  const snapshotRecord = snapshotFactory(asins, snapshotId, runId);
  const {
    id: _snapshotRecordId,
    runId: _snapshotRunId,
    createdAt: _snapshotCreatedAt,
    ...candidate
  } = snapshotRecord;
  void _snapshotRecordId;
  void _snapshotRunId;
  void _snapshotCreatedAt;
  const snapshot = await repository.createDataSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: asins,
    expectedRunCutoffAt: CUTOFF,
    candidateId: snapshotId,
    createdAt: STARTED_AT,
    candidate,
  });
  return {
    actorId,
    organizationId,
    projectId,
    runId,
    stageId,
    jobAttemptId,
    snapshotId,
    leaseGeneration: job!.leaseGeneration,
    logicalExecutionCycleId: job!.logicalExecutionCycleId,
    snapshot: snapshot.snapshot,
    facts: preprocessVocSnapshot(snapshot.snapshot),
  };
}

function allMissingVocSnapshot(
  asins: readonly string[],
  snapshotId: string,
  runId: string,
) {
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins,
    dataCutoffAt: CUTOFF,
    sourceBundles: [
      {
        sourceId: "sorftime-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: "US",
        capturedAt: CUTOFF,
        records: [
          {
            asin: asins[0]!,
            marketplace: "US",
            sampledReviews: 1,
            fetchedAt: "2026-08-15",
            status: "ready",
            family: "generic",
            blocks: [],
          },
        ],
      },
    ],
  });
  return VocDataSnapshotRecordSchema.parse({
    ...candidate,
    id: snapshotId,
    runId,
    createdAt: STARTED_AT,
  });
}

test("public-parser-valid facts drift is rejected before provider dispatch", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const snapshot = subject.snapshot;
  const changedAlexa = snapshot.payload.records.alexaVoc.map((record, index) =>
    index === 0
      ? { ...record, positives: [...record.positives, "semantic drift fixture"] }
      : record,
  );
  const changedCandidate = buildVocSnapshotCandidate({
    marketplace: snapshot.marketplace,
    asins: snapshot.asins,
    dataCutoffAt: snapshot.dataCutoffAt,
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: snapshot.marketplace,
        capturedAt: snapshot.sources.find((source) => source.type === "manual-voc")!.capturedAt,
        records: changedAlexa,
      },
      {
        sourceId: "sorftime-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: snapshot.marketplace,
        capturedAt: snapshot.sources.find(
          (source) => source.reference === VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        )!.capturedAt,
        records: snapshot.payload.records.sorftimeReviewAnalysis,
      },
      {
        sourceId: "seller-sprite-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        marketplace: snapshot.marketplace,
        capturedAt: snapshot.sources.find(
          (source) => source.reference === VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        )!.capturedAt,
        records: snapshot.payload.records.sellerSpriteReviewAnalysis,
      },
    ],
  });
  const changedSnapshot = VocDataSnapshotRecordSchema.parse({
    ...changedCandidate,
    id: snapshot.id,
    runId: snapshot.runId,
    createdAt: snapshot.createdAt,
  });
  const changedFacts = structuredClone(preprocessVocSnapshot(changedSnapshot));
  changedFacts.snapshot.contentHash = snapshot.contentHash;
  const parserValidatedDrift = parseVocDeterministicPreprocessingResult(changedFacts);
  assert.notEqual(parserValidatedDrift.factsDigest, subject.facts.factsDigest);
  assert.equal(parserValidatedDrift.snapshot.contentHash, subject.facts.snapshot.contentHash);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(parserValidatedDrift));
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: parserValidatedDrift,
        model: {
          name: "configured-test-model",
          estimatedInputTokens: 4_000,
          maxOutputTokens: 4_000,
          timeoutMs: 5_000,
          pricing: {
            inputUsdPerMillionTokens: 1,
            outputUsdPerMillionTokens: 2,
          },
        },
      },
      executionContext(subject),
    ),
    /identity conflict/i,
  );
  assert.equal(provider.requests.length, 0);
});

async function serviceHarness(
  repository: SqliteAgentRepository,
  provider: ModelProvider,
  maxTokens = 50_000,
  serviceRepository: SqliteAgentRepository = repository,
  clockStart = STARTED_AT,
) {
  const registry = await SkillRegistry.open(path.resolve("skills-src"));
  let tick = Date.parse(clockStart);
  const clock = () => new Date((tick += 10));
  const skillRunner = new SkillRunner({
    registry,
    provider,
    providerName: "fake",
    budgetCoordinator: new ModelBudgetCoordinator({
      repository,
      limitProvider: new StaticModelBudgetLimitProvider({
        call: { maxTokens, maxCostMicros: 500_000 },
        run: { maxTokens, maxCostMicros: 500_000 },
        organizationUtcDay: { maxTokens, maxCostMicros: 500_000 },
      }),
      clock,
      createId: randomUUID,
    }),
    sleep: async () => {},
    now: () => tick,
  });
  const auditedRunner = new AuditedSkillRunner({
    skillRunner,
    repository,
    clock,
    createId: randomUUID,
  });
  return new VocPositioningExecutionService({
    repository: serviceRepository,
    auditedRunner,
    clock,
    createId: randomUUID,
  });
}

function modelConfig() {
  return {
    name: "configured-test-model",
    estimatedInputTokens: 4_000,
    maxOutputTokens: 4_000,
    timeoutMs: 5_000,
    pricing: {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    },
  };
}

function executionContext(
  subject: Awaited<ReturnType<typeof seedExecution>>,
): VocPositioningExecutionContext {
  return {
    actorId: subject.actorId,
    organizationId: subject.organizationId,
    runId: subject.runId,
    projectId: subject.projectId,
    stageId: subject.stageId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    logicalExecutionCycleId: subject.logicalExecutionCycleId,
    dataCutoffAt: CUTOFF,
  } satisfies AuditedSkillExecutionContext & { actorId: string };
}

async function runRecoveryWorker(
  repository: SqliteAgentRepository,
  provider: ModelProvider,
  subject: Awaited<ReturnType<typeof seedExecution>>,
) {
  const service = await serviceHarness(
    repository,
    provider,
    50_000,
    repository,
    "2026-08-16T00:02:03.000Z",
  );
  const handler = createVocPositioningJobHandler({
    service,
    prepare: () => ({
      request: {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: modelConfig(),
      },
      context: {
        actorId: subject.actorId,
        organizationId: subject.organizationId,
        projectId: subject.projectId,
        dataCutoffAt: CUTOFF,
      },
    }),
  });
  const worker = new JobAttemptWorkerLoop({
    repository,
    ownerId: "voc-recovery-worker",
    handler,
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock: {
      now: () => "2026-08-16T00:02:03.000Z",
      sleep: async (_durationMs, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    },
  });
  assert.equal(await worker.runOnce(), true);
}

test("lease-expiry recovery classifies an uncommitted AgentRun instead of recording an unhandled worker failure", async (t) => {
  const temporary = temporaryDatabase();
  let repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const failingFinalizeRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "finalizeAgentRun") {
        return async () => {
          throw new Error("simulated audit commit interruption");
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqliteAgentRepository;
  const interruptedService = await serviceHarness(
    failingFinalizeRepository,
    provider,
    50_000,
    failingFinalizeRepository,
  );

  await assert.rejects(
    interruptedService.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: modelConfig(),
      },
      executionContext(subject),
    ),
    /audit persistence failed/i,
  );
  assert.equal(provider.requests.length, 1);

  repository.close();
  repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:02:03.000Z"),
  });
  await runRecoveryWorker(repository, provider, subject);

  assert.equal(provider.requests.length, 1);
  const attempts = await repository.listJobAttempts(subject.stageId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.status, "failed");
  assert.deepEqual(attempts[1]?.error, {
    classification: "infrastructure",
    message: "Agent run audit persistence failed",
  });
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "failed");
});

class RetryWorkerClock {
  #current = Date.parse("2026-08-16T00:00:02.000Z");

  now = () => new Date(this.#current).toISOString();

  advance(durationMs: number) {
    this.#current += durationMs;
  }

  sleep = async (_durationMs: number, signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
}

class AdvancingRunLoopClock implements WorkerClock {
  #current = Date.parse("2026-08-16T00:00:02.000Z");

  now = () => new Date(this.#current).toISOString();

  sleep = async (durationMs: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        this.#current += durationMs;
        resolve();
      }, 0);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
}

class TriggeredHeartbeatClock implements WorkerClock {
  #heartbeat!: () => void;
  now = () => "2026-08-16T00:00:02.000Z";

  failHeartbeat() {
    this.#heartbeat();
  }

  sleep = async (durationMs: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (durationMs === 60_000) {
        this.#heartbeat = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
      }
    });
}

async function createRetryWorker(
  repository: SqliteAgentRepository,
  provider: ModelProvider,
  subject: Awaited<ReturnType<typeof seedExecution>>,
  clock: WorkerClock,
  ownerId = "voc-physical-retry-worker",
  serviceRepository: SqliteAgentRepository = repository,
  workerRepository: SqliteAgentRepository = repository,
) {
  const service = await serviceHarness(
    repository,
    provider,
    500_000,
    serviceRepository,
  );
  return new JobAttemptWorkerLoop({
    repository: workerRepository,
    ownerId,
    handler: createVocPositioningJobHandler({
      service,
      prepare: () => ({
        request: {
          snapshotId: subject.snapshotId,
          facts: subject.facts,
          model: modelConfig(),
        },
        context: {
          actorId: subject.actorId,
          organizationId: subject.organizationId,
          projectId: subject.projectId,
          dataCutoffAt: CUTOFF,
        },
      }),
    }),
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 60_000,
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
}

async function runIsolatedCrashWorker(
  databasePath: string,
  crashPoint:
    | "before-report"
    | "after-report"
    | "after-terminal-failure-before-fail-job"
    | "graceful-after-terminal-failure-before-fail-job"
    | "heartbeat-after-terminal-failure-before-fail-job",
  subject: Awaited<ReturnType<typeof seedExecution>>,
) {
  const worker = new Worker(
    new URL("./helpers/voc-positioning-crash-worker.ts", import.meta.url),
    {
      workerData: {
        path: databasePath,
        crashPoint,
        subject: {
          actorId: subject.actorId,
          organizationId: subject.organizationId,
          projectId: subject.projectId,
          snapshotId: subject.snapshotId,
          facts: subject.facts,
        },
      },
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  let providerCalls = 0;
  let crashReady = false;
  let gracefulStopped =
    crashPoint !== "graceful-after-terminal-failure-before-fail-job";
  await new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const type = (message as { type?: unknown }).type;
      if (type === "provider-call") providerCalls += 1;
      if (type === "crash-ready") crashReady = true;
      if (type === "graceful-stopped") gracefulStopped = true;
      if (crashReady && gracefulStopped) resolve();
      if (type === "error") {
        reject(new Error(JSON.stringify(message)));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Crash worker exited before crash point: ${code}`));
    });
  });
  await worker.terminate();
  return providerCalls;
}

for (const [label, asins] of [
  ["full scooter", SCOOTER_ASINS],
  ["partial lighting", LIGHTING_ASINS],
] as const) {
  test(`${label} facts execute the published Skill and persist one analysis result`, async (t) => {
    const temporary = temporaryDatabase();
    const repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedExecution(repository, asins);
    const provider = new FakeVocProvider(
      validAmazonVocInsightOutput(subject.facts),
    );
    const service = await serviceHarness(repository, provider);
    const allowedModel = { ...modelConfig(), timeoutMs: 300_000 };

    const first = await service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: allowedModel,
      },
      executionContext(subject),
    );
    const replay = await service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: allowedModel,
      },
      executionContext(subject),
    );

    assert.equal(provider.requests.length, 1);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.report, first.report);
    assert.equal(first.report.status, label === "full scooter" ? "complete" : "partial");
    assert.equal(first.report.skill.id, "amazon-voc-insight");
    assert.equal(first.report.result.kind, "amazon-voc-insight-result");
    assert.equal(
      first.report.result.positioningProjection.identity.factsDigest,
      subject.facts.factsDigest,
    );
    const sent = provider.requests[0]!.input as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent), [
      "schemaVersion",
      "kind",
      "snapshot",
      "factsDigest",
      "coverage",
      "dimensions",
    ]);
    assert.equal(JSON.stringify(sent).includes(subject.actorId), false);
    assert.equal(JSON.stringify(sent).includes(subject.organizationId), false);
  });
}

test("malformed provider JSON receives one constrained format repair", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const valid = validAmazonVocInsightOutput(subject.facts);
  const provider = new FakeVocProvider(valid, async (_request, attempt, output) => {
    if (attempt === 1) {
      throw new ModelProviderError("invalid_output", "private malformed body", {
        usage: {
          responseId: "voc-malformed-1",
          inputTokens: 500,
          outputTokens: 100,
        },
      });
    }
    return {
      value: output,
      responseId: "voc-repaired-2",
      inputTokens: 500,
      outputTokens: 250,
    };
  });
  const service = await serviceHarness(repository, provider);

  const result = await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(result.report.status, "complete");
  assert.equal(provider.requests.length, 2);
  assert.match(provider.requests[1]!.instructions, /FORMAT REPAIR/);
  assert.match(provider.requests[1]!.instructions, /amazon-voc-insight/);
  assert.match(provider.requests[1]!.instructions, /七个核心 VOC 维度/);
  assert.match(provider.requests[1]!.instructions, /产品机会优先级排序/);
  assert.match(
    provider.requests[1]!.instructions,
    /顾客关注点.*好评点.*差评点.*未被满足的需求.*使用场景.*使用人群.*购买动机/s,
  );
  assert.doesNotMatch(provider.requests[1]!.instructions, /VOC_REPAIR_GUIDANCE_V1/);
  assert.equal(
    provider.requests[1]!.responseFormat.format.name,
    "AmazonVocInsightOutput_1_0_0",
  );
  assert.equal(provider.requests[1]!.instructions.includes("private malformed body"), false);
});

test("positioning projection residuals receive one bounded full-output repair", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const valid = validAmazonVocInsightOutput(subject.facts);
  const invalid = structuredClone(valid);
  const omittedJudgment = invalid.positioningProjection.themeJudgments.shift();
  const omittedAction = invalid.positioningProjection.actions.shift();
  assert.ok(omittedJudgment);
  assert.ok(omittedAction);
  assert.equal(omittedAction.themeRefs.length, 1);
  invalid.positioningProjection.actions[0]!.actionType = "retain";
  invalid.positioningProjection.actions[0]!.validationDomains = [];
  const validation = invalid.positioningProjection.nextValidations[0]!;
  const referenced = validation.themeRefs[0]!;
  const unrelated = subject.facts.evidenceIndex.find(
    (evidence) => evidence.dimension !== referenced.dimension || evidence.themeKey !== referenced.themeKey,
  );
  assert.ok(unrelated);
  validation.evidenceIds = [unrelated.id];
  const provider = new FakeVocProvider(valid, async (_request, attempt) => ({
    value: attempt === 1 ? invalid : valid,
    responseId: `voc-relay-residual-${attempt}`,
    inputTokens: 500,
    outputTokens: 250,
  }));
  const service = await serviceHarness(repository, provider);

  const result = await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(result.report.status, "complete");
  assert.equal(provider.requests.length, 2);
  assert.equal(
    provider.requests[1]!.responseFormat.format.name,
    "AmazonVocInsightOutput_1_0_0",
  );
  const repair = provider.requests[1]!.instructions;
  assert.match(repair, /FORMAT REPAIR/);
  assert.match(repair, /amazon-voc-insight/);
  assert.doesNotMatch(repair, /VOC_REPAIR_GUIDANCE_V1/);
  const replay = await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );
  assert.equal(replay.replayed, true);
  assert.equal(provider.requests.length, 2);
  assert.equal(
    provider.requests[1]!.responseFormat.format.name,
    "AmazonVocInsightOutput_1_0_0",
  );
});

test("legacy VOC repair patches are rejected by the full-output repair contract", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const valid = validAmazonVocInsightOutput(subject.facts);
  const invalid = structuredClone(valid);
  const validation = invalid.positioningProjection.nextValidations[0]!;
  const referenced = validation.themeRefs[0]!;
  const unrelated = subject.facts.evidenceIndex.find(
    (evidence) => evidence.dimension !== referenced.dimension || evidence.themeKey !== referenced.themeKey,
  );
  assert.ok(unrelated);
  validation.evidenceIds = [unrelated.id];
  const unauthorizedPatch = {
    schemaVersion: "1.0.0",
    kind: "voc-positioning-repair-patch",
    operations: [{
      op: "replace-references",
      target: "nextValidations",
      index: 1,
      themeRefs: valid.positioningProjection.nextValidations[0]!.themeRefs,
      evidenceIds: valid.positioningProjection.nextValidations[0]!.evidenceIds,
    }],
  };
  const provider = new FakeVocProvider(valid, async (_request, attempt) => ({
    value: attempt === 1 ? invalid : unauthorizedPatch,
    responseId: `voc-unauthorized-patch-${attempt}`,
    inputTokens: 500,
    outputTokens: 250,
  }));
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
    (error) => error instanceof WorkerTaskError && error.category === "model-output",
  );
  assert.equal(provider.requests.length, 2);
  assert.equal(
    provider.requests[1]!.responseFormat.format.name,
    "AmazonVocInsightOutput_1_0_0",
  );
  assert.match(provider.requests[1]!.instructions, /FORMAT REPAIR/);
  assert.doesNotMatch(provider.requests[1]!.instructions, /VOC_REPAIR_GUIDANCE_V1/);
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    }),
    [],
  );
});

test("unknown structural diagnostics use only generic safe repair", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const valid = validAmazonVocInsightOutput(subject.facts);
  const invalid = structuredClone(valid);
  invalid.positioningProjection.nextValidations[0]!.themeRefs[0]!.dimension =
    "target-audience" as never;
  const provider = new FakeVocProvider(valid, async (_request, attempt, output) => ({
    value: attempt === 1 ? invalid : output,
    responseId: `voc-unknown-repair-${attempt}`,
    inputTokens: 500,
    outputTokens: 250,
  }));
  const service = await serviceHarness(repository, provider);

  await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(provider.requests.length, 2);
  assert.match(provider.requests[1]!.instructions, /FORMAT REPAIR/);
  assert.doesNotMatch(provider.requests[1]!.instructions, /VOC_REPAIR_GUIDANCE_V1/);
  assert.equal(
    provider.requests[1]!.responseFormat.format.name,
    "AmazonVocInsightOutput_1_0_0",
  );
});

test("semantic deterministic drift receives one constrained format repair", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const valid = validAmazonVocInsightOutput(subject.facts);
  const invalid = structuredClone(valid);
  const driftedFactsDigest = "0".repeat(64);
  assert.notEqual(
    driftedFactsDigest,
    valid.positioningProjection.identity.factsDigest,
  );
  invalid.positioningProjection.identity.factsDigest = driftedFactsDigest;
  const provider = new FakeVocProvider(valid, async (_request, attempt, output) => ({
    value: attempt === 1 ? invalid : output,
    responseId: `voc-semantic-${attempt}`,
    inputTokens: 500,
    outputTokens: 250,
  }));
  const service = await serviceHarness(repository, provider);

  const result = await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(result.report.status, "complete");
  assert.equal(provider.requests.length, 2);
  assert.match(provider.requests[1]!.instructions, /FORMAT REPAIR/);
  assert.match(provider.requests[1]!.instructions, /voc-identity-mismatch/);
});

test("unsafe legacy narratives fail repair and neither body nor report is persisted", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const unsafe = structuredClone(validAmazonVocInsightOutput(subject.facts));
  Object.assign(unsafe.positioningProjection.coreConclusion, {
    statement: "公司已批准立项，预计利润率80%，无需成本专利合规验证",
  });
  const provider = new FakeVocProvider(unsafe);
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
    (error) =>
      error instanceof WorkerTaskError &&
      error.category === "model-output" &&
      /model output/i.test(error.message),
  );

  assert.equal(provider.requests.length, 2);
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    }),
    [],
  );
  const database = new DatabaseSync(temporary.path, { readOnly: true });
  const persisted = database
    .prepare("SELECT output_json, error_json FROM agent_runs WHERE run_id = ?")
    .get(subject.runId) as { output_json: string | null; error_json: string | null };
  database.close();
  assert.equal(persisted.output_json, null);
  assert.equal(JSON.stringify(persisted).includes("预计利润率"), false);
  assert.equal(JSON.stringify(persisted).includes("无需成本"), false);
});

test("the real Worker preserves exhausted VOC model output as model-output", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const invalid = structuredClone(validAmazonVocInsightOutput(subject.facts));
  Object.assign(invalid.positioningProjection.coreConclusion, {
    forbidden: "must remain private",
  });
  const provider = new FakeVocProvider(invalid);
  const worker = await createRetryWorker(
    repository,
    provider,
    subject,
    new RetryWorkerClock(),
  );

  assert.equal(await worker.runOnce(), true);
  assert.equal(provider.requests.length, 2);
  assert.deepEqual((await repository.findRunStage(subject.stageId))?.lastError, {
    classification: "model-output",
    message: "Model output failed deterministic VOC validation",
  });
  const publicRun = await new AnalysisRunService({
    repository,
    executionContext: {
      actorId: subject.actorId,
      organizationId: subject.organizationId,
    },
  }).getRun(subject.runId);
  assert.equal(
    publicRun.stages.find((stage) => stage.id === subject.stageId)?.lastError?.code,
    "MODEL_OUTPUT_ERROR",
  );
});

test("temporary provider failure retries through the audited runner", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(
    validAmazonVocInsightOutput(subject.facts),
    async (_request, attempt, output) => {
      if (attempt === 1) throw new ModelProviderError("transient", "private outage");
      return {
        value: output,
        responseId: "voc-retry-2",
        inputTokens: 500,
        outputTokens: 250,
      };
    },
  );
  const service = await serviceHarness(repository, provider);

  await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(provider.requests.length, 2);
});

test("an exhausted transient AgentRun starts a new physical execution cycle that can succeed", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider(
    validAmazonVocInsightOutput(subject.facts),
    async (_request, attempt, output) => {
      if (attempt <= 3) {
        throw new ModelProviderError("transient", "private exhausted outage");
      }
      return {
        value: output,
        responseId: "voc-physical-retry-success",
        inputTokens: 500,
        outputTokens: 250,
      };
    },
  );
  const clock = new RetryWorkerClock();
  const worker = await createRetryWorker(repository, provider, subject, clock);

  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(
    (await repository.listJobAttempts(subject.stageId)).map(
      ({ status, retryable, availableAt }) => ({ status, retryable, availableAt }),
    ),
    [{
      status: "failed",
      retryable: true,
      availableAt: "2026-08-16T00:00:02.100Z",
    }],
  );
  clock.advance(100);
  assert.equal(await worker.runOnce(), true);

  assert.equal(provider.requests.length, 4);
  const physicalAttempts = await repository.listJobAttempts(subject.stageId);
  assert.equal(physicalAttempts.length, 2);
  assert.notEqual(
    physicalAttempts[0]?.logicalExecutionCycleId,
    physicalAttempts[1]?.logicalExecutionCycleId,
  );
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
  assert.equal((await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "voc-positioning",
  })).length, 1);
  const database = new DatabaseSync(temporary.path, { readOnly: true });
  const count = database
    .prepare("SELECT count(*) AS count FROM agent_runs WHERE run_id = ?")
    .get(subject.runId) as { count: number };
  database.close();
  assert.equal(count.count, 2);
});

test("persistent physical retry bounds count every in-attempt provider retry", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider(
    validAmazonVocInsightOutput(subject.facts),
    async () => {
      throw new ModelProviderError("transient", "private persistent outage");
    },
  );
  const clock = new RetryWorkerClock();
  const worker = await createRetryWorker(repository, provider, subject, clock);

  assert.equal(await worker.runOnce(), true);
  assert.equal((await repository.listJobAttempts(subject.stageId))[0]?.retryable, true);
  clock.advance(100);
  assert.equal(await worker.runOnce(), true);
  assert.equal(provider.requests.length, 6);
  assert.equal(
    (await repository.listJobAttempts(subject.stageId))[1]?.error?.classification,
    "upstream-temporary",
  );
  assert.deepEqual(
    (await repository.listJobAttempts(subject.stageId)).map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      maxAttempts: attempt.maxAttempts,
      retryCycleStartAttempt: attempt.retryCycleStartAttempt,
      retryable: attempt.retryable,
      availableAt: attempt.availableAt,
    })),
    [
      {
        attemptNumber: 1,
        maxAttempts: 3,
        retryCycleStartAttempt: 1,
        retryable: true,
        availableAt: "2026-08-16T00:00:02.100Z",
      },
      {
        attemptNumber: 2,
        maxAttempts: 3,
        retryCycleStartAttempt: 1,
        retryable: true,
        availableAt: "2026-08-16T00:00:02.300Z",
      },
    ],
  );
  clock.advance(201);
  assert.equal(await worker.runOnce(), true);

  assert.equal(provider.requests.length, 9);
  assert.equal((await repository.listJobAttempts(subject.stageId)).length, 3);
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "failed");
  const database = new DatabaseSync(temporary.path, { readOnly: true });
  const count = database
    .prepare("SELECT count(*) AS count FROM agent_runs WHERE run_id = ?")
    .get(subject.runId) as { count: number };
  database.close();
  assert.equal(count.count, 3);
});

test("explicit rerun of a succeeded stage creates a new AgentRun and report version", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const clock = new RetryWorkerClock();
  const worker = await createRetryWorker(repository, provider, subject, clock);
  assert.equal(await worker.runOnce(), true);

  await new AnalysisRunService({
    repository,
    executionContext: {
      actorId: subject.actorId,
      organizationId: subject.organizationId,
    },
    now: clock.now,
    createId: randomUUID,
  }).retryStage(subject.runId, "voc-positioning");
  assert.equal(await worker.runOnce(), true);

  assert.equal(provider.requests.length, 2);
  const reports = await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "voc-positioning",
  });
  assert.deepEqual(reports.map(({ version }) => version), [1, 2]);
  assert.notEqual(reports[0]?.agentRunId, reports[1]?.agentRunId);
  const rerunAttempts = await repository.listJobAttempts(subject.stageId);
  assert.notEqual(
    rerunAttempts[0]?.logicalExecutionCycleId,
    rerunAttempts[1]?.logicalExecutionCycleId,
  );
});

test("budget exhaustion and pre-aborted cancellation dispatch no provider or report", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const budgeted = await serviceHarness(repository, provider, 1);

  await assert.rejects(
    budgeted.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
    BudgetExceededError,
  );
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    }),
    [],
  );

  const cancelledProvider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const cancelled = await serviceHarness(repository, cancelledProvider);
  const controller = new AbortController();
  controller.abort(createTrustedExecutionAbortReason("run-cancelled"));
  await assert.rejects(
    cancelled.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: modelConfig(),
        signal: controller.signal,
      },
      executionContext(subject),
    ),
    /aborted|cancel/i,
  );
  assert.equal(cancelledProvider.requests.length, 0);
});

test("trusted live run cancellation is the only abort persisted as cancelled", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider = new FakeVocProvider(
    validAmazonVocInsightOutput(subject.facts),
    async (request) =>
      await new Promise((_resolve, reject) => {
        started();
        request.signal?.addEventListener(
          "abort",
          () => reject(new ModelProviderError("aborted", "private cancellation")),
          { once: true },
        );
      }),
  );
  const service = await serviceHarness(repository, provider);
  const controller = new AbortController();
  const executing = service.execute(
    {
      snapshotId: subject.snapshotId,
      facts: subject.facts,
      model: modelConfig(),
      signal: controller.signal,
    },
    executionContext(subject),
  );
  await providerStarted;
  controller.abort(createTrustedExecutionAbortReason("run-cancelled"));
  await assert.rejects(
    executing,
    (error: unknown) =>
      error instanceof SkillRuntimeError && error.code === "CANCELLED",
  );

  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  const terminal = inspector
    .prepare("SELECT terminal_status FROM agent_runs WHERE run_id = ?")
    .get(subject.runId) as { terminal_status: string };
  inspector.close();
  assert.equal(terminal.terminal_status, "cancelled");
  assert.equal(provider.requests.length, 1);
});

for (const interruption of ["worker-stop", "heartbeat-loss"] as const) {
  test(`${interruption} during live provider work recovers after SQLite reopen without cancellation`, async (t) => {
    const temporary = temporaryDatabase();
    let repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedExecution(repository, SCOOTER_ASINS);
    await repository.releaseJobLease({
      jobId: subject.jobAttemptId,
      ownerId: LEASE_OWNER,
      leaseGeneration: subject.leaseGeneration,
      releasedAt: "2026-08-16T00:00:01.000Z",
    });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const interruptedProvider = new FakeVocProvider(
      validAmazonVocInsightOutput(subject.facts),
      async (request) =>
        await new Promise((_resolve, reject) => {
          started();
          request.signal?.addEventListener(
            "abort",
            () => reject(new ModelProviderError("aborted", "private worker reason")),
            { once: true },
          );
        }),
    );
    const clock =
      interruption === "worker-stop"
        ? new RetryWorkerClock()
        : new TriggeredHeartbeatClock();
    const workerRepository =
      interruption === "heartbeat-loss"
        ? new Proxy(repository, {
            get(target, property) {
              if (property === "renewJobLease") {
                return async () => {
                  throw new Error("private heartbeat repository failure");
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          })
        : repository;
    const worker = await createRetryWorker(
      repository,
      interruptedProvider,
      subject,
      clock,
      `${interruption}-worker`,
      repository,
      workerRepository,
    );
    if (interruption === "worker-stop") {
      worker.start();
      await providerStarted;
      await worker.stop();
    } else {
      const processing = worker.runOnce();
      await providerStarted;
      (clock as TriggeredHeartbeatClock).failHeartbeat();
      await processing;
      await worker.stop();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    const interruptedInspector = new DatabaseSync(temporary.path, { readOnly: true });
    const interruptedRuns = interruptedInspector
      .prepare("SELECT terminal_status FROM agent_runs WHERE run_id = ?")
      .all(subject.runId) as Array<{ terminal_status: string | null }>;
    interruptedInspector.close();
    assert.ok(interruptedRuns.length >= 1);
    assert.ok(interruptedRuns.every((row) => row.terminal_status !== "cancelled"));

    repository.close();
    repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:02:03.000Z"),
    });
    const recoveryProvider = new FakeVocProvider(
      validAmazonVocInsightOutput(subject.facts),
    );
    await runRecoveryWorker(repository, recoveryProvider, subject);

    assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
    assert.equal(interruptedProvider.requests.length, 1);
    assert.equal(recoveryProvider.requests.length, 1);
    assert.equal((await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    })).length, 1);
  });
}

test("restart replays the terminal AgentRun and report without redispatch", async (t) => {
  const temporary = temporaryDatabase();
  let repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const firstService = await serviceHarness(repository, provider);
  const first = await firstService.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );
  repository.close();

  repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:04.000Z"),
  });
  const restarted = await serviceHarness(repository, provider);
  const replay = await restarted.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(provider.requests.length, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.report, first.report);
});

test("report persistence failure after paid success is classified for worker retry", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const unavailableReports = new Proxy(repository, {
    get(target, property) {
      if (property === "publishVocPositioningReport") {
        return async () => {
          throw new Error("private storage diagnostic");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = await serviceHarness(
    repository,
    provider,
    50_000,
    unavailableReports,
  );

  await assert.rejects(
    service.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "WorkerTaskError" &&
      "category" in error &&
      error.category === "upstream-temporary" &&
      !error.message.includes("private storage diagnostic"),
  );
  assert.equal(provider.requests.length, 1);
});

test("lease-expiry restart recovers terminal AgentRun before report insert without redispatch", async (t) => {
  const temporary = temporaryDatabase();
  let repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  repository.close();
  const isolatedProviderCalls = await runIsolatedCrashWorker(
    temporary.path,
    "before-report",
    subject,
  );
  repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:02:03.000Z"),
  });
  await runRecoveryWorker(repository, provider, subject);

  assert.equal(isolatedProviderCalls + provider.requests.length, 1);
  const reports = await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "voc-positioning",
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.version, 1);
  const recoveredAttempts = await repository.listJobAttempts(subject.stageId);
  assert.equal(recoveredAttempts.length, 2);
  assert.equal(
    recoveredAttempts[0]?.logicalExecutionCycleId,
    recoveredAttempts[1]?.logicalExecutionCycleId,
  );
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
});

test("lease-expiry restart reuses inserted report before job completion without redispatch", async (t) => {
  const temporary = temporaryDatabase();
  let repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  repository.close();
  const isolatedProviderCalls = await runIsolatedCrashWorker(
    temporary.path,
    "after-report",
    subject,
  );
  repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:02:03.000Z"),
  });
  assert.equal((await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "voc-positioning",
  })).length, 1);
  await runRecoveryWorker(repository, provider, subject);

  assert.equal(isolatedProviderCalls + provider.requests.length, 1);
  assert.equal((await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "voc-positioning",
  })).length, 1);
  const recoveredAttempts = await repository.listJobAttempts(subject.stageId);
  assert.equal(recoveredAttempts.length, 2);
  assert.equal(
    recoveredAttempts[0]?.logicalExecutionCycleId,
    recoveredAttempts[1]?.logicalExecutionCycleId,
  );
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
});

for (const crashPoint of [
  "after-terminal-failure-before-fail-job",
  "graceful-after-terminal-failure-before-fail-job",
  "heartbeat-after-terminal-failure-before-fail-job",
] as const) {
  test(`${crashPoint} starts a fresh bounded cycle after close and lease expiry`, async (t) => {
    const temporary = temporaryDatabase();
    let repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedExecution(repository, SCOOTER_ASINS);
    await repository.releaseJobLease({
      jobId: subject.jobAttemptId,
      ownerId: LEASE_OWNER,
      leaseGeneration: subject.leaseGeneration,
      releasedAt: "2026-08-16T00:00:01.000Z",
    });
    repository.close();

    const isolatedProviderCalls = await runIsolatedCrashWorker(
      temporary.path,
      crashPoint,
      subject,
    );
    repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:02:03.000Z"),
    });
    const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
    await runRecoveryWorker(repository, provider, subject);

    assert.equal(isolatedProviderCalls, 3);
    const attempts = await repository.listJobAttempts(subject.stageId);
    assert.equal(provider.requests.length, 1);
    assert.equal(attempts.length, 2);
    assert.notEqual(
      attempts[0]?.logicalExecutionCycleId,
      attempts[1]?.logicalExecutionCycleId,
    );
    assert.equal((await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    })).length, 1);
    assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
  });
}

for (const crashPoint of ["before-report", "after-report"] as const) {
  test(`final allowed attempt ${crashPoint} recovers without consuming another model attempt`, async (t) => {
    const temporary = temporaryDatabase();
    let repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedExecution(
      repository,
      SCOOTER_ASINS,
      realVocSnapshot,
      1,
    );
    await repository.releaseJobLease({
      jobId: subject.jobAttemptId,
      ownerId: LEASE_OWNER,
      leaseGeneration: subject.leaseGeneration,
      releasedAt: "2026-08-16T00:00:01.000Z",
    });
    repository.close();
    const isolatedProviderCalls = await runIsolatedCrashWorker(
      temporary.path,
      crashPoint,
      subject,
    );
    repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:02:03.000Z"),
    });
    const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
    await runRecoveryWorker(repository, provider, subject);

    assert.equal(isolatedProviderCalls + provider.requests.length, 1);
    const reports = await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    });
    assert.deepEqual(reports.map(({ version }) => version), [1]);
    assert.equal((await repository.listJobAttempts(subject.stageId)).length, 1);
    assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
  });
}

for (const failurePoint of ["before-insert", "after-commit"] as const) {
  test(`Worker report-only recovery converges ${failurePoint} publication failure`, async (t) => {
    const temporary = temporaryDatabase();
    let repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedExecution(
      repository,
      SCOOTER_ASINS,
      realVocSnapshot,
      1,
    );
    await repository.releaseJobLease({
      jobId: subject.jobAttemptId,
      ownerId: LEASE_OWNER,
      leaseGeneration: subject.leaseGeneration,
      releasedAt: "2026-08-16T00:00:01.000Z",
    });
    const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
    const publicationFailure = new Proxy(repository, {
      get(target, property) {
        if (property === "publishVocPositioningReport") {
          return async (...args: Parameters<SqliteAgentRepository["publishVocPositioningReport"]>) => {
            if (failurePoint === "after-commit") {
              await target.publishVocPositioningReport(...args);
            }
            throw new Error("private transient database failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const clock = new RetryWorkerClock();
    const firstWorker = await createRetryWorker(
      repository,
      provider,
      subject,
      clock,
      "report-failure-worker",
      publicationFailure,
    );
    assert.equal(await firstWorker.runOnce(), true);
    const firstCycle = (await repository.listJobAttempts(subject.stageId))[0]
      ?.logicalExecutionCycleId;
    repository.close();
    // The stored retry uses the transaction clock (00:00:03), not the worker
    // clock captured before the publication call (00:00:02).
    clock.advance(1_100);
    repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    const recoveryWorker = await createRetryWorker(
      repository,
      provider,
      subject,
      clock,
      "report-recovery-worker",
    );
    assert.equal(await recoveryWorker.runOnce(), true);

    assert.equal(provider.requests.length, 1);
    const attempts = await repository.listJobAttempts(subject.stageId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.logicalExecutionCycleId, firstCycle);
    const reports = await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    });
    assert.deepEqual(reports.map(({ version }) => version), [1]);
    assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
  });
}

for (const maxAttempts of [1, 3] as const) {
  test(`persistent report publication failure is bounded with physical maxAttempts=${maxAttempts}`, async (t) => {
    const temporary = temporaryDatabase();
    const repository = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
    });
    t.after(() => {
      repository.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedExecution(
      repository,
      SCOOTER_ASINS,
      realVocSnapshot,
      maxAttempts,
    );
    await repository.releaseJobLease({
      jobId: subject.jobAttemptId,
      ownerId: LEASE_OWNER,
      leaseGeneration: subject.leaseGeneration,
      releasedAt: "2026-08-16T00:00:01.000Z",
    });
    const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
    let publicationCalls = 0;
    let finishProbe!: (outcome: "terminal" | "hot-loop") => void;
    const probe = new Promise<"terminal" | "hot-loop">((resolve) => {
      finishProbe = resolve;
    });
    const publicationFailure = new Proxy(repository, {
      get(target, property) {
        if (property === "publishVocPositioningReport") {
          return async () => {
            publicationCalls += 1;
            if (publicationCalls >= 8) finishProbe("hot-loop");
            throw new Error("private persistent database failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const workerRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "failJob") {
          return async (...args: Parameters<SqliteAgentRepository["failJob"]>) => {
            const failed = await target.failJob(...args);
            if (!failed.retryable) finishProbe("terminal");
            return failed;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const clock = new AdvancingRunLoopClock();
    const worker = await createRetryWorker(
      repository,
      provider,
      subject,
      clock,
      `persistent-report-worker-${maxAttempts}`,
      publicationFailure,
      workerRepository,
    );
    worker.start();
    const timeout = setTimeout(() => finishProbe("hot-loop"), 2_000);
    const outcome = await probe;
    clearTimeout(timeout);
    await worker.stop();

    assert.equal(outcome, "terminal");
    assert.equal(provider.requests.length, 1);
    assert.ok(publicationCalls > 1 && publicationCalls <= 3);
    assert.equal((await repository.findRunStage(subject.stageId))?.status, "failed");
  });
}

test("publication retry budget and backoff survive SQLite close and reopen", async (t) => {
  const temporary = temporaryDatabase();
  let repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  let publicationCalls = 0;
  const failingRepository = () =>
    new Proxy(repository, {
      get(target, property) {
        if (property === "publishVocPositioningReport") {
          return async () => {
            publicationCalls += 1;
            throw new Error("private persistent database failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const clock = new RetryWorkerClock();
  const firstWorker = await createRetryWorker(
    repository,
    provider,
    subject,
    clock,
    "publication-before-reopen-worker",
    failingRepository(),
  );
  assert.equal(await firstWorker.runOnce(), true);
  const beforeReopen = (await repository.listJobAttempts(subject.stageId))[0]!;
  assert.equal(beforeReopen.reportPublicationAttemptCount, 1);
  assert.equal(beforeReopen.reportPublicationRetryAt, "2026-08-16T00:00:03.100Z");
  assert.equal(await firstWorker.runOnce(), false);

  repository.close();
  repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  clock.advance(1_100);
  const recoveryWorker = await createRetryWorker(
    repository,
    provider,
    subject,
    clock,
    "publication-after-reopen-worker",
    failingRepository(),
  );
  assert.equal(await recoveryWorker.runOnce(), true);
  assert.equal(
    (await repository.listJobAttempts(subject.stageId))[0]
      ?.reportPublicationAttemptCount,
    2,
  );
  clock.advance(100);
  assert.equal(await recoveryWorker.runOnce(), true);

  const terminal = (await repository.listJobAttempts(subject.stageId))[0]!;
  assert.equal(terminal.reportPublicationAttemptCount, 3);
  assert.equal(terminal.reportPublicationRetryAt, null);
  assert.equal(terminal.retryable, false);
  assert.equal(provider.requests.length, 1);
  assert.equal(publicationCalls, 3);
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "failed");
});

test("two SQLite workers increment one eligible publication retry exactly once", async (t) => {
  const temporary = temporaryDatabase();
  const first = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  const second = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    first.close();
    second.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(first, SCOOTER_ASINS);
  await first.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  let publicationCalls = 0;
  const failing = (repository: SqliteAgentRepository) =>
    new Proxy(repository, {
      get(target, property) {
        if (property === "publishVocPositioningReport") {
          return async () => {
            publicationCalls += 1;
            throw new Error("private persistent database failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const firstClock = new RetryWorkerClock();
  const initial = await createRetryWorker(
    first,
    provider,
    subject,
    firstClock,
    "publication-concurrency-initial",
    failing(first),
  );
  assert.equal(await initial.runOnce(), true);
  firstClock.advance(1_100);
  const secondClock = new RetryWorkerClock();
  secondClock.advance(1_100);
  const [left, right] = await Promise.all([
    createRetryWorker(
      first,
      provider,
      subject,
      firstClock,
      "publication-concurrency-a",
      failing(first),
    ).then((worker) => worker.runOnce()),
    createRetryWorker(
      second,
      provider,
      subject,
      secondClock,
      "publication-concurrency-b",
      failing(second),
    ).then((worker) => worker.runOnce()),
  ]);

  assert.deepEqual([left, right].sort(), [false, true]);
  assert.equal(publicationCalls, 2);
  assert.equal(provider.requests.length, 1);
  const attempt = (await first.listJobAttempts(subject.stageId))[0]!;
  assert.equal(attempt.reportPublicationAttemptCount, 2);
  assert.equal(attempt.reportPublicationRetryAt, "2026-08-16T00:00:03.200Z");
});

test("manual retry resets an exhausted publication cycle without redispatching the provider", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS, realVocSnapshot, 1);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const publicationFailure = new Proxy(repository, {
    get(target, property) {
      if (property === "publishVocPositioningReport") {
        return async () => {
          throw new Error("private persistent database failure");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const clock = new RetryWorkerClock();
  const failingWorker = await createRetryWorker(
    repository,
    provider,
    subject,
    clock,
    "manual-publication-failure-worker",
    publicationFailure,
  );
  assert.equal(await failingWorker.runOnce(), true);
  clock.advance(1_100);
  assert.equal(await failingWorker.runOnce(), true);
  clock.advance(100);
  assert.equal(await failingWorker.runOnce(), true);
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "failed");

  await new AnalysisRunService({
    repository,
    executionContext: {
      actorId: subject.actorId,
      organizationId: subject.organizationId,
    },
    now: clock.now,
    createId: randomUUID,
  }).retryStage(subject.runId, "voc-positioning");
  const recoveryWorker = await createRetryWorker(
    repository,
    provider,
    subject,
    clock,
    "manual-publication-recovery-worker",
  );
  assert.equal(await recoveryWorker.runOnce(), true);

  assert.equal(provider.requests.length, 1);
  assert.equal((await repository.findRunStage(subject.stageId))?.status, "succeeded");
  assert.equal((await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "voc-positioning",
  })).length, 1);
  const attempts = await repository.listJobAttempts(subject.stageId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.reportPublicationCycle, 2);
  assert.equal(attempts[0]?.reportPublicationAttemptCount, 0);
});

test("model drift on the same job identity conflicts before another provider call", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const service = await serviceHarness(repository, provider);
  await service.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  await assert.rejects(
    service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: { ...modelConfig(), name: "changed-model" },
      },
      executionContext(subject),
    ),
    /conflict/i,
  );
  assert.equal(provider.requests.length, 1);
});

test("the published Agent definition budget cannot be widened at dispatch", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(validAmazonVocInsightOutput(subject.facts));
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: { ...modelConfig(), timeoutMs: 300_001 },
      },
      executionContext(subject),
    ),
    /configuration|budget|limit/i,
  );
  assert.equal(provider.requests.length, 0);
});

test("actor transaction race rejects report publication after provider completion", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(
    validAmazonVocInsightOutput(subject.facts),
    async (_request, _attempt, output) => {
      const database = new DatabaseSync(temporary.path);
      database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(subject.actorId);
      database.close();
      return {
        value: output,
        responseId: "voc-actor-race",
        inputTokens: 500,
        outputTokens: 250,
      };
    },
  );
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
    /subject|available/i,
  );
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    }),
    [],
  );
});

test("claim and lease takeover fence the old owner from committing a report", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS);
  const provider = new FakeVocProvider(
    validAmazonVocInsightOutput(subject.facts),
    async (_request, _attempt, output) => {
      const database = new DatabaseSync(temporary.path);
      database
        .prepare(
          `UPDATE job_attempts
           SET leased_by = 'replacement-worker', lease_generation = lease_generation + 1
           WHERE id = ?`,
        )
        .run(subject.jobAttemptId);
      database.close();
      return {
        value: output,
        responseId: "voc-stale-owner",
        inputTokens: 500,
        outputTokens: 250,
      };
    },
  );
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
  );
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    }),
    [],
  );
});

test("the real Worker maps all-missing VOC facts to waiting-input without provider dispatch", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedExecution(repository, SCOOTER_ASINS, allMissingVocSnapshot);
  assert.equal(subject.facts.evidenceIndex.length, 0);
  await repository.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: LEASE_OWNER,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-16T00:00:01.000Z",
  });
  const provider = new FakeVocProvider({} as VocPositioningOutput);
  const service = await serviceHarness(repository, provider);
  const handler = createVocPositioningJobHandler({
    service,
    prepare: async () => ({
      request: {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: modelConfig(),
      },
      context: {
        actorId: subject.actorId,
        organizationId: subject.organizationId,
        projectId: subject.projectId,
        dataCutoffAt: CUTOFF,
      },
    }),
  });
  const worker = new JobAttemptWorkerLoop({
    repository,
    ownerId: LEASE_OWNER,
    handler,
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock: {
      now: () => "2026-08-16T00:00:02.000Z",
      sleep: async (_durationMs, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    },
  });

  assert.equal(await worker.runOnce(), true);

  assert.equal(provider.requests.length, 0);
  const [stage] = await repository.listRunStages(subject.runId);
  assert.equal(stage?.status, "waiting-input");
  assert.deepEqual(stage?.lastError, {
    classification: "data-quality",
    message: "VOC input is required; paste or import an Amazon/Alexa VOC file to continue",
  });
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "voc-positioning",
    }),
    [],
  );
});

for (const unauthorized of [false, true]) test(`strategy repair patches preserve the insight and reject unrelated edits: ${unauthorized}`, async t => {
 const temporary = temporaryDatabase();
 const repository = openSqliteAgentRepository({path:temporary.path,busyTimeoutMs:5000,nowProvider:()=>new Date("2026-08-16T00:00:03.000Z")});
 t.after(()=>{repository.close();rmSync(temporary.directory,{recursive:true,force:true});});
 const subject=await seedExecution(repository,SCOOTER_ASINS);
 const valid=validAmazonVocInsightOutput(subject.facts);
 const invalid=structuredClone(valid);
 const index=invalid.positioningProjection.positioning.findIndex(x=>x.stance==='supported-by-voc' && x.dimension!=='price-tier');
 assert.ok(index>=0);invalid.positioningProjection.positioning[index]!.strategy='differentiate';
 const patch={schemaVersion:'1.0.0',kind:'voc-strategy-repair',changes:[{index:unauthorized?(index+1)%10:index,strategy:valid.positioningProjection.positioning[index]!.strategy}]};
 const provider=new FakeVocProvider(valid,async(_request,attempt)=>({value:attempt===1?invalid:patch,responseId:`patch-${attempt}`,inputTokens:500,outputTokens:250}));
 const service=await serviceHarness(repository,provider);
 const execution=service.execute({snapshotId:subject.snapshotId,facts:subject.facts,model:{...modelConfig(),estimatedInputTokens:32000}},executionContext(subject));
 if(unauthorized) await assert.rejects(execution);else {const result=await execution;assert.equal(result.report.status,'complete');assert.deepEqual((result.report.result as {insight:unknown}).insight,valid.insight);}
 assert.equal(provider.requests.length,2);assert.equal(provider.requests[1]!.responseFormat.format.name,'AmazonVocStrategyRepair_1_0_0');assert.deepEqual(provider.requests[1]!.input,{});assert.ok(provider.requests[1]!.instructions.length<6000);assert.ok(provider.requests[1]!.timeoutMs<=60000);
});

test("compact VOC output restores snapshot facts without changing model judgments",async t=>{
 const temporary=temporaryDatabase();const repository=openSqliteAgentRepository({path:temporary.path,busyTimeoutMs:5000,nowProvider:()=>new Date("2026-08-16T00:00:03.000Z")});t.after(()=>{repository.close();rmSync(temporary.directory,{recursive:true,force:true});});
 const subject=await seedExecution(repository,SCOOTER_ASINS);const valid=validAmazonVocInsightOutput(subject.facts);
 const compact=JSON.parse(JSON.stringify(valid));const p=compact.positioningProjection;delete p.identity;delete p.coverage;
 for(const j of p.themeJudgments){delete j.metrics;delete j.evidenceIds;delete j.label;delete j.priority;}
 for(const row of [p.coreConclusion,...p.positioning,...p.actions,...p.nextValidations,...Object.values(p.checklists).flat()])delete (row as {evidenceIds?:unknown}).evidenceIds;
 assert.ok(JSON.stringify(compact).length < JSON.stringify(valid).length * 0.75);
 const provider=new FakeVocProvider(compact);const service=await serviceHarness(repository,provider);
 const result=await service.execute({snapshotId:subject.snapshotId,facts:subject.facts,model:modelConfig()},executionContext(subject));assert.equal(result.report.status,'complete');assert.equal(provider.requests.length,1);assert.equal('evidenceIndex' in (provider.requests[0]!.input as object),false);assert.deepEqual((result.report.result as {insight:unknown}).insight,valid.insight);
 const stored=(result.report.result as {positioningProjection:typeof valid.positioningProjection}).positioningProjection;assert.deepEqual(stored.identity,valid.positioningProjection.identity);assert.deepEqual(stored.themeJudgments,valid.positioningProjection.themeJudgments);
});

test("real relay adapter allows the runner to apply bounded strategy repair",async t=>{
 const temporary=temporaryDatabase();const repository=openSqliteAgentRepository({path:temporary.path,busyTimeoutMs:5000,nowProvider:()=>new Date("2026-08-16T00:00:03.000Z")});t.after(()=>{repository.close();rmSync(temporary.directory,{recursive:true,force:true});});
 const subject=await seedExecution(repository,SCOOTER_ASINS);const valid=validAmazonVocInsightOutput(subject.facts);const invalid=structuredClone(valid);invalid.positioningProjection.positioning[0]!.strategy='differentiate';
 const names:string[]=[];
 const provider=new OpenAIProvider({transport:'relay-chat-json',deferOutputValidation:true,client:{chat:{completions:{create:async(body:{response_format:{json_schema:{name:string}}})=>{names.push(body.response_format.json_schema.name);return {id:`real-adapter-${names.length}`,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(names.length===1?invalid:{schemaVersion:'1.0.0',kind:'voc-strategy-repair',changes:[{index:0,strategy:valid.positioningProjection.positioning[0]!.strategy}]})}}],usage:{prompt_tokens:500,completion_tokens:250,total_tokens:750}};}}}} as never});
 const service=await serviceHarness(repository,provider);const result=await service.execute({snapshotId:subject.snapshotId,facts:subject.facts,model:modelConfig()},executionContext(subject));assert.equal(result.report.status,'complete');assert.deepEqual(names,['AmazonVocInsightOutput_1_0_0','AmazonVocStrategyRepair_1_0_0']);
});

test("real relay adapter repairs unknown compact references without infrastructure failure",async t=>{
 const temporary=temporaryDatabase();const repository=openSqliteAgentRepository({path:temporary.path,busyTimeoutMs:5000,nowProvider:()=>new Date("2026-08-16T00:00:03.000Z")});t.after(()=>{repository.close();rmSync(temporary.directory,{recursive:true,force:true});});
 const subject=await seedExecution(repository,SCOOTER_ASINS);const valid=validAmazonVocInsightOutput(subject.facts);const invalid=structuredClone(valid);const compact=JSON.parse(JSON.stringify(invalid));const p=compact.positioningProjection;delete p.identity;delete p.coverage;
 for(const j of p.themeJudgments){delete j.metrics;delete j.evidenceIds;delete j.label;delete j.priority;}
 for(const row of [p.coreConclusion,...p.positioning,...p.actions,...p.nextValidations,...Object.values(p.checklists).flat()])delete (row as {evidenceIds?:unknown}).evidenceIds;
 p.coreConclusion.themeRefs[0].themeKey='nonexistent-reference';
 const names:string[]=[];
 const provider=new OpenAIProvider({transport:'relay-chat-json',deferOutputValidation:true,client:{chat:{completions:{create:async(body:{response_format:{json_schema:{name:string}}})=>{names.push(body.response_format.json_schema.name);return {id:`real-adapter-${names.length}`,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(names.length===1?compact:valid)}}],usage:{prompt_tokens:500,completion_tokens:250,total_tokens:750}};}}}} as never});
 const service=await serviceHarness(repository,provider);const result=await service.execute({snapshotId:subject.snapshotId,facts:subject.facts,model:modelConfig()},executionContext(subject));assert.equal(result.report.status,'complete');assert.deepEqual(names,['AmazonVocInsightOutput_1_0_0','AmazonVocInsightOutput_1_0_0']);
});

test("compact response bounds narrative sections while preserving all positioning dimensions", () => {
 const shape = compactVocResponseSchema.shape.insight.shape;
 assert.equal(shape.productDirections.safeParse([]).success, false);
 const schema = JSON.stringify(z.toJSONSchema(compactVocResponseSchema));
 assert.match(schema, /"maxItems":3/);
 assert.equal(JSON.parse(schema).properties.positioningProjection.properties.positioning.minItems, 10);
});
