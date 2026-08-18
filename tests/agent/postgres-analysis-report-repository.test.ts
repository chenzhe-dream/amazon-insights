import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { buildKeywordAnalysisSnapshotCandidate } from "../../server/data/keyword-analysis-snapshot";
import { buildTrafficSnapshotCandidate } from "../../server/data/traffic-data-snapshot";
import type { TrafficDataSnapshotRecord } from "../../server/data/traffic-data-snapshot";
import type { VocDataSnapshotRecord } from "../../server/data/voc-data-snapshot";
import type { FinalizeAgentRunInput, RegisterSkillVersionInput } from "../../server/db/agent-run-repository";
import {
  AnalysisReportConflictError,
  AnalysisReportDataError,
  AnalysisReportLeaseLostError,
  AnalysisReportSubjectNotFoundError,
  type AnalysisReportRepository,
} from "../../server/db/analysis-report-repository";
import { PostgresAgentRunStore } from "../../server/db/postgres/agent-run-store";
import { PostgresAnalysisReportStore } from "../../server/db/postgres/analysis-report-store";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { PostgresDataSnapshotStore } from "../../server/db/postgres/data-snapshot-store";
import { PostgresJobStore } from "../../server/db/postgres/job-store";
import { PostgresKeywordAnalysisSnapshotStore } from "../../server/db/postgres/keyword-analysis-snapshot-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresProductDependencyReconciler } from "../../server/db/postgres/product-dependency-reconciler";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresTrafficDataSnapshotStore } from "../../server/db/postgres/traffic-data-snapshot-store";
import {
  PRODUCT_DEFINITION_DATA_BOUNDARY,
  buildProductDefinitionInput,
  type ProductDefinitionInput,
  type ProductDefinitionOutput,
} from "../../server/domain/product/product-definition-contracts";
import {
  buildDeterministicTrafficInput,
  type TrafficAnalysisInput,
  type TrafficAnalysisOutput,
} from "../../server/domain/traffic/traffic-analysis-contracts";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import type { VocPositioningOutput } from "../../server/domain/voc/voc-positioning-contracts";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const now = "2026-08-19T00:00:00.000Z";
const cutoff = "2026-08-15T23:59:59.999Z";
const claimedAt = "2026-08-18T00:00:00.000Z";
const completedAt = "2026-08-18T00:00:01.000Z";
const publishedAt = "2026-08-18T00:00:02.000Z";
const leaseOwner = "postgres-report-worker";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

interface RepositoryBundle {
  pool: Pool;
  queries: PostgresQueryContext;
  core: PostgresCoreStore;
  jobs: PostgresJobStore;
  agentRuns: PostgresAgentRunStore;
  vocSnapshots: PostgresDataSnapshotStore;
  trafficSnapshots: PostgresTrafficDataSnapshotStore;
  keywords: PostgresKeywordAnalysisSnapshotStore;
  reports: AnalysisReportRepository;
}

interface SeededTarget {
  organizationId: string;
  actorId: string;
  projectId: string;
  runId: string;
  vocStageId: string;
  trafficStageId: string;
  productStageId: string;
  vocSnapshot: VocDataSnapshotRecord;
  trafficSnapshot: TrafficDataSnapshotRecord;
  keywordSnapshot: Awaited<ReturnType<PostgresKeywordAnalysisSnapshotStore["createKeywordAnalysisSnapshotForRun"]>>["snapshot"];
  factsDigest: string;
}

interface SeededExecution<Result extends Record<string, unknown>> {
  target: SeededTarget;
  stageId: string;
  jobAttemptId: string;
  agentRunId: string;
  logicalExecutionLineage: string;
  leaseGeneration: number;
  skill: { id: string; version: string; contentHash: string };
  model: { provider: string; model: string; responseId?: string };
  result: Result;
}

async function freshRepository(): Promise<RepositoryBundle> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const queries = new PostgresQueryContext(pool);
  const reconciler = new PostgresProductDependencyReconciler(queries);
  return {
    pool,
    queries,
    core: new PostgresCoreStore(queries),
    jobs: new PostgresJobStore(queries),
    agentRuns: new PostgresAgentRunStore(queries),
    vocSnapshots: new PostgresDataSnapshotStore(queries),
    trafficSnapshots: new PostgresTrafficDataSnapshotStore(queries),
    keywords: new PostgresKeywordAnalysisSnapshotStore(queries, { dependencyReconciler: reconciler }),
    reports: new PostgresAnalysisReportStore(queries, { dependencyReconciler: reconciler, now: () => now }),
  };
}

