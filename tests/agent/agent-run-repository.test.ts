import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  AgentRunClaimLostError,
  AgentRunConflictError,
  AgentRunLeaseLostError,
  AgentRunSubjectNotFoundError,
  SkillVersionConflictError,
  type AgentRunRepository,
  type RegisterSkillVersionInput,
} from "../../server/db/agent-run-repository";
import type { ModelBudgetLedgerRepository } from "../../server/db/model-budget-repository";
import {
  openSqliteAgentRepository as openSqliteAgentRepositoryBase,
  registerVocSnapshotIntegrityFunction,
} from "../../server/db/sqlite-repository";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";

const now = "2026-08-15T08:00:00.000Z";
const completedAt = "2026-08-15T08:00:01.000Z";
const leaseOwnerId = "worker-a";
const claimToken = "10000000-0000-4000-8000-000000000991";

function openSqliteAgentRepository(
  options: Parameters<typeof openSqliteAgentRepositoryBase>[0],
) {
  return openSqliteAgentRepositoryBase({
    ...options,
    nowProvider: options.nowProvider ?? (() => new Date(now)),
  });
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-run-audit-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

function asAgentRunRepository(repository: unknown) {
  return repository as AgentRunRepository;
}

const fixtureAsins = ["B0ABC12345", "B0DEF67890", "B0GHI13579"];

function strictSnapshotCandidate(dataCutoffAt = now) {
  return buildVocSnapshotCandidate({
    marketplace: "US",
    asins: fixtureAsins,
    dataCutoffAt,
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: "US",
        capturedAt: dataCutoffAt,
        records: [
          {
            asin: fixtureAsins[0]!,
            attention: ["fixture"],
            positives: ["fixture"],
            negatives: ["fixture"],
            unmet: ["fixture"],
            audiences: ["fixture"],
            scenarios: ["fixture"],
            motives: ["fixture"],
            captureStatus: "dialog",
            alexaReport: {
              title: "Fixture",
              asin: fixtureAsins[0]!,
              rating: 4,
              reviewCount: 1,
              prompt: "Fixture",
              overallConclusion: "Fixture",
            },
          },
        ],
      },
    ],
  });
}

