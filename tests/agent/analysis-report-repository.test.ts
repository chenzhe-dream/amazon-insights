import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { RegisterSkillVersionInput } from "../../server/db/agent-run-repository";
import {
  AnalysisReportConflictError,
  type AnalysisReportRepository,
} from "../../server/db/analysis-report-repository";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import type { VocPositioningOutput } from "../../server/domain/voc/voc-positioning-contracts";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";
const CLAIMED_AT = "2026-08-16T00:00:00.000Z";
const COMPLETED_AT = "2026-08-16T00:00:01.000Z";
const PUBLISHED_AT = "2026-08-16T00:00:02.000Z";
const LEASE_OWNER = "voc-worker-a";
const CLAIM_TOKEN = "10000000-0000-4000-8000-000000000991";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-report-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

function skillVersionInput(): RegisterSkillVersionInput {
  const contentHash = "c".repeat(64);
  return {
    id: randomUUID(),
    skillId: "define-amazon-voc-positioning",
    version: "1.0.0",
    contentHash,
    manifest: {
      id: "define-amazon-voc-positioning",
      version: "1.0.0",
      entry: "SKILL.md",
      allowedReferences: ["references/priority-rules.md"],
      inputSchema: "VocPositioningInput@1.0.0",
      outputSchema: "VocPositioningOutput@1.0.0",
      fixtures: ["voc-three-tables-complete-v1"],
      contentHash,
    },
    createdAt: CLAIMED_AT,
  };
}

async function seedSucceededVocAgentRun(repository: SqliteAgentRepository) {
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
    displayName: "VOC report actor",
    role: "admin",
    status: "active",
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "VOC report project",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actorId,
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: CUTOFF,
    idempotencyScope: `voc-report:${runId}`,
    idempotencyKey: "create",
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
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
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  });
  await repository.enqueueJob({
    id: jobAttemptId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: CLAIMED_AT,
    createdAt: CLAIMED_AT,
  });
  const job = await repository.claimNextJob({
    ownerId: LEASE_OWNER,
    claimedAt: CLAIMED_AT,
    leaseDurationMs: 60_000,
  });
  assert.equal(job?.id, jobAttemptId);

  const snapshotRecord = realVocSnapshot(SCOOTER_ASINS, snapshotId, runId);
  const {
    id: _snapshotRecordId,
    runId: _snapshotRunId,
    createdAt: _snapshotCreatedAt,
    ...snapshotCandidate
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
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: snapshotId,
    createdAt: CLAIMED_AT,
    candidate: snapshotCandidate,
  });
  const facts = preprocessVocSnapshot(snapshot.snapshot);
  const result = validVocPositioningOutput(facts);
  const logicalExecutionLineage = "c".repeat(64);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const agentRun = await repository.beginAgentRun({
    id: randomUUID(),
    organizationId,
    runId,
    stageId,
    jobAttemptId,
    skillVersionId: skill.id,
    snapshotIds: [snapshotId],
    executionFingerprint: "d".repeat(64),
    logicalExecutionLineage,
    logicalExecutionCycleId: job!.logicalExecutionCycleId,
    outputSchemaDigest: "e".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "f".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: CUTOFF,
    startedAt: CLAIMED_AT,
    leaseOwnerId: LEASE_OWNER,
    leaseGeneration: job!.leaseGeneration,
    claimToken: CLAIM_TOKEN,
    claimAcquiredAt: CLAIMED_AT,
    claimExpiresAt: "2026-08-16T00:00:30.000Z",
  });
  const finalized = await repository.finalizeAgentRun({
    agentRunId: agentRun.record.id,
    organizationId,
    leaseOwnerId: LEASE_OWNER,
    leaseGeneration: job!.leaseGeneration,
    claimToken: CLAIM_TOKEN,
    completedAt: COMPLETED_AT,
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "response-voc-1",
      output: result,
      error: null,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostMicros: 25,
      durationMs: 1_000,
      attemptCount: 1,
      usageCompleteness: "complete",
      attempts: [
        {
          ordinal: 0,
          kind: "initial",
          transientRetryCount: 0,
          formatRepair: false,
          accounting: "settled",
          errorClassification: null,
        },
      ],
      terminalMetadata: { kind: "succeeded" },
    },
  });
  return {
    organizationId,
    actorId,
    projectId,
    runId,
    stageId,
    jobAttemptId,
    snapshotId,
    leaseGeneration: job!.leaseGeneration,
    skill,
    agentRun: finalized.record,
    facts,
    result,
    logicalExecutionLineage,
  };
}