function siblingReports(pool: Pool): AnalysisReportRepository {
  const queries = new PostgresQueryContext(pool);
  return new PostgresAnalysisReportStore(queries, {
    dependencyReconciler: new PostgresProductDependencyReconciler(queries),
    now: () => now,
  });
}

async function seedTarget(repository: RepositoryBundle): Promise<SeededTarget> {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const vocStageId = randomUUID();
  const trafficStageId = randomUUID();
  const productStageId = randomUUID();
  await repository.core.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Report actor",
    role: "admin",
    status: "active",
    createdAt: claimedAt,
    updatedAt: claimedAt,
  });
  await repository.core.createProject({
    id: projectId,
    organizationId,
    name: "Report project",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actorId,
    createdAt: claimedAt,
    updatedAt: claimedAt,
  });
  await repository.core.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: cutoff,
    idempotencyScope: `postgres-report:${runId}`,
    idempotencyKey: "create",
    createdAt: claimedAt,
    updatedAt: claimedAt,
  });
  for (const [id, stage] of [
    [vocStageId, "voc-positioning"],
    [trafficStageId, "traffic-analysis"],
    [productStageId, "product-definition"],
  ] as const) {
    await repository.core.createRunStage({
      id,
      runId,
      stage,
      status: stage === "product-definition" ? "waiting-input" : "queued",
      progress: 0,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: claimedAt,
      updatedAt: claimedAt,
    });
  }

  const vocRecord = realVocSnapshot(SCOOTER_ASINS, randomUUID(), runId);
  const { id: _id, runId: _runId, createdAt: _createdAt, ...vocCandidate } = vocRecord;
  void _id;
  void _runId;
  void _createdAt;
  const vocSnapshot = await repository.vocSnapshots.createDataSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: cutoff,
    candidateId: vocRecord.id,
    createdAt: claimedAt,
    candidate: vocCandidate,
  });
  const trafficInput = buildDeterministicTrafficInput({
    marketplace: "US",
    asins: SCOOTER_ASINS,
    dataCutoffAt: cutoff,
  });
  const trafficSnapshot = await repository.trafficSnapshots.createTrafficDataSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: cutoff,
    candidateId: randomUUID(),
    createdAt: claimedAt,
    candidate: buildTrafficSnapshotCandidate({ asins: SCOOTER_ASINS, trafficInput }),
  });
  const keywordSnapshot = await repository.keywords.createKeywordAnalysisSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: cutoff,
    candidateId: randomUUID(),
    createdAt: claimedAt,
    candidate: keywordCandidate(),
  });
  return {
    organizationId,
    actorId,
    projectId,
    runId,
    vocStageId,
    trafficStageId,
    productStageId,
    vocSnapshot: vocSnapshot.snapshot,
    trafficSnapshot: trafficSnapshot.snapshot,
    keywordSnapshot: keywordSnapshot.snapshot,
    factsDigest: preprocessVocSnapshot(vocSnapshot.snapshot).factsDigest,
  };
}

