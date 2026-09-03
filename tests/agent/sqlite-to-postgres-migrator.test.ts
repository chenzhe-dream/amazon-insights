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
const SQLITE_MIGRATIONS_THROUGH_FEEDBACK = [
  [1, "agent_runtime"],
  [2, "job_retry_cycles"],
  [3, "model_budget_ledger"],
  [4, "agent_run_audit"],
  [5, "voc_data_snapshot"],
  [6, "agent_run_logical_lineage"],
  [7, "traffic_data_snapshot"],
  [8, "keyword_analysis_snapshot"],
  [9, "connector_credentials"],
  [10, "user_feedback"],
] as const;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function applySqliteMigrationSource(
  database: DatabaseSync,
  version: number,
  name: string,
) {
  const filename = `${String(version).padStart(4, "0")}_${name}.sql`;
  const sql = readFileSync(
    new URL(`../../server/db/migrations/${filename}`, import.meta.url),
    "utf8",
  );
  database.exec(sql);
  database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  ).run(
    version,
    name,
    createHash("sha256").update(sql).digest("hex"),
    "2026-08-20T00:00:00.000Z",
  );
}

function createSource(options: { schemaVersion?: 10 | 14 } = {}): {
  path: string;
  database: DatabaseSync;
  ids: Record<string, string>;
} {
  const schemaVersion = options.schemaVersion ?? 14;
  const directory = mkdtempSync(join(tmpdir(), "agent-pg-cutover-"));
  directories.push(directory);
  const path = join(directory, "source.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  for (const [version, name] of SQLITE_MIGRATIONS_THROUGH_FEEDBACK) {
    applySqliteMigrationSource(database, version, name);
  }

  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    session: randomUUID(),
    feedback: randomUUID(),
    attachment: randomUUID(),
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
  if (schemaVersion === 14) {
    applySqliteMigrationSource(database, 14, "help_feedback_center");
    const attachment = Buffer.from([0, 1, 2, 39, 92, 255]);
    database.prepare(
      `INSERT INTO user_feedback_attachments
         (id, feedback_id, organization_id, created_by_user_id, file_name,
          media_type, byte_size, sha256, image_content, created_at)
       VALUES (?, ?, ?, ?, 'evidence.png', 'image/png', ?, ?, ?, ?)`,
    ).run(
      ids.attachment,
      ids.feedback,
      "10000000-0000-4000-8000-000000000001",
      ids.user,
      attachment.byteLength,
      createHash("sha256").update(attachment).digest("hex"),
      attachment,
      "2026-08-20T00:00:00.000Z",
    );
  }
  return { path, database, ids };
}

async function cleanTarget(): Promise<Pool> {
  const schema = `cutover_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  return pool;
}

test("copies version 14 IDs, JSON, timestamps, and binary attachments in dependency order", async () => {
  const source = createSource();
  const pool = await cleanTarget();
  const before = createHash("sha256").update(readFileSync(source.path)).digest("hex");
  source.database.close();

  const result = await migrateSqliteToPostgres({ sqlitePath: source.path, pool });

  assert.equal(result.sourceSchemaVersion, 14);
  assert.equal(result.counts.users, 1);
  assert.equal(result.counts.projects, 1);
  assert.equal(result.counts.user_feedback, 1);
  assert.equal(result.counts.user_feedback_workflow, 1);
  assert.equal(result.counts.user_feedback_events, 1);
  assert.equal(result.counts.user_feedback_attachments, 1);
  assert.equal(result.excludedSessions, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count, 0);
  assert.deepEqual((await pool.query("SELECT id, asins_json, created_at FROM projects")).rows[0], {
    id: source.ids.project,
    asins_json: ["B000000001"],
    created_at: new Date("2026-08-20T00:00:00.000Z"),
  });
  assert.deepEqual(
    (await pool.query(
      `SELECT feedback_id, organization_id, created_by_user_id, image_content
         FROM user_feedback_attachments WHERE id = $1`,
      [source.ids.attachment],
    )).rows[0],
    {
      feedback_id: source.ids.feedback,
      organization_id: "10000000-0000-4000-8000-000000000001",
      created_by_user_id: source.ids.user,
      image_content: Buffer.from([0, 1, 2, 39, 92, 255]),
    },
  );
  assert.equal(createHash("sha256").update(readFileSync(source.path)).digest("hex"), before);
});

test("version 10 sources receive deterministic feedback workflow and event backfill", async () => {
  const source = createSource({ schemaVersion: 10 });
  source.database.close();
  const pool = await cleanTarget();

  const result = await migrateSqliteToPostgres({ sqlitePath: source.path, pool });

  assert.equal(result.sourceSchemaVersion, 10);
  assert.equal(result.counts.user_feedback, 1);
  assert.equal(result.counts.user_feedback_workflow, 1);
  assert.equal(result.counts.user_feedback_events, 1);
  assert.equal(result.counts.user_feedback_attachments, 0);
  assert.deepEqual(
    (await pool.query(
      "SELECT feedback_id, status, admin_seen_at, version FROM user_feedback_workflow",
    )).rows[0],
    {
      feedback_id: source.ids.feedback,
      status: "new",
      admin_seen_at: null,
      version: 1,
    },
  );
  assert.deepEqual(
    (await pool.query(
      "SELECT id, feedback_id, event_type, from_status, to_status FROM user_feedback_events",
    )).rows[0],
    {
      id: source.ids.feedback,
      feedback_id: source.ids.feedback,
      event_type: "created",
      from_status: null,
      to_status: "new",
    },
  );
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
  assert.equal((await target.query("SELECT count(*)::int AS count FROM user_feedback_workflow")).rows[0].count, 0);
  assert.equal((await target.query("SELECT count(*)::int AS count FROM user_feedback_events")).rows[0].count, 0);
  assert.equal((await target.query("SELECT count(*)::int AS count FROM user_feedback_attachments")).rows[0].count, 0);
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

test("rejects matching migration names when a recorded source checksum is wrong", async () => {
  const source = createSource();
  source.database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 9").run("0".repeat(64));
  source.database.close();
  const pool = await cleanTarget();
  await assert.rejects(
    migrateSqliteToPostgres({ sqlitePath: source.path, pool }),
    (error: unknown) => error instanceof SqliteToPostgresMigrationError && error.message === "SQLite source schema is incompatible",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
});

test("rejects a source whose table columns do not match the versioned target shape", async () => {
  const source = createSource();
  source.database.exec("ALTER TABLE users RENAME COLUMN display_name TO display_label");
  source.database.close();
  const pool = await cleanTarget();
  await assert.rejects(
    migrateSqliteToPostgres({ sqlitePath: source.path, pool }),
    (error: unknown) => error instanceof SqliteToPostgresMigrationError && error.message === "SQLite source schema is incompatible",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
});
