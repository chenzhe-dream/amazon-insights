import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import {
  PostgresManualAlexaVocStore,
  type PostgresQueryExecutor,
} from "../../server/db/postgres/manual-alexa-voc-store";
import { ALEXA_VOC_NORMALIZATION_SKILL } from "../../server/domain/voc/alexa-voc-normalization-contracts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const PROJECT_ID = "10000000-0000-4000-8000-000000000003";
const RUN_ID = "10000000-0000-4000-8000-000000000004";
const SNAPSHOT_ID = "10000000-0000-4000-8000-000000000005";
const STAGE_ID = "10000000-0000-4000-8000-000000000006";
const JOB_ID = "10000000-0000-4000-8000-000000000007";
const ASIN = "B0ALEXA001";
const NOW = "2026-09-01T00:00:00.000Z";
const EXECUTION_IDENTITY = {
  providerName: "local-fixture",
  model: {
    name: "fake-model",
    estimatedInputTokens: 100,
    maxOutputTokens: 200,
    timeoutMs: 1_000,
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
  },
} as const;

function result<Row extends QueryResultRow>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return { command: "SELECT", rowCount, oid: 0, fields: [], rows };
}

test("PostgreSQL normalization queue and finalizer helper share run-then-stage locking", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const payload = {
    kind: "alexa-voc-normalization-input",
    version: "1.0.0",
    asin: ASIN,
    rawReportSha256: "a".repeat(64),
    plaintextBytes: 19,
    executionFingerprint: "b".repeat(64),
    executionIdentity: EXECUTION_IDENTITY,
    envelope: {
      algVersion: "AES-256-GCM/v1" as const,
      keyId: "normalization-test",
      wrappedDek: "AA",
      nonce: "AA",
      ciphertext: "c2VjcmV0",
      tag: "AA",
      aadSha256: "c".repeat(64),
      plaintextBytes: 19,
      plaintextSha256: "a".repeat(64),
    },
  };
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (/FROM projects project/.test(sql)) return result<Row>([{
        project_id: PROJECT_ID,
        organization_id: ORGANIZATION_ID,
        marketplace: "US",
        asins_json: [ASIN],
        run_id: RUN_ID,
        data_cutoff_at: NOW,
        run_status: "queued",
      } as unknown as Row]);
      if (/INSERT INTO run_stages/.test(sql)) return result<Row>([], 1);
      if (/SELECT id FROM analysis_runs/.test(sql)) {
        return result<Row>([{ id: RUN_ID } as unknown as Row]);
      }
      if (/SELECT id, status FROM run_stages/.test(sql)) {
        return result<Row>([{ id: STAGE_ID, status: "queued" } as unknown as Row]);
      }
      if (/INSERT INTO data_snapshots/.test(sql)) return result<Row>([], 1);
      if (/SELECT ds\.id, ds\.run_id/.test(sql)) return result<Row>([{
        id: SNAPSHOT_ID,
        run_id: RUN_ID,
        marketplace: "US",
        payload_json: payload,
        created_at: NOW,
        project_id: PROJECT_ID,
        organization_id: ORGANIZATION_ID,
      } as unknown as Row]);
      return result<Row>([]);
    },
    async transaction<Result>(operation: () => Promise<Result>) { return operation(); },
  };
  const store = new PostgresManualAlexaVocStore(executor);
  const queued = await store.transaction(() => store.queueNormalizationInput({
    actorUserId: USER_ID,
    actorOrganizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    marketplace: "US",
    asin: ASIN,
    snapshotId: SNAPSHOT_ID,
    stageId: STAGE_ID,
    jobId: JOB_ID,
    rawReportSha256: payload.rawReportSha256,
    plaintextBytes: payload.plaintextBytes,
    executionFingerprint: payload.executionFingerprint,
    executionIdentity: EXECUTION_IDENTITY,
    envelope: payload.envelope,
    queuedAt: NOW,
  }));

  assert.equal(queued.snapshot.id, SNAPSHOT_ID);
  assert.equal(queued.snapshotCreated, true);
  assert.equal(queued.stageId, STAGE_ID);
  assert.equal(queued.jobId, JOB_ID);
  assert.equal(queued.jobCreated, true);
  assert.match(calls[0]!.sql, /projects project[\s\S]*analysis_runs run[\s\S]*FOR UPDATE OF project, run/);
  const runLockAt = calls.findIndex(({ sql }) =>
    /SELECT id FROM analysis_runs[\s\S]*FOR UPDATE/.test(sql)
  );
  const stageLockAt = calls.findIndex(({ sql }) =>
    /SELECT id, status FROM run_stages[\s\S]*FOR UPDATE/.test(sql)
  );
  const snapshotInsertAt = calls.findIndex(({ sql }) =>
    /INSERT INTO data_snapshots/.test(sql)
  );
  assert.ok(runLockAt >= 0, "queue must explicitly acquire the shared run lock");
  assert.ok(runLockAt < stageLockAt, "queue must lock run before stage");
  assert.ok(stageLockAt < snapshotInsertAt, "queue must lock stage before input insert");
  const activeJobRead = calls.find(({ sql }) =>
    /SELECT attempt\.\* FROM job_attempts attempt/.test(sql)
  );
  assert.ok(activeJobRead);
  assert.match(activeJobRead.sql, /status = 'queued'[\s\S]*status = 'running'/);
  assert.match(activeJobRead.sql, /status = 'failed'[\s\S]*retry_scheduled_at IS NULL/);
  assert.match(activeJobRead.sql, /NOT EXISTS[\s\S]*successor\.retry_cycle_start_attempt = attempt\.retry_cycle_start_attempt[\s\S]*successor\.attempt_number > attempt\.attempt_number/);
  // Durable eligibility is validated from every input by the shared recovery
  // reducer after this candidate read, rather than an EXISTS on any sibling.
  assert.doesNotMatch(activeJobRead.sql, /agent_run\.validation_status/);
  assert.match(activeJobRead.sql, /NOT EXISTS[\s\S]*terminal\.snapshot_id = \$3/);
  assert.deepEqual(activeJobRead.values, [STAGE_ID, true, SNAPSHOT_ID]);
  assert.doesNotMatch(activeJobRead.sql, /FOR UPDATE/);
  assert.ok(calls.some(({ sql }) => /INSERT INTO job_attempts/.test(sql)));

  const finalizerLockStart = calls.length;
  await store.transaction(() => store.lockNormalizationRunAndStage({
    runId: RUN_ID,
  }));
  const finalizerLockCalls = calls.slice(finalizerLockStart);
  const finalizerRunLockAt = finalizerLockCalls.findIndex(({ sql }) =>
    /SELECT id FROM analysis_runs[\s\S]*FOR UPDATE/.test(sql)
  );
  const finalizerStageLockAt = finalizerLockCalls.findIndex(({ sql }) =>
    /SELECT id, status FROM run_stages[\s\S]*FOR UPDATE/.test(sql)
  );
  assert.ok(finalizerRunLockAt >= 0);
  assert.ok(finalizerRunLockAt < finalizerStageLockAt,
    "finalizer helper must lock run before stage");
  assert.doesNotMatch(
    finalizerLockCalls.map(({ sql }) => sql).join("\n"),
    /FROM job_attempts[\s\S]*FOR UPDATE/,
  );
  const serializedParameters = JSON.stringify(calls.map(call => call.values));
  assert.doesNotMatch(serializedParameters, /secret Alexa report/);
  assert.match(serializedParameters, /c2VjcmV0/);
});