async function seedExecution<Result extends Record<string, unknown>>(
  repository: RepositoryBundle,
  target: SeededTarget,
  input: {
    stage: "voc-positioning" | "traffic-analysis" | "product-definition";
    snapshotIds: readonly string[];
    result: Result;
    responseId: string;
    skillId: string;
  },
): Promise<SeededExecution<Result>> {
  const stageId = input.stage === "voc-positioning"
    ? target.vocStageId
    : input.stage === "traffic-analysis"
      ? target.trafficStageId
      : target.productStageId;
  const jobAttemptId = randomUUID();
  const attemptNumber = await nextAttemptNumber(repository.pool, stageId);
  await repository.jobs.enqueueJob({
    id: jobAttemptId,
    stageId,
    attemptNumber,
    maxAttempts: 10,
    availableAt: claimedAt,
    createdAt: claimedAt,
  });
  const job = await repository.jobs.claimNextJob({
    ownerId: leaseOwner,
    claimedAt,
    leaseDurationMs: 14 * 24 * 60 * 60 * 1000,
    stage: input.stage,
  });
  assert.equal(job?.id, jobAttemptId);
  const skill = await repository.agentRuns.registerSkillVersion(skillVersionInput(input.skillId));
  const claimToken = randomUUID();
  const logicalExecutionLineage = sha256(`${input.stage}:${randomUUID()}`);
  const begun = await repository.agentRuns.beginAgentRun({
    id: randomUUID(),
    organizationId: target.organizationId,
    runId: target.runId,
    stageId,
    jobAttemptId,
    skillVersionId: skill.id,
    snapshotIds: input.snapshotIds,
    executionFingerprint: sha256(`fingerprint:${jobAttemptId}`),
    logicalExecutionLineage,
    logicalExecutionCycleId: job!.logicalExecutionCycleId,
    outputSchemaDigest: sha256(`schema:${input.stage}`),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: sha256(`input:${jobAttemptId}`), recordCount: input.snapshotIds.length },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: cutoff,
    startedAt: claimedAt,
    leaseOwnerId: leaseOwner,
    leaseGeneration: job!.leaseGeneration,
    claimToken,
    claimAcquiredAt: claimedAt,
    claimExpiresAt: "2026-08-30T00:00:00.000Z",
  });
  const finalized = await repository.agentRuns.finalizeAgentRun({
    agentRunId: begun.record.id,
    organizationId: target.organizationId,
    leaseOwnerId: leaseOwner,
    leaseGeneration: job!.leaseGeneration,
    claimToken,
    completedAt,
    outcome: succeededOutcome(input.result, input.responseId),
  });
  return {
    target,
    stageId,
    jobAttemptId,
    agentRunId: finalized.record.id,
    logicalExecutionLineage,
    leaseGeneration: job!.leaseGeneration,
    skill: finalized.record.skill,
    model: finalized.record.model,
    result: input.result,
  };
}

function vocPublishInput(seed: SeededExecution<VocPositioningOutput>) {
  return {
    id: randomUUID(),
    actorId: seed.target.actorId,
    actorOrganizationId: seed.target.organizationId,
    expectedProjectId: seed.target.projectId,
    runId: seed.target.runId,
    stageId: seed.stageId,
    jobAttemptId: seed.jobAttemptId,
    agentRunId: seed.agentRunId,
    logicalExecutionLineage: seed.logicalExecutionLineage,
    snapshotId: seed.target.vocSnapshot.id,
    factsDigest: seed.target.factsDigest,
    skill: seed.skill,
    model: seed.model,
    leaseOwnerId: leaseOwner,
    leaseGeneration: seed.leaseGeneration,
    publishedAt,
    result: seed.result,
  };
}

function trafficPublishInput(seed: SeededExecution<TrafficAnalysisOutput>) {
  return {
    id: randomUUID(),
    actorId: seed.target.actorId,
    actorOrganizationId: seed.target.organizationId,
    expectedProjectId: seed.target.projectId,
    runId: seed.target.runId,
    stageId: seed.stageId,
    jobAttemptId: seed.jobAttemptId,
    agentRunId: seed.agentRunId,
    logicalExecutionLineage: seed.logicalExecutionLineage,
    snapshotId: seed.target.trafficSnapshot.id,
    skill: seed.skill,
    model: seed.model,
    leaseOwnerId: leaseOwner,
    leaseGeneration: seed.leaseGeneration,
    publishedAt,
    result: seed.result,
  };
}

function productPublishInput(
  seed: SeededExecution<ProductDefinitionOutput>,
  vocReportId: string,
) {
  return {
    id: randomUUID(),
    actorId: seed.target.actorId,
    actorOrganizationId: seed.target.organizationId,
    expectedProjectId: seed.target.projectId,
    runId: seed.target.runId,
    stageId: seed.stageId,
    jobAttemptId: seed.jobAttemptId,
    agentRunId: seed.agentRunId,
    logicalExecutionLineage: seed.logicalExecutionLineage,
    vocReportId,
    keywordSnapshotId: seed.target.keywordSnapshot.id,
    skill: seed.skill,
    model: seed.model,
    leaseOwnerId: leaseOwner,
    leaseGeneration: seed.leaseGeneration,
    publishedAt,
    result: seed.result,
  };
}

