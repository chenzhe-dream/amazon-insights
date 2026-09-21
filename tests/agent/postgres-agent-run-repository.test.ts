import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  AgentRunClaimLostError,
  AgentRunConflictError,
  AgentRunLeaseLostError,
  AgentRunSubjectNotFoundError,
  SkillVersionConflictError,
  type BeginAgentRunInput,
  type FinalizeAgentRunInput,
  type RegisterSkillVersionInput,
} from "../../server/db/agent-run-repository";
import { PostgresAgentRunStore } from "../../server/db/postgres/agent-run-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const now = "2026-08-15T08:00:00.000Z";
const completedAt = "2026-08-15T08:00:01.000Z";
const leaseExpiresAt = "2026-08-15T08:10:00.000Z";
const fixtureAsins = ["B0ABC12345", "B0DEF67890", "B0GHI13579"];

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

interface Subject {
  organizationId: string;
  projectId: string;
  runId: string;
  stageId: string;
  jobAttemptId: string;
  snapshotId: string;
  logicalExecutionCycleId: string;
  leaseOwnerId: string;
  leaseGeneration: number;
}

async function freshRepository() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  return {
    pool,
    repository: new PostgresAgentRunStore(new PostgresQueryContext(pool)),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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

async function seedSubject(
  pool: Pool,
  overrides: Partial<Pick<Subject, "organizationId" | "leaseOwnerId">> = {},
): Promise<Subject> {
  const organizationId = overrides.organizationId ?? randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobAttemptId = randomUUID();
  const snapshotId = randomUUID();
  const leaseOwnerId = overrides.leaseOwnerId ?? `worker-${randomUUID()}`;
  const logicalExecutionCycleId = sha256(`${stageId}:1`);

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'AgentRun test', 'admin', 'active', $4, $4)`,
    [userId, organizationId, `${userId}@example.com`, now],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ($1, $2, 'AgentRun audit', 'US', $3::jsonb, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify(fixtureAsins), userId, now],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, 'existing-data', 'running', $3, $4, $5, 'create', $4, $4)`,
    [runId, projectId, userId, now, `agent-run-test:${runId}`],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, started_at,
        created_at, updated_at)
     VALUES ($1, $2, 'voc-positioning', 'running', 1, 1, $3, $3, $3)`,
    [stageId, runId, now],
  );
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id, status, available_at, leased_by,
        lease_expires_at, lease_generation, retryable, started_at,
        created_at, updated_at)
     VALUES ($1, $2, 1, 3, 1, $3, 'running', $4, $5, $6, 1, FALSE, $4, $4, $4)`,
    [
      jobAttemptId,
      stageId,
      logicalExecutionCycleId,
      now,
      leaseOwnerId,
      leaseExpiresAt,
    ],
  );
  const candidate = strictSnapshotCandidate();
  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
        asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
        created_at)
     VALUES ($1, $2, 'voc', 'voc', $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $6)`,
    [
      snapshotId,
      runId,
      candidate.schemaVersion,
      candidate.marketplace,
      JSON.stringify(candidate.asins),
      now,
      JSON.stringify(candidate.sources),
      JSON.stringify(candidate.payload),
      candidate.contentHash,
    ],
  );

  return {
    organizationId,
    projectId,
    runId,
    stageId,
    jobAttemptId,
    snapshotId,
    logicalExecutionCycleId,
    leaseOwnerId,
    leaseGeneration: 1,
  };
}

function skillVersionInput(
  overrides: Partial<RegisterSkillVersionInput> = {},
): RegisterSkillVersionInput {
  const contentHash = overrides.contentHash ?? "c".repeat(64);
  const skillId = overrides.skillId ?? "define-amazon-voc-positioning";
  const version = overrides.version ?? "1.0.0";
  return {
    id: overrides.id ?? randomUUID(),
    skillId,
    version,
    contentHash,
    manifest: overrides.manifest ?? {
      id: skillId,
      version,
      entry: "SKILL.md",
      allowedReferences: ["references/priority-rules.md"],
      inputSchema: "VocPositioningInput@1.0.0",
      outputSchema: "VocPositioningOutput@1.0.0",
      fixtures: ["scooter-complete"],
      contentHash,
    },
    createdAt: overrides.createdAt ?? now,
  };
}

function beginInput(
  subject: Subject,
  skillVersionId: string,
  overrides: Partial<BeginAgentRunInput> = {},
): BeginAgentRunInput {
  return {
    id: randomUUID(),
    organizationId: subject.organizationId,
    runId: subject.runId,
    stageId: subject.stageId,
    jobAttemptId: subject.jobAttemptId,
    skillVersionId,
    snapshotIds: [subject.snapshotId],
    executionFingerprint: "d".repeat(64),
    logicalExecutionLineage: sha256(`lineage:${subject.stageId}`),
    logicalExecutionCycleId: subject.logicalExecutionCycleId,
    outputSchemaDigest: "e".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "f".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: now,
    startedAt: now,
    leaseOwnerId: subject.leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken: `claim-${randomUUID()}`,
    claimAcquiredAt: now,
    claimExpiresAt: "2026-08-15T08:05:00.000Z",
    ...overrides,
  };
}

function succeededOutcome(): FinalizeAgentRunInput["outcome"] {
  return {
    terminalStatus: "succeeded",
    validationStatus: "passed",
    responseId: "response-1",
    output: { status: "complete" },
    error: null,
    inputTokens: 10,
    outputTokens: 20,
    estimatedCostMicros: 30,
    durationMs: 40,
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
  };
}

function failedOutcome(): FinalizeAgentRunInput["outcome"] {
  return {
    terminalStatus: "failed",
    validationStatus: "failed",
    responseId: null,
    output: null,
    error: {
      code: "UPSTREAM_PERMANENT",
      message: "Provider rejected the request",
      requestId: randomUUID(),
      retryable: false,
    },
    inputTokens: null,
    outputTokens: null,
    estimatedCostMicros: null,
    durationMs: 40,
    attemptCount: 1,
    usageCompleteness: "unavailable",
    attempts: [
      {
        ordinal: 0,
        kind: "initial",
        transientRetryCount: 0,
        formatRepair: false,
        accounting: "unavailable",
        errorClassification: "upstream-permanent",
      },
    ],
    terminalMetadata: {
      kind: "failed",
      classification: "upstream-permanent",
    },
  };
}

test("PostgreSQL AgentRun persists a complete auditable execution and aggregates usage", async () => {
  const { pool, repository } = await freshRepository();
  const subject = await seedSubject(pool);
  const skillInput = skillVersionInput();
  const skill = await repository.registerSkillVersion(skillInput);
  assert.deepEqual(await repository.registerSkillVersion(skillInput), skill);

  const input = beginInput(subject, skill.id);
  const begun = await repository.beginAgentRun(input);
  assert.equal(begun.created, true);
  assert.equal(begun.claimStatus, "acquired");
  assert.deepEqual(begun.record.snapshotIds, [subject.snapshotId]);
  await repository.assertAgentRunClaim({
    agentRunId: begun.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: subject.jobAttemptId,
    leaseOwnerId: subject.leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken: input.claimToken,
    asOf: completedAt,
  });

  const finalizeInput: FinalizeAgentRunInput = {
    agentRunId: begun.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId: subject.leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken: input.claimToken,
    completedAt,
    outcome: succeededOutcome(),
  };
  const finalized = await repository.finalizeAgentRun(finalizeInput);
  assert.equal(finalized.transitioned, true);
  assert.equal(finalized.record.status, "succeeded");
  assert.deepEqual(finalized.record.attempts, finalizeInput.outcome.attempts);
  assert.equal((await repository.finalizeAgentRun(finalizeInput)).transitioned, false);
  assert.deepEqual(
    await repository.listAgentRuns({
      organizationId: subject.organizationId,
      runId: subject.runId,
    }),
    [finalized.record],
  );
  assert.deepEqual(
    await repository.getAgentRunUsage({
      organizationId: subject.organizationId,
      runId: subject.runId,
    }),
    {
      usageCompleteness: "complete",
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostMicros: 30,
      durationMs: 40,
      attemptCount: 1,
      agentRunCount: 1,
    },
  );
  assert.deepEqual(
    await repository.getJobAttemptModelUsage({
      agentRunId: begun.record.id,
      organizationId: subject.organizationId,
      runId: subject.runId,
      jobAttemptId: subject.jobAttemptId,
    }),
    {
      usageCompleteness: "unavailable",
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: null,
      responseId: null,
      attempts: [],
    },
  );
});

test("PostgreSQL AgentRun begin is idempotent and rejects changed fingerprints and Skill provenance", async () => {
  const { pool, repository } = await freshRepository();
  const subject = await seedSubject(pool);
  const skillInput = skillVersionInput();
  const skill = await repository.registerSkillVersion(skillInput);
  const input = beginInput(subject, skill.id);
  const owner = await repository.beginAgentRun(input);

  const replay = await repository.beginAgentRun({ ...input, id: randomUUID() });
  assert.equal(replay.created, false);
  assert.equal(replay.record.id, owner.record.id);
  assert.equal(replay.claimStatus, "acquired");
  const observer = await repository.beginAgentRun({
    ...input,
    id: randomUUID(),
    claimToken: `observer-${randomUUID()}`,
  });
  assert.equal(observer.claimStatus, "observing");
  await assert.rejects(
    repository.beginAgentRun({
      ...input,
      id: randomUUID(),
      executionFingerprint: "0".repeat(64),
    }),
    AgentRunConflictError,
  );
  await assert.rejects(
    repository.registerSkillVersion(
      skillVersionInput({
        id: randomUUID(),
        skillId: skill.skillId,
        version: skill.version,
        contentHash: "1".repeat(64),
      }),
    ),
    SkillVersionConflictError,
  );
});

test("PostgreSQL AgentRun fences organization, stage, token, owner, generation, and lease", async () => {
  const { pool, repository } = await freshRepository();
  const subject = await seedSubject(pool);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const input = beginInput(subject, skill.id);

  await assert.rejects(
    repository.beginAgentRun({ ...input, organizationId: randomUUID() }),
    AgentRunSubjectNotFoundError,
  );
  await assert.rejects(
    repository.beginAgentRun({ ...input, id: randomUUID(), stageId: randomUUID() }),
    AgentRunSubjectNotFoundError,
  );
  await assert.rejects(
    repository.beginAgentRun({ ...input, id: randomUUID(), leaseOwnerId: "wrong" }),
    AgentRunLeaseLostError,
  );
  await assert.rejects(
    repository.beginAgentRun({ ...input, id: randomUUID(), leaseGeneration: 2 }),
    AgentRunLeaseLostError,
  );

  const begun = await repository.beginAgentRun(input);
  await assert.rejects(
    repository.assertAgentRunClaim({
      agentRunId: begun.record.id,
      organizationId: subject.organizationId,
      jobAttemptId: subject.jobAttemptId,
      leaseOwnerId: subject.leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken: "wrong-token",
      asOf: completedAt,
    }),
    AgentRunClaimLostError,
  );
  await assert.rejects(
    repository.assertAgentRunClaim({
      agentRunId: begun.record.id,
      organizationId: subject.organizationId,
      jobAttemptId: subject.jobAttemptId,
      leaseOwnerId: subject.leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken: input.claimToken,
      asOf: "2026-08-15T08:11:00.000Z",
    }),
    AgentRunLeaseLostError,
  );
  await assert.rejects(
    repository.finalizeAgentRun({
      agentRunId: begun.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId: subject.leaseOwnerId,
      leaseGeneration: subject.leaseGeneration,
      claimToken: "wrong-token",
      completedAt,
      outcome: failedOutcome(),
    }),
    AgentRunClaimLostError,
  );
});

test("PostgreSQL AgentRun reclaims one logical execution and aggregates model attempts across jobs", async () => {
  const { pool, repository } = await freshRepository();
  const subject = await seedSubject(pool);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const originalInput = beginInput(subject, skill.id);
  const original = await repository.beginAgentRun(originalInput);
  await insertModelAttempt(pool, subject, subject.jobAttemptId, 0, "settled", original.record.id);

  await pool.query(
    `UPDATE job_attempts
        SET status = 'failed', retryable = FALSE, leased_by = NULL,
            lease_expires_at = NULL, completed_at = $1, updated_at = $1
      WHERE id = $2`,
    [completedAt, subject.jobAttemptId],
  );
  const recoveredJobId = randomUUID();
  const recoveredOwner = `worker-${randomUUID()}`;
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id, status, available_at, leased_by,
        lease_expires_at, lease_generation, retryable, started_at,
        created_at, updated_at)
     VALUES ($1, $2, 2, 3, 1, $3, 'running', $4, $5, $6, 2, FALSE, $4, $4, $4)`,
    [
      recoveredJobId,
      subject.stageId,
      subject.logicalExecutionCycleId,
      completedAt,
      recoveredOwner,
      leaseExpiresAt,
    ],
  );
  const recoveredInput = beginInput(
    {
      ...subject,
      jobAttemptId: recoveredJobId,
      leaseOwnerId: recoveredOwner,
      leaseGeneration: 2,
    },
    skill.id,
    {
      id: randomUUID(),
      logicalExecutionLineage: originalInput.logicalExecutionLineage,
      logicalExecutionCycleId: subject.logicalExecutionCycleId,
      claimToken: `recovered-${randomUUID()}`,
      claimAcquiredAt: completedAt,
    },
  );
  const recovered = await repository.beginAgentRun(recoveredInput);
  assert.equal(recovered.record.id, original.record.id);
  assert.equal(recovered.created, false);
  assert.equal(recovered.claimStatus, "acquired");
  const recoveredUsageScope = {
    agentRunId: original.record.id,
    organizationId: subject.organizationId,
    runId: subject.runId,
    jobAttemptId: recoveredJobId,
  };
  assert.equal((await repository.getJobAttemptModelUsage(recoveredUsageScope)).inputTokens, 12,
    "the active recovery must see previous billed attempts before deciding to call the provider");
  for (const invalid of [
    { ...recoveredUsageScope, organizationId: randomUUID() },
    { ...recoveredUsageScope, runId: randomUUID() },
    { ...recoveredUsageScope, jobAttemptId: subject.jobAttemptId },
  ]) {
    assert.deepEqual((await repository.getJobAttemptModelUsage(invalid)).attempts, []);
  }
  await repository.assertAgentRunClaim({
    agentRunId: original.record.id,
    organizationId: subject.organizationId,
    jobAttemptId: recoveredJobId,
    leaseOwnerId: recoveredOwner,
    leaseGeneration: 2,
    claimToken: recoveredInput.claimToken,
    asOf: "2026-08-15T08:02:00.000Z",
  });
  await assert.rejects(
    repository.finalizeAgentRun({
      agentRunId: original.record.id,
      organizationId: subject.organizationId,
      leaseOwnerId: subject.leaseOwnerId,
      leaseGeneration: 1,
      claimToken: originalInput.claimToken,
      completedAt: "2026-08-15T08:02:00.000Z",
      outcome: failedOutcome(),
    }),
    AgentRunClaimLostError,
  );

  await insertModelAttempt(
    pool,
    subject,
    recoveredJobId,
    1,
    "dispatched",
    original.record.id,
  );
  const usage = await repository.getJobAttemptModelUsage({
    agentRunId: original.record.id,
    organizationId: subject.organizationId,
    runId: subject.runId,
    jobAttemptId: recoveredJobId,
  });
  assert.equal(usage.usageCompleteness, "partial");
  assert.equal(usage.inputTokens, 23);
  assert.equal(usage.outputTokens, 44);
  assert.equal(usage.estimatedCostMicros, 65);
  assert.equal(usage.responseId, "response-0");
  assert.deepEqual(usage.attempts.map(({ ordinal }) => ordinal), [0, 1]);
});

