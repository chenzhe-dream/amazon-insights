import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as agentConfig from "../../server/config";
import {
  AlexaVocSnapshotRecordSchema,
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import {
  openSqliteAgentRepository,
  registerVocSnapshotIntegrityFunction,
} from "../../server/db/sqlite-repository";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { repositoryVocCandidateFixture } from "./helpers/voc-positioning-fixture";

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
const logicalLineageMigrationUrl = new URL(
  "../../server/db/migrations/0006_agent_run_logical_lineage.sql",
  import.meta.url,
);
const trafficSnapshotMigrationUrl = new URL(
  "../../server/db/migrations/0007_traffic_data_snapshot.sql",
  import.meta.url,
);
const connectorCredentialMigrationUrl = new URL(
  "../../server/db/migrations/0009_connector_credentials.sql",
  import.meta.url,
);
const feedbackMigrationUrl = new URL(
  "../../server/db/migrations/0010_user_feedback.sql",
  import.meta.url,
);
const helpFeedbackCenterMigrationUrl = new URL(
  "../../server/db/migrations/0014_help_feedback_center.sql",
  import.meta.url,
);
const manualAlexaVocMigrationUrl = new URL(
  "../../server/db/migrations/0019_manual_alexa_voc.sql",
  import.meta.url,
);
const vocSnapshotProvenanceMigrationUrl = new URL(
  "../../server/db/migrations/0020_voc_snapshot_per_asin_provenance.sql",
  import.meta.url,
);
const comparisonProjectScopeMigrationUrl = new URL(
  "../../server/db/migrations/0021_comparison_project_scope.sql",
  import.meta.url,
);
const sqliteMigrationsUrl = new URL(
  "../../server/db/migrations/",
  import.meta.url,
);

function applySqliteMigrationsBefore(
  database: DatabaseSync,
  exclusiveVersion: number,
): void {
  const migrations = readdirSync(sqliteMigrationsUrl)
    .map((filename) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
      return match
        ? { filename, version: Number(match[1]), name: match[2]! }
        : null;
    })
    .filter((migration): migration is NonNullable<typeof migration> =>
      migration !== null && migration.version < exclusiveVersion
    )
    .sort((left, right) => left.version - right.version);

  for (const migration of migrations) {
    const sql = readFileSync(new URL(migration.filename, sqliteMigrationsUrl), "utf8");
    database.exec(sql);
    database.prepare(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      migration.version,
      migration.name,
      createHash("sha256").update(sql).digest("hex"),
      "2026-08-31T00:00:00.000Z",
    );
  }
}

