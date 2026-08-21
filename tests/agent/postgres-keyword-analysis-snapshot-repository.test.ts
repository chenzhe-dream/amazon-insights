import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { buildKeywordAnalysisSnapshotCandidate } from "../../server/data/keyword-analysis-snapshot";
import {
  DataSnapshotCutoffConflictError,
  DataSnapshotSubjectNotFoundError,
} from "../../server/db/data-snapshot-repository";
import {
  KeywordAnalysisSnapshotConflictError,
  KeywordAnalysisSnapshotDataError,
  type CreateKeywordAnalysisSnapshotForRunInput,
} from "../../server/db/keyword-analysis-snapshot-repository";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { PostgresKeywordAnalysisSnapshotStore } from "../../server/db/postgres/keyword-analysis-snapshot-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresProductDependencyReconciler } from "../../server/db/postgres/product-dependency-reconciler";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const createdAt = "2026-08-15T00:00:00.000Z";
const targetAsins = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"] as const;

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

interface RepositoryBundle {
  pool: Pool;
  queries: PostgresQueryContext;
  core: PostgresCoreStore;
  keywords: PostgresKeywordAnalysisSnapshotStore;
  reconciler: PostgresProductDependencyReconciler;
}

interface SeededTarget {
  organizationId: string;
  actorId: string;
  projectId: string;
  runId: string;
  productStageId: string;
}

async function freshRepository(): Promise<RepositoryBundle> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const queries = new PostgresQueryContext(pool);
  const reconciler = new PostgresProductDependencyReconciler(queries);
  return {
    pool,
    queries,
    core: new PostgresCoreStore(queries),
    keywords: new PostgresKeywordAnalysisSnapshotStore(queries, {
      dependencyReconciler: reconciler,
    }),
    reconciler,
  };
}

function siblingRepository(pool: Pool) {
  const queries = new PostgresQueryContext(pool);
  return {
    queries,
    keywords: new PostgresKeywordAnalysisSnapshotStore(queries, {
      dependencyReconciler: new PostgresProductDependencyReconciler(queries),
    }),
  };
}

async function seedTarget(
  repository: Pick<RepositoryBundle, "core">,
): Promise<SeededTarget> {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const productStageId = randomUUID();
  await repository.core.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Keyword actor",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.core.createProject({
    id: projectId,
    organizationId,
    name: "Keyword target",
    marketplace: "US",
    asins: [...targetAsins],
    createdBy: actorId,
    createdAt,
    updatedAt: createdAt,
  });
  await repository.core.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: createdAt,
    idempotencyScope: `keyword:${runId}`,
    idempotencyKey: "create",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.core.createRunStage({
    id: productStageId,
    runId,
    stage: "product-definition",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  });
  return { organizationId, actorId, projectId, runId, productStageId };
}

function keywordCandidate() {
  return keywordCandidateAt(createdAt);
}

function keywordCandidateAt(dataCutoffAt: string) {
  return buildKeywordAnalysisSnapshotCandidate({
    marketplace: "US",
    asins: targetAsins,
    dataCutoffAt,
    groups: [{
      id: "portable-demand",
      label: "Portable demand",
      keywords: ["portable scooter"],
      demand: "high",
      trend: "stable",
      seasonality: "non-seasonal",
      evidenceIds: ["evidence-1"],
    }],
    evidence: [{
      id: "evidence-1",
      sourceId: "sif-keyword-analysis",
      capturedAt: dataCutoffAt,
      searchVolume: 1200,
      purchaseRate: 0.22,
    }],
  });
}

function changedKeywordCandidate() {
  const candidate = keywordCandidate();
  return buildKeywordAnalysisSnapshotCandidate({
    marketplace: "US",
    asins: targetAsins,
    dataCutoffAt: createdAt,
    groups: [{ ...candidate.payload.groups[0]!, label: "Changed demand" }],
    evidence: candidate.payload.evidence,
  });
}

function createInput(
  target: SeededTarget,
  overrides: Partial<CreateKeywordAnalysisSnapshotForRunInput> = {},
): CreateKeywordAnalysisSnapshotForRunInput {
  return {
    actorId: target.actorId,
    actorOrganizationId: target.organizationId,
    runId: target.runId,
    expectedProjectId: target.projectId,
    expectedMarketplace: "US",
    expectedAsins: [...targetAsins],
    expectedRunCutoffAt: createdAt,
    candidateId: randomUUID(),
    createdAt,
    candidate: keywordCandidate(),
    ...overrides,
  };
}