function publishInput(
  seeded: Awaited<ReturnType<typeof seedSucceededVocAgentRun>>,
  overrides: Partial<Parameters<AnalysisReportRepository["publishVocPositioningReport"]>[0]> = {},
) {
  return {
    id: randomUUID(),
    actorId: seeded.actorId,
    actorOrganizationId: seeded.organizationId,
    expectedProjectId: seeded.projectId,
    runId: seeded.runId,
    stageId: seeded.stageId,
    jobAttemptId: seeded.jobAttemptId,
    agentRunId: seeded.agentRun.id,
    logicalExecutionLineage: seeded.logicalExecutionLineage,
    snapshotId: seeded.snapshotId,
    factsDigest: seeded.facts.factsDigest,
    skill: { ...seeded.agentRun.skill },
    model: { ...seeded.agentRun.model },
    leaseOwnerId: LEASE_OWNER,
    leaseGeneration: seeded.leaseGeneration,
    publishedAt: PUBLISHED_AT,
    result: seeded.result,
    ...overrides,
  };
}

async function seedAdditionalSucceededVocAgentRun(
  repository: SqliteAgentRepository,
  seeded: Awaited<ReturnType<typeof seedSucceededVocAgentRun>>,
) {
  const jobAttemptId = randomUUID();
  await repository.enqueueJob({
    id: jobAttemptId,
    stageId: seeded.stageId,
    attemptNumber: 2,
    maxAttempts: 3,
    availableAt: CLAIMED_AT,
    createdAt: CLAIMED_AT,
  });
  const job = await repository.claimNextJob({
    ownerId: LEASE_OWNER,
    claimedAt: CLAIMED_AT,
    leaseDurationMs: 60_000,
  });
  assert.equal(job?.id, jobAttemptId);
  const claimToken = randomUUID();
  const logicalExecutionLineage = "2".repeat(64);
  const agentRun = await repository.beginAgentRun({
    id: randomUUID(),
    organizationId: seeded.organizationId,
    runId: seeded.runId,
    stageId: seeded.stageId,
    jobAttemptId,
    skillVersionId: seeded.skill.id,
    snapshotIds: [seeded.snapshotId],
    executionFingerprint: "a".repeat(64),
    logicalExecutionLineage,
    logicalExecutionCycleId: job!.logicalExecutionCycleId,
    outputSchemaDigest: "b".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "1".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: CUTOFF,
    startedAt: CLAIMED_AT,
    leaseOwnerId: LEASE_OWNER,
    leaseGeneration: job!.leaseGeneration,
    claimToken,
    claimAcquiredAt: CLAIMED_AT,
    claimExpiresAt: "2026-08-16T00:00:30.000Z",
  });
  const finalized = await repository.finalizeAgentRun({
    agentRunId: agentRun.record.id,
    organizationId: seeded.organizationId,
    leaseOwnerId: LEASE_OWNER,
    leaseGeneration: job!.leaseGeneration,
    claimToken,
    completedAt: COMPLETED_AT,
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "response-voc-2",
      output: seeded.result,
      error: null,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostMicros: 25,
      durationMs: 1_000,
      attemptCount: 1,
      usageCompleteness: "complete",
      attempts: [
        {
          ordinal: 0,
          kind: "initial",
          transientRetryCount: 0,
          formatRepair: false,
          accounting: "settled",
          errorClassification: null,
        },
      ],
      terminalMetadata: { kind: "succeeded" },
    },
  });
  return {
    ...seeded,
    jobAttemptId,
    leaseGeneration: job!.leaseGeneration,
    agentRun: finalized.record,
    logicalExecutionLineage,
  };
}

