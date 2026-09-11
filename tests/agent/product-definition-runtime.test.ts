import { productDefinitionModelConfig } from "../../server/runtime/product-definition-runtime";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import { buildKeywordAnalysisSnapshotCandidate } from "../../server/data/keyword-analysis-snapshot";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  PRODUCT_DEFINITION_DATA_BOUNDARY,
  ProductDefinitionOutputSchema,
  buildProductDefinitionInput,
  assertProductDefinitionCapabilityLanguage,
  type ProductDefinitionInput,
} from "../../server/domain/product/product-definition-contracts";
import type {
  ModelProvider,
  StructuredGenerationRequest,
} from "../../server/runtime/model-provider";
import {
  SCOOTER_ASINS,
  realVocFacts,
  realVocSnapshot,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const NOW = "2026-08-17T00:00:00.000Z";
const CUTOFF = "2026-08-15T23:59:59.999Z";

test("product definition waits with exact dependencies and auto-runs after keyword snapshot arrives", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-product-runtime-"));
  const databasePath = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path: databasePath, busyTimeoutMs: 5_000 });
  const subject = await seedProductRun(repository);
  const provider = new ProductRuntimeProvider(
    realVocFacts(SCOOTER_ASINS, subject.snapshotId, subject.runId),
  );
  const service = await createAgentService({
    repository,
    provider,
    providerName: "product-runtime-fixture",
    env: runtimeEnv(databasePath),
  });
  t.after(async () => {
    await service.stop();
    try { repository.close(); } catch { /* already closed for reopen assertion */ }
    rmSync(directory, { recursive: true, force: true });
  });

  await service.start({ host: "127.0.0.1", port: 0 });
  await waitForStage(repository, subject.vocStageId, "succeeded");
  const blocked = await waitForStage(repository, subject.productStageId, "waiting-input");
  assert.deepEqual(
    dependencyPaths(blocked.lastError),
    ["dependencies.keyword-analysis-snapshot"],
  );
  assert.equal(provider.productRequests.length, 0);
  assert.equal((await repository.listJobAttempts(subject.productStageId)).length, 0);

  const keywordCreated = await repository.createKeywordAnalysisSnapshotForRun({
    actorId: subject.actorId,
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    expectedProjectId: subject.projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: randomUUID(),
    createdAt: NOW,
    candidate: keywordCandidate(),
  });
  const vocReports = await repository.listAnalysisReports({ actorOrganizationId: subject.organizationId, runId: subject.runId, stage: "voc-positioning" });
  buildProductDefinitionInput({ marketplace: "US", asins: SCOOTER_ASINS, dataCutoffAt: CUTOFF, vocReport: vocReports[0]!, keywordSnapshot: keywordCreated.snapshot });

  const completed = await waitForStage(repository, subject.productStageId, "succeeded", true);
  assert.equal(completed.status, "succeeded", JSON.stringify({ error: completed.lastError, productRequests: provider.productRequests.length }));
  assert.equal(completed.progress, 100);
  const runBeforeRestart = await repository.findAnalysisRun(subject.runId);
  assert.equal(runBeforeRestart?.status, "succeeded");
  assert.equal(provider.productRequests.length, 1);
  const reports = await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "product-definition",
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.version, 1);
  assert.equal(reports[0]?.status, "complete");
  const result = ProductDefinitionOutputSchema.parse(reports[0]?.result);
  assert.equal(result.opportunity.scope, "demand-and-product-definition-opportunity");
  assert.equal(result.opportunity.projectApproval, "not-approved");
  assert.equal(result.dataBoundary, PRODUCT_DEFINITION_DATA_BOUNDARY);
  const latestMigrationVersion = repository.listAppliedMigrations().at(-1)?.version;

  await service.stop();
  repository.close();
  const reopened = openSqliteAgentRepository({ path: databasePath, busyTimeoutMs: 5_000 });
  try {
    const runAfterRestart = await reopened.findAnalysisRun(subject.runId);
    assert.equal(runAfterRestart?.status, "succeeded");
    assert.deepEqual(runAfterRestart, runBeforeRestart);
    const persisted = await reopened.listAnalysisReports({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      stage: "product-definition",
    });
    assert.deepEqual(persisted, reports);
  } finally {
    reopened.close();
  }

  // Planned 0022 migrations must advance this explicit runtime contract in their own unit.
  assert.equal(latestMigrationVersion, 21);
});

