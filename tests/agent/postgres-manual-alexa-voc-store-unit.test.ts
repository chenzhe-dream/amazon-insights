import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import {
  PostgresManualAlexaVocStore,
  type PostgresQueryExecutor,
} from "../../server/db/postgres/manual-alexa-voc-store";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const PROJECT_ID = "10000000-0000-4000-8000-000000000003";
const RUN_ID = "10000000-0000-4000-8000-000000000004";
const SNAPSHOT_ID = "10000000-0000-4000-8000-000000000005";
const STAGE_ID = "10000000-0000-4000-8000-000000000006";
const JOB_ID = "10000000-0000-4000-8000-000000000007";
const ASIN = "B0ALEXA001";
const NOW = "2026-09-01T00:00:00.000Z";

function result<Row extends QueryResultRow>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return { command: "SELECT", rowCount, oid: 0, fields: [], rows };
}

test("PostgreSQL normalization queue uses the dedicated encrypted snapshot and one atomic stage/job path", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const payload = {
    kind: "alexa-voc-normalization-input",
    version: "1.0.0",
    asin: ASIN,
    rawReportSha256: "a".repeat(64),
    plaintextBytes: 19,
    executionFingerprint: "b".repeat(64),
    envelope: {
      algVersion: "AES-256-GCM/v1",
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
  let step = 0;
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      step += 1;
      if (step === 1) return result<Row>([{
        project_id: PROJECT_ID,
        organization_id: ORGANIZATION_ID,
        marketplace: "US",
        asins_json: [ASIN],
        run_id: RUN_ID,
        data_cutoff_at: NOW,
        run_status: "queued",
      } as unknown as Row]);
      if (step === 2) return result<Row>([], 1);
      if (step === 3) return result<Row>([{
        id: SNAPSHOT_ID,
        run_id: RUN_ID,
        marketplace: "US",
        payload_json: payload,
        created_at: NOW,
        project_id: PROJECT_ID,
        organization_id: ORGANIZATION_ID,
      } as unknown as Row]);
      if (step === 5) return result<Row>([{ id: STAGE_ID, status: "queued" } as unknown as Row]);
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
    envelope: payload.envelope,
    queuedAt: NOW,
  }));

  assert.equal(queued.snapshot.id, SNAPSHOT_ID);
  assert.equal(queued.snapshotCreated, true);
  assert.equal(queued.stageId, STAGE_ID);
  assert.equal(queued.jobId, JOB_ID);
  assert.equal(queued.jobCreated, true);
  assert.match(calls[0]!.sql, /projects project[\s\S]*analysis_runs run[\s\S]*FOR UPDATE OF project, run/);
  assert.match(calls[1]!.sql, /alexa-voc-normalization-input/);
  assert.match(calls[4]!.sql, /stage = 'alexa-voc-normalization'/);
  assert.match(calls[5]!.sql, /status IN \('queued', 'running'\)/);
  assert.match(calls[7]!.sql, /INSERT INTO job_attempts/);
  const serializedParameters = JSON.stringify(calls.map(call => call.values));
  assert.doesNotMatch(serializedParameters, /secret Alexa report/);
  assert.match(serializedParameters, /c2VjcmV0/);
});