test("PostgreSQL successful fingerprint lookup is bounded by the target run cutoff", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return result<Row>([]);
    },
    async transaction<Result>(operation: () => Promise<Result>) { return operation(); },
  };
  const store = new PostgresManualAlexaVocStore(executor);
  assert.equal(await store.findCommittedNormalizationByFingerprint({
    actorOrganizationId: ORGANIZATION_ID,
    marketplace: "US",
    asin: ASIN,
    executionFingerprint: "d".repeat(64),
    dataCutoffAt: NOW,
  }), null);
  assert.match(calls[0]!.sql, /revision\.captured_at <= \$5::timestamptz/);
  assert.match(calls[0]!.sql,
    /NOT EXISTS[\s\S]*authoritative_newer\.captured_at > revision\.captured_at[\s\S]*authoritative_newer\.revision > revision\.revision/,
    "reuse must reject a matching historical fingerprint when a later cutoff-visible revision exists");
  assert.deepEqual(calls[0]!.values, [
    ORGANIZATION_ID,
    "US",
    JSON.stringify([ASIN]),
    "d".repeat(64),
    NOW,
    ALEXA_VOC_NORMALIZATION_SKILL.id,
    ALEXA_VOC_NORMALIZATION_SKILL.version,
    ALEXA_VOC_NORMALIZATION_SKILL.contentHash,
  ]);
});