async function seedActiveAttempt(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  path: string,
  storedCutoffAt = now,
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
    displayName: "AgentRun test",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "AgentRun audit",
    marketplace: "US",
    asins: fixtureAsins,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: now,
    idempotencyScope: `agent-run-test:${runId}`,
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

  const database = new DatabaseSync(path);
  registerVocSnapshotIntegrityFunction(database);
  database.exec("PRAGMA foreign_keys = ON");
  if (storedCutoffAt !== now) {
    database
      .prepare("UPDATE analysis_runs SET data_cutoff_at = ? WHERE id = ?")
      .run(storedCutoffAt, runId);
  }
  if (storedCutoffAt === now) {
    const candidate = strictSnapshotCandidate();
    database
      .prepare(
        `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
          data_cutoff_at, sources_json, payload_json, content_hash, created_at)
         VALUES (?, ?, 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        runId,
        candidate.schemaVersion,
        candidate.marketplace,
        JSON.stringify(candidate.asins),
        candidate.dataCutoffAt,
        JSON.stringify(candidate.sources),
        JSON.stringify(candidate.payload),
        candidate.contentHash,
        now,
      );
  } else {
    database.exec("DROP TRIGGER data_snapshots_legacy_insert_closed");
    database
      .prepare(
        `INSERT INTO data_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
         VALUES (?, ?, '1.0.0', 'US', ?, ?, '[]', '{}', ?, ?)`,
      )
      .run(
        snapshotId,
        runId,
        JSON.stringify(fixtureAsins),
        storedCutoffAt,
        "legacy-hash",
        now,
      );
    database.exec(`
      CREATE TRIGGER data_snapshots_legacy_insert_closed
      BEFORE INSERT ON data_snapshots
      WHEN NEW.snapshot_kind IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'legacy data snapshot inserts are closed');
      END
    `);
  }
  database.close();

  return {
    organizationId,
    projectId,
    runId,
    stageId,
    jobAttemptId,
    snapshotId,
    leaseGeneration: claimed!.leaseGeneration,
    logicalExecutionCycleId: claimed!.logicalExecutionCycleId,
  };
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
      fixtures: ["scooter-complete"],
      contentHash,
    },
    createdAt: now,
  };
}

function beginInput(
  subject: Awaited<ReturnType<typeof seedActiveAttempt>>,
  skillVersionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    organizationId: subject.organizationId,
    runId: subject.runId,
    stageId: subject.stageId,
    jobAttemptId: subject.jobAttemptId,
    skillVersionId,
    snapshotIds: [subject.snapshotId],
    executionFingerprint: "d".repeat(64),
    ...(typeof overrides.logicalExecutionLineage === "string"
      ? { logicalExecutionCycleId: subject.logicalExecutionCycleId }
      : {}),
    outputSchemaDigest: "e".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "f".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: now,
    startedAt: now,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    claimAcquiredAt: now,
    claimExpiresAt: "2026-08-15T08:00:30.000Z",
    ...overrides,
  } as const;
}

test("migration 0006 rejects malformed lineage and concurrent duplicate logical executions", async (t) => {
  const temporary = temporaryDatabase();
  const firstSqlite = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  const secondSqlite = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    firstSqlite.close();
    secondSqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const firstSubject = await seedActiveAttempt(firstSqlite, temporary.path);
  const secondSubject = await seedActiveAttempt(secondSqlite, temporary.path);
  const skill = await firstSqlite.registerSkillVersion(skillVersionInput());
  const lineage = "9".repeat(64);

  const settled = await Promise.allSettled([
    firstSqlite.beginAgentRun(
      beginInput(firstSubject, skill.id, { logicalExecutionLineage: lineage }),
    ),
    secondSqlite.beginAgentRun(
      beginInput(secondSubject, skill.id, { logicalExecutionLineage: lineage }),
    ),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.ok(
    settled.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof AgentRunConflictError,
    ),
  );

  const database = new DatabaseSync(temporary.path);
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE job_attempts SET logical_execution_cycle_id = ? WHERE id = ?",
        )
        .run("0".repeat(64), firstSubject.jobAttemptId),
    /logical execution cycle is immutable/i,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT logical_execution_cycle_id FROM job_attempts WHERE id = ?",
        )
        .get(firstSubject.jobAttemptId) as {
        logical_execution_cycle_id: string;
      }
    ).logical_execution_cycle_id,
    firstSubject.logicalExecutionCycleId,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE agent_runs SET logical_execution_lineage = 'not-a-sha' WHERE logical_execution_lineage = ?",
        )
        .run(lineage),
    /lineage is immutable|CHECK constraint/i,
  );
  database.close();
  await assert.rejects(
    firstSqlite.beginAgentRun(
      beginInput(firstSubject, skill.id, {
        logicalExecutionLineage: "A".repeat(64),
      }),
    ),
    /invalid agent run audit identity/i,
  );
});

test("pending AgentRun grants one invocation claim and rejects observer finalize", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const ownerInput = beginInput(subject, skill.id);

  const owner = await repository.beginAgentRun(ownerInput);
  const observer = await repository.beginAgentRun({
    ...ownerInput,
    id: randomUUID(),
    claimToken: "10000000-0000-4000-8000-000000000992",
  });

  assert.equal(owner.claimStatus, "acquired");
  assert.equal(observer.claimStatus, "observing");
  assert.equal(observer.record.validationStatus, "pending");
  await assert.rejects(
    repository.finalizeAgentRun({
      agentRunId: owner.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken: "10000000-0000-4000-8000-000000000992",
      completedAt,
      outcome: {
        terminalStatus: "failed",
        validationStatus: "failed",
        responseId: null,
        output: null,
        error: {
          code: "INFRASTRUCTURE_ERROR",
          message: "Observer cannot complete the owner claim",
          requestId: `agent-run:${owner.record.id}`,
          retryable: false,
        },
        inputTokens: null,
        outputTokens: null,
        estimatedCostMicros: null,
        durationMs: 1,
        attemptCount: 0,
        usageCompleteness: "unavailable",
        attempts: [],
        terminalMetadata: { kind: "failed", classification: "infrastructure" },
      },
    }),
    AgentRunClaimLostError,
  );
});

test("same Worker lease cannot take over an expired claim", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const owner = await repository.beginAgentRun(
    beginInput(subject, skill.id, {
      claimExpiresAt: "2026-08-15T08:00:10.000Z",
    }),
  );

  const observer = await repository.beginAgentRun(
    beginInput(subject, skill.id, {
      id: randomUUID(),
      claimToken: "10000000-0000-4000-8000-000000000994",
      claimAcquiredAt: "2026-08-15T08:00:20.000Z",
      claimExpiresAt: "2026-08-15T08:00:50.000Z",
    }),
  );

  assert.equal(owner.claimStatus, "acquired");
  assert.equal(observer.claimStatus, "observing");
  await assert.rejects(
    repository.finalizeAgentRun({
      agentRunId: owner.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken: "10000000-0000-4000-8000-000000000994",
      completedAt: "2026-08-15T08:00:21.000Z",
      outcome: {
        terminalStatus: "failed",
        validationStatus: "failed",
        responseId: null,
        output: null,
        error: {
          code: "INFRASTRUCTURE_ERROR",
          message: "Observer cannot replace an active Worker lease claim",
          requestId: `agent-run:${owner.record.id}`,
          retryable: false,
        },
        inputTokens: null,
        outputTokens: null,
        estimatedCostMicros: null,
        durationMs: null,
        attemptCount: 0,
        usageCompleteness: "unavailable",
        attempts: [],
        terminalMetadata: { kind: "failed", classification: "infrastructure" },
      },
    }),
    AgentRunClaimLostError,
  );
});

test("legacy offset run and snapshot can complete an AgentRun audit", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const offsetCutoff = "2026-08-15T16:00:00+08:00";
  const subject = await seedActiveAttempt(sqlite, temporary.path, offsetCutoff);
  const skill = await repository.registerSkillVersion(skillVersionInput());

  const pending = await repository.beginAgentRun(
    beginInput(subject, skill.id, { dataCutoffAt: offsetCutoff }),
  );
  const finalized = await repository.finalizeAgentRun({
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    completedAt,
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "resp-offset",
      output: { safe: true },
      error: null,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicros: 2,
      durationMs: 1,
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
    },
  });

  assert.equal(finalized.record.validationStatus, "passed");
  assert.equal(finalized.record.dataCutoffAt, offsetCutoff);
});

test("expired or replaced Worker lease claim can be recovered by CAS", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const firstInput = beginInput(subject, skill.id, {
    claimExpiresAt: "2026-08-15T08:02:00.000Z",
  });
  const first = await repository.beginAgentRun(firstInput);
  await repository.assertAgentRunClaim({
    agentRunId: first.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    asOf: "2026-08-15T08:00:30.000Z",
  });
  const replacementOwner = "worker-b";
  const replacementGeneration = subject.leaseGeneration + 1;
  const inspector = new DatabaseSync(temporary.path);
  inspector
    .prepare(
      `UPDATE job_attempts
       SET leased_by = ?, lease_generation = ?, lease_expires_at = ?
       WHERE id = ?`,
    )
    .run(
      replacementOwner,
      replacementGeneration,
      "2026-08-15T08:02:00.000Z",
      subject.jobAttemptId,
    );
  inspector.close();

  const replacementToken = "10000000-0000-4000-8000-000000000993";
  const replacement = await repository.beginAgentRun({
    ...firstInput,
    id: randomUUID(),
    leaseOwnerId: replacementOwner,
    leaseGeneration: replacementGeneration,
    claimToken: replacementToken,
    claimAcquiredAt: "2026-08-15T08:01:00.000Z",
    claimExpiresAt: "2026-08-15T08:01:30.000Z",
  });
  assert.equal(first.claimStatus, "acquired");
  assert.equal(replacement.claimStatus, "acquired");

  await assert.rejects(
    repository.assertAgentRunClaim({
      agentRunId: first.record.id,
      organizationId: subject.organizationId,
      jobAttemptId: subject.jobAttemptId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken,
      asOf: "2026-08-15T08:01:01.000Z",
    }),
    AgentRunClaimLostError,
  );
  await repository.assertAgentRunClaim({
    agentRunId: replacement.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId: replacementOwner,
    leaseGeneration: replacementGeneration,
    claimToken: replacementToken,
    asOf: "2026-08-15T08:01:01.000Z",
  });

  await assert.rejects(
    repository.finalizeAgentRun({
      agentRunId: replacement.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId: replacementOwner,
      leaseGeneration: replacementGeneration,
      claimToken,
      completedAt: "2026-08-15T08:01:01.000Z",
      outcome: {
        terminalStatus: "failed",
        validationStatus: "failed",
        responseId: null,
        output: null,
        error: {
          code: "INFRASTRUCTURE_ERROR",
          message: "Stale claim cannot recover",
          requestId: `agent-run:${replacement.record.id}`,
          retryable: false,
        },
        inputTokens: null,
        outputTokens: null,
        estimatedCostMicros: null,
        durationMs: 1,
        attemptCount: 0,
        usageCompleteness: "unavailable",
        attempts: [],
        terminalMetadata: { kind: "failed", classification: "infrastructure" },
      },
    }),
    AgentRunClaimLostError,
  );
});

test("lease-expiry successor inherits the trusted cycle and recovers a pending AgentRun claim", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const lineage = "8".repeat(64);
  const firstInput = beginInput(subject, skill.id, {
    logicalExecutionLineage: lineage,
  });
  const first = await repository.beginAgentRun(firstInput);

  const successor = await sqlite.claimNextJob({
    ownerId: "worker-successor",
    claimedAt: "2026-08-15T08:01:01.000Z",
    leaseDurationMs: 60_000,
  });
  assert.ok(successor);
  assert.notEqual(successor.id, subject.jobAttemptId);
  assert.equal(
    successor.logicalExecutionCycleId,
    subject.logicalExecutionCycleId,
  );

  await assert.rejects(
    repository.beginAgentRun({
      ...firstInput,
      id: randomUUID(),
      jobAttemptId: successor.id,
      executionFingerprint: "6".repeat(64),
      logicalExecutionLineage: "9".repeat(64),
      logicalExecutionCycleId: successor.logicalExecutionCycleId,
      leaseOwnerId: "worker-successor",
      leaseGeneration: successor.leaseGeneration,
      claimToken: "10000000-0000-4000-8000-000000000993",
      claimAcquiredAt: "2026-08-15T08:01:01.000Z",
      claimExpiresAt: "2026-08-15T08:01:30.000Z",
    }),
    AgentRunConflictError,
  );

  const recovered = await repository.beginAgentRun({
    ...firstInput,
    id: randomUUID(),
    jobAttemptId: successor.id,
    executionFingerprint: "7".repeat(64),
    logicalExecutionCycleId: successor.logicalExecutionCycleId,
    leaseOwnerId: "worker-successor",
    leaseGeneration: successor.leaseGeneration,
    claimToken: "10000000-0000-4000-8000-000000000994",
    claimAcquiredAt: "2026-08-15T08:01:01.000Z",
    claimExpiresAt: "2026-08-15T08:01:30.000Z",
  });
  assert.equal(recovered.record.id, first.record.id);
  assert.equal(recovered.claimStatus, "acquired");
  await assert.rejects(
    repository.assertAgentRunClaim({
      agentRunId: first.record.id,
      organizationId: subject.organizationId,
      jobAttemptId: subject.jobAttemptId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken,
      asOf: "2026-08-15T08:01:02.000Z",
    }),
    AgentRunSubjectNotFoundError,
  );
  await repository.assertAgentRunClaim({
    agentRunId: first.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: successor.id,
    leaseOwnerId: "worker-successor",
    leaseGeneration: successor.leaseGeneration,
    claimToken: "10000000-0000-4000-8000-000000000994",
    asOf: "2026-08-15T08:01:02.000Z",
  });
});

type IndependentBudgetWorkerResult =
  | { ok: true; threadId: number; value: Record<string, unknown> }
  | {
      ok: false;
      threadId: number;
      error: { name: string; code?: string };
    };

interface IndependentBudgetWorkerTask {
  worker: Worker;
  result: Promise<IndependentBudgetWorkerResult>;
  exited: Promise<number>;
  isSettled(): boolean;
}

function startIndependentBudgetWorker(
  path: string,
  barrier: SharedArrayBuffer,
  workerData: Record<string, unknown>,
): IndependentBudgetWorkerTask {
  const worker = new Worker(
    new URL("./helpers/sqlite-model-budget-worker.ts", import.meta.url),
    {
      workerData: {
        path,
        barrier,
        barrierTimeoutMs: 5_000,
        ...workerData,
      },
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  const threadId = worker.threadId;
  let settled = false;
  let finish!: (value: IndependentBudgetWorkerResult) => void;
  const result = new Promise<IndependentBudgetWorkerResult>((resolve) => {
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
        threadId,
        error: { name: "IndependentBudgetWorkerExitError" },
      });
      resolve(code);
    });
  });
  worker.once("message", (message) =>
    finish(message as IndependentBudgetWorkerResult),
  );
  worker.once("error", () =>
    finish({
      ok: false,
      threadId,
      error: { name: "IndependentBudgetWorkerError" },
    }),
  );
  return { worker, result, exited, isSettled: () => settled };
}

async function withinIndependentBudgetWorker<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function releaseIndependentBudgetWorkerBarrier(
  tasks: readonly IndependentBudgetWorkerTask[],
  barrier: Int32Array,
) {
  const deadline = Date.now() + 2_000;
  while (Atomics.load(barrier, 0) < tasks.length) {
    if (tasks.some((task) => task.isSettled())) {
      throw new Error("independent budget worker exited before barrier");
    }
    if (Date.now() >= deadline) {
      throw new Error("independent budget worker barrier timed out");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, tasks.length);
}

async function cleanupIndependentBudgetWorkers(
  tasks: readonly IndependentBudgetWorkerTask[],
  barrier: Int32Array,
) {
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, tasks.length);
  await Promise.allSettled(
    tasks.map((task) =>
      task.worker.threadId === -1
        ? undefined
        : withinIndependentBudgetWorker(
            task.worker.terminate(),
            2_000,
            "independent budget worker termination",
          ),
    ),
  );
  await withinIndependentBudgetWorker(
    Promise.all(tasks.map((task) => task.exited)),
    2_000,
    "independent budget worker exit",
  );
  await withinIndependentBudgetWorker(
    Promise.all(tasks.map((task) => task.result)),
    2_000,
    "independent budget worker result cleanup",
  );
}

test("model ledger mutations atomically reject a stale AgentRun claim", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const agentRuns = asAgentRunRepository(sqlite);
  const budget = sqlite as unknown as ModelBudgetLedgerRepository;
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await agentRuns.registerSkillVersion(skillVersionInput());
  const pending = await agentRuns.beginAgentRun(beginInput(subject, skill.id));
  const executionAuthority = {
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
  };
  const limits = {
    call: { maxTokens: 10_000, maxCostMicros: 10_000 },
    run: { maxTokens: 10_000, maxCostMicros: 10_000 },
    organizationUtcDay: { maxTokens: 10_000, maxCostMicros: 10_000 },
  };
  const reserve = (ordinal: number, suffix: string) => budget.reserveModelBudget({
    id: randomUUID(),
    idempotencyKey: `atomic-claim-fence:${suffix}`,
    requestFingerprint: suffix.repeat(64),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
    limits,
    reservedAt: now,
    leaseExpiresAt: "2026-08-15T08:01:00.000Z",
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: ordinal,
    attemptKind: ordinal === 0 ? "initial" : "transient-retry",
    transientRetryCount: Math.min(ordinal, 2),
    formatRepair: false,
  });
  const forDispatch = await reserve(0, "1");
  const forSettle = await reserve(1, "2");
  const forRelease = await reserve(2, "3");
  const ownedRelease = await reserve(3, "5");
  const releasedByOwner = await budget.releaseModelBudget({
    reservationId: ownedRelease.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.050Z",
    executionAuthority,
  });
  assert.equal(releasedByOwner.transitioned, true);
  assert.equal(releasedByOwner.reservation.state, "released");
  const replacement = new DatabaseSync(temporary.path);
  replacement
    .prepare(
      `UPDATE job_attempts
       SET leased_by = 'replacement-worker', lease_generation = lease_generation + 1,
           lease_expires_at = '2026-08-15T08:02:00.000Z'
       WHERE id = ?`,
    )
    .run(subject.jobAttemptId);
  replacement.close();
  const replacementToken = "10000000-0000-4000-8000-000000000995";
  const replacementClaim = await agentRuns.beginAgentRun(
    beginInput(subject, skill.id, {
      leaseOwnerId: "replacement-worker",
      leaseGeneration: subject.leaseGeneration + 1,
      claimToken: replacementToken,
      claimAcquiredAt: "2026-08-15T08:00:00.400Z",
      claimExpiresAt: "2026-08-15T08:00:30.400Z",
    }),
  );
  assert.equal(replacementClaim.claimStatus, "acquired");
  const replacementAuthority = {
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId: "replacement-worker",
    leaseGeneration: subject.leaseGeneration + 1,
    claimToken: replacementToken,
  };
  await assert.rejects(
    budget.reserveModelBudget({
      id: randomUUID(),
      idempotencyKey: "atomic-claim-fence:3",
      requestFingerprint: "3".repeat(64),
      runId: subject.runId,
      projectId: subject.projectId,
      projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
      limits,
      reservedAt: now,
      leaseExpiresAt: "2026-08-15T08:01:00.000Z",
      jobAttemptId: subject.jobAttemptId,
      requestOrdinal: 2,
      attemptKind: "transient-retry",
      transientRetryCount: 2,
      formatRepair: false,
      executionAuthority,
    } as never),
    /execution authority|lease/i,
  );
  await assert.rejects(
    budget.dispatchModelBudget({
      reservationId: forDispatch.reservation.id,
      transitionedAt: "2026-08-15T08:00:00.100Z",
      executionAuthority,
    } as never),
    /execution authority|lease/i,
  );
  await assert.rejects(
    budget.settleModelBudget({
      reservationId: forSettle.reservation.id,
      transitionedAt: "2026-08-15T08:00:00.200Z",
      actual: { inputTokens: 8, outputTokens: 4, costMicros: 16 },
      responseId: "resp-stale-must-not-settle",
      executionAuthority,
    } as never),
    /execution authority|lease/i,
  );
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const workers = [
    startIndependentBudgetWorker(temporary.path, shared, {
      operation: "release",
      repositoryNow: now,
      input: {
        reservationId: forRelease.reservation.id,
        transitionedAt: "2026-08-15T08:00:00.300Z",
        executionAuthority,
      },
    }),
    startIndependentBudgetWorker(temporary.path, shared, {
      operation: "reserve-dispatch",
      repositoryNow: now,
      reserveInput: {
        id: randomUUID(),
        idempotencyKey: "atomic-claim-fence:3",
        requestFingerprint: "3".repeat(64),
        runId: subject.runId,
        projectId: subject.projectId,
        projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
        limits,
        reservedAt: now,
        leaseExpiresAt: "2026-08-15T08:01:00.000Z",
        jobAttemptId: subject.jobAttemptId,
        requestOrdinal: 2,
        attemptKind: "transient-retry",
        transientRetryCount: 2,
        formatRepair: false,
        executionAuthority: replacementAuthority,
      },
      dispatchInput: {
        reservationId: forRelease.reservation.id,
        transitionedAt: "2026-08-15T08:00:00.500Z",
        executionAuthority: replacementAuthority,
      },
    }),
  ];
  try {
    assert.equal(
      new Set(workers.map((worker) => worker.worker.threadId)).size,
      2,
    );
    await releaseIndependentBudgetWorkerBarrier(workers, barrier);
    const [staleRelease, replacementExecution] =
      await withinIndependentBudgetWorker(
        Promise.all(workers.map((worker) => worker.result)),
        5_000,
        "independent budget worker competition",
      );
    await withinIndependentBudgetWorker(
      Promise.all(workers.map((worker) => worker.exited)),
      2_000,
      "independent budget worker normal exit",
    );
    assert.equal(staleRelease.ok, false);
    assert.equal(
      staleRelease.ok ? undefined : staleRelease.error.code,
      "BUDGET_EXECUTION_AUTHORITY_LOST",
    );
    assert.equal(replacementExecution.ok, true);
    assert.equal(
      new Set([staleRelease.threadId, replacementExecution.threadId]).size,
      2,
    );
    const replacementValue = replacementExecution.ok
      ? replacementExecution.value
      : {};
    assert.equal(
      (replacementValue.reserved as { created?: boolean } | undefined)?.created,
      false,
    );
    assert.equal(
      (replacementValue.dispatched as { transitioned?: boolean } | undefined)
        ?.transitioned,
      true,
    );
    assert.equal(replacementValue.providerCalls, 1);
  } finally {
    await cleanupIndependentBudgetWorkers(workers, barrier);
  }
  const inspector = new DatabaseSync(temporary.path);
  const states = inspector
    .prepare(
      `SELECT state FROM model_budget_reservations
       WHERE id IN (?, ?, ?) ORDER BY id`,
    )
    .all(
      forDispatch.reservation.id,
      forSettle.reservation.id,
      forRelease.reservation.id,
    ) as Array<{
      state: string;
    }>;
  assert.equal(states.filter((row) => row.state === "dispatched").length, 1);
  assert.equal(states.filter((row) => row.state === "reserved").length, 2);
  const ordinalCount = inspector
    .prepare(
      `SELECT COUNT(*) AS count FROM model_budget_reservations
       WHERE job_attempt_id = ? AND request_ordinal = 2`,
    )
    .get(subject.jobAttemptId) as { count: number };
  inspector.close();
  assert.equal(ordinalCount.count, 1);
});

test("queued model ledger mutations use repository transaction-entry time for authority", async (t) => {
  const temporary = temporaryDatabase();
  let repositoryNow = now;
  let clockCalls = 0;
  const sqlite = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => {
      clockCalls += 1;
      return new Date(repositoryNow);
    },
  } as never);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const agentRuns = asAgentRunRepository(sqlite);
  const budget = sqlite as unknown as ModelBudgetLedgerRepository;
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await agentRuns.registerSkillVersion(skillVersionInput());
  const pending = await agentRuns.beginAgentRun(beginInput(subject, skill.id));
  const authority = {
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
  };
  const limits = {
    call: { maxTokens: 10_000, maxCostMicros: 10_000 },
    run: { maxTokens: 10_000, maxCostMicros: 10_000 },
    organizationUtcDay: { maxTokens: 10_000, maxCostMicros: 10_000 },
  };
  const reserve = (ordinal: number, suffix: string) =>
    budget.reserveModelBudget({
      id: randomUUID(),
      idempotencyKey: `transaction-entry:${suffix}`,
      requestFingerprint: suffix.repeat(64),
      runId: subject.runId,
      projectId: subject.projectId,
      projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
      limits,
      reservedAt: now,
      leaseExpiresAt: "2026-08-15T08:01:00.000Z",
      jobAttemptId: subject.jobAttemptId,
      requestOrdinal: ordinal,
      attemptKind: ordinal === 0 ? "initial" : "transient-retry",
      transientRetryCount: Math.min(ordinal, 2),
      formatRepair: false,
      executionAuthority: authority,
    });
  const forSettle = await reserve(0, "6");
  const forRelease = await reserve(1, "7");
  const ownedControl = await reserve(2, "8");
  const releasedControl = await budget.releaseModelBudget({
    reservationId: ownedControl.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.010Z",
    executionAuthority: authority,
  });
  assert.equal(releasedControl.transitioned, true);

  let unblock!: () => void;
  let transactionEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    transactionEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const blocker = sqlite.transaction(async () => {
    transactionEntered();
    await blocked;
  });
  await entered;
  const callsBeforeQueuedWrites = clockCalls;
  const queued = Promise.allSettled([
    budget.reserveModelBudget({
      id: randomUUID(),
      idempotencyKey: "transaction-entry:9",
      requestFingerprint: "9".repeat(64),
      runId: subject.runId,
      projectId: subject.projectId,
      projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
      limits,
      reservedAt: now,
      leaseExpiresAt: "2026-08-15T08:01:00.000Z",
      jobAttemptId: subject.jobAttemptId,
      requestOrdinal: 3,
      attemptKind: "format-repair",
      transientRetryCount: 0,
      formatRepair: true,
      executionAuthority: authority,
    }),
    budget.settleModelBudget({
      reservationId: forSettle.reservation.id,
      transitionedAt: "2026-08-15T08:00:00.020Z",
      actual: { inputTokens: 8, outputTokens: 4, costMicros: 16 },
      responseId: "resp-must-not-settle-after-lease-expiry",
      executionAuthority: authority,
    }),
    budget.releaseModelBudget({
      reservationId: forRelease.reservation.id,
      transitionedAt: "2026-08-15T08:00:00.030Z",
      executionAuthority: authority,
    }),
  ]);
  repositoryNow = "2026-08-15T08:02:00.000Z";
  unblock();
  await blocker;
  const outcomes = await queued;
  assert.equal(clockCalls - callsBeforeQueuedWrites, 3);
  assert.equal(
    outcomes.every(
      (outcome) =>
        outcome.status === "rejected" &&
        outcome.reason instanceof Error &&
        /execution authority|lease/i.test(outcome.reason.message),
    ),
    true,
  );
  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  const rows = inspector
    .prepare(
      `SELECT id, state FROM model_budget_reservations
       WHERE id IN (?, ?) ORDER BY id`,
    )
    .all(forSettle.reservation.id, forRelease.reservation.id) as Array<{
      id: string;
      state: string;
    }>;
  const extra = inspector
    .prepare(
      "SELECT COUNT(*) AS count FROM model_budget_reservations WHERE idempotency_key = 'transaction-entry:9'",
    )
    .get() as { count: number };
  inspector.close();
  assert.deepEqual(rows.map((row) => row.state), ["reserved", "reserved"]);
  assert.equal(extra.count, 0);
});

test("dispatch waiting behind a SQLite write lock uses fresh reservation TTL", async () => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(now),
  } as never);
  const agentRuns = asAgentRunRepository(sqlite);
  const budget = sqlite as unknown as ModelBudgetLedgerRepository;
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await agentRuns.registerSkillVersion(skillVersionInput());
  const pending = await agentRuns.beginAgentRun(beginInput(subject, skill.id));
  const authority = {
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
  };
  const reserved = await budget.reserveModelBudget({
    id: randomUUID(),
    idempotencyKey: "write-lock-fresh-authority",
    requestFingerprint: "a".repeat(64),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
    limits: {
      call: { maxTokens: 10_000, maxCostMicros: 10_000 },
      run: { maxTokens: 10_000, maxCostMicros: 10_000 },
      organizationUtcDay: { maxTokens: 10_000, maxCostMicros: 10_000 },
    },
    reservedAt: now,
    leaseExpiresAt: "2026-08-15T08:01:00.000Z",
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: 0,
    attemptKind: "initial",
    transientRetryCount: 0,
    formatRepair: false,
    executionAuthority: authority,
  });
  const reservationLeaseExpiresAt = new Date(Date.now() + 500).toISOString();
  const jobLeaseExpiresAt = new Date(Date.now() + 5_000).toISOString();
  const transitionedAt = new Date().toISOString();
  const leaseUpdater = new DatabaseSync(temporary.path);
  leaseUpdater
    .prepare("UPDATE job_attempts SET lease_expires_at = ? WHERE id = ?")
    .run(jobLeaseExpiresAt, subject.jobAttemptId);
  leaseUpdater
    .prepare(
      "UPDATE model_budget_reservations SET lease_expires_at = ? WHERE id = ?",
    )
    .run(reservationLeaseExpiresAt, reserved.reservation.id);
  leaseUpdater.close();

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const worker = new Worker(
    new URL("./helpers/sqlite-model-budget-worker.ts", import.meta.url),
    {
      workerData: {
        path: temporary.path,
        barrier: shared,
        barrierTimeoutMs: 5_000,
        operation: "dispatch",
        input: {
          reservationId: reserved.reservation.id,
          transitionedAt,
          executionAuthority: authority,
        },
      },
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    worker.once("message", (message) => resolve(message as Record<string, unknown>));
    worker.once("error", reject);
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  let lock: DatabaseSync | undefined;
  try {
    const readyDeadline = Date.now() + 2_000;
    while (Atomics.load(barrier, 0) < 1) {
      if (Date.now() >= readyDeadline) throw new Error("dispatch worker did not reach barrier");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    lock = new DatabaseSync(temporary.path);
    lock.exec("PRAGMA busy_timeout = 5000");
    lock.exec("BEGIN IMMEDIATE");
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, 1);
    const waitMs = Math.max(
      0,
      Date.parse(reservationLeaseExpiresAt) - Date.now() + 50,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    lock.exec("COMMIT");
    lock.close();
    lock = undefined;
    const outcome = await result;
    const providerCalls =
      outcome.ok === true &&
      (outcome.value as { transitioned?: boolean } | undefined)?.transitioned === true
        ? 1
        : 0;
    assert.equal(outcome.ok, true);
    assert.equal(
      (outcome.value as { transitioned?: boolean } | undefined)?.transitioned,
      false,
    );
    assert.equal(providerCalls, 0);
    const inspector = new DatabaseSync(temporary.path, { readOnly: true });
    const row = inspector
      .prepare("SELECT state FROM model_budget_reservations WHERE id = ?")
      .get(reserved.reservation.id) as { state: string };
    inspector.close();
    assert.equal(row.state, "released");
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, 1);
    if (lock !== undefined) {
      try {
        lock.exec("ROLLBACK");
      } catch {}
      lock.close();
    }
    if (worker.threadId !== -1) await worker.terminate();
    await exited;
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

const completedAttempts = [
  {
    ordinal: 0,
    kind: "initial",
    transientRetryCount: 0,
    formatRepair: false,
    accounting: "settled",
    errorClassification: null,
  },
] as const;

type AgentRunWorkerResult = Record<string, unknown>;

interface AgentRunWorkerTask {
  worker: Worker;
  result: Promise<AgentRunWorkerResult>;
  exit: Promise<number>;
  isSettled(): boolean;
}

function runFinalizeWorker(
  path: string,
  input: Parameters<AgentRunRepository["finalizeAgentRun"]>[0],
  barrier: SharedArrayBuffer,
  options: { barrierTimeoutMs?: number } = {},
) {
  const worker = new Worker(
    new URL("./helpers/sqlite-agent-run-worker.ts", import.meta.url),
    {
      workerData: {
        path,
        input,
        barrier,
        barrierTimeoutMs: options.barrierTimeoutMs ?? 5_000,
      },
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  const threadId = worker.threadId;
  let settled = false;
  let finish!: (result: AgentRunWorkerResult) => void;
  const result = new Promise<AgentRunWorkerResult>((resolve) => {
    finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });
  const exit = new Promise<number>((resolve) => {
    worker.once("exit", (code) => {
      finish({
        ok: false,
        threadId,
        error: { name: "AgentRunWorkerExitError", code: "AGENT_RUN_WORKER_EXIT" },
      });
      resolve(code);
    });
  });
  worker.once("message", (message) => finish(message as AgentRunWorkerResult));
  worker.once("error", () => finish({
    ok: false,
    threadId,
    error: { name: "AgentRunWorkerError", code: "AGENT_RUN_WORKER_ERROR" },
  }));
  return {
    worker,
    result,
    exit,
    isSettled: () => settled,
  } satisfies AgentRunWorkerTask;
}

async function cleanupFinalizeWorkers(
  tasks: readonly AgentRunWorkerTask[],
  barrier: Int32Array,
) {
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, tasks.length);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitedInTime = await Promise.race([
    Promise.all(tasks.map((task) => task.exit)).then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 500);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!exitedInTime) {
    await Promise.allSettled(
      tasks.map((task) =>
        task.worker.threadId === -1 ? undefined : task.worker.terminate(),
      ),
    );
  }
  await Promise.all(tasks.map((task) => task.exit));
  await Promise.all(tasks.map((task) => task.result));
}

async function waitForWorkers(
  tasks: readonly AgentRunWorkerTask[],
  barrier: Int32Array,
) {
  const deadline = Date.now() + 5_000;
  while (Atomics.load(barrier, 0) < tasks.length) {
    if (tasks.some((task) => task.isSettled())) {
      throw new Error("AgentRun worker exited before reaching the barrier");
    }
    if (Date.now() >= deadline) throw new Error("AgentRun worker barrier timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("SkillVersion is idempotent and rejects semantic content drift", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const input = skillVersionInput();

  const first = await repository.registerSkillVersion(input);
  const replay = await repository.registerSkillVersion({ ...input, id: randomUUID() });
  assert.deepEqual(replay, first);
  await assert.rejects(
    repository.registerSkillVersion({
      ...input,
      id: randomUUID(),
      contentHash: "d".repeat(64),
      manifest: { ...input.manifest, contentHash: "d".repeat(64) },
    }),
    SkillVersionConflictError,
  );
});

test("one active JobAttempt audit finalizes once and survives restart", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pendingInput = beginInput(subject, skill.id);
  const agentRunId = pendingInput.id;

  const begun = await repository.beginAgentRun(pendingInput);
  assert.equal(begun.created, true);
  assert.equal(begun.record.validationStatus, "pending");
  assert.equal(begun.record.inputTokens, null);
  assert.equal(begun.record.attemptCount, null);

  const finalizeInput = {
    agentRunId,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    completedAt,
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "resp_audit_1",
      output: { summary: "durable output" },
      error: null,
      inputTokens: Number.MAX_SAFE_INTEGER - 1,
      outputTokens: 1,
      estimatedCostMicros: Number.MAX_SAFE_INTEGER,
      durationMs: 1_000,
      attemptCount: 1,
      usageCompleteness: "complete",
      attempts: completedAttempts,
      terminalMetadata: { kind: "succeeded" },
    },
  } as const;
  await assert.rejects(
    repository.finalizeAgentRun({
      ...finalizeInput,
      outcome: { ...finalizeInput.outcome, estimatedCostMicros: 1.5 },
    }),
  );
  const finalized = await repository.finalizeAgentRun(finalizeInput);
  assert.equal(finalized.transitioned, true);
  assert.equal(finalized.record.validationStatus, "passed");
  const replayedFinalize = await repository.finalizeAgentRun(finalizeInput);
  assert.equal(replayedFinalize.transitioned, false);
  const terminalBeginReplay = await repository.beginAgentRun(pendingInput);
  assert.equal(terminalBeginReplay.created, false);
  assert.deepEqual(terminalBeginReplay.record, finalized.record);
  await assert.rejects(
    repository.beginAgentRun({
      ...pendingInput,
      executionFingerprint: "0".repeat(64),
    }),
    AgentRunConflictError,
  );
  await assert.rejects(
    repository.finalizeAgentRun({
      ...finalizeInput,
      outcome: {
        ...finalizeInput.outcome,
        output: { summary: "changed immutable output" },
      },
    }),
    AgentRunConflictError,
  );
  const inspector = new DatabaseSync(temporary.path);
  assert.throws(
    () => inspector.prepare("UPDATE agent_runs SET provider = 'changed'").run(),
    /immutable/i,
  );
  assert.throws(
    () => inspector.prepare("DELETE FROM agent_runs").run(),
    /immutable/i,
  );
  inspector.close();
  sqlite.close();

  const reopenedSqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const reopened = asAgentRunRepository(reopenedSqlite);
  t.after(() => {
    reopenedSqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const rows = await reopened.listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.deepEqual(rows, [finalized.record]);
  assert.deepEqual(
    await reopened.getAgentRunUsage({
      organizationId: subject.organizationId,
      runId: subject.runId,
    }),
    {
      usageCompleteness: "complete",
      inputTokens: Number.MAX_SAFE_INTEGER - 1,
      outputTokens: 1,
      estimatedCostMicros: Number.MAX_SAFE_INTEGER,
      durationMs: 1_000,
      attemptCount: 1,
      agentRunCount: 1,
    },
  );
});

test("terminal metadata boundary transactionally rejects every malformed closed shape", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const database = new DatabaseSync(temporary.path);
  t.after(() => {
    database.close();
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
  const completeFailed = database.prepare(
    `UPDATE agent_runs
     SET terminal_status = 'failed', validation_status = 'failed',
         output_json = NULL, error_json = ?, completed_at = ?,
         usage_completeness = 'unavailable', input_tokens = NULL,
         output_tokens = NULL, estimated_cost_micros = NULL, duration_ms = NULL,
         attempt_count = 0, attempts_json = '[]', terminal_metadata_json = ?
     WHERE id = ?`,
  );
  const safeError = JSON.stringify({
    code: "INFRASTRUCTURE_ERROR",
    message: "Safe failure",
    requestId: `agent-run:${pending.record.id}`,
    retryable: false,
  });
  const malformed = [
    '{"kind":',
    "null",
    "[]",
    "{}",
    '{"kind":1}',
    '{"kind":"failed"}',
    '{"kind":"failed","classification":1}',
    '{"kind":"failed","classification":"cancelled"}',
    '{"kind":"failed","classification":"infrastructure","extra":true}',
    '{"kind":"budget-exceeded","scope":"call","metric":"tokens","used":0,"projected":1}',
    '{"kind":"budget-exceeded","scope":"invalid","metric":"tokens","used":0,"projected":1,"limit":2}',
    '{"kind":"budget-exceeded","scope":"call","metric":"invalid","used":0,"projected":1,"limit":2}',
    '{"kind":"budget-exceeded","scope":"call","metric":"tokens","used":-1,"projected":1,"limit":2}',
    '{"kind":"budget-exceeded","scope":"call","metric":"tokens","used":0,"projected":9007199254740992,"limit":9007199254740992}',
    '{"kind":"budget-exceeded","scope":"call","metric":"costUsd","used":1e999,"projected":1,"limit":2}',
    '{"kind":"budget-exceeded","scope":"call","metric":"costMicros","used":0,"projected":1,"limit":2,"extra":true}',
  ];

  for (const metadata of malformed) {
    assert.throws(
      () => completeFailed.run(safeError, completedAt, metadata, pending.record.id),
      /completed agent run|terminal metadata|constraint|malformed JSON/i,
      metadata,
    );
    const row = database
      .prepare(
        `SELECT validation_status, terminal_status, completed_at,
                error_json, terminal_metadata_json
         FROM agent_runs WHERE id = ?`,
      )
      .get(pending.record.id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, {
      validation_status: "pending",
      terminal_status: null,
      completed_at: null,
      error_json: null,
      terminal_metadata_json: null,
    });
  }
});

test("terminal metadata boundary accepts each strict closed shape", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const database = new DatabaseSync(temporary.path);
  t.after(() => {
    database.close();
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const legal = [
    { status: "succeeded", metadata: { kind: "succeeded" } },
    {
      status: "failed",
      metadata: { kind: "failed", classification: "infrastructure" },
    },
    { status: "cancelled", metadata: { kind: "cancelled" } },
    {
      status: "budget-exceeded",
      metadata: {
        kind: "budget-exceeded",
        scope: "daily",
        metric: "costMicros",
        used: 1,
        projected: 2,
        limit: Number.MAX_SAFE_INTEGER,
      },
    },
  ] as const;

  for (const item of legal) {
    const subject = await seedActiveAttempt(sqlite, temporary.path);
    const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
    const succeeded = item.status === "succeeded";
    const safeError = succeeded
      ? null
      : JSON.stringify({
          code: item.status === "cancelled" ? "CANCELLED" : "INFRASTRUCTURE_ERROR",
          message: "Safe terminal outcome",
          requestId: `agent-run:${pending.record.id}`,
          retryable: false,
        });
    database
      .prepare(
        `UPDATE agent_runs
         SET terminal_status = ?, validation_status = ?, response_id = ?,
             output_json = ?, error_json = ?, completed_at = ?,
             usage_completeness = ?, input_tokens = ?, output_tokens = ?,
             estimated_cost_micros = ?, duration_ms = ?, attempt_count = ?,
             attempts_json = ?, terminal_metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        item.status,
        succeeded ? "passed" : "failed",
        succeeded ? "resp-raw-legal" : null,
        succeeded ? JSON.stringify({ summary: "safe" }) : null,
        safeError,
        completedAt,
        succeeded ? "complete" : "unavailable",
        succeeded ? 1 : null,
        succeeded ? 1 : null,
        succeeded ? 1 : null,
        succeeded ? 1 : null,
        succeeded ? 1 : 0,
        JSON.stringify(succeeded ? completedAttempts : []),
        JSON.stringify(item.metadata),
        pending.record.id,
      );
    const [stored] = await repository.listAgentRuns({
      organizationId: subject.organizationId,
      runId: subject.runId,
    });
    assert.equal(stored.status, item.status);
    assert.deepEqual(stored.terminalMetadata, item.metadata);
  }
});