test("PostgreSQL keyword snapshots persist latest artifact and isolate organizations", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const first = await repository.keywords.createKeywordAnalysisSnapshotForRun(
    createInput(target),
  );
  const replay = await repository.keywords.createKeywordAnalysisSnapshotForRun(
    createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
  );

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.equal(Object.isFrozen(first.snapshot.payload.groups[0]), true);
  assert.deepEqual(
    await repository.keywords.findKeywordAnalysisSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: first.snapshot.id,
    }),
    first.snapshot,
  );
  assert.deepEqual(
    await repository.keywords.listKeywordAnalysisSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [first.snapshot],
  );
  assert.deepEqual(
    await repository.keywords.getKeywordAnalysisArtifact(target.runId),
    { available: true, version: first.snapshot.contentHash },
  );
  assert.equal(
    await repository.keywords.findKeywordAnalysisSnapshotById({
      actorOrganizationId: randomUUID(),
      snapshotId: first.snapshot.id,
    }),
    null,
  );
});

test("PostgreSQL keyword snapshots validate subject, conflict, concurrency, rollback, and stored JSON", async () => {
  const repository = await freshRepository();
  const competitorPool = postgres.createPool({ searchPath: await currentSchema(repository.pool) });
  const competitor = siblingRepository(competitorPool);
  const target = await seedTarget(repository);
  const sameHash = await Promise.allSettled([
    repository.keywords.createKeywordAnalysisSnapshotForRun(createInput(target)),
    competitor.keywords.createKeywordAnalysisSnapshotForRun(
      createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
    ),
  ]);
  assert.equal(sameHash.filter(({ status }) => status === "fulfilled").length, 2);

  const driftTarget = await seedTarget(repository);
  const differentHash = await Promise.allSettled([
    repository.keywords.createKeywordAnalysisSnapshotForRun(createInput(driftTarget)),
    competitor.keywords.createKeywordAnalysisSnapshotForRun(
      createInput(driftTarget, { candidate: changedKeywordCandidate() }),
    ),
  ]);
  assert.ok(differentHash.some((result) =>
    result.status === "rejected" &&
    result.reason instanceof KeywordAnalysisSnapshotConflictError
  ));

  await assert.rejects(
    repository.keywords.createKeywordAnalysisSnapshotForRun(
      createInput(target, { actorOrganizationId: randomUUID() }),
    ),
    DataSnapshotSubjectNotFoundError,
  );
  await assert.rejects(
    repository.keywords.createKeywordAnalysisSnapshotForRun(
      createInput(target, { candidate: keywordCandidateAt("2026-08-16T00:00:00.000Z") }),
    ),
    DataSnapshotCutoffConflictError,
  );
  await assert.rejects(
    repository.queries.transaction(async () => {
      const rollbackTarget = await seedTarget(repository);
      await repository.keywords.createKeywordAnalysisSnapshotForRun(createInput(rollbackTarget));
      throw new Error("force rollback");
    }),
    /force rollback/,
  );

  const created = (await repository.keywords.listKeywordAnalysisSnapshotsByRun({
    actorOrganizationId: target.organizationId,
    runId: target.runId,
  }))[0]!;
  await repository.pool.query(
    "DROP TRIGGER keyword_analysis_snapshots_update_immutable ON keyword_analysis_snapshots",
  );
  try {
    await repository.pool.query(
      "UPDATE keyword_analysis_snapshots SET payload_json = '{}'::jsonb WHERE id = $1",
      [created.id],
    );
    await assert.rejects(
      repository.keywords.findKeywordAnalysisSnapshotById({
        actorOrganizationId: target.organizationId,
        snapshotId: created.id,
      }),
      KeywordAnalysisSnapshotDataError,
    );
  } finally {
    await repository.pool.query(
      `CREATE TRIGGER keyword_analysis_snapshots_update_immutable
       BEFORE UPDATE ON keyword_analysis_snapshots
       FOR EACH ROW EXECUTE FUNCTION prevent_keyword_analysis_snapshot_update()`,
    );
  }
});

