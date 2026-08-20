import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  migrateSqliteToPostgres,
  SqliteToPostgresMigrationError,
} from "../../server/db/migrate-sqlite-to-postgres";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

let postgres: PostgresTestContainer;
const directories: string[] = [];

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function createSource(): { path: string; database: DatabaseSync; ids: Record<string, string> } {
  const directory = mkdtempSync(join(tmpdir(), "agent-pg-cutover-"));
  directories.push(directory);
  const path = join(directory, "source.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  for (let version = 1; version <= 10; version += 1) {
    const filename = version === 10
      ? "0010_user_feedback.sql"
      : `${String(version).padStart(4, "0")}_${[
          "agent_runtime",
          "job_retry_cycles",
          "model_budget_ledger",
          "agent_run_audit",
          "voc_data_snapshot",
          "agent_run_logical_lineage",
          "traffic_data_snapshot",
          "keyword_analysis_snapshot",
          "connector_credentials",
        ][version - 1]}.sql`;
    const sql = readFileSync(new URL(`../../server/db/migrations/${filename}`, import.meta.url), "utf8");
    database.exec(sql);
    database.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(version, filename.slice(5, -4), createHash("sha256").update(sql).digest("hex"), "2026-08-20T00:00:00.000Z");
  }

  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    session: randomUUID(),
    feedback: randomUUID(),
  };
  database.prepare(
    `INSERT INTO users (id, organization_id, email, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, 'admin@example.test', 'Admin', 'hash', 'admin', 'active', ?, ?)`,
  ).run(ids.user, "10000000-0000-4000-8000-000000000001", "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  database.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ids.session, ids.user, "a".repeat(64), "2026-08-21T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  database.prepare(
    `INSERT INTO projects (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES (?, ?, 'Project', 'US', ?, ?, ?, ?)`,
  ).run(ids.project, "10000000-0000-4000-8000-000000000001", JSON.stringify(["B000000001"]), ids.user, "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  database.prepare(
    `INSERT INTO user_feedback (id, organization_id, actor_user_id, category, title, description, page_path, app_version, created_at)
     VALUES (?, ?, ?, 'bug', 'Title', 'Description', '/projects', 'test', ?)`,
  ).run(ids.feedback, "10000000-0000-4000-8000-000000000001", ids.user, "2026-08-20T00:00:00.000Z");
  return { path, database, ids };
}

async function cleanTarget(): Promise<Pool> {
  const schema = `cutover_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  return pool;
}

test("copies IDs, JSON/timestamps and counts while excluding all sessions and preserving source", async () => {
  const source = createSource();
  const pool = await cleanTarget();
  const before = createHash("sha256").update(readFileSync(source.path)).digest("hex");
  source.database.close();

  const result = await migrateSqliteToPostgres({ sqlitePath: source.path, pool });

  assert.equal(result.sourceSchemaVersion, 10);
  assert.equal(result.counts.users, 1);
  assert.equal(result.counts.projects, 1);
  assert.equal(result.counts.user_feedback, 1);
  assert.equal(result.excludedSessions, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count, 0);
  assert.deepEqual((await pool.query("SELECT id, asins_json, created_at FROM projects")).rows[0], {
    id: source.ids.project,
    asins_json: ["B000000001"],
    created_at: new Date("2026-08-20T00:00:00.000Z"),
  });
  assert.equal(createHash("sha256").update(readFileSync(source.path)).digest("hex"), before);
});

test("requires an empty target and rolls back every copied row after a failure", async () => {
  const nonEmptySource = createSource();
  nonEmptySource.database.close();
  const nonEmptyTarget = await cleanTarget();
  await nonEmptyTarget.query(
    `INSERT INTO users (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, 'existing@example.test', 'Existing', 'admin', 'active', now(), now())`,
    [randomUUID(), randomUUID()],
  );
  await assert.rejects(
    migrateSqliteToPostgres({ sqlitePath: nonEmptySource.path, pool: nonEmptyTarget }),
    (error: unknown) => error instanceof SqliteToPostgresMigrationError && error.message === "PostgreSQL target is not empty",
  );

  const badSource = createSource();
  badSource.database.exec("PRAGMA foreign_keys = OFF");
  badSource.database.prepare("UPDATE projects SET created_by = ?").run(randomUUID());
  badSource.database.close();
  const target = await cleanTarget();
  await assert.rejects(migrateSqliteToPostgres({ sqlitePath: badSource.path, pool: target }));
  assert.equal((await target.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
  assert.equal((await target.query("SELECT count(*)::int AS count FROM projects")).rows[0].count, 0);
});

test("fails closed without leaking a source path or PostgreSQL URL", async () => {
  const pool = await cleanTarget();
  const secretPath = join(tmpdir(), `secret-${randomUUID()}.sqlite`);
  let error: unknown;
  try {
    await migrateSqliteToPostgres({ sqlitePath: secretPath, pool });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SqliteToPostgresMigrationError);
  assert.doesNotMatch(error.message, /secret-|postgres(?:ql)?:\/\//i);
  assert.equal(error.message, "SQLite to PostgreSQL migration failed");
});