function insertSqliteManualAlexaVocRevision(
  database: DatabaseSync,
  overrides: Readonly<Partial<{
    organizationId: string;
    marketplace: string;
    asin: string;
    revision: number;
    contentHash: string;
    capturedAt: string;
    rawReportAlgVersion: string | null;
    rawReportKeyId: string | null;
    rawReportWrappedDek: Buffer | null;
    rawReportNonce: Buffer | null;
    rawReportCiphertext: Buffer | null;
    rawReportTag: Buffer | null;
    rawReportAadSha256: string | null;
    rawReportPlaintextBytes: number;
    createdBy: string;
    normalizedRecord: unknown;
    normalizedSchemaVersion: string;
    parserVersion: string;
  }>> = {},
): void {
  const input = {
    organizationId: "org-1",
    marketplace: "US",
    asin: "B07VY9Q95Q",
    revision: 1,
    contentHash: "a".repeat(64),
    capturedAt: "2026-08-31T01:00:00.000Z",
    rawReportAlgVersion: null,
    rawReportKeyId: null,
    rawReportWrappedDek: null,
    rawReportNonce: null,
    rawReportCiphertext: null,
    rawReportTag: null,
    rawReportAadSha256: null,
    rawReportPlaintextBytes: 128,
    createdBy: "user-1",
    normalizedRecord: {
      asin: "B07VY9Q95Q",
      captureStatus: "dialog",
    },
    normalizedSchemaVersion: "1.0.0",
    parserVersion: "1.0.0",
    ...overrides,
  };
  database.prepare(
    `INSERT INTO manual_alexa_voc_revisions
       (organization_id, marketplace, asin, revision, content_hash, captured_at,
        normalized_record, normalized_schema_version, parser_version,
        raw_report_sha256, raw_report_alg_version, raw_report_key_id,
        raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
        raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
        created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.organizationId,
    input.marketplace,
    input.asin,
    input.revision,
    input.contentHash,
    input.capturedAt,
    JSON.stringify(input.normalizedRecord),
    input.normalizedSchemaVersion,
    input.parserVersion,
    "b".repeat(64),
    input.rawReportAlgVersion,
    input.rawReportKeyId,
    input.rawReportWrappedDek,
    input.rawReportNonce,
    input.rawReportCiphertext,
    input.rawReportTag,
    input.rawReportAadSha256,
    input.rawReportPlaintextBytes,
    input.createdBy,
    input.capturedAt,
  );
}

function sqliteRepositoryVocSnapshotFixture(dataCutoffAt: string) {
  const record = AlexaVocSnapshotRecordSchema.parse({
    asin: "B07VY9Q95Q",
    attention: ["durability"],
    positives: ["stable"],
    negatives: ["heavy"],
    unmet: ["lighter"],
    audiences: ["commuters"],
    scenarios: ["daily travel"],
    motives: ["reliability"],
    captureStatus: "dialog",
    alexaReport: {
      title: "Buyer summary",
      asin: "B07VY9Q95Q",
      rating: 4.2,
      reviewCount: 10,
      prompt: "Summarize buyer feedback",
      overallConclusion: "Buyers value stability.",
      captureStatus: "dialog",
    },
  });
  const contentHash = canonicalJsonSha256(record);
  return buildVocSnapshotCandidate({
    marketplace: "US",
    asins: [record.asin],
    dataCutoffAt,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.manualAlexaVocRepository,
      marketplace: "US",
      capturedAt: dataCutoffAt,
      records: [record],
      recordProvenance: [{
        asin: record.asin,
        revision: "1",
        contentHash,
        source: "repository",
        generation: null,
        capturedAt: dataCutoffAt,
        normalizedSchemaVersion: "alexa-voc-record/v2",
        parserVersion: "deterministic-alexa-parser/v3",
      }],
    }],
  });
}

function assertSqliteManualAlexaVocSchema(
  database: DatabaseSync,
  label: string,
): void {
  const tableNames = new Set(
    (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map(({ name }) => name),
  );
  for (const table of [
    "manual_alexa_voc_revisions",
    "manual_alexa_voc_heads",
    "manual_alexa_voc_publication_outbox",
    "manual_alexa_voc_access_audit",
    "run_creation_idempotency",
  ]) {
    assert.equal(tableNames.has(table), true, `${label}: ${table}`);
  }

  const timestamp = "2026-08-31T01:00:00.000Z";
  database.prepare(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('user-1', 'org-1', 'owner@example.test', 'Owner', 'admin', 'active', ?, ?),
            ('user-2', 'org-2', 'other@example.test', 'Other', 'admin', 'active', ?, ?)`,
  ).run(timestamp, timestamp, timestamp, timestamp);

  assert.throws(
    () => insertSqliteManualAlexaVocRevision(database, {
      revision: 2,
      createdBy: "user-2",
    }),
    /FOREIGN KEY/,
    `${label}: tenant owner`,
  );
  assert.throws(
    () => insertSqliteManualAlexaVocRevision(database, { marketplace: "CA" }),
    /CHECK/,
    `${label}: marketplace`,
  );
  assert.throws(
    () => insertSqliteManualAlexaVocRevision(database, {
      revision: 2,
      rawReportPlaintextBytes: 0,
    }),
    /CHECK/,
    `${label}: plaintext bytes`,
  );
  assert.throws(
    () => insertSqliteManualAlexaVocRevision(database, {
      revision: 2,
      rawReportAlgVersion: "AES-256-GCM/v1",
      rawReportKeyId: "key-1",
    }),
    /CHECK/,
    `${label}: encrypted field coherence`,
  );
  assert.throws(
    () => insertSqliteManualAlexaVocRevision(database, {
      revision: 2,
      rawReportAlgVersion: "AES-256-GCM/v1",
      rawReportKeyId: "key-1",
      rawReportWrappedDek: Buffer.from("wrapped"),
      rawReportNonce: Buffer.alloc(12, 1),
      rawReportCiphertext: Buffer.alloc(135_169),
      rawReportTag: Buffer.alloc(16, 2),
      rawReportAadSha256: "c".repeat(64),
    }),
    /CHECK/,
    `${label}: ciphertext bytes`,
  );

  insertSqliteManualAlexaVocRevision(database);
  assert.equal(
    (database.prepare(
      `SELECT CAST(revision AS TEXT) AS revision
         FROM manual_alexa_voc_revisions
        WHERE organization_id = 'org-1' AND marketplace = 'US'
          AND asin = 'B07VY9Q95Q'`,
    ).get() as { revision: string }).revision,
    "1",
    `${label}: bigint-compatible revision retrieval`,
  );
  assert.throws(
    () => database.prepare(
      `INSERT INTO manual_alexa_voc_heads
         (organization_id, marketplace, asin, latest_revision,
          latest_content_hash, latest_captured_at, generation, updated_at)
       VALUES ('org-1', 'US', 'B07VY9Q95Q', 1, ?, ?, 1, ?)`,
    ).run("f".repeat(64), timestamp, timestamp),
    /FOREIGN KEY/,
    `${label}: head tuple`,
  );
  database.prepare(
    `INSERT INTO manual_alexa_voc_heads
       (organization_id, marketplace, asin, latest_revision,
        latest_content_hash, latest_captured_at, generation, updated_at)
     VALUES ('org-1', 'US', 'B07VY9Q95Q', 1, ?, ?, 1, ?)`,
  ).run("a".repeat(64), timestamp, timestamp);

  insertSqliteManualAlexaVocRevision(database, {
    revision: 2,
    contentHash: "d".repeat(64),
    rawReportAlgVersion: "AES-256-GCM/v1",
    rawReportKeyId: "key-1",
    rawReportWrappedDek: Buffer.from("wrapped"),
    rawReportNonce: Buffer.alloc(12, 3),
    rawReportCiphertext: Buffer.from("ciphertext"),
    rawReportTag: Buffer.alloc(16, 4),
    rawReportAadSha256: "e".repeat(64),
  });
  assert.throws(
    () => insertSqliteManualAlexaVocRevision(database, {
      revision: 3,
      contentHash: "f".repeat(64),
      rawReportAlgVersion: "AES-256-GCM/v1",
      rawReportKeyId: "key-1",
      rawReportWrappedDek: Buffer.from("wrapped-again"),
      rawReportNonce: Buffer.alloc(12, 3),
      rawReportCiphertext: Buffer.from("ciphertext-again"),
      rawReportTag: Buffer.alloc(16, 5),
      rawReportAadSha256: "1".repeat(64),
    }),
    /UNIQUE/,
    `${label}: nonce uniqueness`,
  );

  database.prepare(
    `INSERT INTO manual_alexa_voc_publication_outbox
       (id, organization_id, marketplace, asin, revision, content_hash,
        captured_at, generation, status, available_at, lease_generation,
        attempt_count, created_at, updated_at)
     VALUES ('outbox-revision-1', 'org-1', 'US', 'B07VY9Q95Q', 1, ?, ?, 1,
             'pending', ?, 0, 2147483647, ?, ?)`,
  ).run("a".repeat(64), timestamp, timestamp, timestamp, timestamp);
  assert.throws(
    () => database.prepare(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, created_at, updated_at)
       VALUES ('outbox-revision-1-again', 'org-1', 'US', 'B07VY9Q95Q', 1,
               ?, ?, 2, 'pending', ?, 0, 0, ?, ?)`,
    ).run("a".repeat(64), timestamp, timestamp, timestamp, timestamp),
    /UNIQUE/,
    `${label}: outbox revision/hash uniqueness ignores generation`,
  );
  assert.throws(
    () => database.prepare(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, created_at, updated_at)
       VALUES ('outbox-attempt-overflow', 'org-1', 'US', 'B07VY9Q95Q', 2,
               ?, ?, 2, 'pending', ?, 0, 2147483648, ?, ?)`,
    ).run("d".repeat(64), timestamp, timestamp, timestamp, timestamp),
    /CHECK/,
    `${label}: outbox attempt count matches PostgreSQL integer range`,
  );
  assert.throws(
    () => database.prepare(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, applied_at, created_at, updated_at)
       VALUES ('outbox-published', 'org-1', 'US', 'B07VY9Q95Q', 2,
               ?, ?, 2, 'published', ?, 0, 0, ?, ?, ?)`,
    ).run(
      "d".repeat(64),
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ),
    /CHECK/,
    `${label}: published is not a legal outbox terminal status`,
  );
  assert.throws(
    () => database.prepare(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, created_at, updated_at)
       VALUES ('outbox-invalid', 'org-1', 'US', 'B07VY9Q95Q', 2,
               ?, ?, 2, 'invalid', ?, 0, 0, ?, ?)`,
    ).run("d".repeat(64), timestamp, timestamp, timestamp, timestamp),
    /CHECK/,
    `${label}: invalid outbox status`,
  );
  database.prepare(
    `INSERT INTO manual_alexa_voc_publication_outbox
       (id, organization_id, marketplace, asin, revision, content_hash,
        captured_at, generation, status, available_at, lease_generation,
        attempt_count, applied_at, created_at, updated_at)
     VALUES ('outbox-applied', 'org-1', 'US', 'B07VY9Q95Q', 2,
             ?, ?, 2, 'applied', ?, 0, 0, ?, ?, ?)`,
  ).run(
    "d".repeat(64),
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );

  const snapshotCandidate = repositoryVocCandidateFixture(
    ["B07VY9Q95Q"],
    timestamp,
  );
  for (const chain of [
    { organizationId: "org-1", userId: "user-1", projectId: "project-a", runId: "run-a", snapshotId: "snapshot-a" },
    { organizationId: "org-2", userId: "user-2", projectId: "project-b", runId: "run-b", snapshotId: "snapshot-b" },
  ] as const) {
    database.prepare(
      `INSERT INTO projects
         (id, organization_id, name, marketplace, asins_json, created_by,
          created_at, updated_at)
       VALUES (?, ?, ?, 'US', '["B07VY9Q95Q"]', ?, ?, ?)`,
    ).run(
      chain.projectId,
      chain.organizationId,
      chain.projectId,
      chain.userId,
      timestamp,
      timestamp,
    );
    database.prepare(
      `INSERT INTO analysis_runs
         (id, project_id, mode, status, created_by, data_cutoff_at,
          idempotency_scope, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'existing-data', 'running', ?, ?, ?, 'create', ?, ?)`,
    ).run(
      chain.runId,
      chain.projectId,
      chain.userId,
      timestamp,
      `manual-alexa:${chain.runId}`,
      timestamp,
      timestamp,
    );
    database.prepare(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
          asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
          created_at)
       VALUES (?, ?, 'voc', 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chain.snapshotId,
      chain.runId,
      snapshotCandidate.schemaVersion,
      snapshotCandidate.marketplace,
      JSON.stringify(snapshotCandidate.asins),
      snapshotCandidate.dataCutoffAt,
      JSON.stringify(snapshotCandidate.sources),
      JSON.stringify(snapshotCandidate.payload),
      snapshotCandidate.contentHash,
      timestamp,
    );
  }

  const insertIdempotency = (
    idempotencyKey: string,
    organizationId: string,
    projectId: string,
    runId: string | null,
    snapshotId: string | null,
    completedAt: string | null,
  ) => database.prepare(
    `INSERT INTO run_creation_idempotency
       (organization_id, idempotency_key, request_fingerprint, project_id,
        run_id, snapshot_id, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    organizationId,
    idempotencyKey,
    createHash("sha256").update(idempotencyKey).digest("hex"),
    projectId,
    runId,
    snapshotId,
    timestamp,
    completedAt,
  );
  assert.throws(
    () => insertIdempotency(
      "cross-organization",
      "org-1",
      "project-b",
      "run-b",
      "snapshot-b",
      timestamp,
    ),
    /FOREIGN KEY/,
    `${label}: organization cannot reference another tenant run`,
  );
  assert.throws(
    () => insertIdempotency(
      "cross-project-run",
      "org-1",
      "project-a",
      "run-b",
      null,
      null,
    ),
    /FOREIGN KEY/,
    `${label}: run belongs to idempotency project`,
  );
  assert.throws(
    () => insertIdempotency(
      "cross-run-snapshot",
      "org-1",
      "project-a",
      "run-a",
      "snapshot-b",
      timestamp,
    ),
    /FOREIGN KEY/,
    `${label}: snapshot belongs to idempotency run`,
  );
  assert.throws(
    () => insertIdempotency(
      "partial-snapshot",
      "org-1",
      "project-a",
      "run-a",
      "snapshot-a",
      null,
    ),
    /CHECK/,
    `${label}: snapshot state cannot be partially completed`,
  );
  assert.throws(
    () => insertIdempotency(
      "partial-completion",
      "org-1",
      "project-a",
      "run-a",
      null,
      timestamp,
    ),
    /CHECK/,
    `${label}: completed state requires snapshot`,
  );
  insertIdempotency("pending", "org-1", "project-a", null, null, null);
  insertIdempotency("running", "org-1", "project-a", "run-a", null, null);
  insertIdempotency(
    "completed",
    "org-1",
    "project-a",
    "run-a",
    "snapshot-a",
    timestamp,
  );

  const cutoffIndex = database.prepare(
    `SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'manual_alexa_voc_revisions_cutoff_idx'`,
  ).get() as { sql: string } | undefined;
  assert.match(
    cutoffIndex?.sql ?? "",
    /captured_at DESC[\s\S]*revision DESC/i,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

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

test("the logical lineage migration bounds report publication recovery", () => {
  const sql = readFileSync(logicalLineageMigrationUrl, "utf8");
  assert.match(sql, /report_publication_attempt_count INTEGER/i);
  assert.match(sql, /report_publication_retry_at TEXT/i);
  assert.match(sql, /job_attempts_report_publication_state_update/i);
  assert.match(sql, /OLD\.status IS 'failed'/i);
  assert.match(sql, /NEW\.status IS 'queued'/i);
});

test("the forward traffic snapshot migration isolates immutable traffic artifacts", () => {
  assert.equal(existsSync(trafficSnapshotMigrationUrl), true);

  const sql = readFileSync(trafficSnapshotMigrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE data_snapshots ADD COLUMN artifact_kind TEXT/i);
  assert.match(sql, /artifact_kind IN \('legacy', 'voc', 'traffic'\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX data_snapshots_traffic_semantic_identity_idx\b/i);
  assert.match(sql, /WHERE artifact_kind = 'traffic'/i);
  assert.match(sql, /CREATE TRIGGER data_snapshots_traffic_insert_consistency\b/i);
  assert.match(sql, /NEW\.artifact_kind = 'traffic'/i);
  assert.match(sql, /data snapshots are immutable/i);
});

test("manual Alexa VOC migration enforces equivalent fresh-install and upgrade constraints", () => {
  assert.equal(existsSync(manualAlexaVocMigrationUrl), true);

  for (const mode of ["fresh", "upgrade"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `manual-alexa-voc-${mode}-`));
    const path = join(directory, "agent.sqlite");
    let database: DatabaseSync | undefined;
    try {
      if (mode === "upgrade") {
        database = new DatabaseSync(path);
        database.exec("PRAGMA foreign_keys = ON");
        registerVocSnapshotIntegrityFunction(database);
        applySqliteMigrationsBefore(database, 19);
        database.close();
        database = undefined;
      }

      const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
      repository.close();
      database = new DatabaseSync(path);
      registerVocSnapshotIntegrityFunction(database);
      database.exec("PRAGMA foreign_keys = ON");
      assertSqliteManualAlexaVocSchema(database, mode);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("forward VOC provenance migration replaces the 0005 insert gate without rewriting history", () => {
  assert.equal(existsSync(vocSnapshotProvenanceMigrationUrl), true);
  const sql = readFileSync(vocSnapshotProvenanceMigrationUrl, "utf8");
  assert.match(sql, /DROP TRIGGER data_snapshots_insert_consistency/i);
  assert.match(sql, /CREATE TRIGGER data_snapshots_insert_consistency/i);
  assert.match(sql, /repository:\/\/manual-alexa-voc\/selected-revisions/i);
  assert.match(sql, /recordProvenance/i);
  assert.match(sql, /voc_snapshot_integrity/i);
});

test("comparison project scope migration supports fresh install and actual 0020 upgrade", () => {
  assert.equal(existsSync(comparisonProjectScopeMigrationUrl), true);
  const sql = readFileSync(comparisonProjectScopeMigrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE project_creation_idempotency\b/i);
  assert.match(sql, /PRIMARY KEY \(organization_id, idempotency_key\)/i);
  assert.match(sql, /CREATE TABLE legacy_project_owner_bindings\b/i);
  assert.match(sql, /legacy_project_id TEXT PRIMARY KEY/i);

  for (const mode of ["fresh", "upgrade"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `comparison-project-scope-${mode}-`));
    const path = join(directory, "agent.sqlite");
    try {
      if (mode === "upgrade") {
        const database = new DatabaseSync(path);
        database.exec("PRAGMA foreign_keys = ON");
        registerVocSnapshotIntegrityFunction(database);
        applySqliteMigrationsBefore(database, 21);
        assert.equal(
          (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
            version: number;
          }).version,
          20,
        );
        database.close();
      }

      const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
      assert.equal(repository.listAppliedMigrations().at(-1)?.version, 22);
      repository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("SQLite upgrades an actual 0019 schema to strict 0020 provenance constraints", () => {
  const directory = mkdtempSync(join(tmpdir(), "voc-provenance-upgrade-"));
  const path = join(directory, "agent.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    registerVocSnapshotIntegrityFunction(database);
    applySqliteMigrationsBefore(database, 20);
    assert.equal(
      (database.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number }).version,
      19,
    );
    database.close();
    database = undefined;

    const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    assert.deepEqual(repository.listAppliedMigrations().find(({ version }) => version === 20), {
      version: 20,
      name: "voc_snapshot_per_asin_provenance",
      checksum: createHash("sha256")
        .update(readFileSync(vocSnapshotProvenanceMigrationUrl, "utf8"))
        .digest("hex"),
    });
    assert.equal(repository.listAppliedMigrations().at(-1)?.version, 22);
    repository.close();
    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    registerVocSnapshotIntegrityFunction(database);

    const cutoff = "2026-08-31T08:00:00.000Z";
    const candidate = sqliteRepositoryVocSnapshotFixture(cutoff);
    const record = candidate.payload.records.alexaVoc[0]!;
    const provenance = candidate.sources[0]!.recordProvenance![0]!;
    database.prepare(
      `INSERT INTO users
         (id, organization_id, email, display_name, role, status,
          created_at, updated_at)
       VALUES ('upgrade-user', 'upgrade-org', 'upgrade@example.test',
               'Upgrade owner', 'admin', 'active', ?, ?)`,
    ).run(cutoff, cutoff);
    database.prepare(
      `INSERT INTO projects
         (id, organization_id, name, marketplace, asins_json, created_by,
          created_at, updated_at)
       VALUES ('upgrade-project', 'upgrade-org', 'Upgrade project', 'US', ?,
               'upgrade-user', ?, ?)`,
    ).run(JSON.stringify(candidate.asins), cutoff, cutoff);
    insertSqliteManualAlexaVocRevision(database, {
      organizationId: "upgrade-org",
      asin: record.asin,
      contentHash: provenance.contentHash,
      capturedAt: cutoff,
      createdBy: "upgrade-user",
      normalizedRecord: record,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
    });
    const insertCandidate = (
      snapshotId: string,
      runId: string,
      value: typeof candidate,
    ) => database!.prepare(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version,
          marketplace, asins_json, data_cutoff_at, sources_json, payload_json,
          content_hash, created_at)
       VALUES (?, ?, 'voc', 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshotId,
      runId,
      value.schemaVersion,
      value.marketplace,
      JSON.stringify(value.asins),
      value.dataCutoffAt,
      JSON.stringify(value.sources),
      JSON.stringify(value.payload),
      value.contentHash,
      cutoff,
    );
    const createRun = (runId: string) => database!.prepare(
      `INSERT INTO analysis_runs
         (id, project_id, mode, status, created_by, data_cutoff_at,
          idempotency_scope, idempotency_key, created_at, updated_at)
       VALUES (?, 'upgrade-project', 'existing-data', 'running',
               'upgrade-user', ?, ?, 'create', ?, ?)`,
    ).run(runId, cutoff, `snapshot:${runId}`, cutoff, cutoff);

    createRun("upgrade-run-valid");
    insertCandidate("upgrade-snapshot-valid", "upgrade-run-valid", candidate);
    const invalidCases = [
      { name: "rewritten-revision", field: "revision", value: "2" },
      { name: "missing-revision", field: "revision", remove: true },
      { name: "null-revision", field: "revision", value: null },
      { name: "missing-parser", field: "parserVersion", remove: true },
      { name: "null-parser", field: "parserVersion", value: null },
      {
        name: "missing-schema",
        field: "normalizedSchemaVersion",
        remove: true,
      },
      { name: "null-schema", field: "normalizedSchemaVersion", value: null },
    ] as const;
    for (const invalidCase of invalidCases) {
      const tampered = structuredClone(candidate);
      const source = tampered.sources[0]!;
      const recordProvenance = source.recordProvenance!;
      const tamperedProvenance = recordProvenance[0] as unknown as Record<
        string,
        unknown
      >;
      if ("remove" in invalidCase && invalidCase.remove) {
        Reflect.deleteProperty(tamperedProvenance, invalidCase.field);
      } else {
        Reflect.set(
          tamperedProvenance,
          invalidCase.field,
          Reflect.get(invalidCase, "value"),
        );
      }
      Reflect.set(source, "checksum", canonicalJsonSha256({
        sourceId: "alexa-voc",
        marketplace: tampered.marketplace,
        records: tampered.payload.records.alexaVoc,
        recordProvenance,
      }));
      Reflect.set(tampered, "contentHash", canonicalJsonSha256({
        schemaVersion: tampered.schemaVersion,
        marketplace: tampered.marketplace,
        asins: tampered.asins,
        dataCutoffAt: tampered.dataCutoffAt,
        sources: tampered.sources,
        payload: tampered.payload,
      }));
      const runId = `upgrade-run-${invalidCase.name}`;
      createRun(runId);
      assert.throws(
        () => insertCandidate(
          `upgrade-snapshot-${invalidCase.name}`,
          runId,
          tampered,
        ),
        (error: unknown) => error instanceof Error,
        invalidCase.name,
      );
    }
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the connector credential migration versions one active secret and seals audit history", (t) => {
  assert.equal(existsSync(connectorCredentialMigrationUrl), true);

  const sql = readFileSync(connectorCredentialMigrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE connector_credentials\b/i);
  assert.match(sql, /CREATE UNIQUE INDEX connector_credentials_active_idx\b/i);
  assert.match(sql, /WHERE status = 'active'/i);
  assert.match(sql, /CREATE TRIGGER audit_events_update_immutable\b/i);
  assert.match(sql, /CREATE TRIGGER audit_events_delete_immutable\b/i);

  const directory = mkdtempSync(join(tmpdir(), "connector-credential-migration-"));
  const path = join(directory, "agent.sqlite");
  const database = new DatabaseSync(path);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(migrationUrl, "utf8"));
  database.exec(sql);
  const timestamp = "2026-08-19T08:00:00.000Z";
  database.prepare(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`,
  ).run("admin-1", "org-1", "admin@example.com", "Admin", timestamp, timestamp);
  database.prepare(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`,
  ).run("admin-2", "org-2", "admin-2@example.com", "Other Admin", timestamp, timestamp);

  assert.throws(() =>
    database.prepare(
      `INSERT INTO connector_credentials
         (id, organization_id, connector, version, status, ciphertext, nonce,
          auth_tag, key_id, created_by, created_at)
       VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(
      "cross-org-create",
      "org-1",
      "sorftime",
      Buffer.from("ciphertext"),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      "master-v1",
      "admin-2",
      timestamp,
    ),
  );
  assert.equal(
    (database.prepare(
      "SELECT COUNT(*) AS count FROM connector_credentials WHERE id = 'cross-org-create'",
    ).get() as { count: number }).count,
    0,
  );
  database.prepare(
    `INSERT INTO connector_credentials
       (id, organization_id, connector, version, status, ciphertext, nonce,
        auth_tag, key_id, created_by, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    "credential-1",
    "org-1",
    "sif",
    1,
    Buffer.from("ciphertext"),
    Buffer.alloc(12, 1),
    Buffer.alloc(16, 2),
    "master-v1",
    "admin-1",
    timestamp,
  );

  assert.throws(() =>
    database.prepare(
      `UPDATE connector_credentials
       SET status = 'revoked', revoked_by = 'admin-2', revoked_at = ?
       WHERE id = 'credential-1'`,
    ).run(timestamp),
  );
  assert.deepEqual(
    { ...database.prepare(
      "SELECT status, revoked_by, revoked_at FROM connector_credentials WHERE id = 'credential-1'",
    ).get() },
    { status: "active", revoked_by: null, revoked_at: null },
  );

  assert.throws(() =>
    database.prepare(
      `INSERT INTO connector_credentials
         (id, organization_id, connector, version, status, ciphertext, nonce,
          auth_tag, key_id, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(
      "credential-2",
      "org-1",
      "sif",
      2,
      Buffer.from("ciphertext-2"),
      Buffer.alloc(12, 3),
      Buffer.alloc(16, 4),
      "master-v1",
      "admin-1",
      timestamp,
    ),
  );

  database.prepare(
    `UPDATE connector_credentials
     SET status = 'revoked', revoked_by = ?, revoked_at = ?
     WHERE id = ?`,
  ).run("admin-1", timestamp, "credential-1");
  database.prepare(
    `INSERT INTO connector_credentials
       (id, organization_id, connector, version, status, ciphertext, nonce,
        auth_tag, key_id, created_by, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    "credential-2",
    "org-1",
    "sif",
    2,
    Buffer.from("ciphertext-2"),
    Buffer.alloc(12, 3),
    Buffer.alloc(16, 4),
    "master-v1",
    "admin-1",
    timestamp,
  );
  assert.equal(
    (database.prepare(
      "SELECT COUNT(*) AS count FROM connector_credentials WHERE organization_id = ? AND connector = ? AND status = 'active'",
    ).get("org-1", "sif") as { count: number }).count,
    1,
  );

  assert.throws(() =>
    database.prepare("DELETE FROM connector_credentials WHERE id = 'credential-2'").run(),
  );
  assert.throws(() =>
    database.prepare(
      "UPDATE connector_credentials SET ciphertext = ? WHERE id = 'credential-2'",
    ).run(Buffer.from("tampered")),
  );

  const malformed = [
    { id: "bad-ciphertext", version: 3, status: "active", ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyId: "master-v1" },
    { id: "bad-nonce", version: 3, status: "active", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(11), authTag: Buffer.alloc(16), keyId: "master-v1" },
    { id: "bad-tag", version: 3, status: "active", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(15), keyId: "master-v1" },
    { id: "bad-key", version: 3, status: "active", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyId: "" },
    { id: "bad-status", version: 3, status: "unknown", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyId: "master-v1" },
    { id: "bad-version", version: 0, status: "active", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyId: "master-v1" },
  ] as const;
  for (const candidate of malformed) {
    assert.throws(() =>
      database.prepare(
        `INSERT INTO connector_credentials
           (id, organization_id, connector, version, status, ciphertext, nonce,
            auth_tag, key_id, created_by, created_at)
         VALUES (?, 'org-1', 'sellerSprite', ?, ?, ?, ?, ?, ?, 'admin-1', ?)`,
      ).run(
        candidate.id,
        candidate.version,
        candidate.status,
        candidate.ciphertext,
        candidate.nonce,
        candidate.authTag,
        candidate.keyId,
        timestamp,
      ),
      candidate.id,
    );
  }
  assert.equal(
    (database.prepare(
      "SELECT COUNT(*) AS count FROM connector_credentials WHERE connector = 'sellerSprite'",
    ).get() as { count: number }).count,
    0,
  );

  database.prepare(
    `INSERT INTO audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id,
        metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run("audit-1", "org-1", "admin-1", "connector.credential-rotated", "connector", "sif", timestamp);
  assert.throws(() =>
    database.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = 'audit-1'").run(),
  );
  assert.throws(() =>
    database.prepare("DELETE FROM audit_events WHERE id = 'audit-1'").run(),
  );
});

