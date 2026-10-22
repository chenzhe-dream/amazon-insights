import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { buildAgentApp } from "../../server/app";
import {
  LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
  LegacyManualAlexaVocSource,
} from "../../server/data/legacy-manual-alexa-voc-source";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import {
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocOutboxLease,
  type PutManualAlexaVocInput,
} from "../../server/db/manual-alexa-voc-repository";
import {
  PostgresAgentRepository,
} from "../../server/db/postgres-repository";
import {
  PostgresManualAlexaVocStore,
  type PostgresQueryExecutor,
} from "../../server/db/postgres/manual-alexa-voc-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import type { ManualAlexaVocEncryptedRaw } from "../../server/security/manual-alexa-voc-cipher";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { ALEXA_VOC_NORMALIZATION_SKILL } from "../../server/domain/voc/alexa-voc-normalization-contracts";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const ASIN = "B0AAAA0001";
const OTHER_ASIN = "B0BBBB0002";
const THIRD_ASIN = "B0CCCC0003";
const CREATED_AT = "2026-08-31T08:00:00.000Z";
const NORMALIZED_SCHEMA_VERSION = "alexa-voc-record/v2" as const;
const PARSER_VERSION = "deterministic-alexa-parser/v3" as const;

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

function hash(character: "a" | "b" | "c" | "d" | "e" | "f") {
  return character.repeat(64);
}

function normalizedRecord(asin = ASIN, marker = "fixture") {
  return {
    asin,
    attention: [`attention-${marker}`],
    positives: [`positive-${marker}`],
    negatives: [`negative-${marker}`],
    unmet: [`unmet-${marker}`],
    audiences: [`audience-${marker}`],
    scenarios: [`scenario-${marker}`],
    motives: [`motive-${marker}`],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: `Report ${marker}`,
      asin,
      rating: 4.5,
      reviewCount: 42,
      prompt: "fixture prompt",
      overallConclusion: `conclusion-${marker}`,
    },
  };
}

function encryptedRaw(seed: number): ManualAlexaVocEncryptedRaw {
  return Object.freeze({
    algVersion: "AES-256-GCM/v1",
    keyId: `fixture-key-${seed}`,
    wrappedDek: Uint8Array.from({ length: 60 }, (_, index) => (seed + index) % 256),
    nonce: Uint8Array.from({ length: 12 }, (_, index) => (seed * 3 + index) % 256),
    ciphertext: Uint8Array.from([seed, seed + 1, seed + 2, seed + 3]),
    tag: Uint8Array.from({ length: 16 }, (_, index) => (seed * 7 + index) % 256),
    aadSha256: hash("d"),
    plaintextBytes: 4,
    plaintextSha256: hash("e"),
  });
}

function putInput(input: Readonly<{
  organizationId: string;
  createdBy: string;
  asin?: string;
  expectedRevision: string;
  contentHash: string;
  marker?: string;
  rawSeed?: number;
}>): PutManualAlexaVocInput {
  const asin = (input.asin ?? ASIN).trim().toUpperCase();
  return {
    organizationId: input.organizationId,
    marketplace: "US",
    asin: input.asin ?? ASIN,
    createdBy: input.createdBy,
    expectedRevision: input.expectedRevision,
    normalizedRecord: normalizedRecord(asin, input.marker),
    normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    contentHash: input.contentHash,
    raw: encryptedRaw(input.rawSeed ?? 1),
  };
}

function addMilliseconds(timestamp: string, milliseconds: number) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

async function withLegacyDefaultOrganization<Result>(
  organizationId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
  process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID = organizationId;
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
    } else {
      process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID = previous;
    }
  }
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  milliseconds = 5_000,
): Promise<Result> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`fixture timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createSchema(): Promise<string> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const migrationPool = postgres.createPool({ searchPath: schema });
  try {
    await runPostgresMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }
  return schema;
}

function openRepository(t: test.TestContext, schema: string) {
  const pool = postgres.createPool({ searchPath: schema });
  const repository = new PostgresAgentRepository(pool);
  t.after(async () => {
    await repository.close();
  });
  return { pool, repository };
}

async function seedUser(
  repository: PostgresAgentRepository,
  organizationId: string,
  status: "active" | "disabled" = "active",
) {
  const id = randomUUID();
  await repository.createUser({
    id,
    organizationId,
    email: `${id}@example.com`,
    displayName: "Manual Alexa VOC PostgreSQL fixture",
    role: "admin",
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return id;
}

async function write(
  repository: PostgresAgentRepository,
  input: Omit<Parameters<typeof putInput>[0], "expectedRevision"> &
    Readonly<{ expectedRevision?: string }>,
) {
  return repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId: input.organizationId,
      marketplace: "US",
      asins: [input.asin ?? ASIN],
    });
    const expectedRevision = input.expectedRevision ??
      await repository.manualAlexaVoc.peekNextRevision({
        organizationId: input.organizationId,
        marketplace: "US",
        asin: input.asin ?? ASIN,
      });
    return repository.manualAlexaVoc.put(putInput({ ...input, expectedRevision }));
  });
}

async function expectRepositoryError(
  operation: Promise<unknown>,
  kind: ManualAlexaVocRepositoryError["kind"],
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ManualAlexaVocRepositoryError);
    assert.equal(error.kind, kind);
    return true;
  });
}

async function createRunCreationTarget(input: Readonly<{
  repository: PostgresAgentRepository;
  organizationId: string;
  actor: string;
  projectId: string;
  runId: string;
  snapshotId: string;
}>) {
  await input.repository.createAnalysisRun({
    id: input.runId,
    projectId: input.projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: input.actor,
    dataCutoffAt: CREATED_AT,
    idempotencyScope: `manual-voc-run:${input.runId}`,
    idempotencyKey: "create",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    dataCutoffAt: CREATED_AT,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: CREATED_AT,
      records: [normalizedRecord()],
    }],
  });
  await input.repository.createDataSnapshotForRun({
    actorId: input.actor,
    actorOrganizationId: input.organizationId,
    runId: input.runId,
    expectedProjectId: input.projectId,
    expectedMarketplace: "US",
    expectedAsins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    expectedRunCutoffAt: CREATED_AT,
    candidateId: input.snapshotId,
    createdAt: CREATED_AT,
    candidate,
  });
}

async function insertNonCooperativeRevision(input: Readonly<{
  client: PoolClient;
  organizationId: string;
  actor: string;
  contentHash: string;
  capturedAt: string;
  includeHead: boolean;
}>) {
  const raw = encryptedRaw(91);
  await input.client.query(
    `INSERT INTO manual_alexa_voc_revisions (
       organization_id, marketplace, asin, revision, content_hash,
       captured_at, normalized_record, normalized_schema_version,
       parser_version, raw_report_sha256, raw_report_alg_version,
       raw_report_key_id, raw_report_wrapped_dek, raw_report_nonce,
       raw_report_ciphertext, raw_report_tag, raw_report_aad_sha256,
       raw_report_plaintext_bytes, created_by, created_at
     ) VALUES ($1, 'US', $2, 1, $3, $4::timestamptz, $5::jsonb, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $4::timestamptz)`,
    [
      input.organizationId,
      ASIN,
      input.contentHash,
      input.capturedAt,
      JSON.stringify(normalizedRecord(ASIN, "non-cooperative")),
      NORMALIZED_SCHEMA_VERSION,
      PARSER_VERSION,
      raw.plaintextSha256,
      raw.algVersion,
      raw.keyId,
      Buffer.from(raw.wrappedDek),
      Buffer.from(raw.nonce),
      Buffer.from(raw.ciphertext),
      Buffer.from(raw.tag),
      raw.aadSha256,
      raw.plaintextBytes,
      input.actor,
    ],
  );
  if (!input.includeHead) return;
  await input.client.query(
    `INSERT INTO manual_alexa_voc_heads (
       organization_id, marketplace, asin, latest_revision,
       latest_content_hash, latest_captured_at, generation, updated_at
     ) VALUES ($1, 'US', $2, 1, $3, $4::timestamptz, 1, $4::timestamptz)`,
    [input.organizationId, ASIN, input.contentHash, input.capturedAt],
  );
}

async function waitForBlockedRevisionInsert(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await postgres.pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
          WHERE query LIKE 'INSERT INTO manual_alexa_voc_revisions%'
            AND wait_event_type = 'Lock'
       ) AS blocked`,
    );
    if (result.rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture did not observe the blocked revision insert");
}

