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
    /findCommittedNormalizationByFingerprint/,
  );
  assert.match(normalizationRuntime, /committed\s*===\s*null/);
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
