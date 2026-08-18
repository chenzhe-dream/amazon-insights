import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
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

test("PostgreSQL 0001 migrates a fresh database once and is reentrant", async () => {
  const pool = await freshSchemaPool();

  const first = await runPostgresMigrations(pool);
  const second = await runPostgresMigrations(pool);
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name`,
  );

  assert.deepEqual(first.map(({ version }) => version), [1]);
  assert.deepEqual(second, first);
  assert.deepEqual(
    tables.rows.map(({ table_name }) => table_name),
    [
      "agent_runs",
      "analysis_reports",
      "analysis_runs",
      "audit_events",
      "connector_status",
      "data_snapshots",
      "job_attempts",
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
    "1",
  );
});

test("concurrent PostgreSQL migration runners serialize on a fresh schema", async () => {
  const pool = await freshSchemaPool();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => runPostgresMigrations(pool)),
  );

  assert.ok(results.every((migrations) => migrations.length === 1));
  assert.equal(
    (await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations"))
      .rows[0]?.count,
    "1",
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

  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
        sources_json, payload_json, content_hash, created_at)
     VALUES ('snapshot-1', 'run-1', '1', 'US', '{}', $1, '{}', '{}', 'hash', $1)`,
    [now],
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