test("serializes concurrent revisions by tenant scope and binds the runtime capability", async (t) => {
  const schema = await createSchema();
  const first = openRepository(t, schema);
  const second = openRepository(t, schema);
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const actor = await seedUser(first.repository, organizationA);
  await seedUser(first.repository, organizationB);

  const results = await Promise.all([
    write(first.repository, {
      organizationId: organizationA,
      createdBy: actor,
      contentHash: hash("a"),
      marker: "concurrent-a",
      rawSeed: 1,
    }),
    write(second.repository, {
      organizationId: organizationA,
      createdBy: actor,
      contentHash: hash("b"),
      marker: "concurrent-b",
      rawSeed: 2,
    }),
  ]);

  assert.deepEqual(results.map((result) => result.record.revision).sort(), ["1", "2"]);
  assert.deepEqual(
    await first.repository.manualAlexaVoc.listCurrent({
      organizationId: organizationB,
      marketplace: "US",
      asins: [ASIN],
    }),
    [],
  );
  const history = await first.pool.query<{ revision: string }>(
    `SELECT revision::text AS revision
       FROM manual_alexa_voc_revisions
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2
      ORDER BY revision`,
    [organizationA, ASIN],
  );
  assert.deepEqual(history.rows.map((row) => row.revision), ["1", "2"]);
  const outboxForHead = await first.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM manual_alexa_voc_publication_outbox o
       JOIN manual_alexa_voc_heads h
         ON h.organization_id = o.organization_id
        AND h.marketplace = o.marketplace AND h.asin = o.asin
        AND h.latest_revision = o.revision
        AND h.latest_content_hash = o.content_hash
      WHERE h.organization_id = $1 AND h.marketplace = 'US' AND h.asin = $2`,
    [organizationA, ASIN],
  );
  assert.equal(outboxForHead.rows[0]?.count, "1");
});

test("publishes a schema-valid VOC snapshot with an empty Alexa dimension", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const projectId = randomUUID();
  const runId = randomUUID();
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Empty Alexa dimension",
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    createdBy: actor,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actor,
    dataCutoffAt: CREATED_AT,
    idempotencyScope: `empty-dimension:${runId}`,
    idempotencyKey: "create",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    dataCutoffAt: CREATED_AT,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: CREATED_AT,
      records: [{ ...normalizedRecord(ASIN, "empty-negatives"), negatives: [] }],
    }],
  });

  const created = await repository.createDataSnapshotForRun({
    actorId: actor,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    expectedRunCutoffAt: CREATED_AT,
    candidateId: randomUUID(),
    createdAt: CREATED_AT,
    candidate,
  });
  assert.deepEqual(created.snapshot.payload.records.alexaVoc[0]?.negatives, []);

  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots (
         id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
         sources_json, payload_json, content_hash, created_at, snapshot_kind, artifact_kind
       ) SELECT $1, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
                sources_json,
                jsonb_set(payload_json, '{records,alexaVoc,0,negatives}', $2::jsonb),
                content_hash, created_at, snapshot_kind, artifact_kind
           FROM data_snapshots WHERE id = $3`,
      [randomUUID(), JSON.stringify(Array.from({ length: 257 }, () => "oversized")), created.snapshot.id],
    ),
    /invalid Alexa VOC snapshot record/,
  );
});