test("the help feedback migration backfills workflow, seals history, and stores bounded BLOB attachments", (t) => {
  assert.equal(existsSync(helpFeedbackCenterMigrationUrl), true);
  const directory = mkdtempSync(join(tmpdir(), "help-feedback-migration-"));
  const database = new DatabaseSync(join(directory, "agent.sqlite"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(migrationUrl, "utf8"));
  database.exec(readFileSync(connectorCredentialMigrationUrl, "utf8"));
  database.exec(readFileSync(feedbackMigrationUrl, "utf8"));
  const timestamp = "2026-08-20T00:00:00.000Z";
  const userId = "10000000-0000-4000-8000-000000000014";
  const organizationId = "20000000-0000-4000-8000-000000000014";
  const feedbackId = "30000000-0000-4000-8000-000000000014";
  database.prepare(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, 'member@example.test', 'Member', 'member', 'active', ?, ?)`,
  ).run(userId, organizationId, timestamp, timestamp);
  database.prepare(
    `INSERT INTO user_feedback
       (id, organization_id, actor_user_id, category, title, description,
        page_path, app_version, created_at)
     VALUES (?, ?, ?, 'bug', 'Legacy feedback', 'Preserve me', '/projects', NULL, ?)`,
  ).run(feedbackId, organizationId, userId, timestamp);

  database.exec(readFileSync(helpFeedbackCenterMigrationUrl, "utf8"));

  assert.deepEqual(
    { ...database.prepare(
      "SELECT status, admin_seen_at, version, updated_at FROM user_feedback_workflow WHERE feedback_id = ?",
    ).get(feedbackId) },
    { status: "new", admin_seen_at: null, version: 1, updated_at: timestamp },
  );
  assert.deepEqual(
    { ...database.prepare(
      "SELECT id, event_type, from_status, to_status, created_at FROM user_feedback_events WHERE feedback_id = ?",
    ).get(feedbackId) },
    {
      id: feedbackId,
      event_type: "created",
      from_status: null,
      to_status: "new",
      created_at: timestamp,
    },
  );
  assert.throws(() => database.prepare(
    "UPDATE user_feedback_events SET to_status = 'closed' WHERE feedback_id = ?",
  ).run(feedbackId), /immutable/i);
  assert.throws(() => database.prepare(
    "DELETE FROM user_feedback_events WHERE feedback_id = ?",
  ).run(feedbackId), /immutable/i);
  assert.throws(() => database.prepare(
    `INSERT INTO user_feedback_events
       (id, feedback_id, organization_id, actor_user_id, event_type,
        from_status, to_status, created_at)
     VALUES ('no-op', ?, ?, ?, 'status_changed', 'new', 'new', ?)`,
  ).run(feedbackId, organizationId, userId, timestamp));

  const attachment = Buffer.from([0, 1, 2, 255]);
  database.prepare(
    `INSERT INTO user_feedback_attachments
       (id, feedback_id, organization_id, created_by_user_id, file_name,
        media_type, byte_size, sha256, image_content, created_at)
     VALUES ('attachment-1', ?, ?, ?, 'evidence.png', 'image/png', ?, ?, ?, ?)`,
  ).run(
    feedbackId,
    organizationId,
    userId,
    attachment.byteLength,
    "a".repeat(64),
    attachment,
    timestamp,
  );
  const storedAttachment = database.prepare(
    "SELECT image_content FROM user_feedback_attachments WHERE id = 'attachment-1'",
  ).get() as { image_content: Uint8Array };
  assert.deepEqual(Buffer.from(storedAttachment.image_content), attachment);
  assert.equal(
    (database.prepare("PRAGMA table_info(user_feedback_attachments)").all() as Array<{
      name: string;
      type: string;
    }>).find(({ name }) => name === "image_content")?.type,
    "BLOB",
  );
  assert.throws(() => database.prepare(
    `INSERT INTO user_feedback_attachments
       (id, feedback_id, organization_id, created_by_user_id, file_name,
        media_type, byte_size, sha256, image_content, created_at)
     VALUES ('attachment-bad-size', ?, ?, ?, 'bad.png', 'image/png', 5, ?, ?, ?)`,
  ).run(feedbackId, organizationId, userId, "b".repeat(64), attachment, timestamp));

  for (const [table, index] of [
    ["user_feedback_workflow", "user_feedback_workflow_unread_idx"],
    ["user_feedback_workflow", "user_feedback_workflow_status_idx"],
    ["user_feedback_events", "user_feedback_events_feedback_created_idx"],
    ["user_feedback_attachments", "user_feedback_attachments_feedback_idx"],
  ] as const) {
    assert.ok(
      (database.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).some(
        ({ name }) => name === index,
      ),
    );
  }
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
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

  const candidate = repositoryVocCandidateFixture(
    JSON.parse(asins) as string[],
    timestamp,
  );
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

test("SQLite 0022 preserves populated stage children and admits paired normalization inputs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "alexa-normalization-0022-"));
  const path = join(directory, "agent.sqlite");
  t.after(() => rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  }));
  const timestamp = "2026-09-01T00:00:00.000Z";
  const legacy = new DatabaseSync(path);
  registerVocSnapshotIntegrityFunction(legacy);
  applySqliteMigrationsBefore(legacy, 22);
  legacy.exec(`
    INSERT INTO users
      (id, organization_id, email, display_name, role, status, created_at, updated_at)
    VALUES ('user-0022', 'org-0022', 'migration-0022@example.test', 'Migration',
            'member', 'active', '${timestamp}', '${timestamp}');
    INSERT INTO projects
      (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
    VALUES ('project-0022', 'org-0022', 'Migration', 'US', '["B07VY9Q95Q"]',
            'user-0022', '${timestamp}', '${timestamp}');
    INSERT INTO analysis_runs
      (id, project_id, mode, status, created_by, data_cutoff_at,
       idempotency_scope, idempotency_key, created_at, updated_at)
    VALUES ('run-0022', 'project-0022', 'existing-data', 'queued', 'user-0022',
            '${timestamp}', 'migration-0022', 'create', '${timestamp}', '${timestamp}');
    INSERT INTO run_stages
      (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
    VALUES ('stage-0022', 'run-0022', 'voc-positioning', 'queued', 0, 0,
            '${timestamp}', '${timestamp}');
    INSERT INTO job_attempts
      (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
       logical_execution_cycle_id, status, available_at, lease_generation,
       retryable, report_publication_cycle, report_publication_attempt_count,
       created_at, updated_at)
    VALUES ('job-0022', 'stage-0022', 1, 3, 1,
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'queued', '${timestamp}', 0, 0, 1, 0, '${timestamp}', '${timestamp}');
    INSERT INTO data_snapshots
      (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
       asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
       created_at)
    VALUES ('traffic-0022', 'run-0022', NULL, 'traffic', '1.0.0', 'US',
            '["B07VY9Q95Q"]', '${timestamp}', '[{},{}]',
            '{"input":{"kind":"competitor-traffic-analysis-input","marketplace":"US","dataCutoffAt":"${timestamp}"}}',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            '${timestamp}');
  `);
  legacy.close();

  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  repository.close();
  const inspector = new DatabaseSync(path);
  registerVocSnapshotIntegrityFunction(inspector);
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM job_attempts WHERE id = 'job-0022'").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM data_snapshots WHERE id = 'traffic-0022'").get() as { count: number }).count,
    1,
  );
  inspector.prepare(
    `INSERT INTO run_stages
      (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
     VALUES ('normalization-stage-0022', 'run-0022', 'alexa-voc-normalization',
             'queued', 0, 0, ?, ?)`,
  ).run(timestamp, timestamp);
  inspector.prepare(
    `INSERT INTO data_snapshots
      (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
       asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
       created_at)
     VALUES ('normalization-input-0022', 'run-0022',
             'alexa-voc-normalization-input', 'alexa-voc-normalization-input',
             '1.0.0', 'US', '["B07VY9Q95Q"]', ?, '[]', '{}', ?, ?)`,
  ).run(timestamp, "c".repeat(64), timestamp);
  assert.throws(
    () => inspector.prepare(
      `INSERT INTO data_snapshots
        (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
         asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
         created_at)
       VALUES ('normalization-mismatch-0022', 'run-0022',
               'alexa-voc-normalization-input', 'voc', '1.0.0', 'US',
               '["B07VY9Q95Q"]', ?, '[]', '{}', ?, ?)`,
    ).run(timestamp, "d".repeat(64), timestamp),
    /artifact kind is inconsistent/i,
  );
  assert.deepEqual(inspector.prepare("PRAGMA foreign_key_check").all(), []);
  inspector.close();
});

test("SQLite 0022 aborts and remains unapplied when foreign_key_check finds a child violation", () => {
  const directory = mkdtempSync(join(tmpdir(), "alexa-normalization-0022-fk-"));
  const path = join(directory, "agent.sqlite");
  const timestamp = "2026-09-01T00:00:00.000Z";
  try {
    const legacy = new DatabaseSync(path);
    applySqliteMigrationsBefore(legacy, 22);
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      INSERT INTO job_attempts
        (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
         logical_execution_cycle_id, status, available_at, lease_generation,
         retryable, report_publication_cycle, report_publication_attempt_count,
         created_at, updated_at)
      VALUES ('orphan-job-0022', 'missing-stage-0022', 1, 3, 1,
              'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
              'queued', '${timestamp}', 0, 0, 1, 0, '${timestamp}', '${timestamp}');
    `);
    legacy.close();

    assert.throws(
      () => openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 }),
      /foreign key check failed.*job_attempts.*run_stages/i,
    );
    const inspector = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      inspector.prepare("SELECT 1 FROM schema_migrations WHERE version = 22").get(),
      undefined,
    );
    inspector.close();
  } finally {
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});