test("keyword snapshot alone never runs product definition and lists missing validated VOC report", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-product-missing-voc-"));
  const repository = openSqliteAgentRepository({ path: join(directory, "agent.sqlite"), busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedProductRun(repository, { enqueueVoc: false });
  await repository.createKeywordAnalysisSnapshotForRun({
    actorId: subject.actorId,
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    expectedProjectId: subject.projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: randomUUID(),
    createdAt: NOW,
    candidate: keywordCandidate(),
  });

  const stage = await repository.findRunStage(subject.productStageId);
  assert.equal(stage?.status, "waiting-input");
  assert.deepEqual(dependencyPaths(stage?.lastError), [
    "dependencies.voc-positioning-report",
  ]);
  assert.equal((await repository.listJobAttempts(subject.productStageId)).length, 0);
});

test("commercial-data gaps are machine-closed and profit or approval claims fail closed", () => {
  const parsed = ProductDefinitionOutputSchema.parse(validProductOutput(productInputFixture()));
  assert.deepEqual(parsed.commercialValidation, {
    cost: "requires-validation",
    profitability: "requires-validation",
    patent: "requires-validation",
    compliance: "requires-validation",
    supplyChain: "requires-validation",
  });
  assert.equal(parsed.opportunity.projectApproval, "not-approved");
  assert.throws(
    () => assertProductDefinitionCapabilityLanguage({
      ...parsed,
      finalDefinition: parsed.finalDefinition.map((row, index) =>
        index === 0 ? { ...row, conclusion: "ROI 80%，公司已批准立项" } : row,
      ),
    }),
    /commercial capability boundary/i,
  );
});

test("product validation failure preserves persisted VOC and keyword dependencies", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-product-failure-"));
  const databasePath = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path: databasePath, busyTimeoutMs: 5_000 });
  const subject = await seedProductRun(repository);
  const keyword = await repository.createKeywordAnalysisSnapshotForRun({
    actorId: subject.actorId,
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    expectedProjectId: subject.projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: randomUUID(),
    createdAt: NOW,
    candidate: keywordCandidate(),
  });
  const provider = new ProductRuntimeProvider(
    realVocFacts(SCOOTER_ASINS, subject.snapshotId, subject.runId),
    true,
  );
  const service = await createAgentService({ repository, provider, providerName: "product-invalid-fixture", env: runtimeEnv(databasePath) });
  t.after(async () => {
    await service.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await service.start({ host: "127.0.0.1", port: 0 });
  await waitForStage(repository, subject.productStageId, "failed");
  assert.equal(provider.productRequests.length, 2);
  assert.equal((await repository.listAnalysisReports({ actorOrganizationId: subject.organizationId, runId: subject.runId, stage: "product-definition" })).length, 0);
  assert.equal((await repository.listAnalysisReports({ actorOrganizationId: subject.organizationId, runId: subject.runId, stage: "voc-positioning" })).length, 1);
  assert.deepEqual((await repository.listKeywordAnalysisSnapshotsByRun({ actorOrganizationId: subject.organizationId, runId: subject.runId })), [keyword.snapshot]);
  assert.equal((await repository.findAnalysisRun(subject.runId))?.status, "partial");
});

class ProductRuntimeProvider implements ModelProvider {
  readonly productRequests: StructuredGenerationRequest<unknown>[] = [];

  constructor(
    private readonly vocFacts: ReturnType<typeof realVocFacts>,
    private readonly invalidProduct = false,
  ) {}

  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    const input = request.input as { kind?: string };
    if (input.kind === "voc-positioning-input") {
      return {
        value: validVocPositioningOutput(this.vocFacts) as T,
        responseId: "voc-response",
        inputTokens: 100,
        outputTokens: 50,
      };
    }
    assert.equal(input.kind, "amazon-product-definition-input");
    this.productRequests.push(request as StructuredGenerationRequest<unknown>);
    if (this.invalidProduct) {
      return { value: {} as T, responseId: "invalid-product-response", inputTokens: 10, outputTokens: 5 };
    }
    return {
      value: validProductOutput(request.input as ProductDefinitionInput) as T,
      responseId: "product-response",
      inputTokens: 150,
      outputTokens: 80,
    };
  }
}

function validProductOutput(input: ProductDefinitionInput) {
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

function keywordCandidate() {
  return buildKeywordAnalysisSnapshotCandidate({
    marketplace: "US",
    asins: SCOOTER_ASINS,
    dataCutoffAt: CUTOFF,
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
      capturedAt: CUTOFF,
      searchVolume: 1_000,
      purchaseRate: null,
    }],
  });
}

function productInputFixture(): ProductDefinitionInput {
  const snapshotId = randomUUID();
  const runId = randomUUID();
  const vocResult = validVocPositioningOutput(
    realVocFacts(SCOOTER_ASINS, snapshotId, runId),
  );
  const keyword = keywordCandidate();
  return {
    schemaVersion: "1.0.0",
    kind: "amazon-product-definition-input",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    dataCutoffAt: CUTOFF,
    voc: { reportId: randomUUID(), version: 1, snapshotIds: [snapshotId], result: vocResult },
    keywords: { snapshotId: randomUUID(), contentHash: keyword.contentHash, groups: keyword.payload.groups, evidence: keyword.payload.evidence },
    commercialData: { cost: "missing", profitability: "missing", patent: "missing", compliance: "missing", supplyChain: "missing" },
  };
}