test("failed AgentRun persists only a normalized safe error", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
  const failed = await repository.finalizeAgentRun({
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    completedAt,
    outcome: {
      terminalStatus: "failed",
      validationStatus: "failed",
      responseId: null,
      output: null,
      error: {
        code: "UPSTREAM_PERMANENT",
        message: "Model provider request failed",
        requestId: `agent-run:${pending.record.id}`,
        retryable: false,
      },
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: null,
      durationMs: 1_000,
      attemptCount: 0,
      usageCompleteness: "unavailable",
      attempts: [],
      terminalMetadata: {
        kind: "failed",
        classification: "upstream-permanent",
      },
    },
  });
  sqlite.close();

  const reopenedSqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    reopenedSqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const [restored] = await asAgentRunRepository(reopenedSqlite).listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.deepEqual(restored, failed.record);
  assert.deepEqual(restored?.error, {
    code: "UPSTREAM_PERMANENT",
    message: "Model provider request failed",
    requestId: `agent-run:${pending.record.id}`,
    retryable: false,
  });
});

for (const terminal of [
  {
    label: "permanent contract failure",
    terminalStatus: "failed" as const,
    stageStatus: "failed" as const,
    attemptStatus: "failed" as const,
    terminalMetadata: {
      kind: "failed" as const,
      classification: "model-output" as const,
    },
    error: {
      code: "MODEL_OUTPUT_ERROR" as const,
      message: "Model output failed validation",
      retryable: false,
    },
  },
  {
    label: "permanent upstream failure",
    terminalStatus: "failed" as const,
    stageStatus: "failed" as const,
    attemptStatus: "failed" as const,
    terminalMetadata: {
      kind: "failed" as const,
      classification: "upstream-permanent" as const,
    },
    error: {
      code: "UPSTREAM_PERMANENT" as const,
      message: "Model provider request failed",
      retryable: false,
    },
  },
  {
    label: "budget exhaustion",
    terminalStatus: "budget-exceeded" as const,
    stageStatus: "budget-exceeded" as const,
    attemptStatus: "failed" as const,
    terminalMetadata: {
      kind: "budget-exceeded" as const,
      scope: "run" as const,
      metric: "costMicros" as const,
      used: 10,
      projected: 20,
      limit: 15,
    },
    error: {
      code: "CONFIGURATION_ERROR" as const,
      message: "Model execution budget exceeded",
      retryable: false,
    },
  },
  {
    label: "cancellation",
    terminalStatus: "cancelled" as const,
    stageStatus: "cancelled" as const,
    attemptStatus: "cancelled" as const,
    terminalMetadata: { kind: "cancelled" as const },
    error: {
      code: "CANCELLED" as const,
      message: "Skill execution was cancelled",
      retryable: false,
    },
  },
] as const) {
  test(`lease-expiry claim settles durable ${terminal.label} without a successor`, async (t) => {
    const temporary = temporaryDatabase();
    let sqlite = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
    });
    t.after(() => {
      sqlite.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    });
    const subject = await seedActiveAttempt(sqlite, temporary.path);
    const repository = asAgentRunRepository(sqlite);
    const skill = await repository.registerSkillVersion(skillVersionInput());
    const pending = await repository.beginAgentRun(
      beginInput(subject, skill.id, {
        logicalExecutionLineage: randomUUID().replaceAll("-", "").repeat(2),
      }),
    );
    await repository.finalizeAgentRun({
      agentRunId: pending.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken,
      completedAt,
      outcome: {
        terminalStatus: terminal.terminalStatus,
        validationStatus: "failed",
        responseId: null,
        output: null,
        error: {
          ...terminal.error,
          requestId: `agent-run:${pending.record.id}`,
        },
        inputTokens: null,
        outputTokens: null,
        estimatedCostMicros: null,
        durationMs: 1,
        attemptCount: 0,
        usageCompleteness: "unavailable",
        attempts: [],
        terminalMetadata: terminal.terminalMetadata,
      },
    });
    sqlite.close();
    sqlite = openSqliteAgentRepository({
      path: temporary.path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date("2026-08-15T08:02:00.000Z"),
    });

    assert.equal(await sqlite.claimNextJob({
      ownerId: "worker-b",
      claimedAt: "2026-08-15T08:02:00.000Z",
      leaseDurationMs: 60_000,
    }), null);
    assert.equal((await sqlite.findRunStage(subject.stageId))?.status, terminal.stageStatus);
    const attempts = await sqlite.listJobAttempts(subject.stageId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, terminal.attemptStatus);
    assert.equal(attempts[0]?.retryable, false);
  });
}