test("PostgreSQL reports publish VOC, traffic, and product artifacts with replay, versioning, and isolation", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const facts = preprocessVocSnapshot(target.vocSnapshot);
  const vocResult = validVocPositioningOutput(facts);
  const voc = await seedExecution(repository, target, {
    stage: "voc-positioning",
    snapshotIds: [target.vocSnapshot.id],
    result: vocResult,
    responseId: "response-voc-1",
    skillId: "define-amazon-voc-positioning",
  });

  const createdVoc = await repository.reports.publishVocPositioningReport(vocPublishInput(voc));
  const replayVoc = await repository.reports.publishVocPositioningReport(vocPublishInput(voc));
  assert.equal(createdVoc.created, true);
  assert.equal(replayVoc.created, false);
  assert.equal(replayVoc.report.id, createdVoc.report.id);
  assert.equal(createdVoc.report.version, 1);
  assert.equal(Object.isFrozen(createdVoc.report), true);
  assert.equal(Object.isFrozen(createdVoc.report.result), true);
  assert.deepEqual(
    await repository.reports.listAnalysisReports({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
      stage: "voc-positioning",
    }),
    [createdVoc.report],
  );
  assert.equal(
    await repository.reports.findAnalysisReportById({
      actorOrganizationId: randomUUID(),
      reportId: createdVoc.report.id,
    }),
    null,
  );

  const secondVoc = await seedExecution(repository, target, {
    stage: "voc-positioning",
    snapshotIds: [target.vocSnapshot.id],
    result: vocResult,
    responseId: "response-voc-2",
    skillId: "define-amazon-voc-positioning",
  });
  const concurrent = await Promise.all([
    repository.reports.publishVocPositioningReport(vocPublishInput(secondVoc)),
    siblingReports(postgres.createPool({ searchPath: await currentSchema(repository.pool) }))
      .publishVocPositioningReport(vocPublishInput(await seedExecution(repository, target, {
        stage: "voc-positioning",
        snapshotIds: [target.vocSnapshot.id],
        result: vocResult,
        responseId: "response-voc-3",
        skillId: "define-amazon-voc-positioning",
      }))),
  ]);
  assert.deepEqual(concurrent.map(({ report }) => report.version).sort(), [2, 3]);

  const trafficResult = validTrafficOutput(target.trafficSnapshot.payload.input);
  const traffic = await seedExecution(repository, target, {
    stage: "traffic-analysis",
    snapshotIds: [target.trafficSnapshot.id],
    result: trafficResult,
    responseId: "response-traffic-1",
    skillId: "analyze-amazon-traffic",
  });
  const createdTraffic = await repository.reports.publishTrafficAnalysisReport(trafficPublishInput(traffic));
  assert.equal(createdTraffic.created, true);
  assert.deepEqual(createdTraffic.report.evidence, [{
    id: target.trafficSnapshot.id,
    type: "snapshot",
    sourceId: "traffic-data-snapshot",
    capturedAt: target.trafficSnapshot.createdAt,
  }]);

  const productInput = buildProductDefinitionInput({
    marketplace: "US",
    asins: SCOOTER_ASINS,
    dataCutoffAt: cutoff,
    vocReport: createdVoc.report,
    keywordSnapshot: target.keywordSnapshot,
  });
  const product = await seedExecution(repository, target, {
    stage: "product-definition",
    snapshotIds: createdVoc.report.snapshotIds,
    result: validProductOutput(productInput),
    responseId: "response-product-1",
    skillId: "define-amazon-product",
  });
  const createdProduct = await repository.reports.publishProductDefinitionReport(
    productPublishInput(product, createdVoc.report.id),
  );
  assert.equal(createdProduct.created, true);
  assert.deepEqual(createdProduct.report.snapshotIds, [
    ...createdVoc.report.snapshotIds,
    target.keywordSnapshot.id,
  ]);
});

