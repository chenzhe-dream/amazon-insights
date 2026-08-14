import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as agentConfig from "../../server/config";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import { registerVocSnapshotIntegrityFunction } from "../../server/db/sqlite-repository";

const migrationUrl = new URL(
  "../../server/db/migrations/0001_agent_runtime.sql",
  import.meta.url,
);
const budgetMigrationUrl = new URL(
  "../../server/db/migrations/0003_model_budget_ledger.sql",
  import.meta.url,
);
const retryMigrationUrl = new URL(
  "../../server/db/migrations/0002_job_retry_cycles.sql",
  import.meta.url,
);
const agentRunAuditMigrationUrl = new URL(
  "../../server/db/migrations/0004_agent_run_audit.sql",
  import.meta.url,
);
const vocSnapshotMigrationUrl = new URL(
  "../../server/db/migrations/0005_voc_data_snapshot.sql",
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

test("the forward AgentRun audit migration normalizes provenance and completion", () => {
  assert.equal(existsSync(agentRunAuditMigrationUrl), true);

  const sql = readFileSync(agentRunAuditMigrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE agent_runs ADD COLUMN execution_fingerprint TEXT/i);
  assert.match(sql, /ALTER TABLE agent_runs ADD COLUMN output_schema_digest TEXT/i);
  assert.match(sql, /ALTER TABLE agent_runs ADD COLUMN usage_completeness TEXT/i);
  assert.match(sql, /ALTER TABLE agent_runs ADD COLUMN attempts_json TEXT/i);
  assert.match(sql, /ALTER TABLE model_budget_reservations ADD COLUMN attempt_kind TEXT/i);
  assert.match(sql, /ALTER TABLE model_budget_reservations ADD COLUMN transient_retry_count INTEGER/i);
  assert.match(sql, /ALTER TABLE model_budget_reservations ADD COLUMN format_repair INTEGER/i);
  assert.match(sql, /ALTER TABLE model_budget_reservations ADD COLUMN response_id TEXT/i);
  assert.match(sql, /CREATE TABLE agent_run_snapshots\b/i);
  assert.match(sql, /CREATE UNIQUE INDEX agent_runs_job_attempt_idx\b/i);
  assert.match(sql, /CREATE TRIGGER agent_runs_completed_immutable\b/i);
  assert.match(sql, /CREATE TRIGGER agent_runs_delete_immutable\b/i);
});

test("the forward VOC snapshot migration enforces identity and immutability", () => {
  assert.equal(existsSync(vocSnapshotMigrationUrl), true);

  const sql = readFileSync(vocSnapshotMigrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE data_snapshots ADD COLUMN snapshot_kind TEXT/i);
  assert.match(sql, /CREATE UNIQUE INDEX data_snapshots_semantic_identity_idx\b/i);
  assert.match(
    sql,
    /ON data_snapshots\s*\(run_id, schema_version, marketplace, asins_json, data_cutoff_at\)/i,
  );
  assert.match(sql, /WHERE snapshot_kind = 'voc'/i);
  assert.match(sql, /CREATE TRIGGER data_snapshots_insert_consistency\b/i);
  assert.match(sql, /CREATE TRIGGER data_snapshots_legacy_insert_closed\b/i);
  assert.match(sql, /CREATE TRIGGER data_snapshots_update_immutable\b/i);
  assert.match(sql, /CREATE TRIGGER data_snapshots_delete_immutable\b/i);
  assert.match(sql, /snapshot sources exceed cutoff/i);
  assert.match(sql, /data snapshots are immutable/i);
});

test("duplicate legacy snapshots and AgentRun links survive migration 0005 and reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-legacy-upgrade-"));
  const path = join(directory, "agent.sqlite");
  let database = new DatabaseSync(path);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(migrationUrl, "utf8"));
  database.exec(readFileSync(retryMigrationUrl, "utf8"));
  database.exec(readFileSync(budgetMigrationUrl, "utf8"));
  const timestamp = "2026-08-15T08:00:00.000Z";
  const asins = '["B09V5RW2VK","B07VY9Q95Q","B0BPXRVWYK"]';
  database.exec(`
    INSERT INTO users
      (id, organization_id, email, display_name, role, status, created_at, updated_at)
    VALUES ('legacy-user', 'legacy-org', 'legacy-voc@example.com', 'Legacy VOC',
            'member', 'active', '${timestamp}', '${timestamp}');
    INSERT INTO projects
      (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
    VALUES
      ('legacy-project', 'legacy-org', 'Legacy VOC', 'US', '${asins}',
       'legacy-user', '${timestamp}', '${timestamp}'),
      ('orphan-project', 'legacy-org', 'Unlinked legacy VOC', 'US', '${asins}',
       'legacy-user', '${timestamp}', '${timestamp}');
    INSERT INTO analysis_runs
      (id, project_id, mode, status, created_by, data_cutoff_at,
       idempotency_scope, idempotency_key, created_at, updated_at)
    VALUES ('legacy-run', 'legacy-project', 'existing-data', 'running', 'legacy-user',
            '${timestamp}', 'legacy-voc-upgrade', 'create', '${timestamp}', '${timestamp}'),
           ('orphan-run', 'orphan-project', 'existing-data', 'running', 'legacy-user',
            '${timestamp}', 'orphan-voc-upgrade', 'create', '${timestamp}', '${timestamp}');
    INSERT INTO run_stages
      (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
    VALUES ('legacy-stage', 'legacy-run', 'voc-positioning', 'running', 50, 1,
            '${timestamp}', '${timestamp}');
    INSERT INTO skill_versions
      (id, skill_id, version, content_hash, manifest_json, created_at)
    VALUES ('legacy-skill', 'legacy-voc', '1.0.0', 'legacy-content', '{}', '${timestamp}');
    INSERT INTO data_snapshots
      (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
       sources_json, payload_json, content_hash, created_at)
    VALUES
      ('legacy-snapshot-a', 'legacy-run', '1.0.0', 'US', '${asins}', '${timestamp}',
       '[]', '{}', 'legacy-hash-a', '${timestamp}'),
      ('legacy-snapshot-b', 'legacy-run', '1.0.0', 'US', '${asins}', '${timestamp}',
       '[]', '{}', 'legacy-hash-b', '${timestamp}'),
      ('orphan-snapshot', 'orphan-run', '1.0.0', 'US', '${asins}', '${timestamp}',
       '[]', '{}', 'orphan-hash', '${timestamp}');
    INSERT INTO agent_runs
      (id, run_id, stage_id, skill_version_id, schema_version, snapshot_ids_json,
       provider, model, input_summary_json, output_schema_version,
       validation_status, data_cutoff_at, started_at)
    VALUES ('legacy-agent-run', 'legacy-run', 'legacy-stage', 'legacy-skill', '1.0.0',
            '["legacy-snapshot-a"]', 'legacy', 'legacy', '{}', '1.0.0',
            'pending', '${timestamp}', '${timestamp}');
  `);
  database.exec(readFileSync(agentRunAuditMigrationUrl, "utf8"));
  database.exec(
    "INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal) " +
      "VALUES ('legacy-agent-run', 'legacy-snapshot-a', 0)",
  );

  assert.doesNotThrow(() =>
    database.exec(readFileSync(vocSnapshotMigrationUrl, "utf8")),
  );
  database.close();
  database = new DatabaseSync(path);
  registerVocSnapshotIntegrityFunction(database);
  database.exec("PRAGMA foreign_keys = ON");

  assert.deepEqual(
    database
      .prepare(
        "SELECT id, snapshot_kind FROM data_snapshots ORDER BY id",
      )
      .all()
      .map((row) => ({
        id: String((row as Record<string, unknown>).id),
        snapshot_kind: (row as Record<string, unknown>).snapshot_kind,
      })),
    [
      { id: "legacy-snapshot-a", snapshot_kind: null },
      { id: "legacy-snapshot-b", snapshot_kind: null },
      { id: "orphan-snapshot", snapshot_kind: null },
    ],
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT agent_run_id, snapshot_id, ordinal FROM agent_run_snapshots",
      )
      .all()
      .map((row) => ({
        agent_run_id: String((row as Record<string, unknown>).agent_run_id),
        snapshot_id: String((row as Record<string, unknown>).snapshot_id),
        ordinal: Number((row as Record<string, unknown>).ordinal),
      })),
    [
      {
        agent_run_id: "legacy-agent-run",
        snapshot_id: "legacy-snapshot-a",
        ordinal: 0,
      },
    ],
  );

  const candidate = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins: JSON.parse(asins) as string[],
    dataCutoffAt: timestamp,
  }).candidate;
  assert.ok(candidate);
  database
    .prepare(
      `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
        data_cutoff_at, sources_json, payload_json, content_hash, created_at)
       VALUES ('valid-voc-snapshot', 'legacy-run', 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidate.schemaVersion,
      candidate.marketplace,
      JSON.stringify(candidate.asins),
      candidate.dataCutoffAt,
      JSON.stringify(candidate.sources),
      JSON.stringify(candidate.payload),
      candidate.contentHash,
      timestamp,
    );

  const expectRejected = (label: string, operation: () => void) => {
    database.exec("SAVEPOINT snapshot_kind_guard");
    let error: unknown;
    try {
      operation();
    } catch (caught) {
      error = caught;
    } finally {
      database.exec("ROLLBACK TO snapshot_kind_guard");
      database.exec("RELEASE snapshot_kind_guard");
    }
    assert.ok(error, `${label} must be rejected after migration 0005`);
  };

  expectRejected("new NULL-kind garbage insert", () => {
    database.exec(`
      INSERT INTO data_snapshots
        (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
         data_cutoff_at, sources_json, payload_json, content_hash, created_at)
      VALUES ('post-migration-null', 'legacy-run', NULL, 'garbage', 'ZZ', '[]',
              'not-a-date', '[]', '{}', 'garbage', '${timestamp}')
    `);
  });
  expectRejected("unlinked legacy snapshot delete", () => {
    database.exec("DELETE FROM data_snapshots WHERE id = 'orphan-snapshot'");
  });
  expectRejected("legacy snapshot AnalysisRun cascade", () => {
    database.exec("DELETE FROM analysis_runs WHERE id = 'orphan-run'");
  });
  expectRejected("legacy snapshot Project cascade", () => {
    database.exec("DELETE FROM projects WHERE id = 'orphan-project'");
  });
  expectRejected("legacy NULL to voc", () => {
    database.exec(
      "UPDATE data_snapshots SET snapshot_kind = 'voc' WHERE id = 'legacy-snapshot-a'",
    );
  });
  expectRejected("legacy NULL to another kind", () => {
    database.exec(
      "UPDATE data_snapshots SET snapshot_kind = 'review' WHERE id = 'legacy-snapshot-a'",
    );
  });
  expectRejected("legacy payload update", () => {
    database.exec(
      `UPDATE data_snapshots SET payload_json = '{"garbage":true}'
       WHERE id = 'legacy-snapshot-a'`,
    );
  });
  expectRejected("legacy identity update", () => {
    database.exec(
      `UPDATE data_snapshots SET marketplace = 'CA'
       WHERE id = 'legacy-snapshot-a'`,
    );
  });
  expectRejected("VOC to NULL", () => {
    database.exec(
      "UPDATE data_snapshots SET snapshot_kind = NULL WHERE id = 'valid-voc-snapshot'",
    );
  });
  expectRejected("VOC to another kind", () => {
    database.exec(
      "UPDATE data_snapshots SET snapshot_kind = 'review' WHERE id = 'valid-voc-snapshot'",
    );
  });
  expectRejected("VOC payload update", () => {
    database.exec(
      `UPDATE data_snapshots SET payload_json = '{"garbage":true}'
       WHERE id = 'valid-voc-snapshot'`,
    );
  });

  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS count FROM data_snapshots WHERE id = 'post-migration-null'")
        .get() as { count: number }
    ).count,
    0,
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT id, snapshot_kind FROM data_snapshots ORDER BY id",
      )
      .all()
      .map((row) => ({
        id: String((row as Record<string, unknown>).id),
        snapshot_kind: (row as Record<string, unknown>).snapshot_kind,
      })),
    [
      { id: "legacy-snapshot-a", snapshot_kind: null },
      { id: "legacy-snapshot-b", snapshot_kind: null },
      { id: "orphan-snapshot", snapshot_kind: null },
      { id: "valid-voc-snapshot", snapshot_kind: "voc" },
    ],
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT p.id AS project_id, r.id AS run_id
         FROM projects p
         JOIN analysis_runs r ON r.project_id = p.id
         WHERE p.id = 'orphan-project'`,
      )
      .all()
      .map((row) => ({
        project_id: String((row as Record<string, unknown>).project_id),
        run_id: String((row as Record<string, unknown>).run_id),
      })),
    [{ project_id: "orphan-project", run_id: "orphan-run" }],
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT agent_run_id, snapshot_id, ordinal FROM agent_run_snapshots",
      )
      .all()
      .map((row) => ({
        agent_run_id: String((row as Record<string, unknown>).agent_run_id),
        snapshot_id: String((row as Record<string, unknown>).snapshot_id),
        ordinal: Number((row as Record<string, unknown>).ordinal),
      })),
    [
      {
        agent_run_id: "legacy-agent-run",
        snapshot_id: "legacy-snapshot-a",
        ordinal: 0,
      },
    ],
  );
});