test("legacy AgentRun rows are ignored by the v1.1 audit reader and usage", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await asAgentRunRepository(sqlite).registerSkillVersion(skillVersionInput());
  sqlite.close();
  const database = new DatabaseSync(temporary.path);
  database
    .prepare(
      `INSERT INTO agent_runs
       (id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
        snapshot_ids_json, provider, model, input_summary_json,
        output_schema_version, validation_status, data_cutoff_at, started_at)
       VALUES (?, ?, ?, NULL, ?, '1.0.0', '[]', 'legacy', 'legacy', '{}',
               '1.0.0', 'failed', ?, ?)`,
    )
    .run(randomUUID(), subject.runId, subject.stageId, skill.id, now, now);
  database.close();

  const reopenedSqlite = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    reopenedSqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const reopened = asAgentRunRepository(reopenedSqlite);
  const scope = {
    organizationId: subject.organizationId,
    runId: subject.runId,
  };

  assert.deepEqual(await reopened.listAgentRuns(scope), []);
  assert.deepEqual(await reopened.getAgentRunUsage(scope), {
    usageCompleteness: "unavailable",
    inputTokens: null,
    outputTokens: null,
    estimatedCostMicros: null,
    durationMs: null,
    attemptCount: null,
    agentRunCount: 0,
  });
});