test("normalization queue replaces exhausted work but reuses at-max durable recovery", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actorUserId = await seedUser(repository, organizationId);
  const projectId = randomUUID();
  const runId = randomUUID();
  await repository.createProject({
    id: projectId, organizationId, name: "Queue recovery", marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN], createdBy: actorUserId,
    createdAt: CREATED_AT, updatedAt: CREATED_AT,
  });
  await repository.createAnalysisRun({
    id: runId, projectId, mode: "existing-data", status: "queued", createdBy: actorUserId,
    dataCutoffAt: CREATED_AT, idempotencyScope: `queue-recovery:${runId}`,
    idempotencyKey: "create", createdAt: CREATED_AT, updatedAt: CREATED_AT,
  });
  const fingerprint = hash("f");
  const queue = (queuedAt: string, executionFingerprint = fingerprint) => repository.transaction(() =>
    repository.manualAlexaVoc.queueNormalizationInput({
      actorUserId, actorOrganizationId: organizationId, projectId, runId,
      marketplace: "US", asin: ASIN, snapshotId: randomUUID(), stageId: randomUUID(),
      jobId: randomUUID(), rawReportSha256: hash("e"), plaintextBytes: 8,
      executionFingerprint,
      executionIdentity: {
        providerName: "openai:responses-strict",
        model: { name: "gpt-test", estimatedInputTokens: 100, maxOutputTokens: 200,
          timeoutMs: 1_000, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
      },
      envelope: {
        algVersion: "AES-256-GCM/v1", keyId: "normalization-test", wrappedDek: "AA",
        nonce: "AA", ciphertext: "AA", tag: "AA", aadSha256: hash("a"),
        plaintextBytes: 8, plaintextSha256: hash("e"),
      },
      queuedAt,
    }));
  const first = await queue(CREATED_AT);
  await pool.query(
    `UPDATE job_attempts
        SET status = 'failed', max_attempts = attempt_number, retryable = TRUE,
            retry_scheduled_at = NULL
      WHERE id = $1`,
    [first.jobId],
  );
  const readStatus = () => repository.manualAlexaVoc.listNormalizationStatuses({
    actorOrganizationId: organizationId, projectId, runId, marketplace: "US", asins: [ASIN],
  });
  assert.deepEqual((await readStatus())[0], {
    asin: ASIN, fingerprint, status: "failure", revision: null, error: "persistence",
  });
  await repository.transaction(() => repository.manualAlexaVoc.putNormalizationTerminal({
    snapshotId: first.snapshot.id, runId, jobAttemptId: first.jobId, agentRunId: null,
    asin: ASIN, executionFingerprint: fingerprint, status: "failure",
    category: "model-output", completedAt: addMilliseconds(CREATED_AT, 1),
  }));
  await pool.query("UPDATE job_attempts SET error_json = $1::jsonb WHERE id = $2", [
    JSON.stringify({ code: "QUEUE_TIMEOUT", message: "fixture deadline" }), first.jobId,
  ]);
  assert.equal((await readStatus())[0]?.error, "model-output", "an existing ASIN terminal keeps its actual failure category");
  const replacement = await queue(addMilliseconds(CREATED_AT, 1));
  assert.equal(replacement.jobCreated, true);
  assert.notEqual(replacement.jobId, first.jobId);
  assert.equal((await readStatus())[0]?.status, "pending");

  const claimInput = {
    ownerId: "normalizer", stage: "alexa-voc-normalization",
    claimedAt: addMilliseconds(CREATED_AT, 2), leaseDurationMs: 60_000,
  } as const;
  assert.equal(await repository.claimNextJob(claimInput), null);
  const claimed = await repository.claimNextJob(claimInput);
  assert.equal(claimed?.id, replacement.jobId);
  const skill = await repository.registerSkillVersion({
    id: randomUUID(), skillId: ALEXA_VOC_NORMALIZATION_SKILL.id,
    version: ALEXA_VOC_NORMALIZATION_SKILL.version,
    contentHash: ALEXA_VOC_NORMALIZATION_SKILL.contentHash,
    manifest: {
      ...ALEXA_VOC_NORMALIZATION_SKILL, entry: "SKILL.md",
      allowedReferences: ["references/examples.md", "references/matrix-format.md"],
      inputSchema: "AlexaVocNormalizationInput@1.0.0",
      outputSchema: "AlexaVocNormalizationOutput@1.0.0",
      fixtures: ["alexa-voc-normalization-complete-v1"],
    }, createdAt: CREATED_AT,
  });
  const agentRunId = randomUUID();
  const claimToken = randomUUID();
  await repository.beginAgentRun({
    id: agentRunId, organizationId, runId, stageId: replacement.stageId,
    jobAttemptId: replacement.jobId, skillVersionId: skill.id,
    snapshotIds: [replacement.snapshot.id], executionFingerprint: fingerprint,
    outputSchemaDigest: hash("d"), provider: "openai", model: "gpt-5",
    inputSummary: { contentHash: fingerprint, recordCount: 1 },
    outputSchemaVersion: "1.0.0", dataCutoffAt: CREATED_AT,
    startedAt: addMilliseconds(CREATED_AT, 2), leaseOwnerId: "normalizer",
    leaseGeneration: claimed!.leaseGeneration, claimToken,
    claimAcquiredAt: addMilliseconds(CREATED_AT, 2),
    claimExpiresAt: addMilliseconds(CREATED_AT, 60_002),
    logicalExecutionLineage: hash("c"),
    logicalExecutionCycleId: claimed!.logicalExecutionCycleId,
  });
  await repository.finalizeAgentRun({
    agentRunId, organizationId, leaseOwnerId: "normalizer",
    leaseGeneration: claimed!.leaseGeneration, claimToken,
    completedAt: addMilliseconds(CREATED_AT, 3),
    outcome: {
      terminalStatus: "succeeded", validationStatus: "passed", responseId: "resp_recovery",
      output: { schemaVersion: "1.0.0", kind: "alexa-voc-normalization-result" },
      error: null, inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1,
      durationMs: 1, attemptCount: 1, usageCompleteness: "complete",
      attempts: [{ ordinal: 0, kind: "initial", transientRetryCount: 0,
        formatRepair: false, accounting: "settled", errorClassification: null }],
      terminalMetadata: { kind: "succeeded" },
    },
  });
  await pool.query(
    `UPDATE job_attempts
        SET status = 'failed', max_attempts = attempt_number, retryable = TRUE,
            retry_scheduled_at = NULL, leased_by = NULL, lease_expires_at = NULL
      WHERE id = $1`,
    [replacement.jobId],
  );
  const durableRecovery = await queue(addMilliseconds(CREATED_AT, 4));
  assert.equal(durableRecovery.jobCreated, false);
  assert.equal(durableRecovery.jobId, replacement.jobId);
  assert.equal((await readStatus())[0]?.status, "pending");

  await pool.query(
    `INSERT INTO job_attempts (
       id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
       logical_execution_cycle_id, status, available_at, lease_generation,
       retryable, retry_scheduled_at, created_at, updated_at
     ) VALUES ($1, $2, 3, 3, 3, $3, 'failed', $4, 0, FALSE, NULL, $4, $4)`,
    [randomUUID(), replacement.stageId, hash("b"), addMilliseconds(CREATED_AT, 5)],
  );
  assert.deepEqual((await readStatus())[0], {
    asin: ASIN, fingerprint, status: "pending", revision: null, error: null,
  }, "an unowned sibling attempt cannot replace this input's durable recovery status");
  assert.deepEqual(await repository.manualAlexaVoc.listNormalizationStatuses({
    actorOrganizationId: randomUUID(), projectId, runId, marketplace: "US", asins: [ASIN],
  }), []);
  const newFingerprint = hash("a");
  const fresh = await queue(addMilliseconds(CREATED_AT, 6), newFingerprint);
  assert.equal(fresh.jobCreated, true);
  assert.deepEqual((await readStatus())[0], {
    asin: ASIN, fingerprint: newFingerprint, status: "pending", revision: null, error: null,
  });
});

