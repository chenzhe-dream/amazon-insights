import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

async function freshSchemaPool(): Promise<Pool> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  return postgres.createPool({ searchPath: schema });
}

function vocSnapshotFixture(dataCutoffAt: string) {
  const marketplace = "US";
  const asins = ["B000000001"];
  const alexaVoc = [
    {
      asin: asins[0],
      attention: ["durability"],
      positives: ["stable"],
      negatives: ["heavy"],
      unmet: ["lighter"],
      audiences: ["commuters"],
      scenarios: ["daily travel"],
      motives: ["reliability"],
      captureStatus: "dialog",
      alexaReport: {
        title: "Buyer summary",
        asin: asins[0],
        rating: 4.2,
        reviewCount: 10,
        prompt: "Summarize buyer feedback",
        overallConclusion: "Buyers value stability.",
        captureStatus: "dialog",
      },
    },
  ];
  const payload = {
    schemaVersion: "1.0.0",
    kind: "voc",
    marketplace,
    asins,
    records: {
      alexaVoc,
      sorftimeReviewAnalysis: [],
      sellerSpriteReviewAnalysis: [],
    },
  };
  const sources = [
    {
      type: "manual-voc",
      reference: "app/rufus-voc-data.ts#rufusVocData",
      marketplace,
      capturedAt: dataCutoffAt,
      checksum: canonicalJsonSha256({
        sourceId: "alexa-voc",
        marketplace,
        records: alexaVoc,
      }),
    },
  ];
  const hashInput = {
    schemaVersion: "1.0.0",
    marketplace,
    asins,
    dataCutoffAt,
    sources,
    payload,
  };
  return { ...hashInput, contentHash: canonicalJsonSha256(hashInput) };
}

async function insertVocSnapshot(
  pool: Pool,
  input: Readonly<{ id: string; runId: string; dataCutoffAt: string }>,
) {
  const snapshot = vocSnapshotFixture(input.dataCutoffAt);
  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
        data_cutoff_at, sources_json, payload_json, content_hash, created_at)
     VALUES ($1, $2, 'voc', $3, $4, $5, $6, $7, $8, $9, $6)`,
    [
      input.id,
      input.runId,
      snapshot.schemaVersion,
      snapshot.marketplace,
      JSON.stringify(snapshot.asins),
      input.dataCutoffAt,
      JSON.stringify(snapshot.sources),
      JSON.stringify(snapshot.payload),
      snapshot.contentHash,
    ],
  );
}

test("PostgreSQL 0001-0006 migrate a fresh database once and are reentrant", async () => {
  const pool = await freshSchemaPool();

  const first = await runPostgresMigrations(pool);
  const second = await runPostgresMigrations(pool);
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name`,
  );

  assert.deepEqual(
    first.map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: "agent_runtime" },
      { version: 2, name: "job_retry_cycles" },
      { version: 3, name: "model_budget_ledger" },
      { version: 4, name: "agent_run_audit" },
      { version: 5, name: "voc_data_snapshot" },
      { version: 6, name: "agent_run_logical_lineage" },
    ],
  );
  assert.ok(first.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));
  assert.equal(new Set(first.map(({ checksum }) => checksum)).size, 6);
  assert.deepEqual(second, first);
  assert.deepEqual(
    tables.rows.map(({ table_name }) => table_name),
    [
      "agent_run_snapshots",
      "agent_runs",
      "analysis_reports",
      "analysis_runs",
      "audit_events",
      "connector_status",
      "data_snapshots",
      "job_attempts",
      "model_budget_reservations",
      "projects",
      "run_stages",
      "schema_migrations",
      "sessions",
      "skill_versions",
      "users",
    ],
  );
  assert.equal(
    (await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations"))
      .rows[0]?.count,
    "6",
  );
});

