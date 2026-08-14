import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as agentConfig from "../../server/config";

const migrationUrl = new URL(
  "../../server/db/migrations/0001_agent_runtime.sql",
  import.meta.url,
);
const budgetMigrationUrl = new URL(
  "../../server/db/migrations/0003_model_budget_ledger.sql",
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

test("the next migration adds a dedicated persistent model budget ledger", () => {
  assert.equal(existsSync(budgetMigrationUrl), true);

  const sql = readFileSync(budgetMigrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE model_budget_reservations\b/i);
  assert.match(sql, /projected_cost_micros INTEGER NOT NULL/i);
  assert.match(sql, /actual_cost_micros INTEGER/i);
  assert.match(sql, /CHECK \(state IN \('reserved', 'dispatched', 'settled', 'released'\)\)/i);
  assert.match(sql, /CREATE INDEX model_budget_reservations_run_idx\b/i);
  assert.match(sql, /CREATE INDEX model_budget_reservations_org_day_idx\b/i);
  assert.match(sql, /CREATE INDEX model_budget_reservations_expiry_idx\b/i);
});

test("the domain repository contract excludes SQLite diagnostics and lifecycle", () => {
  const source = readFileSync(
    new URL("../../server/db/repository.ts", import.meta.url),
    "utf8",
  );
  const contract = source.slice(source.indexOf("export interface AgentRepository"));

  assert.doesNotMatch(contract, /getConnectionDiagnostics/);
  assert.doesNotMatch(contract, /listAppliedMigrations/);
  assert.doesNotMatch(contract, /\bclose\s*\(/);
  assert.doesNotMatch(source, /StorageConnectionDiagnostics|AppliedMigration/);
});

test("analysis reports reject updates and deletes at the database boundary", async (t) => {
  const { openSqliteAgentRepository } = await import(
    "../../server/db/sqlite-repository"
  );
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-report-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  repository.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  const now = "2026-08-14T08:00:00.000Z";
  database
    .prepare(
      `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
       VALUES ('user-1', 'org-1', 'report@example.com', 'Report', 'member', 'active', ?, ?)`,
    )
    .run(now, now);
  database
    .prepare(
      `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
       VALUES ('project-1', 'org-1', 'Report test', 'US', '["B0ABC12345"]', 'user-1', ?, ?)`,
    )
    .run(now, now);
  database
    .prepare(
      `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
       VALUES ('run-1', 'project-1', 'existing-data', 'succeeded', 'user-1', ?,
               'report-test', 'create', ?, ?)`,
    )
    .run(now, now, now);
  database
    .prepare(
      `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
       VALUES ('stage-1', 'run-1', 'traffic-analysis', 'succeeded', 100, 1, ?, ?)`,
    )
    .run(now, now);
  database
    .prepare(
      `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
       VALUES ('skill-version-1', 'traffic-analysis', '1.0.0', 'hash-1', '{}', ?)`,
    )
    .run(now);
  database
    .prepare(
      `INSERT INTO agent_runs
       (id, run_id, stage_id, skill_version_id, schema_version,
        snapshot_ids_json, provider, model, input_summary_json,
        output_schema_version, output_json, validation_status,
        data_cutoff_at, started_at, completed_at)
       VALUES ('agent-run-1', 'run-1', 'stage-1', 'skill-version-1', '1',
               '[]', 'test', 'test', '{}', '1', '{}', 'passed', ?, ?, ?)`,
    )
    .run(now, now, now);
  database
    .prepare(
      `INSERT INTO analysis_reports
       (id, run_id, agent_run_id, version, stage, schema_version, status,
        snapshot_ids_json, evidence_json, result_json, data_cutoff_at, created_at)
       VALUES ('report-1', 'run-1', 'agent-run-1', 1, 'traffic-analysis', '1',
               'complete', '[]', '{}', '{}', ?, ?)`,
    )
    .run(now, now);

  assert.throws(
    () =>
      database
        .prepare("UPDATE analysis_reports SET status = 'stale' WHERE id = 'report-1'")
        .run(),
    /analysis reports are immutable/i,
  );
  assert.throws(
    () =>
      database.prepare("DELETE FROM analysis_reports WHERE id = 'report-1'").run(),
    /analysis reports are immutable/i,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM analysis_reports").get() as {
      count: number;
    }).count,
    1,
  );
  database.close();
});