async function seedProductRun(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  options: { enqueueVoc?: boolean } = {},
) {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const vocStageId = randomUUID();
  const productStageId = randomUUID();
  await repository.createUser({ id: actorId, organizationId, email: `${actorId}@example.com`, displayName: "Product actor", role: "admin", status: "active", createdAt: NOW, updatedAt: NOW });
  await repository.createProject({ id: projectId, organizationId, name: "Product project", marketplace: "US", asins: [...SCOOTER_ASINS], createdBy: actorId, createdAt: NOW, updatedAt: NOW });
  await repository.createAnalysisRun({ id: runId, projectId, mode: "existing-data", status: "queued", createdBy: actorId, dataCutoffAt: CUTOFF, idempotencyScope: `product-runtime:${runId}`, idempotencyKey: "create", createdAt: NOW, updatedAt: NOW });
  await repository.createRunStage({ id: vocStageId, runId, stage: "voc-positioning", status: "queued", progress: 0, attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: NOW, updatedAt: NOW });
  await repository.createRunStage({ id: productStageId, runId, stage: "product-definition", status: "waiting-input", progress: 0, attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: NOW, updatedAt: NOW });
  if (options.enqueueVoc !== false) {
    await repository.enqueueJob({ id: randomUUID(), stageId: vocStageId, attemptNumber: 1, maxAttempts: 1, availableAt: new Date().toISOString(), createdAt: NOW });
  }
  const snapshotId = randomUUID();
  const snapshot = realVocSnapshot(SCOOTER_ASINS, snapshotId, runId);
  const candidate = { ...snapshot };
  delete (candidate as Partial<typeof snapshot>).id;
  delete (candidate as Partial<typeof snapshot>).runId;
  delete (candidate as Partial<typeof snapshot>).createdAt;
  await repository.createDataSnapshotForRun({ actorId, actorOrganizationId: organizationId, runId, expectedProjectId: projectId, expectedMarketplace: "US", expectedAsins: SCOOTER_ASINS, expectedRunCutoffAt: CUTOFF, candidateId: snapshotId, createdAt: NOW, candidate });
  return { organizationId, actorId, projectId, runId, vocStageId, productStageId, snapshotId };
}

async function waitForStage(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  stageId: string,
  expected: "waiting-input" | "succeeded" | "failed",
  returnTerminalFailure = false,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const stage = await repository.findRunStage(stageId);
    if (stage?.status === expected) return stage;
    if (returnTerminalFailure && stage?.status === "failed") return stage;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stage = await repository.findRunStage(stageId);
  assert.equal(stage?.status, expected, JSON.stringify(stage?.lastError));
  return stage!;
}

function runtimeEnv(databasePath: string) {
  return {
    OPENAI_API_KEY: "fixture-key",
    AGENT_VOC_MODEL: "fixture-model",
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "2000",
    AGENT_VOC_TIMEOUT_MS: "5000",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_CALL_MAX_TOKENS: "100000",
    AGENT_VOC_CALL_MAX_COST_MICROS: "1000000",
    AGENT_VOC_RUN_MAX_TOKENS: "100000",
    AGENT_VOC_RUN_MAX_COST_MICROS: "1000000",
    AGENT_VOC_DAILY_MAX_TOKENS: "1000000",
    AGENT_VOC_DAILY_MAX_COST_MICROS: "10000000",
    AGENT_VOC_WORKER_OWNER_ID: "product-runtime-worker",
    AGENT_VOC_WORKER_LEASE_MS: "120000",
    AGENT_VOC_WORKER_HEARTBEAT_MS: "60000",
    AGENT_VOC_WORKER_POLL_MS: "10",
    AGENT_VOC_WORKER_STOP_TIMEOUT_MS: "1000",
    AGENT_VOC_RETRY_MAX_ATTEMPTS: "1",
    AGENT_VOC_RETRY_INITIAL_DELAY_MS: "10",
    AGENT_VOC_RETRY_MAX_DELAY_MS: "10",
    AGENT_VOC_RETRY_JITTER_RATIO: "0",
    AGENT_SQLITE_PATH: databasePath,
  };
}

function dependencyPaths(error: Record<string, unknown> | null | undefined) {
  if (!error || !Array.isArray(error.details)) return [];
  return error.details.flatMap((detail) =>
    typeof detail === "object" && detail !== null &&
    typeof (detail as { path?: unknown }).path === "string"
      ? [(detail as { path: string }).path]
      : [],
  );
}

test("product stage bounds shared VOC timeout without changing token budgets", () => {
 const config={name:"fixture",timeoutMs:300000,maxOutputTokens:4000,estimatedInputTokens:32000,inputCostPerMillionMicros:1,outputCostPerMillionMicros:1};
 assert.deepEqual(productDefinitionModelConfig(config),{...config,timeoutMs:120000});
 assert.deepEqual(productDefinitionModelConfig({...config,timeoutMs:5000}),{...config,timeoutMs:5000});
 assert.equal(config.timeoutMs,300000);
});