test("deduplicates only the current hash and repairs missing or failed outbox work", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    marker: "first",
    rawSeed: 1,
  });

  await pool.query(
    `DELETE FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  const repairedMissing = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    marker: "ignored",
    rawSeed: 8,
  });
  assert.deepEqual(
    [repairedMissing.record.revision, repairedMissing.idempotent, repairedMissing.publication.status],
    ["1", true, "pending"],
  );
  assert.deepEqual(repairedMissing.record.normalizedRecord, first.record.normalizedRecord);

  await pool.query(
    `UPDATE manual_alexa_voc_publication_outbox
        SET status = 'failed', last_error_json = '{"code":"fixture"}'::jsonb
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  const repairedFailed = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 9,
  });
  assert.equal(repairedFailed.publication.status, "pending");
  const outbox = await pool.query<{
    status: string;
    leased_by: string | null;
    lease_expires_at: Date | null;
    last_error_json: unknown;
    applied_at: Date | null;
  }>(
    `SELECT status, leased_by, lease_expires_at, last_error_json, applied_at
       FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.deepEqual(outbox.rows[0], {
    status: "pending",
    leased_by: null,
    lease_expires_at: null,
    last_error_json: null,
    applied_at: null,
  });

  const second = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("b"),
    marker: "second",
    rawSeed: 2,
  });
  const rollbackHash = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    marker: "third",
    rawSeed: 3,
  });
  assert.deepEqual([second.record.revision, rollbackHash.record.revision], ["2", "3"]);
  assert.equal(rollbackHash.idempotent, false);
});

test("uses clock_timestamp Z serialization, cutoff ordering, and bigint text revisions", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const clock = await repository.transaction(() =>
    repository.manualAlexaVoc.readDatabaseClock(),
  );
  assert.match(clock, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(clock).toISOString(), clock);

  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 1,
  });
  const second = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("b"),
    rawSeed: 2,
  });
  assert.deepEqual(
    (await repository.manualAlexaVoc.listAtCutoff({
      organizationId,
      marketplace: "US",
      asins: [ASIN],
      dataCutoffAt: first.record.capturedAt,
    })).map((record) => record.revision),
    ["1"],
  );
  assert.equal(
    (await repository.manualAlexaVoc.getCurrent({
      organizationId,
      marketplace: "US",
      asin: ASIN,
    }))?.revision,
    second.record.revision,
  );

  const largeRevision = "9007199254740993";
  await pool.query(
    `INSERT INTO manual_alexa_voc_revisions (
       organization_id, marketplace, asin, revision, content_hash, captured_at,
       normalized_record, normalized_schema_version, parser_version,
       raw_report_sha256, raw_report_alg_version, raw_report_key_id,
       raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
       raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
       created_by, created_at
     ) VALUES ($1, 'US', $2, $3::bigint, $4, $5::timestamptz, $6::jsonb, $7, $8,
               $9, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, $10, $5::timestamptz)`,
    [
      organizationId,
      OTHER_ASIN,
      largeRevision,
      hash("c"),
      CREATED_AT,
      JSON.stringify(normalizedRecord(OTHER_ASIN, "large")),
      NORMALIZED_SCHEMA_VERSION,
      PARSER_VERSION,
      hash("d"),
      actor,
    ],
  );
  await pool.query(
    `INSERT INTO manual_alexa_voc_heads (
       organization_id, marketplace, asin, latest_revision,
       latest_content_hash, latest_captured_at, generation, updated_at
     ) VALUES ($1, 'US', $2, $3::bigint, $4, $5::timestamptz, 1, $5::timestamptz)`,
    [organizationId, OTHER_ASIN, largeRevision, hash("c"), CREATED_AT],
  );
  const large = await repository.manualAlexaVoc.getCurrent({
    organizationId,
    marketplace: "US",
    asin: OTHER_ASIN,
  });
  assert.equal(large?.revision, largeRevision);
  assert.equal(typeof large?.revision, "string");
});

test("real PostgreSQL VOC reader is DB-first, tenant-isolated, owner-gated, and never falls back on DB errors", async (t) => {
  const { repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const dynamicRecord = normalizedRecord(ASIN, "reader-db");
  const dynamicWrite = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: canonicalJsonSha256(dynamicRecord),
    marker: "reader-db",
  });
  const cutoff = await repository.transaction(() =>
    repository.manualAlexaVoc.readDatabaseClock()
  );
  const legacyRecord = normalizedRecord(OTHER_ASIN, "reader-legacy");
  const legacyRecords = {
    [OTHER_ASIN]: {
      revision: "7",
      contentHash: canonicalJsonSha256(legacyRecord),
      capturedAt: dynamicWrite.record.capturedAt,
      generation: "1",
    },
  };
  let legacyDataLoads = 0;
  const legacySource = new LegacyManualAlexaVocSource({
    loadManifest: async () => ({
      schemaVersion: LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
      ownerOrganizationId: organizationId,
      marketplace: "US",
      artifactGeneration: "1",
      sourceHeadsHash: canonicalJsonSha256(legacyRecords),
      generatedAt: dynamicWrite.record.capturedAt,
      bindingAuditId: "70000000-0000-4000-8000-000000000031",
      bindingActorUserId: actor,
      records: legacyRecords,
    }),
    loadLegacyData: async () => {
      legacyDataLoads += 1;
      return {
        artifactGeneration: "1",
        capturedAt: dynamicWrite.record.capturedAt,
        marketplace: "US",
        data: { [OTHER_ASIN]: legacyRecord },
      };
    },
  });
  const emptyReviewSources = {
    sorftime: { meta: { marketplace: "US" }, data: {} },
    sellerSprite: { meta: { marketplace: "US" }, data: {} },
  };
  const reader = new RepositoryVocSourceReader({
    manualVoc: repository.manualAlexaVoc,
    legacySource,
    reviewSources: emptyReviewSources,
  });

  await withLegacyDefaultOrganization(organizationId, async () => {
    const selected = await reader.read({
      organizationId,
      marketplace: "US",
      asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
      dataCutoffAt: cutoff,
    });
    assert.deepEqual(
      selected.candidate?.payload.records.alexaVoc.map(record => record.asin),
      [ASIN, OTHER_ASIN],
    );
    assert.deepEqual(
      selected.candidate?.sources[0]?.recordProvenance?.map(provenance => ({
        asin: provenance.asin,
        revision: provenance.revision,
        source: provenance.source,
        generation: provenance.generation,
      })),
      [
        {
          asin: ASIN,
          revision: dynamicWrite.record.revision,
          source: "repository",
          generation: null,
        },
        {
          asin: OTHER_ASIN,
          revision: "7",
          source: "legacy-static-stale",
          generation: "1",
        },
      ],
    );
    assert.equal(legacyDataLoads, 1);
    assert.ok(selected.missingSources.some(missing =>
      missing.sourceId === "alexa-voc" &&
      missing.asin === THIRD_ASIN &&
      missing.reason === "not-found"
    ));

    const crossOrganization = await reader.read({
      organizationId: otherOrganizationId,
      marketplace: "US",
      asins: [ASIN, OTHER_ASIN],
      dataCutoffAt: cutoff,
    });
    assert.equal(crossOrganization.candidate, null);
    assert.equal(legacyDataLoads, 1);

    await repository.close();
    await assert.rejects(
      reader.read({
        organizationId,
        marketplace: "US",
        asins: [OTHER_ASIN],
        dataCutoffAt: cutoff,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManualAlexaVocRepositoryError);
        assert.equal(error.kind, "connection");
        return true;
      },
    );
    assert.equal(legacyDataLoads, 1);
  });
});

test("local VOC route maps a real PostgreSQL reader failure to a safe 503", async (t) => {
  const { repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const origin = "http://127.0.0.1:31900";
  const token = "postgres-reader-route-token";
  const app = buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: token,
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_TRUSTED_ORIGINS: origin,
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
      AGENT_VOC_LOCAL_ORIGIN: origin,
      AGENT_VOC_LOCAL_FAKE: "1",
    },
    repository,
    executionContext: { actorId, organizationId },
    storageAvailable: true,
    openaiCapability: { configured: true, available: true, reason: null },
  });
  t.after(() => app.close());
  await repository.close();

  const response = await app.inject({
    method: "POST",
    url: "/v1/local-voc",
    headers: {
      origin,
      "x-agent-proxy-token": token,
      "content-type": "application/json",
    },
    payload: { asins: [ASIN, OTHER_ASIN, THIRD_ASIN], marketplace: "US" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "INFRASTRUCTURE_ERROR");
  assert.doesNotMatch(
    response.body,
    /postgres|connection|string|closed|reader-route-token/i,
  );
});

test("sorts two-ASIN advisory locks and completes opposite-order transactions without deadlock", async (t) => {
  const schema = await createSchema();
  const first = openRepository(t, schema);
  const second = openRepository(t, schema);
  const organizationId = randomUUID();
  const actor = await seedUser(first.repository, organizationId);

  await Promise.all([
    first.repository.transaction(async () => {
      await first.repository.manualAlexaVoc.lockScopes({
        organizationId,
        marketplace: "US",
        asins: [OTHER_ASIN, ASIN],
      });
      await first.repository.manualAlexaVoc.put(putInput({
        organizationId,
        createdBy: actor,
        asin: ASIN,
        expectedRevision: "1",
        contentHash: hash("a"),
        rawSeed: 1,
      }));
    }),
    second.repository.transaction(async () => {
      await second.repository.manualAlexaVoc.lockScopes({
        organizationId,
        marketplace: "US",
        asins: [ASIN, OTHER_ASIN],
      });
      await second.repository.manualAlexaVoc.put(putInput({
        organizationId,
        createdBy: actor,
        asin: OTHER_ASIN,
        expectedRevision: "1",
        contentHash: hash("b"),
        rawSeed: 2,
      }));
    }),
  ]);
  assert.deepEqual(
    (await first.repository.manualAlexaVoc.listCurrent({
      organizationId,
      marketplace: "US",
      asins: [OTHER_ASIN, ASIN],
    })).map((record) => record.asin),
    [ASIN, OTHER_ASIN],
  );

  const lockKeys: string[] = [];
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(text: string, values?: unknown[]) {
      if (text.includes("pg_advisory_xact_lock")) {
        lockKeys.push(Buffer.from(values?.[0] as Uint8Array).toString("utf8"));
      }
      return queryResult<Row>([]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  };
  const store = new PostgresManualAlexaVocStore(executor);
  await store.transaction(() => store.lockScopes({
    organizationId,
    marketplace: "US",
    asins: [OTHER_ASIN, ASIN],
  }));
  assert.deepEqual(lockKeys, [
    `manual-voc\0${organizationId}\0US\0${ASIN}`,
    `manual-voc\0${organizationId}\0US\0${OTHER_ASIN}`,
  ]);
});

test("requires scoped locks, rolls back atomically, enforces head CAS, and rejects cross-tenant actors", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const actorA = await seedUser(repository, organizationA);
  const actorB = await seedUser(repository, organizationB);
  const disabledActor = await seedUser(repository, organizationA, "disabled");
  const scope = { organizationId: organizationA, marketplace: "US" as const, asin: ASIN };

  await expectRepositoryError(repository.manualAlexaVoc.peekNextRevision(scope), "conflict");
  await expectRepositoryError(
    repository.transaction(() => repository.manualAlexaVoc.put(putInput({
      organizationId: organizationA,
      createdBy: actorA,
      expectedRevision: "1",
      contentHash: hash("a"),
    }))),
    "conflict",
  );
  await assert.rejects(
    repository.transaction(async () => {
      await repository.manualAlexaVoc.lockScopes({
        organizationId: organizationA,
        marketplace: "US",
        asins: [ASIN],
      });
      await repository.manualAlexaVoc.put(putInput({
        organizationId: organizationA,
        createdBy: actorA,
        expectedRevision: "1",
        contentHash: hash("a"),
      }));
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(await repository.manualAlexaVoc.getCurrent(scope), null);

  await expectRepositoryError(write(repository, {
    organizationId: organizationA,
    createdBy: actorB,
    contentHash: hash("a"),
  }), "permission");
  await expectRepositoryError(write(repository, {
    organizationId: organizationA,
    createdBy: disabledActor,
    contentHash: hash("a"),
  }), "permission");
  const first = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("a"),
  });
  await expectRepositoryError(write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("b"),
    expectedRevision: "9",
    rawSeed: 2,
  }), "conflict");
  assert.equal((await repository.manualAlexaVoc.getCurrent(scope))?.revision, first.record.revision);
  await assert.rejects(
    pool.query(
      `UPDATE manual_alexa_voc_heads SET latest_content_hash = $1
        WHERE organization_id = $2 AND marketplace = 'US' AND asin = $3`,
      [hash("f"), organizationA, ASIN],
    ),
    (error: unknown) => (error as { code?: string }).code === "23503",
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_revisions (
         organization_id, marketplace, asin, revision, content_hash, captured_at,
         normalized_record, normalized_schema_version, parser_version,
         raw_report_sha256, raw_report_alg_version, raw_report_key_id,
         raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
         raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
         created_by, created_at
       ) VALUES ($1, 'US', $2, 1, $3, $4::timestamptz, $5::jsonb, $6, $7,
                 $8, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, $9, $4::timestamptz)`,
      [
        organizationA,
        OTHER_ASIN,
        hash("b"),
        CREATED_AT,
        JSON.stringify(normalizedRecord(OTHER_ASIN, "foreign-actor")),
        NORMALIZED_SCHEMA_VERSION,
        PARSER_VERSION,
        hash("c"),
        actorB,
      ],
    ),
    (error: unknown) => (error as { code?: string }).code === "23503",
  );
});