async function insertModelAttempt(
  pool: Pool,
  subject: Subject,
  jobAttemptId: string,
  ordinal: number,
  state: "settled" | "dispatched",
  agentRunId: string,
) {
  const settled = state === "settled";
  await pool.query(
    `INSERT INTO model_budget_reservations (
       id, idempotency_key, request_fingerprint, run_id, project_id,
       organization_id, utc_day, state, projected_input_tokens,
       projected_output_tokens, projected_cost_micros, actual_input_tokens,
       actual_output_tokens, actual_cost_micros, lease_expires_at, created_at,
       updated_at, dispatched_at, settled_at, job_attempt_id, request_ordinal,
       attempt_kind, transient_retry_count, format_repair, response_id, agent_run_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11,
       $12, $13, $14, NULL, $7, $7, $15, $16, $17, $18,
       $19, $20, FALSE, $21, $22
     )`,
    [
      randomUUID(),
      `model-${ordinal}`,
      sha256(`request-${ordinal}`),
      subject.runId,
      subject.projectId,
      subject.organizationId,
      now,
      state,
      10 + ordinal,
      20 + ordinal,
      30 + ordinal,
      settled ? 12 : null,
      settled ? 23 : null,
      settled ? 34 : null,
      state === "dispatched" ? now : null,
      settled ? now : null,
      jobAttemptId,
      ordinal,
      ordinal === 0 ? "initial" : "transient-retry",
      ordinal === 0 ? 0 : 1,
      settled ? `response-${ordinal}` : null,
      agentRunId,
    ],
  );
}