test("legacy duplicate AgentRuns for one job upgrade through migration 0004", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-legacy-upgrade-"));
  const path = join(directory, "agent.sqlite");
  const database = new DatabaseSync(path);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec(readFileSync(migrationUrl, "utf8"));
  database.exec(readFileSync(retryMigrationUrl, "utf8"));
  database.exec(readFileSync(budgetMigrationUrl, "utf8"));
  database.exec(`
    INSERT INTO users
      (id, organization_id, email, display_name, role, status, created_at, updated_at)
    VALUES
      ('legacy-user', 'legacy-org', 'legacy@example.com', 'Legacy', 'member', 'active',
       '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:00.000Z');
    INSERT INTO projects
      (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
    VALUES
      ('legacy-project', 'legacy-org', 'Legacy', 'US', '[]', 'legacy-user',
       '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:00.000Z');
    INSERT INTO analysis_runs
      (id, project_id, mode, status, created_by, data_cutoff_at,
       idempotency_scope, idempotency_key, created_at, updated_at)
    VALUES
      ('legacy-run', 'legacy-project', 'existing-data', 'failed', 'legacy-user',
       '2026-08-15T08:00:00.000Z', 'legacy-upgrade', 'create',
       '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:00.000Z');
    INSERT INTO run_stages
      (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
    VALUES
      ('legacy-stage', 'legacy-run', 'voc-positioning', 'failed', 100, 1,
       '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:00.000Z');
    INSERT INTO job_attempts
      (id, stage_id, attempt_number, max_attempts, status, available_at,
       created_at, updated_at)
    VALUES
      ('legacy-job', 'legacy-stage', 1, 3, 'failed', '2026-08-15T08:00:00.000Z',
       '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:00.000Z');
    INSERT INTO skill_versions
      (id, skill_id, version, content_hash, manifest_json, created_at)
    VALUES
      ('legacy-skill', 'legacy', '1.0.0', 'legacy-hash', '{}',
       '2026-08-15T08:00:00.000Z');
  `);
  const insertLegacy = database.prepare(
    `INSERT INTO agent_runs
     (id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
      snapshot_ids_json, provider, model, input_summary_json,
      output_schema_version, validation_status, data_cutoff_at, started_at)
     VALUES (?, 'legacy-run', 'legacy-stage', 'legacy-job', 'legacy-skill', '1.0.0',
             '[]', 'legacy', 'legacy', '{}', '1.0.0', 'failed', ?, ?)`,
  );
  const timestamp = "2026-08-15T08:00:00.000Z";
  insertLegacy.run("legacy-agent-run-a", timestamp, timestamp);
  insertLegacy.run("legacy-agent-run-b", timestamp, timestamp);

  assert.doesNotThrow(() =>
    database.exec(readFileSync(agentRunAuditMigrationUrl, "utf8")),
  );
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