test("terminal recovery preserves unknown duration as null in usage summaries", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));

  const finalized = await repository.finalizeAgentRun({
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    completedAt,
    outcome: {
      terminalStatus: "failed",
      validationStatus: "failed",
      responseId: null,
      output: null,
      error: {
        code: "INFRASTRUCTURE_ERROR",
        message: "Agent execution result was not durably committed",
        requestId: `agent-run:${pending.record.id}`,
        retryable: false,
      },
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: null,
      durationMs: null,
      attemptCount: 0,
      usageCompleteness: "unavailable",
      attempts: [],
      terminalMetadata: { kind: "failed", classification: "infrastructure" },
    },
  });
  assert.equal(finalized.record.durationMs, null);
  assert.equal(
    (
      await repository.getAgentRunUsage({
        organizationId: subject.organizationId,
        runId: subject.runId,
      })
    ).durationMs,
    null,
  );
});

test("begin rejects relationship, tenant, canonical-ID, and fingerprint drift", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const first = await seedActiveAttempt(sqlite, temporary.path);
  const second = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const valid = beginInput(first, skill.id);

  await assert.rejects(
    repository.beginAgentRun({
      ...valid,
      id: randomUUID(),
      snapshotIds: [first.snapshotId, first.snapshotId],
    }),
    /snapshot/i,
  );
  await assert.rejects(
    repository.beginAgentRun({
      ...valid,
      id: randomUUID(),
      snapshotIds: [first.snapshotId.toUpperCase()],
    }),
    /snapshot/i,
  );
  for (const changed of [
    { id: randomUUID(), snapshotIds: [first.snapshotId, second.snapshotId] },
    { id: randomUUID(), organizationId: second.organizationId },
    { id: randomUUID(), stageId: second.stageId },
    { id: randomUUID(), jobAttemptId: second.jobAttemptId },
    { id: randomUUID(), skillVersionId: randomUUID() },
  ]) {
    await assert.rejects(
      repository.beginAgentRun({ ...valid, ...changed }),
      AgentRunSubjectNotFoundError,
    );
  }
  await assert.rejects(
    repository.beginAgentRun({
      ...valid,
      id: randomUUID(),
      executionFingerprint: "D".repeat(64),
    }),
    /identity/i,
  );
  await assert.rejects(
    repository.beginAgentRun({
      ...valid,
      id: randomUUID(),
      dataCutoffAt: completedAt,
    }),
    AgentRunSubjectNotFoundError,
  );
  assert.deepEqual(
    await repository.listAgentRuns({
      organizationId: first.organizationId,
      runId: first.runId,
    }),
    [],
  );

  const created = await repository.beginAgentRun(valid);
  const replay = await repository.beginAgentRun({ ...valid, id: randomUUID() });
  assert.equal(replay.created, false);
  assert.equal(replay.record.id, created.record.id);
  for (const changed of [
    { executionFingerprint: "0".repeat(64) },
    { outputSchemaDigest: "1".repeat(64) },
    { provider: "other-provider" },
    { model: "other-model" },
    { dataCutoffAt: completedAt },
  ]) {
    await assert.rejects(
      repository.beginAgentRun({ ...valid, ...changed }),
      AgentRunConflictError,
    );
  }
  assert.deepEqual(
    await repository.listAgentRuns({
      organizationId: second.organizationId,
      runId: first.runId,
    }),
    [],
  );
});