test("PostgreSQL AgentRun permits exactly one concurrent terminal outcome", async () => {
  const { pool, repository } = await freshRepository();
  const competing = new PostgresAgentRunStore(new PostgresQueryContext(pool));
  const subject = await seedSubject(pool);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const input = beginInput(subject, skill.id);
  const begun = await repository.beginAgentRun(input);
  const base = {
    agentRunId: begun.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId: subject.leaseOwnerId,
    leaseGeneration: subject.leaseGeneration,
    claimToken: input.claimToken,
    completedAt,
  };

  const results = await Promise.allSettled([
    repository.finalizeAgentRun({ ...base, outcome: succeededOutcome() }),
    competing.finalizeAgentRun({ ...base, outcome: failedOutcome() }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.ok(
    results.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof AgentRunConflictError,
    ),
  );
  const records = await repository.listAgentRuns({
    organizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(records.length, 1);
  assert.notEqual(records[0]!.validationStatus, "pending");
});

test("PostgreSQL AgentRun snapshot links are immutable and failed begin rolls back all rows", async () => {
  const { pool, repository } = await freshRepository();
  const subject = await seedSubject(pool);
  const skill = await repository.registerSkillVersion(skillVersionInput());
  const successful = await repository.beginAgentRun(beginInput(subject, skill.id));

  await assert.rejects(
    pool.query(
      `UPDATE agent_run_snapshots SET ordinal = 1 WHERE agent_run_id = $1`,
      [successful.record.id],
    ),
    /snapshot links are immutable/i,
  );
  await assert.rejects(
    pool.query(`DELETE FROM agent_run_snapshots WHERE agent_run_id = $1`, [successful.record.id]),
    /snapshot links are immutable/i,
  );

  const second = await seedSubject(pool);
  await pool.query(`
    CREATE FUNCTION reject_agent_run_link_for_rollback()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced snapshot link rollback';
    END;
    $$;
    CREATE TRIGGER agent_run_snapshots_force_rollback
    BEFORE INSERT ON agent_run_snapshots
    FOR EACH ROW EXECUTE FUNCTION reject_agent_run_link_for_rollback();
  `);
  const rollbackInput = beginInput(second, skill.id);
  await assert.rejects(
    repository.beginAgentRun(rollbackInput),
    /stored agent run audit data is invalid/i,
  );
  assert.equal(
    (
      await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM agent_runs WHERE id = $1",
        [rollbackInput.id],
      )
    ).rows[0]?.count,
    "0",
  );
  assert.equal(
    (
      await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM agent_run_snapshots WHERE agent_run_id = $1",
        [rollbackInput.id],
      )
    ).rows[0]?.count,
    "0",
  );
});
