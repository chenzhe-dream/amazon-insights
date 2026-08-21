import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";

test("Agent Service selects PostgreSQL storage and never falls back to SQLite on connection failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-pg-service-"));
  const sqlitePath = join(dir, "fallback.sqlite");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(
    createAgentService({
      env: {
        AGENT_DATABASE_URL:
          "postgresql://postgres:service-secret@127.0.0.1:1/agent",
        AGENT_SQLITE_PATH: sqlitePath,
        AGENT_SERVICE_PROXY_TOKEN: "postgres-agent-service-token",
        AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:3001",
        AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /service-secret/);
      return true;
    },
  );
  assert.equal(existsSync(sqlitePath), false);
});
