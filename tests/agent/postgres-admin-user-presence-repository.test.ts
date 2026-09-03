import { randomUUID } from "node:crypto";
import { after, before } from "node:test";

import type { Pool, PoolClient } from "pg";

import type {
  AdminUserPresenceHeartbeatInput,
  AdminUserPresenceHeartbeatResult,
} from "../../server/db/admin-user-presence-repository";
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
  const transitions = new Set<PoolClient>();
  return {
    repository,
    async inspectLastSeenAt(sessionId: string) {
      const result = await inspector.query<{ last_seen_at: Date | null }>(
        "SELECT last_seen_at FROM sessions WHERE id = $1",
        [sessionId],
      );
      return result.rows[0]?.last_seen_at?.toISOString() ?? null;
    },
    async beginRevocationTransition(input: AdminUserPresenceHeartbeatInput) {
      const client = await inspector.connect();
      transitions.add(client);
      let finished = false;
      let heartbeat: Promise<AdminUserPresenceHeartbeatResult> | undefined;
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE sessions SET revoked_at = $2 WHERE id = $1",
          [input.sessionId, "2026-08-31T11:59:59.000Z"],
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        transitions.delete(client);
        throw error;
      }
      const finish = async (command: "COMMIT" | "ROLLBACK") => {
        if (finished) return;
        finished = true;
        try {
          await client.query(command);
        } finally {
          client.release();
          transitions.delete(client);
        }
      };
      return {
        startHeartbeat() {
          heartbeat ??= repository.adminUserPresence.recordHeartbeat(input);
          return heartbeat;
        },
        async waitUntilHeartbeatBlocked() {
          const deadline = Date.now() + 2_000;
          while (true) {
            const blocked = await inspector.query<{ blocked: boolean }>(
              `SELECT EXISTS (
                 SELECT 1
                   FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND pid <> pg_backend_pid()
                    AND query LIKE '%WITH target AS MATERIALIZED%'
                    AND wait_event_type = 'Lock'
               ) AS blocked`,
            );
            if (blocked.rows[0]?.blocked) return;
            if (Date.now() >= deadline) {
              throw new Error("PostgreSQL heartbeat did not block on revocation row lock");
            }
            await delay(10);
          }
        },
        commit: () => finish("COMMIT"),
        close: () => finish("ROLLBACK"),
      };
    },
    async close() {
      await Promise.allSettled([...transitions].map(async (client) => {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }));
      transitions.clear();
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
