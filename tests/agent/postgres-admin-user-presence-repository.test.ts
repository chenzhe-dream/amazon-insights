import { randomUUID } from "node:crypto";
import { after, before } from "node:test";

import type { Pool } from "pg";

import { openPostgresAgentRepository } from "../../server/db/postgres-repository";
import { registerAdminUserPresenceRepositoryContract } from "./helpers/admin-user-presence-repository-contract";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres.close();
});

registerAdminUserPresenceRepositoryContract("PostgreSQL", async () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const repository = await openPostgresAgentRepository({
    connectionString: databaseUrl(postgres.pool, schema),
  });
  const inspector = postgres.createPool({ searchPath: schema });
  return {
    repository,
    async inspectLastSeenAt(sessionId: string) {
      const result = await inspector.query<{ last_seen_at: Date | null }>(
        "SELECT last_seen_at FROM sessions WHERE id = $1",
        [sessionId],
      );
      return result.rows[0]?.last_seen_at?.toISOString() ?? null;
    },
    async close() {
      await Promise.all([repository.close(), inspector.end()]);
    },
  };
});

function databaseUrl(pool: Pool, schema: string) {
  const options = pool.options as {
    host?: string;
    port?: number;
    user?: string;
    database?: string;
  };
  const url = new URL("postgresql://localhost");
  url.hostname = options.host ?? "127.0.0.1";
  url.port = String(options.port);
  url.username = options.user ?? "postgres";
  url.pathname = `/${options.database}`;
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
