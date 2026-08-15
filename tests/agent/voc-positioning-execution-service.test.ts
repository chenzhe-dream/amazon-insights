import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
import { SkillRunner } from "../../server/runtime/skill-runner";
import { JobAttemptWorkerLoop } from "../../server/runtime/worker-loop";
import { SkillRegistry } from "../../server/skills/registry";
import {
  VocPositioningExecutionService,
  type VocPositioningExecutionContext,
} from "../../server/services/voc-positioning-execution-service";
import { createVocPositioningJobHandler } from "../../server/services/voc-positioning-worker-handler";
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
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";
const STARTED_AT = "2026-08-16T00:00:00.000Z";
const LEASE_OWNER = "voc-execution-worker";

class FakeVocProvider implements ModelProvider {
  readonly requests: StructuredGenerationRequest<unknown>[] = [];

  constructor(
    readonly output: VocPositioningOutput,
    readonly generate: (
      request: StructuredGenerationRequest<unknown>,
      attempt: number,
      output: VocPositioningOutput,
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
    maxAttempts: 3,
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
  const provider = new FakeVocProvider(validVocPositioningOutput(parserValidatedDrift));
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
) {
  const registry = await SkillRegistry.open(path.resolve("skills-src"));
  let tick = Date.parse(STARTED_AT);
  const clock = () => new Date((tick += 10));
  const skillRunner = new SkillRunner({
    registry,
    provider,
    providerName: "fake",
    budgetCoordinator: new ModelBudgetCoordinator({
      repository,
      limitProvider: new StaticModelBudgetLimitProvider({
        call: { maxTokens, maxCostMicros: 50_000 },
        run: { maxTokens, maxCostMicros: 50_000 },
        organizationUtcDay: { maxTokens, maxCostMicros: 50_000 },
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
    dataCutoffAt: CUTOFF,
  } satisfies AuditedSkillExecutionContext & { actorId: string };
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
    const provider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
    const service = await serviceHarness(repository, provider);

    const first = await service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: modelConfig(),
      },
      executionContext(subject),
    );
    const replay = await service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
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
    );

    assert.equal(provider.requests.length, 1);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.report, first.report);
    assert.equal(first.report.status, label === "full scooter" ? "complete" : "partial");
    assert.equal(first.report.skill.id, "define-amazon-voc-positioning");
    assert.equal(first.report.result.identity.factsDigest, subject.facts.factsDigest);
    const sent = provider.requests[0]!.input as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent), [
      "schemaVersion",
      "kind",
      "snapshot",
      "factsDigest",
      "coverage",
      "dimensions",
      "evidenceIndex",
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
  const valid = validVocPositioningOutput(subject.facts);
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
  assert.equal(provider.requests[1]!.instructions.includes("private malformed body"), false);
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
  const valid = validVocPositioningOutput(subject.facts);
  const invalid = structuredClone(valid);
  assert.ok(invalid.themeJudgments[0]?.metrics[0]);
  invalid.themeJudgments[0].metrics[0].mentionPct = 99;
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
    validVocPositioningOutput(subject.facts),
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
  const provider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
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

  const cancelledProvider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
  const cancelled = await serviceHarness(repository, cancelledProvider);
  const controller = new AbortController();
  controller.abort();
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
  const provider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
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

test("restart closes the crash gap after AgentRun finalization without redispatch", async (t) => {
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
  const provider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
  const publicationCrash = new Proxy(repository, {
    get(target, property) {
      if (property === "publishVocPositioningReport") {
        return async () => {
          throw new Error("simulated process crash before report publication");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const interrupted = await serviceHarness(
    repository,
    provider,
    50_000,
    publicationCrash,
  );

  await assert.rejects(
    interrupted.execute(
      { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
      executionContext(subject),
    ),
    /simulated process crash/i,
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

  const restarted = await serviceHarness(repository, provider);
  const recovered = await restarted.execute(
    { snapshotId: subject.snapshotId, facts: subject.facts, model: modelConfig() },
    executionContext(subject),
  );

  assert.equal(provider.requests.length, 1);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.report.version, 1);
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
  const provider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
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
  const provider = new FakeVocProvider(validVocPositioningOutput(subject.facts));
  const service = await serviceHarness(repository, provider);

  await assert.rejects(
    service.execute(
      {
        snapshotId: subject.snapshotId,
        facts: subject.facts,
        model: { ...modelConfig(), maxOutputTokens: 8_001 },
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
    validVocPositioningOutput(subject.facts),
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
    validVocPositioningOutput(subject.facts),
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
    message: "VOC positioning requires at least one evidence fact",
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