test("maps SQLSTATE and deserialize failures without converting them into missing results", async () => {
  const scope = { organizationId: randomUUID(), marketplace: "US" as const, asin: ASIN };
  for (const [code, kind] of [
    ["ECONNRESET", "connection"],
    ["08006", "connection"],
    ["57014", "timeout"],
    ["42501", "permission"],
    ["42P01", "schema"],
    ["42703", "schema"],
    ["23514", "schema"],
  ] as const) {
    const executor = throwingExecutor(code);
    const store = new PostgresManualAlexaVocStore(executor);
    await expectRepositoryError(store.getCurrent(scope), kind);
    await expectRepositoryError(store.listCurrent({ ...scope, asins: [ASIN] }), kind);
  }

  const malformed = new PostgresManualAlexaVocStore({
    async query<Row extends QueryResultRow>() {
      return queryResult<Row>([{
        organization_id: scope.organizationId,
        marketplace: "US",
        asin: ASIN,
        revision: "1",
        content_hash: hash("a"),
        captured_at: new Date(CREATED_AT),
        normalized_record: {},
        normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
        parser_version: PARSER_VERSION,
      } as unknown as Row]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  });
  await expectRepositoryError(malformed.getCurrent(scope), "deserialize");

  const empty = new PostgresManualAlexaVocStore({
    async query<Row extends QueryResultRow>() {
      return queryResult<Row>([]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  });
  assert.equal(await empty.getCurrent(scope), null);
  assert.deepEqual(await empty.listCurrent({ ...scope, asins: [ASIN] }), []);
});

test("queries committed normalization reuse through successful latest-skill agent runs", async () => {
  const organizationId = randomUUID();
  const executionFingerprint = hash("f");
  const captured: Array<Readonly<{ text: string; values: readonly unknown[] }>> = [];
  const expected = normalizedRecord(ASIN, "committed-normalization");
  const store = new PostgresManualAlexaVocStore({
    async query<Row extends QueryResultRow>(text: string, values: unknown[] = []) {
      captured.push({ text, values });
      return queryResult<Row>([{
        organization_id: organizationId,
        marketplace: "US",
        asin: ASIN,
        revision: "7",
        content_hash: executionFingerprint,
        captured_at: new Date(CREATED_AT),
        normalized_record: expected,
        normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
        parser_version: PARSER_VERSION,
        agent_run_id: randomUUID(),
      } as unknown as Row]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  });

  const reused = await store.findCommittedNormalizationByFingerprint({
    actorOrganizationId: organizationId,
    marketplace: "US",
    asin: ASIN,
    executionFingerprint,
  });

  assert.equal(reused?.revision, "7");
  assert.equal(reused?.contentHash, executionFingerprint);
  const query = captured[0];
  assert.ok(query);
  assert.match(query.text, /agent_run\.validation_status = 'passed'/);
  assert.match(query.text, /agent_run\.terminal_status = 'succeeded'/);
  assert.match(query.text, /snapshot\.snapshot_kind = 'alexa-voc-normalization-input'/);
  assert.match(query.text, /JOIN agent_run_snapshots/);
  assert.deepEqual(query.values, [
    organizationId,
    "US",
    JSON.stringify([ASIN]),
    executionFingerprint,
    null,
    ALEXA_VOC_NORMALIZATION_SKILL.id,
    ALEXA_VOC_NORMALIZATION_SKILL.version,
    ALEXA_VOC_NORMALIZATION_SKILL.contentHash,
  ]);
});

test("maps exhausted revision and head uniqueness conflicts separately from constraint drift", async () => {
  const scope = { organizationId: randomUUID(), marketplace: "US" as const, asin: ASIN };
  for (const constraint of [
    "manual_alexa_voc_revisions_pkey",
    "manual_alexa_voc_heads_pkey",
  ]) {
    const store = new PostgresManualAlexaVocStore(
      throwingExecutor("23505", constraint),
    );
    await expectRepositoryError(store.getCurrent(scope), "conflict");
  }
  await expectRepositoryError(
    new PostgresManualAlexaVocStore(
      throwingExecutor("23505", "unexpected_unique_constraint"),
    ).getCurrent(scope),
    "schema",
  );
});

test("rolls back and replays the complete callback once after a real first-write 23505", async (t) => {
  for (const collision of [
    { label: "same hash", writerHash: hash("a"), requestedHash: hash("a") },
    { label: "different hash", writerHash: hash("a"), requestedHash: hash("b") },
  ]) {
    const { pool, repository } = openRepository(t, await createSchema());
    const organizationId = randomUUID();
    const actor = await seedUser(repository, organizationId);
    const writer = await pool.connect();
    let writerFinished = false;
    try {
      await writer.query("BEGIN");
      await insertNonCooperativeRevision({
        client: writer,
        organizationId,
        actor,
        contentHash: collision.writerHash,
        capturedAt: CREATED_AT,
        includeHead: true,
      });

      let callbackAttempts = 0;
      const callbackProjectIds: string[] = [];
      const operation = repository.transaction(async () => {
        callbackAttempts += 1;
        const callbackProjectId = randomUUID();
        callbackProjectIds.push(callbackProjectId);
        await repository.createProject({
          id: callbackProjectId,
          organizationId,
          name: `First-write retry ${collision.label}`,
          marketplace: "US",
          asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
          createdBy: actor,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        });
        await repository.manualAlexaVoc.lockScopes({
          organizationId,
          marketplace: "US",
          asins: [ASIN],
        });
        const expectedRevision = await repository.manualAlexaVoc.peekNextRevision({
          organizationId,
          marketplace: "US",
          asin: ASIN,
        });
        return repository.manualAlexaVoc.put(putInput({
          organizationId,
          createdBy: actor,
          expectedRevision,
          contentHash: collision.requestedHash,
          marker: collision.label,
          rawSeed: 2,
        }));
      });
      await waitForBlockedRevisionInsert();
      await writer.query("COMMIT");
      writerFinished = true;

      const result = await withTimeout(operation);
      assert.equal(callbackAttempts, 2, collision.label);
      const callbackWrites = await pool.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = ANY($1::text[]) ORDER BY id`,
        [callbackProjectIds],
      );
      assert.deepEqual(
        callbackWrites.rows.map(({ id }) => id),
        [callbackProjectIds[1]!],
      );
      assert.equal(result.idempotent, collision.writerHash === collision.requestedHash);
      assert.equal(
        result.record.revision,
        collision.writerHash === collision.requestedHash ? "1" : "2",
      );
      const persisted = await pool.query<{
        revision: string;
        content_hash: string;
      }>(
        `SELECT revision::text AS revision, content_hash
           FROM manual_alexa_voc_revisions
          WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2
          ORDER BY revision`,
        [organizationId, ASIN],
      );
      assert.deepEqual(
        persisted.rows.map(({ revision, content_hash: contentHash }) => ({
          revision,
          contentHash,
        })),
        collision.writerHash === collision.requestedHash
          ? [{ revision: "1", contentHash: hash("a") }]
          : [
            { revision: "1", contentHash: hash("a") },
            { revision: "2", contentHash: hash("b") },
          ],
      );
      const outbox = await pool.query<{ count: string; content_hash: string }>(
        `SELECT count(*)::text AS count, min(content_hash)::text AS content_hash
           FROM manual_alexa_voc_publication_outbox
          WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
        [organizationId, ASIN],
      );
      assert.deepEqual(outbox.rows[0], {
        count: "1",
        content_hash: collision.requestedHash,
      });
    } finally {
      if (!writerFinished) await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
  }
});

test("turns a second real first-write 23505 into a typed conflict", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await insertNonCooperativeRevision({
      client: writer,
      organizationId,
      actor,
      contentHash: hash("a"),
      capturedAt: CREATED_AT,
      includeHead: false,
    });
    await writer.query("COMMIT");
  } finally {
    writer.release();
  }

  let callbackAttempts = 0;
  await expectRepositoryError(repository.transaction(async () => {
    callbackAttempts += 1;
    await repository.manualAlexaVoc.lockScopes({
      organizationId,
      marketplace: "US",
      asins: [ASIN],
    });
    return repository.manualAlexaVoc.put(putInput({
      organizationId,
      createdBy: actor,
      expectedRevision: "1",
      contentHash: hash("b"),
    }));
  }), "conflict");
  assert.equal(callbackAttempts, 2);
});

test("leases, fails, retries, applies, and reconciles publication work", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const leasedAt = addMilliseconds(first.record.capturedAt, 1_000);
  const firstLease: ManualAlexaVocOutboxLease | null =
    await repository.manualAlexaVoc.leasePublication({
      ownerId: "publisher-a",
      leasedAt,
      leaseDurationMs: 60_000,
    });
  assert.ok(firstLease);
  assert.deepEqual(
    [firstLease.organizationId, firstLease.asin, firstLease.revision, firstLease.generation, firstLease.leaseGeneration, firstLease.leaseOwner],
    [organizationId, ASIN, "1", "1", "1", "publisher-a"],
  );

  const failedAt = addMilliseconds(leasedAt, 1_000);
  const nextAttemptAt = addMilliseconds(failedAt, 10_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt,
    nextAttemptAt,
    errorCode: "PROJECTION_WRITE_FAILED",
  });
  assert.equal(await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: addMilliseconds(nextAttemptAt, -1),
    leaseDurationMs: 60_000,
  }), null);
  const retryLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: nextAttemptAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(retryLease);
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...firstLease,
    appliedAt: addMilliseconds(nextAttemptAt, 1_000),
  }), "conflict");
  const appliedAt = addMilliseconds(nextAttemptAt, 2_000);
  await repository.manualAlexaVoc.markPublicationApplied({ ...retryLease, appliedAt });
  const applied = await pool.query<{
    status: string;
    attempt_count: number;
    leased_by: string | null;
    lease_expires_at: Date | null;
    last_error_json: unknown;
    applied_at: Date;
  }>(
    `SELECT status, attempt_count, leased_by, lease_expires_at,
            last_error_json, applied_at
       FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.equal(applied.rows[0]?.status, "applied");
  assert.equal(applied.rows[0]?.attempt_count, 2);
  assert.equal(applied.rows[0]?.leased_by, null);
  assert.equal(applied.rows[0]?.lease_expires_at, null);
  assert.equal(applied.rows[0]?.last_error_json, null);
  assert.equal(applied.rows[0]?.applied_at.toISOString(), appliedAt);

  await pool.query(
    `DELETE FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  const reconciledAt = addMilliseconds(appliedAt, 1_000);
  assert.equal(await repository.manualAlexaVoc.reconcilePublication({ reconciledAt }), 1);
  assert.equal((await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-c",
    leasedAt: reconciledAt,
    leaseDurationMs: 60_000,
  }))?.revision, "1");
});

