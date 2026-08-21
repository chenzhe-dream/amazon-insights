import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAgentDatabaseConfig,
  loadAgentStorageConfig,
} from "../../server/config";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";

test("agent storage config selects PostgreSQL only for explicit postgres URLs", () => {
  assert.deepEqual(
    loadAgentStorageConfig({
      AGENT_DATABASE_URL: "postgresql://user:pass@example.internal/app",
      AGENT_SQLITE_PATH: "data/ignored.sqlite",
    }),
    {
      kind: "postgres",
      databaseUrl: "postgresql://user:pass@example.internal/app",
    },
  );
  assert.deepEqual(
    loadAgentStorageConfig({
      AGENT_DATABASE_URL: "postgres://user:pass@example.internal/app",
      AGENT_SQLITE_PATH: "data/ignored.sqlite",
    }).kind,
    "postgres",
  );
});

test("agent storage config keeps SQLite compatibility when database URL is blank", () => {
  const sqlite = loadAgentStorageConfig({
    AGENT_DATABASE_URL: "   ",
    AGENT_SQLITE_PATH: "data/agent.sqlite",
    AGENT_SQLITE_BUSY_TIMEOUT_MS: "7000",
  });
  assert.equal(sqlite.kind, "sqlite");
  assert.deepEqual(
    sqlite,
    { kind: "sqlite", sqlite: loadAgentDatabaseConfig({
      AGENT_SQLITE_PATH: "data/agent.sqlite",
      AGENT_SQLITE_BUSY_TIMEOUT_MS: "7000",
    }) },
  );
});

test("agent storage config rejects non-PostgreSQL URLs without falling back", () => {
  assert.throws(
    () =>
      loadAgentStorageConfig({
        AGENT_DATABASE_URL: "mysql://user:pass@example.internal/app",
        AGENT_SQLITE_PATH: "data/agent.sqlite",
      }),
    /Agent storage configuration is invalid/,
  );
});

test("runtime repository factory fails PostgreSQL closed instead of falling back to SQLite", async () => {
  await assert.rejects(
    openRuntimeAgentRepository({
      kind: "postgres",
      databaseUrl: "postgresql://postgres:storage-secret@127.0.0.1:1/agent",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /storage-secret/);
      return true;
    },
  );
});
