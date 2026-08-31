import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { registerAdminUserPresenceRepositoryContract } from "./helpers/admin-user-presence-repository-contract";

registerAdminUserPresenceRepositoryContract("SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-presence-sqlite-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  return {
    repository,
    async inspectLastSeenAt(sessionId: string) {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const row = database
          .prepare("SELECT last_seen_at FROM sessions WHERE id = ?")
          .get(sessionId) as { last_seen_at: string | null } | undefined;
        return row?.last_seen_at ?? null;
      } finally {
        database.close();
      }
    },
    async close() {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});