test("concurrent publication creates one immutable report and replays idempotently", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const seeded = await seedSucceededVocAgentRun(repository);
  const reports = repository as AnalysisReportRepository;

  const publications = await Promise.all([
    reports.publishVocPositioningReport(publishInput(seeded)),
    reports.publishVocPositioningReport(publishInput(seeded)),
  ]);
  const first = publications.find((publication) => publication.created);
  const replay = publications.find((publication) => !publication.created);

  assert.ok(first);
  assert.ok(replay);
  assert.deepEqual(replay.report, first.report);
  assert.equal(first.report.version, 1);
  assert.deepEqual(first.report.result, seeded.result);
  assert.deepEqual(
    await reports.listAnalysisReports({
      actorOrganizationId: seeded.organizationId,
      runId: seeded.runId,
      stage: "voc-positioning",
    }),
    [first.report],
  );
  assert.deepEqual(
    await reports.listAnalysisReports({
      actorOrganizationId: randomUUID(),
      runId: seeded.runId,
      stage: "voc-positioning",
    }),
    [],
  );
  await assert.rejects(
    reports.publishVocPositioningReport(
      publishInput(seeded, { actorOrganizationId: randomUUID() }),
    ),
    /subject/i,
  );

  const database = new DatabaseSync(temporary.path);
  assert.throws(
    () => database.prepare("UPDATE analysis_reports SET status = 'stale'").run(),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare("DELETE FROM analysis_reports").run(),
    /immutable/i,
  );
  database.close();
});

test("a new terminal AgentRun appends versioned history without changing version one", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const firstRun = await seedSucceededVocAgentRun(repository);
  const reports = repository as AnalysisReportRepository;
  const first = await reports.publishVocPositioningReport(publishInput(firstRun));
  const secondRun = await seedAdditionalSucceededVocAgentRun(repository, firstRun);

  const second = await reports.publishVocPositioningReport(
    publishInput(secondRun, { publishedAt: "2026-08-16T00:00:03.000Z" }),
  );

  assert.equal(first.report.version, 1);
  assert.equal(second.report.version, 2);
  assert.notEqual(second.report.id, first.report.id);
  assert.notEqual(second.report.model.responseId, first.report.model.responseId);
  assert.deepEqual(
    await reports.listAnalysisReports({
      actorOrganizationId: firstRun.organizationId,
      runId: firstRun.runId,
      stage: "voc-positioning",
    }),
    [first.report, second.report],
  );
});

test("same AgentRun with changed immutable result conflicts", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const seeded = await seedSucceededVocAgentRun(repository);
  const reports = repository as AnalysisReportRepository;
  await reports.publishVocPositioningReport(publishInput(seeded));
  const changed = structuredClone(seeded.result) as VocPositioningOutput;
  changed.coreConclusion.strategy =
    changed.coreConclusion.strategy === "retain-verified-value"
      ? "validate-differentiation"
      : "retain-verified-value";

  await assert.rejects(
    reports.publishVocPositioningReport(publishInput(seeded, { result: changed })),
    AnalysisReportConflictError,
  );
});

test("report publication rejects an otherwise valid terminal result under the wrong lineage", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const seeded = await seedSucceededVocAgentRun(repository);
  await assert.rejects(
    repository.publishVocPositioningReport(
      publishInput(seeded, { logicalExecutionLineage: "0".repeat(64) }),
    ),
    AnalysisReportConflictError,
  );
  assert.deepEqual(
    await repository.listAnalysisReports({
      actorOrganizationId: seeded.organizationId,
      runId: seeded.runId,
      stage: "voc-positioning",
    }),
    [],
  );
});

test("transaction-entry time fences an expired lease despite a stale publish timestamp", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:02:00.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const seeded = await seedSucceededVocAgentRun(repository);

  await assert.rejects(
    (repository as AnalysisReportRepository).publishVocPositioningReport(
      publishInput(seeded, { publishedAt: PUBLISHED_AT }),
    ),
    /lease/i,
  );
});