test("fences publication completion by lease generation, owner, and database expiry", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const leasedAt = addMilliseconds(first.record.capturedAt, 1_000);
  const firstLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-a",
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(firstLease);
  assert.equal(firstLease.leaseGeneration, "1");
  const firstFailedAt = addMilliseconds(leasedAt, 1_000);
  const firstRetryAt = addMilliseconds(firstFailedAt, 1_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt: firstFailedAt,
    nextAttemptAt: firstRetryAt,
    errorCode: "RETRY",
  });

  const sameOwnerReplacement = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-a",
    leasedAt: firstRetryAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(sameOwnerReplacement);
  assert.equal(sameOwnerReplacement.leaseGeneration, "2");
  const abaLease = {
    ...sameOwnerReplacement,
    leaseGeneration: firstLease.leaseGeneration,
  };
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...abaLease,
    appliedAt: addMilliseconds(firstRetryAt, 1_000),
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...abaLease,
    failedAt: addMilliseconds(firstRetryAt, 1_000),
    nextAttemptAt: addMilliseconds(firstRetryAt, 2_000),
    errorCode: "ABA",
  }), "conflict");

  const secondFailedAt = addMilliseconds(firstRetryAt, 2_000);
  const secondRetryAt = addMilliseconds(secondFailedAt, 1_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...sameOwnerReplacement,
    failedAt: secondFailedAt,
    nextAttemptAt: secondRetryAt,
    errorCode: "REPLACE_OWNER",
  });
  const replacementOwner = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: secondRetryAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(replacementOwner);
  assert.equal(replacementOwner.leaseGeneration, "3");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...sameOwnerReplacement,
    appliedAt: addMilliseconds(secondRetryAt, 1_000),
  }), "conflict");
  const afterReplacementExpiry = addMilliseconds(
    replacementOwner.leaseExpiresAt,
    1,
  );
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...replacementOwner,
    appliedAt: afterReplacementExpiry,
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...replacementOwner,
    failedAt: afterReplacementExpiry,
    nextAttemptAt: afterReplacementExpiry,
    errorCode: "LATE_TERMINAL_TIMESTAMP",
  }), "conflict");

  const expired = await pool.query<{ lease_expires_at: Date }>(
    `UPDATE manual_alexa_voc_publication_outbox
        SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2
    RETURNING lease_expires_at`,
    [organizationId, ASIN],
  );
  const expiredLease = {
    ...replacementOwner,
    leaseExpiresAt: expired.rows[0]!.lease_expires_at.toISOString(),
  };
  const backdatedAt = addMilliseconds(expiredLease.leaseExpiresAt, -1_000);
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...expiredLease,
    appliedAt: backdatedAt,
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...expiredLease,
    failedAt: backdatedAt,
    nextAttemptAt: backdatedAt,
    errorCode: "BACKDATED",
  }), "conflict");

  const stored = await pool.query<{ status: string; lease_generation: string }>(
    `SELECT status, lease_generation::text AS lease_generation
       FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.deepEqual(stored.rows[0], { status: "leased", lease_generation: "3" });
});

test("preserves monotonic lease generation through same-hash failed outbox repair", async (t) => {
  const { repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const leasedAt = addMilliseconds(first.record.capturedAt, 1_000);
  const firstLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "stable-publisher",
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(firstLease);
  assert.equal(firstLease.leaseGeneration, "1");
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt: addMilliseconds(leasedAt, 1_000),
    nextAttemptAt: addMilliseconds(leasedAt, 2_000),
    errorCode: "REPAIR_ME",
  });

  const repaired = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 2,
  });
  assert.equal(repaired.idempotent, true);
  assert.equal(repaired.publication.status, "pending");
  const secondLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: firstLease.leaseOwner,
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(secondLease);
  assert.equal(secondLease.leaseGeneration, "2");
  assert.equal(secondLease.leaseOwner, firstLease.leaseOwner);
  assert.equal(secondLease.leaseExpiresAt, firstLease.leaseExpiresAt);
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...firstLease,
    appliedAt: addMilliseconds(leasedAt, 3_000),
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt: addMilliseconds(leasedAt, 3_000),
    nextAttemptAt: addMilliseconds(leasedAt, 3_000),
    errorCode: "STALE_AFTER_REPAIR",
  }), "conflict");

  await repository.manualAlexaVoc.markPublicationFailed({
    ...secondLease,
    failedAt: addMilliseconds(leasedAt, 4_000),
    nextAttemptAt: addMilliseconds(leasedAt, 5_000),
    errorCode: "REPAIR_AGAIN",
  });
  await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 3,
  });
  const thirdLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: firstLease.leaseOwner,
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(thirdLease);
  assert.equal(thirdLease.leaseGeneration, "3");
  assert.equal(thirdLease.leaseExpiresAt, firstLease.leaseExpiresAt);
});

test("records access audit and clears expired raw envelopes transactionally", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 4,
  });
  const occurredAt = addMilliseconds(first.record.capturedAt, 1_000);
  await repository.transaction(() => repository.manualAlexaVoc.recordRawAccess({
    id: randomUUID(),
    organizationId,
    marketplace: "US",
    asin: ASIN,
    revision: "1",
    actorUserId: actor,
    purpose: "decrypt",
    occurredAt,
    result: "succeeded",
  }));
  const before = addMilliseconds(first.record.capturedAt, 2_000);
  const clearedAt = addMilliseconds(first.record.capturedAt, 3_000);
  assert.equal(await repository.transaction(() => repository.manualAlexaVoc.clearExpiredRaw({
    organizationId,
    before,
    clearedAt,
    actorUserId: actor,
  })), 1);
  assert.equal(await repository.transaction(() => repository.manualAlexaVoc.clearExpiredRaw({
    organizationId,
    before,
    clearedAt: addMilliseconds(clearedAt, 1_000),
    actorUserId: actor,
  })), 0);

  const stored = await pool.query<Record<string, unknown>>(
    `SELECT normalized_record, raw_report_sha256, raw_report_plaintext_bytes,
            raw_report_alg_version, raw_report_key_id, raw_report_wrapped_dek,
            raw_report_nonce, raw_report_ciphertext, raw_report_tag,
            raw_report_aad_sha256
       FROM manual_alexa_voc_revisions
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.deepEqual(stored.rows[0]?.normalized_record, first.record.normalizedRecord);
  assert.equal(stored.rows[0]?.raw_report_sha256, hash("e"));
  assert.equal(stored.rows[0]?.raw_report_plaintext_bytes, 4);
  for (const key of [
    "raw_report_alg_version",
    "raw_report_key_id",
    "raw_report_wrapped_dek",
    "raw_report_nonce",
    "raw_report_ciphertext",
    "raw_report_tag",
    "raw_report_aad_sha256",
  ]) assert.equal(stored.rows[0]?.[key], null);
  const audit = await pool.query<{ purpose: string; result: string; created_at: Date }>(
    `SELECT purpose, result, created_at
       FROM manual_alexa_voc_access_audit
      WHERE organization_id = $1 ORDER BY created_at`,
    [organizationId],
  );
  assert.deepEqual(audit.rows.map((row) => ({
    purpose: row.purpose,
    result: row.result,
    createdAt: row.created_at.toISOString(),
  })), [
    { purpose: "create", result: "allowed", createdAt: first.record.capturedAt },
    { purpose: "decrypt", result: "allowed", createdAt: occurredAt },
    { purpose: "delete-policy", result: "allowed", createdAt: clearedAt },
  ]);
});