test("concurrent PostgreSQL migration runners serialize on a fresh schema", async () => {
  const pool = await freshSchemaPool();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => runPostgresMigrations(pool)),
  );

  for (const migrations of results) {
    assert.deepEqual(migrations, results[0]);
    assert.deepEqual(migrations.map(({ version }) => version), [1, 2, 3, 4, 5, 6]);
  }
  assert.equal(
    (await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations"))
      .rows[0]?.count,
    "6",
  );
});

test("PostgreSQL migration checksum drift fails closed without exposing connection data", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  await pool.query("UPDATE schema_migrations SET checksum = 'drifted'");

  await assert.rejects(
    runPostgresMigrations(pool),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /migration 1.*checksum/i);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i);
      assert.doesNotMatch(error.message, /agent_test_/i);
      return true;
    },
  );
  assert.equal(
    (await pool.query<{ checksum: string }>("SELECT checksum FROM schema_migrations"))
      .rows[0]?.checksum,
    "drifted",
  );
});

test("PostgreSQL migration runner sanitizes pool connection failures", async () => {
  const failingPool = {
    async connect(): Promise<never> {
      throw new Error("PostgreSQL migration 1 sensitive connection details");
    },
  } as Pool;

  await assert.rejects(runPostgresMigrations(failingPool), {
    message: "PostgreSQL migration runner failed",
  });
});