test("AgentRun begin participates in caller transaction rollback", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const input = beginInput(subject, skill.id);

  await assert.rejects(
    sqlite.transaction(async (transaction) => {
      await asAgentRunRepository(transaction).beginAgentRun(input);
      throw new Error("agent-run-rollback-sentinel");
    }),
    /agent-run-rollback-sentinel/,
  );
  assert.deepEqual(
    await repository.listAgentRuns({
      organizationId: subject.organizationId,
      runId: subject.runId,
    }),
    [],
  );

  const inspector = new DatabaseSync(temporary.path);
  inspector.exec(`
    CREATE TRIGGER agent_run_snapshot_test_abort
    BEFORE INSERT ON agent_run_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'injected snapshot link failure');
    END;
  `);
  inspector.close();
  await assert.rejects(repository.beginAgentRun(input), /injected snapshot link failure/);
  assert.deepEqual(
    await repository.listAgentRuns({
      organizationId: subject.organizationId,
      runId: subject.runId,
    }),
    [],
  );
});

test("AgentRun begin requires a currently active matching lease", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const expired = await seedActiveAttempt(sqlite, temporary.path);
  const inactive = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());

  await assert.rejects(
    repository.beginAgentRun(
      beginInput(expired, skill.id, {
        startedAt: "2026-08-15T08:01:00.000Z",
        claimAcquiredAt: "2026-08-15T08:01:00.000Z",
        claimExpiresAt: "2026-08-15T08:01:30.000Z",
      }),
    ),
    AgentRunLeaseLostError,
  );
  await sqlite.releaseJobLease({
    jobId: inactive.jobAttemptId,
    ownerId: leaseOwnerId,
    leaseGeneration: inactive.leaseGeneration,
    releasedAt: "2026-08-15T08:00:00.500Z",
  });
  await assert.rejects(
    repository.beginAgentRun(beginInput(inactive, skill.id)),
    AgentRunLeaseLostError,
  );
});