test("PostgreSQL reports reject lease, lineage, dependency, replay drift, and stored JSON corruption", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const facts = preprocessVocSnapshot(target.vocSnapshot);
  const voc = await seedExecution(repository, target, {
    stage: "voc-positioning",
    snapshotIds: [target.vocSnapshot.id],
    result: validVocPositioningOutput(facts),
    responseId: "response-voc-fence",
    skillId: "define-amazon-voc-positioning",
  });
  await assert.rejects(
    repository.reports.publishVocPositioningReport({
      ...vocPublishInput(voc),
      leaseGeneration: voc.leaseGeneration + 1,
    }),
    AnalysisReportLeaseLostError,
  );
  await assert.rejects(
    repository.reports.publishVocPositioningReport({
      ...vocPublishInput(voc),
      logicalExecutionLineage: "1".repeat(64),
    }),
    AnalysisReportConflictError,
  );
  await assert.rejects(
    repository.reports.publishVocPositioningReport({
      ...vocPublishInput(voc),
      expectedProjectId: randomUUID(),
    }),
    AnalysisReportSubjectNotFoundError,
  );
  const created = await repository.reports.publishVocPositioningReport(vocPublishInput(voc));
  await assert.rejects(
    repository.reports.publishVocPositioningReport({
      ...vocPublishInput(voc),
      result: { ...voc.result, status: "partial" },
    }),
    AnalysisReportConflictError,
  );
  await repository.pool.query(
    "ALTER TABLE analysis_reports DISABLE TRIGGER analysis_reports_no_update",
  );
  await repository.pool.query(
    "UPDATE analysis_reports SET result_json = $1::jsonb WHERE id = $2",
    [JSON.stringify({ damaged: true }), created.report.id],
  );
  await repository.pool.query(
    "ALTER TABLE analysis_reports ENABLE TRIGGER analysis_reports_no_update",
  );
  await assert.rejects(
    repository.reports.findAnalysisReportById({
      actorOrganizationId: target.organizationId,
      reportId: created.report.id,
    }),
    AnalysisReportDataError,
  );

  const productInput = buildProductDefinitionInput({
    marketplace: "US",
    asins: SCOOTER_ASINS,
    dataCutoffAt: cutoff,
    vocReport: created.report,
    keywordSnapshot: target.keywordSnapshot,
  });
  const product = await seedExecution(repository, target, {
    stage: "product-definition",
    snapshotIds: created.report.snapshotIds,
    result: validProductOutput(productInput),
    responseId: "response-product-fence",
    skillId: "define-amazon-product",
  });
  await assert.rejects(
    repository.reports.publishProductDefinitionReport(
      productPublishInput(product, randomUUID()),
    ),
    AnalysisReportSubjectNotFoundError,
  );
});

function skillVersionInput(skillId: string): RegisterSkillVersionInput {
  const contentHash = sha256(`skill:${skillId}`);
  return {
    id: randomUUID(),
    skillId,
    version: "1.0.0",
    contentHash,
    manifest: {
      id: skillId,
      version: "1.0.0",
      entry: "SKILL.md",
      allowedReferences: ["references/test.md"],
      inputSchema: "TestInput@1.0.0",
      outputSchema: "TestOutput@1.0.0",
      fixtures: ["fixture"],
      contentHash,
    },
    createdAt: claimedAt,
  };
}

function succeededOutcome(
  output: Record<string, unknown>,
  responseId: string,
): FinalizeAgentRunInput["outcome"] {
  return {
    terminalStatus: "succeeded",
    validationStatus: "passed",
    responseId,
    output,
    error: null,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostMicros: 25,
    durationMs: 1_000,
    attemptCount: 1,
    usageCompleteness: "complete",
    attempts: [{
      ordinal: 0,
      kind: "initial",
      transientRetryCount: 0,
      formatRepair: false,
      accounting: "settled",
      errorClassification: null,
    }],
    terminalMetadata: { kind: "succeeded" },
  };
}

function validTrafficOutput(input: TrafficAnalysisInput): TrafficAnalysisOutput {
  return {
    schemaVersion: "1.0.0",
    kind: "competitor-traffic-analysis",
    status: "complete",
    identity: {
      dataCutoffAt: input.dataCutoffAt,
      inputDigest: input.inputDigest,
    },
    summary: "流量规模、份额与结构只用于判断流量获取和运营能力。",
    competitors: input.competitors,
    decisionBoundaries: {
      profitability: "not-assessed",
      advertisingEfficiency: "requires-validation",
      roi: "not-assessed",
      projectApproval: "not-assessed",
    },
    dataBoundary: "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。",
  };
}