test("claims and completes run creation idempotently in the caller transaction", async (t) => {
  const { repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const projectId = randomUUID();
  const runId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "PostgreSQL run creation fixture",
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    createdBy: actor,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actor,
    dataCutoffAt: CREATED_AT,
    idempotencyScope: `manual-voc-run:${runId}`,
    idempotencyKey: "create",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    dataCutoffAt: CREATED_AT,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: CREATED_AT,
      records: [normalizedRecord()],
    }],
  });
  await repository.createDataSnapshotForRun({
    actorId: actor,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    expectedRunCutoffAt: CREATED_AT,
    candidateId: snapshotId,
    createdAt: CREATED_AT,
    candidate,
  });
  const claim = {
    organizationId,
    idempotencyKey: "run-key",
    fingerprint: hash("f"),
  };
  await repository.transaction(async () => {
    assert.deepEqual(await repository.manualAlexaVoc.claimRunCreation(claim), { kind: "winner" });
    await repository.manualAlexaVoc.completeRunCreation({
      ...claim,
      runId,
      snapshotId,
      completedAt: CREATED_AT,
    });
  });
  await repository.transaction(async () => {
    assert.deepEqual(await repository.manualAlexaVoc.claimRunCreation(claim), {
      kind: "replay",
      runId,
      snapshotId,
    });
    assert.deepEqual(await repository.manualAlexaVoc.claimRunCreation({
      ...claim,
      fingerprint: hash("e"),
    }), { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
  });
});

