import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { selectLatestCumulativeVocSnapshot } from "../../server/runtime/voc-positioning-runtime";

const source = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("0023 scopes model request ordinals and logical agent runs by execution fingerprint", async () => {
  for (const path of [
    "server/db/migrations/0023_alexa_voc_agent_run_budget.sql",
    "server/db/migrations/postgres/0023_alexa_voc_agent_run_budget.sql",
  ]) {
    const sql = await source(path);
    assert.match(sql, /agent_run_id/i);
    assert.match(sql, /agent_run_id\s*,\s*request_ordinal/i);
    assert.match(
      sql,
      /logical_execution_cycle_id\s*,\s*execution_fingerprint/i,
    );
    assert.match(sql, /job_attempt_id\s*,\s*execution_fingerprint/i);
    assert.match(sql, /data_snapshots_semantic_identity_idx[\s\S]*content_hash/i);
    assert.match(sql, /CREATE TABLE alexa_voc_normalization_terminals/i);
  }
  const postgresMigration = await source(
    "server/db/migrations/postgres/0023_alexa_voc_agent_run_budget.sql",
  );
  assert.match(postgresMigration, /snapshot_id\s+TEXT\s+PRIMARY KEY/i);
  assert.match(postgresMigration, /run_id\s+TEXT\s+NOT NULL/i);
  assert.match(postgresMigration, /job_attempt_id\s+TEXT\s+NOT NULL/i);
  assert.match(postgresMigration, /agent_run_id\s+TEXT\s+REFERENCES/i);
  assert.doesNotMatch(postgresMigration, /snapshot_id\s+UUID|agent_run_id\s+UUID/i);

  const postgresStore = await source(
    "server/db/postgres/manual-alexa-voc-store.ts",
  );
  assert.doesNotMatch(postgresStore, /\$4::uuid/);
});

test("queue and finalizer lock the normalization run before its stage", async () => {
  const postgresStore = await source(
    "server/db/postgres/manual-alexa-voc-store.ts",
  );
  assert.match(
    postgresStore,
    /lockNormalizationRunAndStage[\s\S]*SELECT id FROM analysis_runs[\s\S]*FOR UPDATE[\s\S]*stage = 'alexa-voc-normalization'[\s\S]*FOR UPDATE/,
  );
  const queueAt = postgresStore.indexOf("async #queueNormalizationInput");
  const queueRunAndStageLockAt = postgresStore.indexOf(
    "#lockNormalizationRunAndStage",
    queueAt,
  );
  const queueSnapshotInsertAt = postgresStore.indexOf(
    "INSERT INTO data_snapshots",
    queueAt,
  );
  assert.ok(queueRunAndStageLockAt >= 0,
    "queue must use the shared run-then-stage lock");
  assert.ok(queueRunAndStageLockAt < queueSnapshotInsertAt,
    "queue must lock run then stage before publishing a late input");
  const activeJobReadAt = postgresStore.indexOf(
    "SELECT id FROM job_attempts",
    queueRunAndStageLockAt,
  );
  const activeJobReadEnd = postgresStore.indexOf("`", activeJobReadAt + 1);
  assert.doesNotMatch(
    postgresStore.slice(activeJobReadAt, activeJobReadEnd),
    /FOR UPDATE/,
    "stage-locked queue must not invert finalizer job/stage lock order",
  );

  const runtime = await source(
    "server/runtime/alexa-voc-normalization-runtime.ts",
  );
  const lockAt = runtime.indexOf("lockNormalizationRunAndStage", runtime.indexOf("finalizeNormalizationJob"));
  const listAt = runtime.indexOf("listNormalizationInputSnapshots", runtime.indexOf("finalizeNormalizationJob"));
  assert.ok(lockAt >= 0, "finalizer must acquire the shared stage lock");
  assert.ok(listAt >= 0, "finalizer must enumerate snapshots");
  assert.ok(lockAt < listAt, "stage lock must precede pending-input enumeration");
});

test("SQLite and PostgreSQL budget queries bind every request to its audited agent run", async () => {
  for (const path of [
    "server/db/sqlite-repository.ts",
    "server/db/postgres/model-budget-store.ts",
  ]) {
    const implementation = await source(path);
    assert.match(implementation, /executionAuthority\.agentRunId/);
    assert.match(implementation, /agent_run_id/);
  }

  const runner = await source("server/runtime/skill-runner.ts");
  assert.match(runner, /agentRunId:[\s\S]*executionAuthority\?\.agentRunId/);
});

test("runtime consumes the latest cumulative VOC snapshot and atomically finalizes terminals", async () => {
  const positioningRuntime = await source(
    "server/runtime/voc-positioning-runtime.ts",
  );
  assert.match(positioningRuntime, /selectLatestCumulativeVocSnapshot/);

  const normalizationRuntime = await source(
    "server/runtime/alexa-voc-normalization-runtime.ts",
  );
  assert.match(
    normalizationRuntime,
    /findCommittedNormalizationReplayByFingerprint/,
  );
  assert.match(normalizationRuntime, /recordReplayedNormalizationTerminal/);
  assert.match(normalizationRuntime, /listNormalizationTerminals/);
  assert.match(normalizationRuntime, /completeJob/);
  assert.match(normalizationRuntime, /leaseGeneration/);
  assert.match(normalizationRuntime, /validationStatus\s*!==\s*"passed"/);
  assert.match(normalizationRuntime, /agentRun\.status\s*!==\s*"succeeded"/);
});

test("latest cumulative snapshot follows committed revision order, not random id order", () => {
  const snapshot = (id: string, revision: string) => ({
    id,
    createdAt: "2026-09-01T00:00:00.000Z",
    sources: [{ recordProvenance: [{ revision }] }],
  });
  assert.equal(
    selectLatestCumulativeVocSnapshot([
      snapshot("ffffffff-ffff-4fff-8fff-ffffffffffff", "1"),
      snapshot("00000000-0000-4000-8000-000000000000", "2"),
    ] as never).id,
    "00000000-0000-4000-8000-000000000000",
  );
});
