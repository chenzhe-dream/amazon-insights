import { DatabaseSync } from "node:sqlite";

import type { Pool, PoolClient } from "pg";

const BASE_TABLE_ORDER = [
  "users",
  "projects",
  "analysis_runs",
  "run_stages",
  "job_attempts",
  "data_snapshots",
  "skill_versions",
  "agent_runs",
  "analysis_reports",
  "connector_status",
  "audit_events",
  "model_budget_reservations",
  "agent_run_snapshots",
  "keyword_analysis_snapshots",
  "connector_credentials",
] as const;

const MIGRATION_NAMES = [
  "agent_runtime",
  "job_retry_cycles",
  "model_budget_ledger",
  "agent_run_audit",
  "voc_data_snapshot",
  "agent_run_logical_lineage",
  "traffic_data_snapshot",
  "keyword_analysis_snapshot",
  "connector_credentials",
  "user_feedback",
] as const;

type SqliteRow = Record<string, unknown>;

export class SqliteToPostgresMigrationError extends Error {
  constructor(message = "SQLite to PostgreSQL migration failed") {
    super(message);
    this.name = "SqliteToPostgresMigrationError";
  }
}

export interface SqliteToPostgresMigrationResult {
  readonly sourceSchemaVersion: 9 | 10;
  readonly counts: Readonly<Record<string, number>>;
  readonly excludedSessions: number;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new SqliteToPostgresMigrationError();
  }
  return `"${identifier}"`;
}

function readSourceVersion(database: DatabaseSync): 9 | 10 {
  const rows = database.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number | bigint; name: string }>;
  const version = rows.length;
  if ((version !== 9 && version !== 10) || rows.some((row, index) =>
    Number(row.version) !== index + 1 || row.name !== MIGRATION_NAMES[index]
  )) {
    throw new SqliteToPostgresMigrationError("SQLite source schema is incompatible");
  }
  return version;
}

async function assertEmptyTarget(client: PoolClient, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    if (result.rows[0]?.count !== "0") {
      throw new SqliteToPostgresMigrationError("PostgreSQL target is not empty");
    }
  }
}

async function postgresColumnTypes(
  client: PoolClient,
  table: string,
): Promise<Map<string, string>> {
  const result = await client.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return new Map(result.rows.map((row) => [row.column_name, row.data_type]));
}

function mapValue(value: unknown, type: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (type === "boolean") return value === true || value === 1 || value === 1n;
  if (type === "json" || type === "jsonb") {
    if (typeof value !== "string") return JSON.stringify(value);
    JSON.parse(value);
    return value;
  }
  return value;
}

async function copyTable(
  source: DatabaseSync,
  client: PoolClient,
  table: string,
  overrides?: Readonly<Record<string, unknown>>,
): Promise<{ count: number; rows: SqliteRow[] }> {
  const rows = source.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as SqliteRow[];
  const columnTypes = await postgresColumnTypes(client, table);
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = columns.map((column) => mapValue(
      Object.prototype.hasOwnProperty.call(overrides ?? {}, column)
        ? overrides![column]
        : row[column],
      columnTypes.get(column),
    ));
    await client.query(
      `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      values,
    );
  }
  return { count: rows.length, rows };
}

async function verifyCounts(
  client: PoolClient,
  counts: Readonly<Record<string, number>>,
): Promise<void> {
  for (const [table, expected] of Object.entries(counts)) {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${quoteIdentifier(table)}`,
    );
    if (result.rows[0]?.count !== expected) throw new SqliteToPostgresMigrationError();
  }
  const foreignKeys = await client.query<{ violations: number }>(
    `SELECT count(*)::int AS violations
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.connamespace = current_schema()::regnamespace
        AND NOT c.convalidated`,
  );
  if ((foreignKeys.rows[0]?.violations ?? 1) !== 0) {
    throw new SqliteToPostgresMigrationError();
  }
}

export async function migrateSqliteToPostgres(options: {
  sqlitePath: string;
  pool: Pool;
}): Promise<SqliteToPostgresMigrationResult> {
  let source: DatabaseSync | undefined;
  let client: PoolClient | undefined;
  try {
    source = new DatabaseSync(options.sqlitePath, { readOnly: true });
    const sourceSchemaVersion = readSourceVersion(source);
    const tables = sourceSchemaVersion === 10
      ? [...BASE_TABLE_ORDER, "user_feedback"]
      : [...BASE_TABLE_ORDER];
    const excludedSessions = Number((source.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number | bigint }).count);
    client = await options.pool.connect();
    await client.query("BEGIN");
    await assertEmptyTarget(client, [...tables, "sessions"]);

    const counts: Record<string, number> = {};
    let projectRows: SqliteRow[] = [];
    for (const table of tables) {
      let copied: { count: number; rows: SqliteRow[] };
      try {
        copied = await copyTable(
          source,
          client,
          table,
          table === "projects" ? { current_run_id: null } : undefined,
        );
      } catch {
        throw new SqliteToPostgresMigrationError(`Copy failed for table ${table}`);
      }
      counts[table] = copied.count;
      if (table === "projects") projectRows = copied.rows;
      if (table === "analysis_runs") {
        for (const project of projectRows) {
          if (project.current_run_id === null) continue;
          await client.query("UPDATE projects SET current_run_id = $1 WHERE id = $2", [
            project.current_run_id,
            project.id,
          ]);
        }
      }
    }
    await verifyCounts(client, counts);
    await client.query("COMMIT");
    return Object.freeze({ sourceSchemaVersion, counts: Object.freeze(counts), excludedSessions });
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SqliteToPostgresMigrationError) throw error;
    throw new SqliteToPostgresMigrationError();
  } finally {
    client?.release();
    source?.close();
  }
}