test("PostgreSQL normalization status query is exact-run scoped and returns only the safe v1 record", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return result<Row>([{
        asin: ASIN,
        execution_fingerprint: "d".repeat(64),
        terminal_status: "success",
        error_category: null,
        retry_pending: false,
        revision: "7",
      } as unknown as Row]);
    },
    async transaction<Result>(operation: () => Promise<Result>) { return operation(); },
  };
  const store = new PostgresManualAlexaVocStore(executor);
  const records = await store.listNormalizationStatuses({
    actorOrganizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    marketplace: "US",
    asins: [ASIN],
  });
  assert.deepEqual(records, [{
    asin: ASIN,
    fingerprint: "d".repeat(64),
    status: "success",
    revision: "7",
    error: null,
  }]);
  assert.match(calls[0]!.sql, /ds\.run_id = \$1 AND project\.id = \$2/);
  assert.match(calls[0]!.sql, /project\.organization_id = \$3/);
  assert.match(calls[0]!.sql, /LATERAL[\s\S]*attempt_number DESC/);
  assert.match(calls[0]!.sql, /newest_attempt\.retry_scheduled_at IS NULL/);
  assert.deepEqual(calls[0]!.values, [RUN_ID, PROJECT_ID, ORGANIZATION_ID, "US", [ASIN]]);
  assert.doesNotMatch(JSON.stringify(records), /rawText|ciphertext|wrappedDek|modelResponse/i);
});

test("normalization configuration failures before model execution are not persistence failures", async () => {
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string) {
      assert.match(sql, /error_json ->> 'classification' AS newest_attempt_error_classification/);
      return result<Row>([{
        asin: ASIN, execution_fingerprint: "d".repeat(64), terminal_status: null,
        newest_attempt_status: "failed", newest_attempt_retryable: false,
        newest_attempt_error_classification: "configuration",
      } as unknown as Row]);
    },
    async transaction<Result>(operation: () => Promise<Result>) { return operation(); },
  };
  const records = await new PostgresManualAlexaVocStore(executor).listNormalizationStatuses({
    actorOrganizationId: ORGANIZATION_ID, projectId: PROJECT_ID, runId: RUN_ID, marketplace: "US", asins: [ASIN],
  });
  assert.equal(records[0]?.error, "configuration");
  assert.equal(records[0]?.status, "failure");
});

test("PostgreSQL normalization status reports a newer active retry as pending", async () => {
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>() {
      return result<Row>([{
        asin: ASIN,
        execution_fingerprint: "d".repeat(64),
        terminal_status: "failure",
        error_category: "model-output",
        retry_pending: true,
        revision: null,
      } as unknown as Row]);
    },
    async transaction<Result>(operation: () => Promise<Result>) { return operation(); },
  };
  const records = await new PostgresManualAlexaVocStore(executor)
    .listNormalizationStatuses({
      actorOrganizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      marketplace: "US",
      asins: [ASIN],
    });
  assert.deepEqual(records, [{
    asin: ASIN,
    fingerprint: "d".repeat(64),
    status: "pending",
    revision: null,
    error: null,
  }]);
});