test("query context destroys a client when rollback fails", async () => {
  let releaseArgument: Error | boolean | undefined;
  const client = {
    async query(text: string) {
      if (text === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    },
    release(argument?: Error | boolean) {
      releaseArgument = argument;
    },
  } as unknown as PoolClient;
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;
  const context = new PostgresQueryContext(pool);

  await assert.rejects(
    context.transaction(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  assert.equal(releaseArgument, true);
});

test("query context rejects close from inside its active transaction", async () => {
  const pool = await freshSchemaPool();
  const context = new PostgresQueryContext(pool);

  const closeResult = await context.transaction(async () =>
    Promise.race([
      context.close().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 100),
      ),
    ]),
  );

  assert.equal(closeResult, "rejected");
  await context.query("SELECT 1");
  await context.close();
});

test("query context rolls back outer work and reuses its client for nested transactions", async () => {
  const pool = await freshSchemaPool();
  const context = new PostgresQueryContext(pool);
  await context.query("CREATE TABLE transaction_probe (value TEXT NOT NULL)");

  await assert.rejects(
    context.transaction(async (outerClient) => {
      await context.query("INSERT INTO transaction_probe (value) VALUES ('rolled-back')");
      await context.transaction(async (nestedClient) => {
        assert.equal(nestedClient, outerClient);
        const directPid = await outerClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const contextualPid = await context.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        assert.equal(contextualPid.rows[0]?.pid, directPid.rows[0]?.pid);
      });
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(
    (await context.query<{ count: string }>("SELECT COUNT(*) AS count FROM transaction_probe"))
      .rows[0]?.count,
    "0",
  );

  await context.transaction(async () => {
    await context.transaction(async () => {
      await context.query("INSERT INTO transaction_probe (value) VALUES ('committed')");
    });
  });
  assert.equal(
    (await context.query<{ count: string }>("SELECT COUNT(*) AS count FROM transaction_probe"))
      .rows[0]?.count,
    "1",
  );

  await Promise.all([context.close(), context.close()]);
  await assert.rejects(context.query("SELECT 1"), /closed/i);
});

test("PostgreSQL 0001 enforces base uniqueness, foreign keys, checks, and report immutability", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('user-1', 'org-1', 'Owner@Example.com', 'Owner', 'admin', 'active', $1, $1)`,
    [now],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO users
         (id, organization_id, email, display_name, role, status, created_at, updated_at)
       VALUES ('user-2', 'org-1', 'owner@example.com', 'Other', 'member', 'active', $1, $1)`,
      [now],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES ('bad-session', 'missing-user', 'token', $1, $1)`,
      [now],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO users
         (id, organization_id, email, display_name, role, status, created_at, updated_at)
       VALUES ('bad-role', 'org-1', 'bad@example.com', 'Bad', 'owner', 'active', $1, $1)`,
      [now],
    ),
  );

  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ('project-1', 'org-1', 'Project', 'US', '["B000000001"]', 'user-1', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('run-1', 'project-1', 'existing-data', 'running', 'user-1', $1,
             'org-1', 'request-1', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, created_at, updated_at)
     VALUES ('stage-1', 'run-1', 'voc-positioning', 'succeeded', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ('skill-1', 'voc', '1.0.0', 'hash-1', '{}', $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO agent_runs
       (id, run_id, stage_id, skill_version_id, schema_version,
        snapshot_ids_json, provider, model, input_summary_json,
        output_schema_version, output_json, validation_status,
        data_cutoff_at, started_at, completed_at)
     VALUES ('agent-1', 'run-1', 'stage-1', 'skill-1', '1', '{}',
             'test', 'test-model', '{}', '1', '{}', 'passed', $1, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_reports
       (id, run_id, agent_run_id, version, stage, schema_version, status,
        snapshot_ids_json, evidence_json, result_json, data_cutoff_at, created_at)
     VALUES ('report-1', 'run-1', 'agent-1', 1, 'voc-positioning', '1', 'complete',
             '{}', '[]', '{}', $1, $1)`,
    [now],
  );

  await assert.rejects(
    pool.query("UPDATE analysis_reports SET status = 'stale' WHERE id = 'report-1'"),
    /immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM analysis_reports WHERE id = 'report-1'"),
    /immutable/i,
  );

  await insertVocSnapshot(pool, {
    id: "snapshot-1",
    runId: "run-1",
    dataCutoffAt: now,
  });
});

test("PostgreSQL 0004 enforces agent-run audit, snapshot, and budget immutability", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const acquiredAt = new Date();
  const leaseExpiresAt = new Date(acquiredAt.getTime() + 60_000);
  const completedAt = new Date(acquiredAt.getTime() + 1_000);
  const now = acquiredAt.toISOString();
  const expires = leaseExpiresAt.toISOString();

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('audit-user', 'audit-org', 'audit@example.com', 'Audit', 'admin',
             'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ('audit-project', 'audit-org', 'Audit', 'US', '["B000000001"]', 'audit-user',
             $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('audit-run', 'audit-project', 'existing-data', 'running',
             'audit-user', $1, 'audit', 'create', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, started_at,
        created_at, updated_at)
     VALUES ('audit-stage', 'audit-run', 'voc-positioning', 'running', 1, 1,
             $1, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id,
        status, available_at, leased_by, lease_expires_at, lease_generation,
        retryable, started_at, created_at, updated_at)
     VALUES ('audit-job', 'audit-stage', 1, 3, 1, $3, 'running', $1,
             'audit-worker', $2, 1, FALSE, $1, $1, $1)`,
    [now, expires, "d".repeat(64)],
  );
  await pool.query(
    `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ('audit-skill', 'voc', '1.0.0', 'audit-hash', '{}', $1)`,
    [now],
  );
  await insertVocSnapshot(pool, {
    id: "audit-snapshot",
    runId: "audit-run",
    dataCutoffAt: now,
  });

  const insertPending = (agentRunId: string, ownerId: string) =>
    pool.query(
      `INSERT INTO agent_runs (
         id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
         snapshot_ids_json, provider, model, response_id, input_summary_json,
         output_schema_version, output_json, validation_status, input_tokens,
         output_tokens, duration_ms, estimated_cost_micros, error_json,
         data_cutoff_at, started_at, completed_at, execution_fingerprint,
         output_schema_digest, terminal_status, usage_completeness,
         attempt_count, attempts_json, execution_claim_token,
         execution_claim_owner_id, execution_claim_generation,
         execution_claim_acquired_at, execution_claim_expires_at,
         terminal_metadata_json
       ) VALUES (
         $1, 'audit-run', 'audit-stage', 'audit-job', 'audit-skill', '1',
         '["audit-snapshot"]', 'test', 'test-model', NULL, '{}', '1', NULL,
         'pending', NULL, NULL, NULL, NULL, NULL, $2, $2, NULL, $3, $4,
         NULL, NULL, NULL, '[]', 'audit-claim', $5, 1, $2, $6, NULL
       )`,
      [agentRunId, now, "a".repeat(64), "b".repeat(64), ownerId, expires],
    );

  await assert.rejects(
    insertPending("audit-agent-invalid", "wrong-worker"),
    /job does not belong to stage/i,
  );
  await insertPending("audit-agent", "audit-worker");
  await assert.rejects(
    insertPending("audit-agent-duplicate", "audit-worker"),
  );

  await pool.query(
    `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
     VALUES ('audit-agent', 'audit-snapshot', 0)`,
  );
  await assert.rejects(
    pool.query(
      "UPDATE agent_run_snapshots SET ordinal = 1 WHERE agent_run_id = 'audit-agent'",
    ),
    /snapshot links are immutable/i,
  );
  await assert.rejects(
    pool.query(
      "DELETE FROM agent_run_snapshots WHERE agent_run_id = 'audit-agent'",
    ),
    /snapshot links are immutable/i,
  );
  await assert.rejects(
    pool.query(
      `UPDATE agent_runs
          SET execution_claim_token = 'replacement-claim',
              execution_claim_acquired_at = $1,
              execution_claim_expires_at = $2
        WHERE id = 'audit-agent'`,
      [now, expires],
    ),
    /same worker lease agent run claim cannot be replaced/i,
  );

  await pool.query(
    `UPDATE agent_runs
        SET response_id = 'response-a', output_json = '{}',
            validation_status = 'passed', input_tokens = 10,
            output_tokens = 20, duration_ms = 30, estimated_cost_micros = 40,
            completed_at = $1, terminal_status = 'succeeded',
            usage_completeness = 'complete', attempt_count = 1,
            attempts_json = '[{}]', terminal_metadata_json = '{"kind":"succeeded"}'
      WHERE id = 'audit-agent'`,
    [completedAt.toISOString()],
  );
  await assert.rejects(
    pool.query(
      "UPDATE agent_runs SET model = 'changed' WHERE id = 'audit-agent'",
    ),
    /completed agent runs are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM agent_runs WHERE id = 'audit-agent'"),
    /agent runs are immutable/i,
  );

  await pool.query(
    `INSERT INTO model_budget_reservations (
       id, idempotency_key, request_fingerprint, run_id, project_id,
       organization_id, utc_day, state, projected_input_tokens,
       projected_output_tokens, projected_cost_micros, lease_expires_at,
       created_at, updated_at, job_attempt_id, request_ordinal, attempt_kind,
       transient_retry_count, format_repair
     ) VALUES ('audit-budget', 'audit-budget', $1, 'audit-run', 'audit-project',
               'audit-org', $2::date, 'reserved', 10, 10, 20, $3, $2, $2,
               'audit-job', 0, 'initial', 0, FALSE)`,
    ["c".repeat(64), now, expires],
  );
  await pool.query(
    `UPDATE model_budget_reservations
        SET state = 'settled', actual_input_tokens = 5,
            actual_output_tokens = 5, actual_cost_micros = 10,
            lease_expires_at = NULL, response_id = 'response-a',
            settled_at = $1, updated_at = $1
      WHERE id = 'audit-budget'`,
    [completedAt.toISOString()],
  );
  await assert.rejects(
    pool.query(
      `UPDATE model_budget_reservations
          SET response_id = 'response-b'
        WHERE id = 'audit-budget'`,
    ),
    /response id may only be set once during settle/i,
  );
});

test("PostgreSQL 0005 enforces canonical VOC snapshot provenance and immutability", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const cutoff = "2026-08-15T08:00:00.000Z";

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('voc-user', 'voc-org', 'voc@example.com', 'VOC', 'member', 'active', $1, $1)`,
    [cutoff],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ('voc-project', 'voc-org', 'VOC', 'US', '["B000000001"]',
             'voc-user', $1, $1)`,
    [cutoff],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('voc-run', 'voc-project', 'existing-data', 'running', 'voc-user', $1,
             'voc-snapshot', 'create', $1, $1)`,
    [cutoff],
  );

  await insertVocSnapshot(pool, {
    id: "voc-snapshot",
    runId: "voc-run",
    dataCutoffAt: cutoff,
  });

  await assert.rejects(
    insertVocSnapshot(pool, {
      id: "voc-snapshot-duplicate",
      runId: "voc-run",
      dataCutoffAt: cutoff,
    }),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
          data_cutoff_at, sources_json, payload_json, content_hash, created_at)
       VALUES ('voc-legacy', 'voc-run', NULL, 'garbage', 'ZZ', '[]', $1,
               '[]', '{}', 'garbage', $1)`,
      [cutoff],
    ),
    /legacy data snapshot inserts are closed/i,
  );

  const invalid = vocSnapshotFixture(cutoff);
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
          data_cutoff_at, sources_json, payload_json, content_hash, created_at)
       VALUES ('voc-invalid-hash', 'voc-run', 'voc', $1, $2, $3, $4, $5, $6, $7, $4)`,
      [
        invalid.schemaVersion,
        invalid.marketplace,
        JSON.stringify(invalid.asins),
        cutoff,
        JSON.stringify(invalid.sources),
        JSON.stringify(invalid.payload),
        "f".repeat(64),
      ],
    ),
    /invalid VOC data snapshot/i,
  );
  await assert.rejects(
    pool.query(
      "UPDATE data_snapshots SET marketplace = 'CA' WHERE id = 'voc-snapshot'",
    ),
    /data snapshots are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM data_snapshots WHERE id = 'voc-snapshot'"),
    /data snapshots are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM analysis_runs WHERE id = 'voc-run'"),
    /data snapshots are immutable/i,
  );
});

test("PostgreSQL 0006 fences logical execution recovery and report publication state", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const startedAt = "2026-08-15T08:00:00.000Z";
  const reclaimedAt = "2026-08-15T08:01:00.000Z";
  const expiresAt = "2026-08-15T08:10:00.000Z";
  const retryAt = "2026-08-15T08:02:00.000Z";
  const cycle = "1".repeat(64);
  const lineage = "2".repeat(64);

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('lineage-user', 'lineage-org', 'lineage@example.com', 'Lineage',
             'member', 'active', $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ('lineage-project', 'lineage-org', 'Lineage', 'US', '["B000000001"]',
             'lineage-user', $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('lineage-run', 'lineage-project', 'existing-data', 'running',
             'lineage-user', $1, 'lineage', 'create', $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, started_at,
        created_at, updated_at)
     VALUES ('lineage-stage', 'lineage-run', 'voc-positioning', 'running', 1, 1,
             $1, $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ('lineage-skill', 'voc', '1.0.0', 'lineage-hash', '{}', $1)`,
    [startedAt],
  );
  await insertVocSnapshot(pool, {
    id: "lineage-snapshot",
    runId: "lineage-run",
    dataCutoffAt: startedAt,
  });
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        status, available_at, lease_generation, retryable, completed_at,
        created_at, updated_at)
     VALUES ('derived-job-1', 'lineage-stage', 10, 12, 10, 'failed', $1, 0,
             FALSE, $1, $1, $1),
            ('derived-job-2', 'lineage-stage', 11, 12, 10, 'failed', $1, 0,
             FALSE, $1, $1, $1)`,
    [startedAt],
  );
  const derivedCycles = await pool.query<{
    id: string;
    logical_execution_cycle_id: string;
  }>(
    `SELECT id, logical_execution_cycle_id
       FROM job_attempts WHERE id LIKE 'derived-job-%' ORDER BY id`,
  );
  const expectedDerivedCycle = createHash("sha256")
    .update("lineage-stage:10")
    .digest("hex");
  assert.deepEqual(derivedCycles.rows, [
    { id: "derived-job-1", logical_execution_cycle_id: expectedDerivedCycle },
    { id: "derived-job-2", logical_execution_cycle_id: expectedDerivedCycle },
  ]);
  await assert.rejects(
    pool.query(
      `INSERT INTO job_attempts
         (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
          logical_execution_cycle_id, status, available_at, lease_generation,
          retryable, completed_at, created_at, updated_at)
       VALUES ('derived-job-invalid', 'lineage-stage', 12, 12, 12, $1, 'failed',
               $2, 0, FALSE, $2, $2, $2)`,
      ["A".repeat(64), startedAt],
    ),
  );
  await assert.rejects(
    pool.query(
      `UPDATE job_attempts SET logical_execution_cycle_id = $1
        WHERE id = 'derived-job-1'`,
      ["3".repeat(64)],
    ),
    /logical execution cycle is immutable/i,
  );
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id, status, available_at, leased_by,
        lease_expires_at, lease_generation, retryable, started_at,
        created_at, updated_at)
     VALUES ('lineage-job-1', 'lineage-stage', 1, 3, 1, $1, 'running', $2,
             'lineage-worker-1', $3, 1, FALSE, $2, $2, $2)`,
    [cycle, startedAt, expiresAt],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO job_attempts
         (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
          logical_execution_cycle_id, status, available_at, lease_generation,
          retryable, created_at, updated_at)
       VALUES ('lineage-job-conflict', 'lineage-stage', 2, 3, 1, $1, 'queued',
               $2, 0, FALSE, $2, $2)`,
      [cycle, startedAt],
    ),
  );

  await pool.query(
    `INSERT INTO agent_runs (
       id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
       snapshot_ids_json, provider, model, response_id, input_summary_json,
       output_schema_version, output_json, validation_status, input_tokens,
       output_tokens, duration_ms, estimated_cost_micros, error_json,
       data_cutoff_at, started_at, completed_at, execution_fingerprint,
       output_schema_digest, logical_execution_lineage, logical_execution_cycle_id,
       active_job_attempt_id, terminal_status, usage_completeness, attempt_count,
       attempts_json, execution_claim_token, execution_claim_owner_id,
       execution_claim_generation, execution_claim_acquired_at,
       execution_claim_expires_at, terminal_metadata_json
     ) VALUES (
       'lineage-agent', 'lineage-run', 'lineage-stage', 'lineage-job-1',
       'lineage-skill', '1.1.0', '["lineage-snapshot"]', 'test', 'test-model',
       NULL, '{"contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","recordCount":1}',
       '1.0.0', NULL, 'pending', NULL, NULL, NULL, NULL, NULL, $1, $1, NULL,
       $2, $3, $4, $5, 'lineage-job-1', NULL, NULL, NULL, '[]', 'claim-1',
       'lineage-worker-1', 1, $1, $6, NULL
     )`,
    [startedAt, "a".repeat(64), "b".repeat(64), lineage, cycle, expiresAt],
  );
  await pool.query(
    `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
     VALUES ('lineage-agent', 'lineage-snapshot', 0)`,
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO agent_runs (
         id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
         snapshot_ids_json, provider, model, input_summary_json,
         output_schema_version, validation_status, data_cutoff_at, started_at,
         execution_fingerprint, output_schema_digest, logical_execution_lineage,
         logical_execution_cycle_id, active_job_attempt_id, attempts_json,
         execution_claim_token, execution_claim_owner_id,
         execution_claim_generation, execution_claim_acquired_at,
         execution_claim_expires_at
       ) VALUES (
         'lineage-agent-untrusted', 'lineage-run', 'lineage-stage', 'lineage-job-1',
         'lineage-skill', '1.1.0', '["lineage-snapshot"]', 'test', 'test-model', '{}',
         '1.0.0', 'pending', $1, $1, $2, $3, $4, $5, 'lineage-job-1', '[]',
         'untrusted-claim', 'lineage-worker-1', 1, $1, $6
       )`,
      [
        startedAt,
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
        expiresAt,
      ],
    ),
    /logical cycle has no trusted job authority/i,
  );

  await pool.query(
    `UPDATE job_attempts
        SET report_publication_max_attempts = 2,
            report_publication_initial_delay_ms = 100,
            report_publication_max_delay_ms = 1_000
      WHERE id = 'lineage-job-1'`,
  );
  await pool.query(
    `UPDATE job_attempts
        SET status = 'failed', retryable = TRUE,
            report_publication_attempt_count = 1,
            report_publication_retry_at = $1
      WHERE id = 'lineage-job-1'`,
    [retryAt],
  );
  await assert.rejects(
    pool.query(
      `UPDATE job_attempts SET report_publication_attempt_count = 0
        WHERE id = 'lineage-job-1'`,
    ),
    /report publication transition is invalid/i,
  );
  await assert.rejects(
    pool.query(
      `UPDATE job_attempts SET report_publication_cycle = 2
        WHERE id = 'lineage-job-1'`,
    ),
    /report publication transition is invalid/i,
  );

  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id, status, available_at, leased_by,
        lease_expires_at, lease_generation, retryable, started_at,
        created_at, updated_at)
     VALUES ('lineage-job-2', 'lineage-stage', 2, 3, 1, $1, 'running', $2,
             'lineage-worker-2', $3, 1, FALSE, $2, $2, $2)`,
    [cycle, reclaimedAt, expiresAt],
  );
  await pool.query(
    `UPDATE agent_runs
        SET active_job_attempt_id = 'lineage-job-2',
            execution_claim_token = 'claim-2',
            execution_claim_owner_id = 'lineage-worker-2',
            execution_claim_generation = 1,
            execution_claim_acquired_at = $1,
            execution_claim_expires_at = $2
      WHERE id = 'lineage-agent'`,
    [reclaimedAt, expiresAt],
  );
  await assert.rejects(
    pool.query(
      `UPDATE agent_runs
          SET active_job_attempt_id = 'lineage-job-1',
              execution_claim_token = 'stale-claim',
              execution_claim_owner_id = 'lineage-worker-1',
              execution_claim_generation = 1,
              execution_claim_acquired_at = $1,
              execution_claim_expires_at = $2
        WHERE id = 'lineage-agent'`,
      [reclaimedAt, expiresAt],
    ),
    /replacement agent run claim has no active job lease/i,
  );
  await assert.rejects(
    pool.query(
      `UPDATE agent_runs
          SET active_job_attempt_id = 'lineage-job-1',
              response_id = 'response', output_json = '{}',
              validation_status = 'passed', input_tokens = 1, output_tokens = 1,
              duration_ms = 1, estimated_cost_micros = 1, completed_at = $1,
              terminal_status = 'succeeded', usage_completeness = 'complete',
              attempt_count = 1, attempts_json = '[{}]',
              terminal_metadata_json = '{"kind":"succeeded"}'
        WHERE id = 'lineage-agent'`,
      [reclaimedAt],
    ),
    /active recovery authority is immutable at completion/i,
  );
});

test("PostgreSQL test container rejects pools created after close", async () => {
  const isolated = await startPostgresTestContainer();
  await isolated.close();
  let latePool: Pool | undefined;
  let closeError: unknown;
  try {
    latePool = isolated.createPool();
  } catch (error) {
    closeError = error;
  }
  await latePool?.end();

  assert.ok(closeError instanceof Error);
  assert.match(closeError.message, /clos/i);
});