test("PostgreSQL product dependency reconciler waits for missing inputs and queues one job when ready", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  await repository.keywords.createKeywordAnalysisSnapshotForRun(createInput(target));
  let stage = await repository.core.findRunStage(target.productStageId);
  assert.equal(stage?.status, "waiting-input");
  assert.deepEqual(stage?.lastError?.details, [{
    path: "dependencies.voc-positioning-report",
    message: "Validated VOC positioning report is required",
  }]);
  assert.equal(await jobCount(repository.pool, target.productStageId), "0");

  await insertVocReport(repository.pool, target);
  await Promise.all([
    repository.reconciler.reconcileProductDefinitionStage(target.runId, createdAt),
    repository.reconciler.reconcileProductDefinitionStage(target.runId, createdAt),
  ]);
  stage = await repository.core.findRunStage(target.productStageId);
  assert.equal(stage?.status, "queued");
  assert.equal(await jobCount(repository.pool, target.productStageId), "1");
  assert.equal((await repository.core.findAnalysisRun(target.runId))?.status, "queued");

  await assert.rejects(
    repository.queries.transaction(async () => {
      await repository.reconciler.reconcileProductDefinitionStage(
        target.runId,
        "2026-08-15T00:00:02.000Z",
      );
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(await jobCount(repository.pool, target.productStageId), "1");
});

async function insertVocReport(pool: Pool, target: SeededTarget) {
  const vocStageId = randomUUID();
  const jobId = randomUUID();
  const skillId = randomUUID();
  const agentRunId = randomUUID();
  await pool.query(
    `INSERT INTO run_stages (id, run_id, stage, status, progress, attempt_count, created_at, updated_at, completed_at)
     VALUES ($1, $2, 'voc-positioning', 'succeeded', 100, 1, $3, $3, $3)`,
    [vocStageId, target.runId, createdAt],
  );
  await pool.query(
    `INSERT INTO job_attempts (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt, status, available_at, lease_generation, retryable, completed_at, created_at, updated_at)
     VALUES ($1, $2, 1, 1, 1, 'succeeded', $3, 0, FALSE, $3, $3, $3)`,
    [jobId, vocStageId, createdAt],
  );
  await pool.query(
    `INSERT INTO skill_versions (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ($1, 'define-amazon-voc-positioning', '1.0.0', $2, '{}'::jsonb, $3)`,
    [skillId, "a".repeat(64), createdAt],
  );
  await pool.query("ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_audit_insert_consistency");
  await pool.query("ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_logical_cycle_insert_consistency");
  try {
    await pool.query(
      `INSERT INTO agent_runs (
         id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
         snapshot_ids_json, provider, model, input_summary_json, output_schema_version,
         output_json, validation_status, data_cutoff_at, started_at, completed_at,
         execution_fingerprint, output_schema_digest, logical_execution_lineage,
         logical_execution_cycle_id, active_job_attempt_id, terminal_status,
         usage_completeness, attempt_count, attempts_json, terminal_metadata_json
       ) VALUES (
         $1, $2, $3, $4, $5, '1.1.0', '[]'::jsonb, 'test', 'model', '{}'::jsonb,
         '1.0.0', '{}'::jsonb, 'passed', $6, $6, $6, $7, $8, $9, NULL, NULL,
         'succeeded', 'complete', 1, '[]'::jsonb, '{"kind":"succeeded"}'::jsonb
       )`,
      [
        agentRunId,
        target.runId,
        vocStageId,
        jobId,
        skillId,
        createdAt,
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
      ],
    );
  } finally {
    await pool.query("ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_logical_cycle_insert_consistency");
    await pool.query("ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_audit_insert_consistency");
  }
  await pool.query(
    `INSERT INTO analysis_reports
       (id, run_id, agent_run_id, version, stage, schema_version, status,
        snapshot_ids_json, evidence_json, result_json, data_cutoff_at, created_at)
     VALUES ($1, $2, $3, 1, 'voc-positioning', '1.0.0', 'complete',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $4, $4)`,
    [randomUUID(), target.runId, agentRunId, createdAt],
  );
}

async function jobCount(pool: Pool, stageId: string) {
  return (
    await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM job_attempts WHERE stage_id = $1",
      [stageId],
    )
  ).rows[0]?.count;
}

async function currentSchema(pool: Pool): Promise<string> {
  const result = await pool.query<{ schema: string }>(
    "SELECT current_schema() AS schema",
  );
  const schema = result.rows[0]?.schema;
  assert.ok(schema);
  return schema;
}
