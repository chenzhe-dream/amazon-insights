import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  AgentRunConflictError,
  AgentRunLeaseLostError,
  AgentRunSubjectNotFoundError,
  SkillVersionConflictError,
  type AgentRunRepository,
  type RegisterSkillVersionInput,
} from "../../server/db/agent-run-repository";
import type { ModelBudgetLedgerRepository } from "../../server/db/model-budget-repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const now = "2026-08-15T08:00:00.000Z";
const completedAt = "2026-08-15T08:00:01.000Z";
const leaseOwnerId = "worker-a";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-run-audit-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

function asAgentRunRepository(repository: unknown) {
  return repository as AgentRunRepository;
}

async function seedActiveAttempt(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  path: string,
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
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
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
    outputSchemaDigest: "e".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "f".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: now,
    startedAt: now,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    ...overrides,
  } as const;
}

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

function runFinalizeWorker(
  path: string,
  input: Parameters<AgentRunRepository["finalizeAgentRun"]>[0],
  barrier: SharedArrayBuffer,
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let result: Record<string, unknown> | undefined;
    const worker = new Worker(
      new URL("./helpers/sqlite-agent-run-worker.ts", import.meta.url),
      {
        workerData: { path, input, barrier, barrierTimeoutMs: 5_000 },
        execArgv: ["--import", "tsx", "--conditions=react-server"],
      },
    );
    worker.once("message", (message) => {
      result = message as Record<string, unknown>;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`AgentRun worker exited with ${code}`));
      else if (!result) reject(new Error("AgentRun worker returned no result"));
      else resolve(result);
    });
  });
}

async function waitForWorkers(barrier: Int32Array, count: number) {
  const deadline = Date.now() + 5_000;
  while (Atomics.load(barrier, 0) < count) {
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
      beginInput(expired, skill.id, { startedAt: "2026-08-15T08:01:00.000Z" }),
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

test("separate worker connections grant one idempotent AgentRun finalize transition", async (t) => {
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
  const finalizeInput: Parameters<AgentRunRepository["finalizeAgentRun"]>[0] = {
    agentRunId: pending.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
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
    },
  };
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(buffer);
  const workers = [
    runFinalizeWorker(temporary.path, finalizeInput, buffer),
    runFinalizeWorker(temporary.path, finalizeInput, buffer),
  ];
  await waitForWorkers(barrier, 2);
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, 2);
  const results = await Promise.all(workers);

  assert.equal(results.filter((result) => result.ok === true).length, 2);
  const transitions = results.map(
    (result) => (result.value as { transitioned: boolean }).transitioned,
  );
  assert.deepEqual(transitions.sort(), [false, true]);
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