test("stale lease cannot finalize a pending AgentRun", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
  await sqlite.releaseJobLease({
    jobId: subject.jobAttemptId,
    ownerId: leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    releasedAt: "2026-08-15T08:00:00.500Z",
  });

  await assert.rejects(
    repository.finalizeAgentRun({
      agentRunId: pending.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken,
      completedAt,
      outcome: {
        terminalStatus: "succeeded",
        validationStatus: "passed",
        responseId: "resp_stale",
        output: { summary: "must not persist" },
        error: null,
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostMicros: 1,
        durationMs: 1,
        attemptCount: 1,
        usageCompleteness: "complete",
        attempts: completedAttempts,
        terminalMetadata: { kind: "succeeded" },
      },
    }),
    AgentRunLeaseLostError,
  );
  assert.equal(
    (
      await repository.listAgentRuns({
        organizationId: subject.organizationId,
        runId: subject.runId,
      })
    )[0]?.validationStatus,
    "pending",
  );
});

test("separate worker connections grant one idempotent AgentRun finalize transition", async () => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
  const finalizeInput: Parameters<AgentRunRepository["finalizeAgentRun"]>[0] = {
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    completedAt,
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "resp_concurrent",
      output: { summary: "one durable winner" },
      error: null,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostMicros: 20,
      durationMs: 1_000,
      attemptCount: 1,
      usageCompleteness: "complete",
      attempts: completedAttempts.map((attempt) => ({ ...attempt })),
      terminalMetadata: { kind: "succeeded" },
    },
  };
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(buffer);
  const workers: AgentRunWorkerTask[] = [
    runFinalizeWorker(temporary.path, finalizeInput, buffer),
    runFinalizeWorker(temporary.path, finalizeInput, buffer),
  ];
  try {
    await waitForWorkers(workers, barrier);
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    const results = await Promise.all(workers.map((worker) => worker.result));
    await Promise.all(workers.map((worker) => worker.exit));

    assert.equal(results.filter((result) => result.ok === true).length, 2);
    const transitions = results.map(
      (result) => (result.value as { transitioned: boolean }).transitioned,
    );
    assert.deepEqual(transitions.sort(), [false, true]);
  } finally {
    await cleanupFinalizeWorkers(workers, barrier);
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("worker cleanup observes forced barrier timeout before database deletion", async () => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(buffer);
  const task = runFinalizeWorker(
    temporary.path,
    {
      agentRunId: pending.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken,
      completedAt,
      outcome: {
        terminalStatus: "failed",
        validationStatus: "failed",
        responseId: null,
        output: null,
        error: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCostMicros: null,
        durationMs: null,
        attemptCount: 0,
        usageCompleteness: "unavailable",
        attempts: [],
        terminalMetadata: { kind: "failed", classification: "infrastructure" },
      },
    },
    buffer,
    { barrierTimeoutMs: 25 },
  );
  let observedExit = false;
  try {
    assert.equal(task.worker instanceof Worker, true);
    const result = await task.result;
    assert.deepEqual(result.error, {
      name: "AgentRunWorkerBarrierTimeoutError",
      code: "AGENT_RUN_WORKER_BARRIER_TIMEOUT",
    });
    await task.exit;
    observedExit = true;
  } finally {
    await cleanupFinalizeWorkers([task], barrier);
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
  assert.equal(observedExit, true);
});

test("snapshot link boundary rejects forks, mutation, deletion, and terminal inserts", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const repository = asAgentRunRepository(sqlite);
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const pending = await repository.beginAgentRun(beginInput(subject, skill.id));
  const extraSnapshotId = randomUUID();
  const extraCandidate = strictSnapshotCandidate("2026-08-15T07:59:59.000Z");
  const database = new DatabaseSync(temporary.path);
  registerVocSnapshotIntegrityFunction(database);
  t.after(() => {
    database.close();
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  database
    .prepare(
      `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, schema_version, marketplace, asins_json, data_cutoff_at,
        sources_json, payload_json, content_hash, created_at)
       VALUES (?, ?, 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      extraSnapshotId,
      subject.runId,
      extraCandidate.schemaVersion,
      extraCandidate.marketplace,
      JSON.stringify(extraCandidate.asins),
      extraCandidate.dataCutoffAt,
      JSON.stringify(extraCandidate.sources),
      JSON.stringify(extraCandidate.payload),
      extraCandidate.contentHash,
      now,
    );

  assert.throws(
    () => database.prepare(
      `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
       VALUES (?, ?, 1)`,
    ).run(pending.record.id, extraSnapshotId),
    /snapshot|pending|immutable/i,
  );
  assert.throws(
    () => database.prepare(
      `UPDATE agent_run_snapshots SET ordinal = 1
       WHERE agent_run_id = ? AND snapshot_id = ?`,
    ).run(pending.record.id, subject.snapshotId),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare(
      `DELETE FROM agent_run_snapshots
       WHERE agent_run_id = ? AND snapshot_id = ?`,
    ).run(pending.record.id, subject.snapshotId),
    /immutable/i,
  );

  await repository.finalizeAgentRun({
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken,
    completedAt,
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "resp-boundary",
      output: { safe: true },
      error: null,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicros: 2,
      durationMs: 1,
      attemptCount: 1,
      usageCompleteness: "complete",
      attempts: completedAttempts,
      terminalMetadata: { kind: "succeeded" },
    },
  });
  assert.throws(
    () => database.prepare(
      `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
       VALUES (?, ?, 1)`,
    ).run(pending.record.id, extraSnapshotId),
    /snapshot|pending|immutable/i,
  );
});

test("budget provenance boundary rejects every attempt identity rewrite", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const budget = sqlite as unknown as ModelBudgetLedgerRepository;
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const other = await seedActiveAttempt(sqlite, temporary.path);
  const reservation = await budget.reserveModelBudget({
    id: randomUUID(),
    idempotencyKey: "provenance-boundary",
    requestFingerprint: "7".repeat(64),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
    limits: {
      call: { maxTokens: 1_000, maxCostMicros: 1_000 },
      run: { maxTokens: 1_000, maxCostMicros: 1_000 },
      organizationUtcDay: { maxTokens: 1_000, maxCostMicros: 1_000 },
    },
    reservedAt: now,
    leaseExpiresAt: "2026-08-15T08:01:00.000Z",
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: 0,
    attemptKind: "initial",
    transientRetryCount: 0,
    formatRepair: false,
  });
  const database = new DatabaseSync(temporary.path);
  t.after(() => {
    database.close();
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });

  for (const sql of [
    "UPDATE model_budget_reservations SET request_ordinal = 1 WHERE id = ?",
    "UPDATE model_budget_reservations SET attempt_kind = 'format-repair' WHERE id = ?",
    "UPDATE model_budget_reservations SET transient_retry_count = 1 WHERE id = ?",
    "UPDATE model_budget_reservations SET format_repair = 1 WHERE id = ?",
  ]) {
    assert.throws(
      () => database.prepare(sql).run(reservation.reservation.id),
      /provenance|immutable/i,
    );
  }
  assert.throws(
    () => database.prepare(
      `UPDATE model_budget_reservations
       SET run_id = ?, project_id = ?, organization_id = ?, job_attempt_id = ?
       WHERE id = ?`,
    ).run(
      other.runId,
      other.projectId,
      other.organizationId,
      other.jobAttemptId,
      reservation.reservation.id,
    ),
    /provenance|immutable/i,
  );
});

test("response id boundary permits settle assignment once and rejects tampering", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const budget = sqlite as unknown as ModelBudgetLedgerRepository;
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  const reservation = await budget.reserveModelBudget({
    id: randomUUID(),
    idempotencyKey: "response-boundary",
    requestFingerprint: "8".repeat(64),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
    limits: {
      call: { maxTokens: 1_000, maxCostMicros: 1_000 },
      run: { maxTokens: 1_000, maxCostMicros: 1_000 },
      organizationUtcDay: { maxTokens: 1_000, maxCostMicros: 1_000 },
    },
    reservedAt: now,
    leaseExpiresAt: "2026-08-15T08:01:00.000Z",
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: 0,
    attemptKind: "initial",
    transientRetryCount: 0,
    formatRepair: false,
  });
  await budget.dispatchModelBudget({
    reservationId: reservation.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.100Z",
  });
  const database = new DatabaseSync(temporary.path);
  t.after(() => {
    database.close();
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  assert.throws(
    () => database.prepare(
      "UPDATE model_budget_reservations SET response_id = 'forged' WHERE id = ?",
    ).run(reservation.reservation.id),
    /response|settle|immutable/i,
  );

  await budget.settleModelBudget({
    reservationId: reservation.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.200Z",
    actual: { inputTokens: 8, outputTokens: 4, costMicros: 16 },
    responseId: "resp-settled",
  });
  for (const responseId of ["forged", null]) {
    assert.throws(
      () => database.prepare(
        "UPDATE model_budget_reservations SET response_id = ? WHERE id = ?",
      ).run(responseId, reservation.reservation.id),
      /response|settle|immutable/i,
    );
  }
});

test("job attempt usage preserves request identity and conservative partial accounting", async (t) => {
  const temporary = temporaryDatabase();
  const sqlite = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const agentRuns = asAgentRunRepository(sqlite);
  const budget = sqlite as unknown as ModelBudgetLedgerRepository;
  const subject = await seedActiveAttempt(sqlite, temporary.path);
  t.after(() => {
    sqlite.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const limits = {
    call: { maxTokens: 10_000, maxCostMicros: 10_000 },
    run: { maxTokens: 10_000, maxCostMicros: 10_000 },
    organizationUtcDay: { maxTokens: 10_000, maxCostMicros: 10_000 },
  };

  const initial = await budget.reserveModelBudget({
    id: randomUUID(),
    idempotencyKey: "agent-run-audit:0",
    requestFingerprint: "1".repeat(64),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 100, outputTokens: 20, costMicros: 300 },
    limits,
    reservedAt: now,
    leaseExpiresAt: "2026-08-15T08:01:00.000Z",
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: 0,
    attemptKind: "initial",
    transientRetryCount: 0,
    formatRepair: false,
  });
  await budget.dispatchModelBudget({
    reservationId: initial.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.100Z",
  });
  await budget.settleModelBudget({
    reservationId: initial.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.200Z",
    actual: { inputTokens: 80, outputTokens: 12, costMicros: 240 },
  });

  const retry = await budget.reserveModelBudget({
    id: randomUUID(),
    idempotencyKey: "agent-run-audit:1",
    requestFingerprint: "2".repeat(64),
    runId: subject.runId,
    projectId: subject.projectId,
    projected: { inputTokens: 110, outputTokens: 25, costMicros: 350 },
    limits,
    reservedAt: "2026-08-15T08:00:00.300Z",
    leaseExpiresAt: "2026-08-15T08:01:00.300Z",
    jobAttemptId: subject.jobAttemptId,
    requestOrdinal: 1,
    attemptKind: "transient-retry",
    transientRetryCount: 1,
    formatRepair: true,
  });
  await budget.dispatchModelBudget({
    reservationId: retry.reservation.id,
    transitionedAt: "2026-08-15T08:00:00.400Z",
  });

  assert.deepEqual(
    await agentRuns.getJobAttemptModelUsage({
      organizationId: subject.organizationId,
      runId: subject.runId,
      jobAttemptId: subject.jobAttemptId,
    }),
    {
      usageCompleteness: "partial",
      inputTokens: 190,
      outputTokens: 37,
      estimatedCostMicros: 590,
      responseId: null,
      attempts: [
        {
          ordinal: 0,
          kind: "initial",
          transientRetryCount: 0,
          formatRepair: false,
          accounting: "settled",
          errorClassification: "unavailable",
        },
        {
          ordinal: 1,
          kind: "transient-retry",
          transientRetryCount: 1,
          formatRepair: true,
          accounting: "projected",
          errorClassification: "unavailable",
        },
      ],
    },
  );
});
