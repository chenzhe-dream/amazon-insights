import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import test from "node:test";

import * as agentConfig from "../../server/config";

const migrationUrl = new URL(
  "../../server/db/migrations/0001_agent_runtime.sql",
  import.meta.url,
);

test("SQLite configuration requires an explicit database path", () => {
  assert.equal(typeof agentConfig.loadAgentDatabaseConfig, "function");

  assert.throws(
    () => agentConfig.loadAgentDatabaseConfig({}),
    /AGENT_SQLITE_PATH/i,
  );

  const config = agentConfig.loadAgentDatabaseConfig({
    AGENT_SQLITE_PATH: "data/agent.sqlite",
  });

  assert.equal(isAbsolute(config.path), true);
  assert.equal(config.busyTimeoutMs, 5_000);
});

test("the initial versioned migration declares every runtime table", () => {
  assert.equal(existsSync(migrationUrl), true);

  const sql = readFileSync(migrationUrl, "utf8");
  const requiredTables = [
    "schema_migrations",
    "users",
    "sessions",
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
  ];

  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`, "i"));
  }
});