function keywordCandidate() {
  return buildKeywordAnalysisSnapshotCandidate({
    marketplace: "US",
    asins: SCOOTER_ASINS,
    dataCutoffAt: cutoff,
    groups: [{
      id: "core-product",
      label: "核心产品词",
      keywords: ["kids scooter"],
      demand: "high",
      trend: "stable",
      seasonality: "unknown",
      evidenceIds: ["keyword-evidence-1"],
    }],
    evidence: [{
      id: "keyword-evidence-1",
      sourceId: "fixture-keyword-analysis",
      capturedAt: cutoff,
      searchVolume: 1_000,
      purchaseRate: null,
    }],
  });
}

function validProductOutput(input: ProductDefinitionInput): ProductDefinitionOutput {
  const theme = input.voc.result.themeJudgments[0]!;
  const keyword = input.keywords.groups[0]!;
  return {
    schemaVersion: "1.0.0",
    kind: "amazon-product-definition",
    status: "complete",
    identity: {
      vocReportId: input.voc.reportId,
      vocReportVersion: input.voc.version,
      keywordSnapshotId: input.keywords.snapshotId,
      keywordContentHash: input.keywords.contentHash,
      dataCutoffAt: input.dataCutoffAt,
    },
    opportunity: {
      grade: "A",
      scope: "demand-and-product-definition-opportunity",
      projectApproval: "not-approved",
    },
    evidenceMatrix: [{
      themeKey: theme.themeKey,
      keywordGroupId: keyword.id,
      vocEvidenceIds: theme.evidenceIds,
      keywordEvidenceIds: keyword.evidenceIds,
      judgment: "dual-validation",
      productRole: "core-foundation",
      priority: theme.priority,
    }],
    finalDefinition: [{
      dimension: "product-form",
      conclusion: "保留VOC核心价值，并以已验证关键词词群承接需求。",
      vocEvidenceIds: theme.evidenceIds,
      keywordEvidenceIds: keyword.evidenceIds,
      action: "validate",
      priority: theme.priority,
      validationStatus: "requires-validation",
    }],
    configurationLayers: {
      mustHave: [{ item: "核心体验", evidenceIds: theme.evidenceIds }],
      differentiation: [{ item: "体验差异化", evidenceIds: theme.evidenceIds }],
      optional: [],
      notInV1: [],
      p0Avoid: [],
    },
    keywordLanding: [{
      groupId: keyword.id,
      role: "core-term",
      productLink: "核心产品形态",
      listingAngle: "需求匹配",
      skuHint: "single-core-sku",
      evidenceIds: keyword.evidenceIds,
    }],
    priorities: [{
      priority: theme.priority,
      direction: "保留并验证核心体验",
      evidenceIds: [...theme.evidenceIds, ...keyword.evidenceIds],
      action: "validate",
      acceptance: "完成样品与用户验证",
    }],
    risks: [
      { area: "cost", status: "requires-validation", nextStep: "验证成本结构" },
      { area: "profitability", status: "requires-validation", nextStep: "验证单位经济性" },
      { area: "patent", status: "requires-validation", nextStep: "完成知识产权检索" },
      { area: "compliance", status: "requires-validation", nextStep: "完成适用标准验证" },
      { area: "supply-chain", status: "requires-validation", nextStep: "验证供应与交付能力" },
    ],
    commercialValidation: {
      cost: "requires-validation",
      profitability: "requires-validation",
      patent: "requires-validation",
      compliance: "requires-validation",
      supplyChain: "requires-validation",
    },
    dataBoundary: PRODUCT_DEFINITION_DATA_BOUNDARY,
  };
}

async function currentSchema(pool: Pool): Promise<string> {
  const result = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");
  return result.rows[0]!.schema;
}

async function nextAttemptNumber(pool: Pool, stageId: string): Promise<number> {
  const result = await pool.query<{ attempt: string | number }>(
    "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt FROM job_attempts WHERE stage_id = $1",
    [stageId],
  );
  return Number(result.rows[0]!.attempt);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
