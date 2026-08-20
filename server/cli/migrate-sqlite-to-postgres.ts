import { Pool } from "pg";

import { migrateSqliteToPostgres } from "../db/migrate-sqlite-to-postgres";
import { runPostgresMigrations } from "../db/postgres/migrations";

export async function runSqliteToPostgresCli(
  args = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
    throw new Error("Usage: migrate-sqlite-to-postgres <sqlite-path>");
  }
  if (!env.AGENT_DATABASE_URL) throw new Error("AGENT_DATABASE_URL is required");
  const pool = new Pool({ connectionString: env.AGENT_DATABASE_URL });
  try {
    await runPostgresMigrations(pool);
    const result = await migrateSqliteToPostgres({ sqlitePath: args[0], pool });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runSqliteToPostgresCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`);
    process.exitCode = 1;
  });
}
