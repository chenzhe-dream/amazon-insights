import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

const migrationsUrl = new URL("../migrations/postgres/", import.meta.url);
const migrationFilenamePattern = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const migrationLockId = "731553996872021104";

export interface AppliedPostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface MigrationFile extends AppliedPostgresMigration {
  readonly compatibleChecksums: readonly string[];
  readonly sql: string;
}

class PostgresMigrationError extends Error {}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function migrationSourceChecksums(sql: string): Readonly<{
  checksum: string;
  compatibleChecksums: readonly string[];
}> {
  const lfSql = sql.replaceAll("\r\n", "\n");
  const checksum = migrationChecksum(lfSql);
  return Object.freeze({
    checksum,
    compatibleChecksums: Object.freeze([
      checksum,
      migrationChecksum(lfSql.replaceAll("\n", "\r\n")),
      migrationChecksum(sql),
    ]),
  });
}

async function migrationFiles(): Promise<MigrationFile[]> {
  const filenames = (await readdir(migrationsUrl)).sort();
  const migrations = await Promise.all(
    filenames.map(async (filename): Promise<MigrationFile | null> => {
      const match = migrationFilenamePattern.exec(filename);
      if (!match) return null;
      const sql = await readFile(new URL(filename, migrationsUrl), "utf8");
      const checksums = migrationSourceChecksums(sql);
      return Object.freeze({
        version: Number(match[1]),
        name: match[2]!,
        ...checksums,
        sql,
      });
    }),
  );
  const selected = migrations.filter(
    (migration): migration is MigrationFile => migration !== null,
  );
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1]!.version >= selected[index]!.version) {
      throw new PostgresMigrationError(
        "PostgreSQL migration sources are not uniquely ordered",
      );
    }
  }
  return selected;
}

async function readAppliedMigrations(
  client: PoolClient,
): Promise<AppliedPostgresMigration[]> {
  const exists = await client.query<{ relation: string | null }>(
    "SELECT to_regclass('schema_migrations')::text AS relation",
  );
  if (!exists.rows[0]?.relation) return [];

  const applied = await client.query<{
    version: number;
    name: string;
    checksum: string;
  }>(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  return applied.rows.map((migration) => Object.freeze({ ...migration }));
}

function assertRecordedMigrationsMatch(
  available: MigrationFile[],
  applied: AppliedPostgresMigration[],
): void {
  if (applied.length > available.length) {
    throw new PostgresMigrationError(
      `PostgreSQL migration ${applied[available.length]!.version} does not match its recorded checksum`,
    );
  }
  for (const [index, recorded] of applied.entries()) {
    const source = available[index];
    if (
      !source ||
      source.version !== recorded.version ||
      source.name !== recorded.name ||
      !source.compatibleChecksums.includes(recorded.checksum)
    ) {
      throw new PostgresMigrationError(
        `PostgreSQL migration ${recorded.version} does not match its recorded checksum`,
      );
    }
  }
}

async function applyMigration(
  client: PoolClient,
  migration: MigrationFile,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new PostgresMigrationError(
      `PostgreSQL migration ${migration.version} failed`,
    );
  }
}

export async function runPostgresMigrations(
  pool: Pool,
): Promise<AppliedPostgresMigration[]> {
  let client: PoolClient | undefined;
  let locked = false;
  try {
    const available = await migrationFiles();
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [migrationLockId]);
    locked = true;

    let applied = await readAppliedMigrations(client);
    assertRecordedMigrationsMatch(available, applied);
    for (const migration of available.slice(applied.length)) {
      await applyMigration(client, migration);
    }

    applied = await readAppliedMigrations(client);
    assertRecordedMigrationsMatch(available, applied);
    return applied;
  } catch (error) {
    if (error instanceof PostgresMigrationError) {
      throw error;
    }
    throw new Error("PostgreSQL migration runner failed");
  } finally {
    if (locked && client) {
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [migrationLockId])
        .catch(() => undefined);
    }
    client?.release();
  }
}