test("serializes same-fingerprint run creation claims across two connections", async (t) => {
  const schema = await createSchema();
  const first = openRepository(t, schema);
  const second = openRepository(t, schema);
  const organizationId = randomUUID();
  const actor = await seedUser(first.repository, organizationId);
  const projectId = randomUUID();
  await first.repository.createProject({
    id: projectId,
    organizationId,
    name: "Concurrent run claim fixture",
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    createdBy: actor,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const claim = {
    organizationId,
    idempotencyKey: "concurrent-same-key",
    fingerprint: hash("f"),
  };

  const compete = async (repository: PostgresAgentRepository) => {
    const runId = randomUUID();
    const snapshotId = randomUUID();
    return repository.transaction(async () => {
      const result = await repository.manualAlexaVoc.claimRunCreation(claim);
      if (result.kind === "winner") {
        await createRunCreationTarget({
          repository,
          organizationId,
          actor,
          projectId,
          runId,
          snapshotId,
        });
        await repository.manualAlexaVoc.completeRunCreation({
          ...claim,
          runId,
          snapshotId,
          completedAt: CREATED_AT,
        });
      }
      return { result, runId, snapshotId };
    });
  };
  const results = await withTimeout(Promise.all([
    compete(first.repository),
    compete(second.repository),
  ]), 10_000);
  assert.deepEqual(results.map(({ result }) => result.kind).sort(), ["replay", "winner"]);
  const winner = results.find(({ result }) => result.kind === "winner")!;
  const replay = results.find(({ result }) => result.kind === "replay")!.result;
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.deepEqual(
      { runId: replay.runId, snapshotId: replay.snapshotId },
      { runId: winner.runId, snapshotId: winner.snapshotId },
    );
  }
  const persisted = await first.pool.query<{ runs: string; snapshots: string }>(
    `SELECT
       (SELECT count(*)::text FROM analysis_runs WHERE project_id = $1) AS runs,
       (SELECT count(*)::text FROM data_snapshots s
          JOIN analysis_runs r ON r.id = s.run_id WHERE r.project_id = $1) AS snapshots`,
    [projectId],
  );
  assert.deepEqual(persisted.rows[0], { runs: "1", snapshots: "1" });
});

test("returns a typed conflict to a different-fingerprint concurrent claimant", async (t) => {
  const schema = await createSchema();
  const first = openRepository(t, schema);
  const second = openRepository(t, schema);
  const organizationId = randomUUID();
  const actor = await seedUser(first.repository, organizationId);
  const projectId = randomUUID();
  await first.repository.createProject({
    id: projectId,
    organizationId,
    name: "Conflicting run claim fixture",
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    createdBy: actor,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const compete = async (
    repository: PostgresAgentRepository,
    fingerprint: string,
  ) => {
    const claim = {
      organizationId,
      idempotencyKey: "concurrent-different-key",
      fingerprint,
    };
    const runId = randomUUID();
    const snapshotId = randomUUID();
    return repository.transaction(async () => {
      const result = await repository.manualAlexaVoc.claimRunCreation(claim);
      if (result.kind === "winner") {
        await createRunCreationTarget({
          repository,
          organizationId,
          actor,
          projectId,
          runId,
          snapshotId,
        });
        await repository.manualAlexaVoc.completeRunCreation({
          ...claim,
          runId,
          snapshotId,
          completedAt: CREATED_AT,
        });
      }
      return result;
    });
  };
  const results = await withTimeout(Promise.all([
    compete(first.repository, hash("e")),
    compete(second.repository, hash("f")),
  ]), 10_000);
  assert.deepEqual(
    results.map((result) => result.kind).sort(),
    ["conflict", "winner"],
  );
  assert.deepEqual(results.find((result) => result.kind === "conflict"), {
    kind: "conflict",
    code: "IDEMPOTENCY_KEY_REUSED",
  });
  const persisted = await first.pool.query<{ runs: string; snapshots: string }>(
    `SELECT
       (SELECT count(*)::text FROM analysis_runs WHERE project_id = $1) AS runs,
       (SELECT count(*)::text FROM data_snapshots s
          JOIN analysis_runs r ON r.id = s.run_id WHERE r.project_id = $1) AS snapshots`,
    [projectId],
  );
  assert.deepEqual(persisted.rows[0], { runs: "1", snapshots: "1" });
});

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function throwingExecutor(code: string, constraint?: string): PostgresQueryExecutor {
  return {
    async query() {
      throw Object.assign(new Error("typed PostgreSQL fixture"), { code, constraint });
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  };
}

test("four markets persist the same ASIN independently and analysis reads only its site's manual VOC", async t => {
  const schema = await createSchema();
  const { repository, pool } = openRepository(t, schema);
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const markets = ["US", "UK", "DE", "CA"] as const;
  for (const marketplace of markets) {
    const input = {
      ...putInput({ organizationId, createdBy: actor, expectedRevision: "1", contentHash: hash("a"), marker: `${marketplace}-only`, rawSeed: markets.indexOf(marketplace) + 1 }),
      marketplace,
    };
    const write = () => repository.transaction(async () => {
      await repository.manualAlexaVoc.lockScopes({ organizationId, marketplace, asins: [ASIN] });
      return repository.manualAlexaVoc.put(input);
    });
    const first = await write();
    const second = await write();
    assert.equal(first.record.marketplace, marketplace);
    assert.equal(second.idempotent, true);
  }
  let legacyCalls = 0;
  const reader = new RepositoryVocSourceReader({
    manualVoc: repository.manualAlexaVoc,
    legacySource: { readIfEligible: async () => { legacyCalls++; return { status: "missing", reason: "not-found" }; } },
  });
  for (const marketplace of markets) {
    const before = legacyCalls;
    const result = await reader.read({ organizationId, marketplace, asins: [ASIN, OTHER_ASIN], dataCutoffAt: new Date(Date.now() + 1000).toISOString() });
    assert.equal(result.recordCount, 1);
    assert.equal(result.candidate?.marketplace, marketplace);
    const serialized = JSON.stringify(result.candidate);
    assert.ok(serialized.includes(`${marketplace}-only`));
    for (const other of markets.filter(value => value !== marketplace)) {
      assert.equal(serialized.includes(`${other}-only`), false);
    }
    if (marketplace !== "US") assert.equal(legacyCalls, before, "non-US sources must not use legacy US data");
  }
  const counts = await pool.query("SELECT marketplace, count(*)::int AS count FROM manual_alexa_voc_revisions GROUP BY marketplace ORDER BY marketplace");
  assert.deepEqual(counts.rows, [...markets].sort().map(marketplace => ({ marketplace, count: 1 })));
});
