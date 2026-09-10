import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { buildKeywordAnalysisSnapshotCandidate } from "../../server/data/keyword-analysis-snapshot";
import { buildTrafficSnapshotCandidate } from "../../server/data/traffic-data-snapshot";
import {
  AlexaVocSnapshotRecordSchema,
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { buildDeterministicTrafficInput } from "../../server/domain/traffic/traffic-analysis-contracts";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

let postgres: PostgresTestContainer;

const MIGRATIONS_URL = new URL(
  "../../server/db/migrations/postgres/",
  import.meta.url,
);
const POSTGRES_MIGRATIONS_THROUGH_CONCURRENCY = [
  [1, "agent_runtime"],
  [2, "job_retry_cycles"],
  [3, "model_budget_ledger"],
  [4, "agent_run_audit"],
  [5, "voc_data_snapshot"],
  [6, "agent_run_logical_lineage"],
  [7, "traffic_data_snapshot"],
  [8, "keyword_analysis_snapshot"],
  [9, "connector_credentials"],
  [10, "user_feedback"],
  [11, "sync_job_queue"],
  [12, "concurrency_control"],
  [13, "concurrency_admin_controls"],
] as const;
const POSTGRES_MIGRATIONS_THROUGH_FEEDBACK = [
  ...POSTGRES_MIGRATIONS_THROUGH_CONCURRENCY,
  [14, "help_feedback_center"],
] as const;
const POSTGRES_MIGRATIONS_THROUGH_STAGE_OUTPUTS = [
  ...POSTGRES_MIGRATIONS_THROUGH_FEEDBACK,
  [15, "sync_run_stage_partial"],
  [16, "sync_stage_outputs"],
] as const;
const POSTGRES_MIGRATIONS_THROUGH_IMAGE_REMARK = [
  ...POSTGRES_MIGRATIONS_THROUGH_STAGE_OUTPUTS,
  [17, "category_transient_retry"],
  [18, "image_remark_concurrency"],
] as const;
const POSTGRES_MIGRATIONS_THROUGH_MANUAL_VOC = [
  ...POSTGRES_MIGRATIONS_THROUGH_IMAGE_REMARK,
  [19, "manual_alexa_voc"],
] as const;
const POSTGRES_MIGRATIONS_THROUGH_VOC_PROVENANCE = [
  ...POSTGRES_MIGRATIONS_THROUGH_MANUAL_VOC,
  [20, "voc_snapshot_per_asin_provenance"],
] as const;
const POSTGRES_MIGRATIONS_THROUGH_DINGTALK = [
  ...POSTGRES_MIGRATIONS_THROUGH_VOC_PROVENANCE,
  [21, "comparison_project_scope"],
  [22, "alexa_voc_normalization_stage"],
  [23, "alexa_voc_agent_run_budget"],
  [24, "alexa_voc_normalization_attempts"],
  [25, "sync_stage_partial_outputs"],
  [26, "dingtalk_authentication"],
] as const;
const TRAFFIC_ASINS = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"] as const;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

async function freshSchemaPool(): Promise<Pool> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  return postgres.createPool({ searchPath: schema });
}

async function applyPostgresMigrationSource(
  pool: Pool,
  version: number,
  name: string,
  transformSql: (sql: string) => string = (sql) => sql,
): Promise<void> {
  const filename = `${String(version).padStart(4, "0")}_${name}.sql`;
  const sql = transformSql(
    await readFile(new URL(filename, MIGRATIONS_URL), "utf8"),
  );
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [version, name, createHash("sha256").update(sql).digest("hex")],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function vocSnapshotFixture(dataCutoffAt: string) {
  const marketplace = "US";
  const asins = ["B000000001"];
  const alexaVoc = [
    {
      asin: asins[0],
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
        asin: asins[0],
        rating: 4.2,
        reviewCount: 10,
        prompt: "Summarize buyer feedback",
        overallConclusion: "Buyers value stability.",
        captureStatus: "dialog",
      },
    },
  ];
  const payload = {
    schemaVersion: "1.0.0",
    kind: "voc",
    marketplace,
    asins,
    records: {
      alexaVoc,
      sorftimeReviewAnalysis: [],
      sellerSpriteReviewAnalysis: [],
    },
  };
  const sources = [
    {
      type: "manual-voc",
      reference: "app/rufus-voc-data.ts#rufusVocData",
      marketplace,
      capturedAt: dataCutoffAt,
      checksum: canonicalJsonSha256({
        sourceId: "alexa-voc",
        marketplace,
        records: alexaVoc,
      }),
    },
  ];
  const hashInput = {
    schemaVersion: "1.0.0",
    marketplace,
    asins,
    dataCutoffAt,
    sources,
    payload,
  };
  return { ...hashInput, contentHash: canonicalJsonSha256(hashInput) };
}

function trafficSnapshotFixture(dataCutoffAt: string) {
  const input = buildDeterministicTrafficInput({
    marketplace: "US",
    asins: TRAFFIC_ASINS,
    dataCutoffAt,
  });
  return buildTrafficSnapshotCandidate({
    asins: TRAFFIC_ASINS,
    trafficInput: input,
  });
}

function keywordSnapshotFixture(dataCutoffAt: string) {
  return buildKeywordAnalysisSnapshotCandidate({
    marketplace: "US",
    asins: TRAFFIC_ASINS,
    dataCutoffAt,
    groups: [{
      id: "portable-demand",
      label: "Portable demand",
      keywords: ["portable scooter"],
      demand: "high",
      trend: "stable",
      seasonality: "non-seasonal",
      evidenceIds: ["keyword-evidence-1"],
    }],
    evidence: [{
      id: "keyword-evidence-1",
      sourceId: "sif-keyword-analysis",
      capturedAt: dataCutoffAt,
      searchVolume: 1200,
      purchaseRate: 0.22,
    }],
  });
}

async function seedSnapshotRun(
  pool: Pool,
  input: Readonly<{
    userId?: string;
    organizationId?: string;
    projectId?: string;
    runId?: string;
    asins?: readonly string[];
    cutoff: string;
  }>,
) {
  const userId = input.userId ?? `user-${randomUUID()}`;
  const organizationId = input.organizationId ?? `org-${randomUUID()}`;
  const projectId = input.projectId ?? `project-${randomUUID()}`;
  const runId = input.runId ?? `run-${randomUUID()}`;
  const asins = input.asins ?? TRAFFIC_ASINS;
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Snapshot actor', 'admin', 'active', $4, $4)`,
    [userId, organizationId, `${userId}@example.com`, input.cutoff],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ($1, $2, 'Snapshot project', 'US', $3::jsonb, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify(asins), userId, input.cutoff],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, 'existing-data', 'running', $3, $4,
             $5, 'create', $4, $4)`,
    [runId, projectId, userId, input.cutoff, `snapshot:${runId}`],
  );
  return { userId, organizationId, projectId, runId, asins };
}

async function insertVocSnapshot(
  pool: Pool,
  input: Readonly<{ id: string; runId: string; dataCutoffAt: string }>,
) {
  const snapshot = vocSnapshotFixture(input.dataCutoffAt);
  const hasArtifactKind = (
    await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'data_snapshots'
            AND column_name = 'artifact_kind'
       ) AS exists`,
    )
  ).rows[0]?.exists === true;
  if (hasArtifactKind) {
    await pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
          asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
          created_at)
       VALUES ($1, $2, 'voc', 'voc', $3, $4, $5, $6, $7, $8, $9, $6)`,
      [
        input.id,
        input.runId,
        snapshot.schemaVersion,
        snapshot.marketplace,
        JSON.stringify(snapshot.asins),
        input.dataCutoffAt,
        JSON.stringify(snapshot.sources),
        JSON.stringify(snapshot.payload),
        snapshot.contentHash,
      ],
    );
    return;
  }
  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
        data_cutoff_at, sources_json, payload_json, content_hash, created_at)
     VALUES ($1, $2, 'voc', $3, $4, $5, $6, $7, $8, $9, $6)`,
    [
      input.id,
      input.runId,
      snapshot.schemaVersion,
      snapshot.marketplace,
      JSON.stringify(snapshot.asins),
      input.dataCutoffAt,
      JSON.stringify(snapshot.sources),
      JSON.stringify(snapshot.payload),
      snapshot.contentHash,
    ],
  );
}

function repositoryVocSnapshotFixture(dataCutoffAt: string) {
  const legacy = vocSnapshotFixture(dataCutoffAt);
  const record = AlexaVocSnapshotRecordSchema.parse(
    legacy.payload.records.alexaVoc[0],
  );
  const contentHash = canonicalJsonSha256(record);
  return buildVocSnapshotCandidate({
    marketplace: legacy.marketplace,
    asins: legacy.asins,
    dataCutoffAt,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.manualAlexaVocRepository,
      marketplace: legacy.marketplace,
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

async function insertPostgresManualAlexaVocRevision(
  pool: Pool,
  overrides: Readonly<Partial<{
    organizationId: string;
    marketplace: string;
    asin: string;
    revision: string;
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
  }>> = {},
): Promise<void> {
  const input = {
    organizationId: "org-1",
    marketplace: "US",
    asin: "B07VY9Q95Q",
    revision: "1",
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
    ...overrides,
  };
  await pool.query(
    `INSERT INTO manual_alexa_voc_revisions
       (organization_id, marketplace, asin, revision, content_hash, captured_at,
        normalized_record, normalized_schema_version, parser_version,
        raw_report_sha256, raw_report_alg_version, raw_report_key_id,
        raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
        raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
        created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '1.0.0', '1.0.0', $8,
             $9, $10, $11, $12, $13, $14, $15, $16, $17, $6)`,
    [
      input.organizationId,
      input.marketplace,
      input.asin,
      input.revision,
      input.contentHash,
      input.capturedAt,
      JSON.stringify({ asin: input.asin, captureStatus: "dialog" }),
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
    ],
  );
}

async function assertPostgresManualAlexaVocSchema(
  pool: Pool,
  label: string,
): Promise<void> {
  const tableNames = new Set((await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()`,
  )).rows.map(({ table_name }) => table_name));
  for (const table of [
    "manual_alexa_voc_revisions",
    "manual_alexa_voc_heads",
    "manual_alexa_voc_publication_outbox",
    "manual_alexa_voc_access_audit",
    "run_creation_idempotency",
  ]) {
    assert.equal(tableNames.has(table), true, `${label}: ${table}`);
  }

  const indexDefinitions = (await pool.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()`,
  )).rows;
  assert.match(
    indexDefinitions.find(({ indexname }) =>
      indexname === "users_id_organization_unique"
    )?.indexdef ?? "",
    /UNIQUE.*\(id, organization_id\)/i,
  );
  assert.match(
    indexDefinitions.find(({ indexname }) =>
      indexname === "manual_alexa_voc_revisions_cutoff_idx"
    )?.indexdef ?? "",
    /captured_at DESC.*revision DESC/i,
  );

  const columnNames = new Set((await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('manual_alexa_voc_publication_outbox',
                           'manual_alexa_voc_access_audit',
                           'run_creation_idempotency')`,
  )).rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`));
  for (const column of [
    "manual_alexa_voc_publication_outbox.status",
    "manual_alexa_voc_publication_outbox.leased_by",
    "manual_alexa_voc_publication_outbox.lease_expires_at",
    "manual_alexa_voc_publication_outbox.lease_generation",
    "manual_alexa_voc_publication_outbox.generation",
    "manual_alexa_voc_access_audit.purpose",
    "manual_alexa_voc_access_audit.result",
    "run_creation_idempotency.request_fingerprint",
    "run_creation_idempotency.run_id",
    "run_creation_idempotency.snapshot_id",
    "run_creation_idempotency.completed_at",
  ]) {
    assert.equal(columnNames.has(column), true, `${label}: ${column}`);
  }

  const constraintDefinitions = (await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace
        AND conrelid IN (
          'manual_alexa_voc_revisions'::regclass,
          'manual_alexa_voc_heads'::regclass,
          'manual_alexa_voc_publication_outbox'::regclass,
          'run_creation_idempotency'::regclass
        )`,
  )).rows.map(({ definition }) => definition).join("\n");
  assert.match(
    constraintDefinitions,
    /FOREIGN KEY \(created_by, organization_id\) REFERENCES users\(id, organization_id\)/i,
  );
  assert.match(
    constraintDefinitions,
    /FOREIGN KEY \(organization_id, marketplace, asin, latest_revision, latest_content_hash, latest_captured_at\)/i,
  );
  assert.match(
    constraintDefinitions,
    /UNIQUE \(organization_id, idempotency_key\)|PRIMARY KEY \(organization_id, idempotency_key\)/i,
  );

  const timestamp = "2026-08-31T01:00:00.000Z";
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('user-1', 'org-1', 'owner@example.test', 'Owner', 'admin', 'active', $1, $1),
            ('user-2', 'org-2', 'other@example.test', 'Other', 'admin', 'active', $1, $1)`,
    [timestamp],
  );

  await assert.rejects(
    insertPostgresManualAlexaVocRevision(pool, { revision: "2", createdBy: "user-2" }),
    /foreign key/i,
    `${label}: tenant owner`,
  );
  await assert.rejects(
    insertPostgresManualAlexaVocRevision(pool, { marketplace: "CA" }),
    /check constraint/i,
    `${label}: marketplace`,
  );
  await assert.rejects(
    insertPostgresManualAlexaVocRevision(pool, {
      revision: "2",
      rawReportPlaintextBytes: 131_073,
    }),
    /check constraint/i,
    `${label}: plaintext bytes`,
  );
  await assert.rejects(
    insertPostgresManualAlexaVocRevision(pool, {
      revision: "2",
      rawReportAlgVersion: "AES-256-GCM/v1",
      rawReportKeyId: "key-1",
    }),
    /check constraint/i,
    `${label}: encrypted field coherence`,
  );
  await assert.rejects(
    insertPostgresManualAlexaVocRevision(pool, {
      revision: "2",
      rawReportAlgVersion: "AES-256-GCM/v1",
      rawReportKeyId: "key-1",
      rawReportWrappedDek: Buffer.from("wrapped"),
      rawReportNonce: Buffer.alloc(12, 1),
      rawReportCiphertext: Buffer.alloc(135_169),
      rawReportTag: Buffer.alloc(16, 2),
      rawReportAadSha256: "c".repeat(64),
    }),
    /check constraint/i,
    `${label}: ciphertext bytes`,
  );

  await insertPostgresManualAlexaVocRevision(pool);
  assert.equal((await pool.query<{ revision: string }>(
    `SELECT revision::text AS revision FROM manual_alexa_voc_revisions
      WHERE organization_id = 'org-1' AND marketplace = 'US'
        AND asin = 'B07VY9Q95Q'`,
  )).rows[0]?.revision, "1");
  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_heads
         (organization_id, marketplace, asin, latest_revision,
          latest_content_hash, latest_captured_at, generation, updated_at)
       VALUES ('org-1', 'US', 'B07VY9Q95Q', 1, $1, $2, 1, $2)`,
      ["f".repeat(64), timestamp],
    ),
    /foreign key/i,
    `${label}: head tuple`,
  );
  await pool.query(
    `INSERT INTO manual_alexa_voc_heads
       (organization_id, marketplace, asin, latest_revision,
        latest_content_hash, latest_captured_at, generation, updated_at)
     VALUES ('org-1', 'US', 'B07VY9Q95Q', 1, $1, $2, 1, $2)`,
    ["a".repeat(64), timestamp],
  );

  await insertPostgresManualAlexaVocRevision(pool, {
    revision: "2",
    contentHash: "d".repeat(64),
    rawReportAlgVersion: "AES-256-GCM/v1",
    rawReportKeyId: "key-1",
    rawReportWrappedDek: Buffer.from("wrapped"),
    rawReportNonce: Buffer.alloc(12, 3),
    rawReportCiphertext: Buffer.from("ciphertext"),
    rawReportTag: Buffer.alloc(16, 4),
    rawReportAadSha256: "e".repeat(64),
  });
  await assert.rejects(
    insertPostgresManualAlexaVocRevision(pool, {
      revision: "3",
      contentHash: "f".repeat(64),
      rawReportAlgVersion: "AES-256-GCM/v1",
      rawReportKeyId: "key-1",
      rawReportWrappedDek: Buffer.from("wrapped-again"),
      rawReportNonce: Buffer.alloc(12, 3),
      rawReportCiphertext: Buffer.from("ciphertext-again"),
      rawReportTag: Buffer.alloc(16, 5),
      rawReportAadSha256: "1".repeat(64),
    }),
    /unique constraint/i,
    `${label}: nonce uniqueness`,
  );

  await pool.query(
    `INSERT INTO manual_alexa_voc_publication_outbox
       (id, organization_id, marketplace, asin, revision, content_hash,
        captured_at, generation, status, available_at, lease_generation,
        attempt_count, created_at, updated_at)
     VALUES ('outbox-revision-1', 'org-1', 'US', 'B07VY9Q95Q', 1, $1, $2, 1,
             'pending', $2, 0, 2147483647, $2, $2)`,
    ["a".repeat(64), timestamp],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, created_at, updated_at)
       VALUES ('outbox-revision-1-again', 'org-1', 'US', 'B07VY9Q95Q', 1,
               $1, $2, 2, 'pending', $2, 0, 0, $2, $2)`,
      ["a".repeat(64), timestamp],
    ),
    /unique constraint/i,
    `${label}: outbox revision/hash uniqueness ignores generation`,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, created_at, updated_at)
       VALUES ('outbox-attempt-overflow', 'org-1', 'US', 'B07VY9Q95Q', 2,
               $1, $2, 2, 'pending', $2, 0, 2147483648, $2, $2)`,
      ["d".repeat(64), timestamp],
    ),
    /out of range/i,
    `${label}: outbox attempt count PostgreSQL integer range`,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, applied_at, created_at, updated_at)
       VALUES ('outbox-published', 'org-1', 'US', 'B07VY9Q95Q', 2,
               $1, $2, 2, 'published', $2, 0, 0, $2, $2, $2)`,
      ["d".repeat(64), timestamp],
    ),
    /check constraint/i,
    `${label}: published is not a legal outbox terminal status`,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_publication_outbox
         (id, organization_id, marketplace, asin, revision, content_hash,
          captured_at, generation, status, available_at, lease_generation,
          attempt_count, created_at, updated_at)
       VALUES ('outbox-invalid', 'org-1', 'US', 'B07VY9Q95Q', 2,
               $1, $2, 2, 'invalid', $2, 0, 0, $2, $2)`,
      ["d".repeat(64), timestamp],
    ),
    /check constraint/i,
    `${label}: invalid outbox status`,
  );
  await pool.query(
    `INSERT INTO manual_alexa_voc_publication_outbox
       (id, organization_id, marketplace, asin, revision, content_hash,
        captured_at, generation, status, available_at, lease_generation,
        attempt_count, applied_at, created_at, updated_at)
     VALUES ('outbox-applied', 'org-1', 'US', 'B07VY9Q95Q', 2,
             $1, $2, 2, 'applied', $2, 0, 0, $2, $2, $2)`,
    ["d".repeat(64), timestamp],
  );

  for (const chain of [
    { organizationId: "org-1", userId: "run-user-a", projectId: "project-a", runId: "run-a", snapshotId: "snapshot-a" },
    { organizationId: "org-2", userId: "run-user-b", projectId: "project-b", runId: "run-b", snapshotId: "snapshot-b" },
  ] as const) {
    await seedSnapshotRun(pool, {
      ...chain,
      asins: ["B000000001"],
      cutoff: timestamp,
    });
    await insertVocSnapshot(pool, {
      id: chain.snapshotId,
      runId: chain.runId,
      dataCutoffAt: timestamp,
    });
  }

  const insertIdempotency = (
    idempotencyKey: string,
    organizationId: string,
    projectId: string,
    runId: string | null,
    snapshotId: string | null,
    completedAt: string | null,
  ) => pool.query(
    `INSERT INTO run_creation_idempotency
       (organization_id, idempotency_key, request_fingerprint, project_id,
        run_id, snapshot_id, created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      organizationId,
      idempotencyKey,
      createHash("sha256").update(idempotencyKey).digest("hex"),
      projectId,
      runId,
      snapshotId,
      timestamp,
      completedAt,
    ],
  );
  await assert.rejects(
    insertIdempotency(
      "cross-organization",
      "org-1",
      "project-b",
      "run-b",
      "snapshot-b",
      timestamp,
    ),
    /foreign key/i,
    `${label}: organization cannot reference another tenant run`,
  );
  await assert.rejects(
    insertIdempotency(
      "cross-project-run",
      "org-1",
      "project-a",
      "run-b",
      null,
      null,
    ),
    /foreign key/i,
    `${label}: run belongs to idempotency project`,
  );
  await assert.rejects(
    insertIdempotency(
      "cross-run-snapshot",
      "org-1",
      "project-a",
      "run-a",
      "snapshot-b",
      timestamp,
    ),
    /foreign key/i,
    `${label}: snapshot belongs to idempotency run`,
  );
  await assert.rejects(
    insertIdempotency(
      "partial-snapshot",
      "org-1",
      "project-a",
      "run-a",
      "snapshot-a",
      null,
    ),
    /check constraint/i,
    `${label}: snapshot state cannot be partially completed`,
  );
  await assert.rejects(
    insertIdempotency(
      "partial-completion",
      "org-1",
      "project-a",
      "run-a",
      null,
      timestamp,
    ),
    /check constraint/i,
    `${label}: completed state requires snapshot`,
  );
  await insertIdempotency("pending", "org-1", "project-a", null, null, null);
  await insertIdempotency("running", "org-1", "project-a", "run-a", null, null);
  await insertIdempotency(
    "completed",
    "org-1",
    "project-a",
    "run-a",
    "snapshot-a",
    timestamp,
  );
}

test("PostgreSQL migrations migrate a fresh database once and are reentrant", async () => {
  const pool = await freshSchemaPool();

  const first = await runPostgresMigrations(pool);
  const second = await runPostgresMigrations(pool);
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name`,
  );

  assert.deepEqual(
    first.map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: "agent_runtime" },
      { version: 2, name: "job_retry_cycles" },
      { version: 3, name: "model_budget_ledger" },
      { version: 4, name: "agent_run_audit" },
      { version: 5, name: "voc_data_snapshot" },
      { version: 6, name: "agent_run_logical_lineage" },
      { version: 7, name: "traffic_data_snapshot" },
      { version: 8, name: "keyword_analysis_snapshot" },
      { version: 9, name: "connector_credentials" },
      { version: 10, name: "user_feedback" },
      { version: 11, name: "sync_job_queue" },
      { version: 12, name: "concurrency_control" },
      { version: 13, name: "concurrency_admin_controls" },
      { version: 14, name: "help_feedback_center" },
      { version: 15, name: "sync_run_stage_partial" },
      { version: 16, name: "sync_stage_outputs" },
      { version: 17, name: "category_transient_retry" },
      { version: 18, name: "image_remark_concurrency" },
      { version: 19, name: "manual_alexa_voc" },
      { version: 20, name: "voc_snapshot_per_asin_provenance" },
      { version: 21, name: "comparison_project_scope" },
      { version: 22, name: "alexa_voc_normalization_stage" },
      { version: 23, name: "alexa_voc_agent_run_budget" },
      { version: 24, name: "alexa_voc_normalization_attempts" },
      { version: 25, name: "sync_stage_partial_outputs" },
      { version: 26, name: "dingtalk_authentication" },
      { version: 27, name: "allow_empty_voc_dimensions" },
      { version: 28, name: "traffic_detail_recoveries" },
      { version: 29, name: "review_metric_provenance" },
      { version: 30, name: "voc_all_step_deadline" },
    ],
  );
  assert.ok(first.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));
  assert.equal(new Set(first.map(({ checksum }) => checksum)).size, 30);
  assert.deepEqual(second, first);
  assert.deepEqual(
    tables.rows.map(({ table_name }) => table_name),
    [
      "agent_run_snapshots",
      "agent_runs",
      "alexa_voc_normalization_input_jobs",
      "alexa_voc_normalization_terminals",
      "analysis_reports",
      "analysis_runs",
      "audit_events",
      "auth_identities",
      "concurrency_physical_attempts",
      "concurrency_policy_current",
      "concurrency_policy_versions",
      "concurrency_resource_circuits",
      "concurrency_resource_permits",
      "connector_credentials",
      "connector_status",
      "data_snapshots",
      "job_attempts",
      "keyword_analysis_snapshots",
      "legacy_project_owner_bindings",
      "manual_alexa_voc_access_audit",
      "manual_alexa_voc_heads",
      "manual_alexa_voc_publication_outbox",
      "manual_alexa_voc_revisions",
      "model_budget_reservations",
      "oauth_login_states",
      "project_creation_idempotency",
      "projects",
      "run_creation_idempotency",
      "run_stages",
      "schema_migrations",
      "seller_sprite_quota_settings",
      "seller_sprite_quota_snapshots",
      "sessions",
      "skill_versions",
      "sync_job_modules",
      "sync_job_stage_outputs",
      "sync_job_submissions",
      "sync_jobs",
      "traffic_detail_recoveries",
      "user_feedback",
      "user_feedback_attachments",
      "user_feedback_events",
      "user_feedback_workflow",
      "users",
    ],
  );
  assert.equal(
    (await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations"))
      .rows[0]?.count,
    "30",
  );
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('sync_jobs', 'sync_job_stage_outputs')
       ORDER BY table_name, ordinal_position`,
  );
  assert.ok(columns.rows.some(row => row.column_name === "job_version"));
  assert.ok(columns.rows.some(row => row.column_name === "output_version"));
});

test("PostgreSQL VOC trigger accepts legacy, explicit and Customers Say-only review rows and rejects invalid provenance", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const cutoff = "2026-08-15T08:00:00.000Z";
  const asin = "B000000001";
  const makeCandidate = (kind: "legacy" | "new" | "cs-zero" | "rounding") => {
    const row = kind === "legacy"
      ? { label: "legacy", sharePct: 25, reason: "e" }
      : kind === "new"
        ? { label: "measured", sharePct: 25, reason: "e", metricKind: "review_sample_incidence" as const, numerator: 1, denominator: 4 }
        : kind === "rounding"
          ? { label: "rounding", sharePct: 0.01, reason: "e", metricKind: "customers_say_topic_share" as const, numerator: 3, denominator: 20_000 }
          : { label: "topic", sharePct: 60, reason: "e", metricKind: "customers_say_topic_share" as const, numerator: 60, denominator: 100 };
    return buildVocSnapshotCandidate({ marketplace: "US", asins: [asin], dataCutoffAt: cutoff, sourceBundles: [{ sourceId: "sorftime-review-analysis", type: "connector", reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis, marketplace: "US", capturedAt: cutoff, records: [{ asin, marketplace: "US", sampledReviews: kind === "cs-zero" ? 0 : 4, fetchedAt: "2026-08-15", status: "ready", blocks: [{ key: "positives", label: "好评", rows: [row] }] }] }] });
  };
  const insert = async (id: string, runId: string, candidate: ReturnType<typeof makeCandidate>) => pool.query(
    `INSERT INTO data_snapshots (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace, asins_json, data_cutoff_at, sources_json, payload_json, content_hash, created_at)
     VALUES ($1,$2,'voc','voc',$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$6)`,
    [id, runId, candidate.schemaVersion, candidate.marketplace, JSON.stringify(candidate.asins), candidate.dataCutoffAt, JSON.stringify(candidate.sources), JSON.stringify(candidate.payload), candidate.contentHash],
  );
  for (const kind of ["legacy", "new", "cs-zero", "rounding"] as const) {
    const seeded = await seedSnapshotRun(pool, { asins: [asin], cutoff, userId: `${kind}-u`, organizationId: `${kind}-o`, projectId: `${kind}-p`, runId: `${kind}-r` });
    await insert(`${kind}-snapshot`, seeded.runId, makeCandidate(kind));
  }
  for (const kind of ["partial", "arithmetic", "denominator"] as const) {
    const seeded = await seedSnapshotRun(pool, { asins: [asin], cutoff, userId: `${kind}-u`, organizationId: `${kind}-o`, projectId: `${kind}-p`, runId: `${kind}-r` });
    const candidate = structuredClone(makeCandidate("new"));
    const record = candidate.payload.records.sorftimeReviewAnalysis[0]!;
    const row = record.blocks[0]!.rows[0]! as Record<string, unknown>;
    if (kind === "partial") delete row.denominator;
    if (kind === "arithmetic") row.sharePct = 90;
    if (kind === "denominator") record.sampledReviews = 5;
    candidate.sources[0]!.checksum = canonicalJsonSha256({ sourceId: "sorftime-review-analysis", marketplace: "US", records: candidate.payload.records.sorftimeReviewAnalysis });
    candidate.contentHash = canonicalJsonSha256({ schemaVersion: candidate.schemaVersion, marketplace: candidate.marketplace, asins: candidate.asins, dataCutoffAt: candidate.dataCutoffAt, sources: candidate.sources, payload: candidate.payload });
    await assert.rejects(insert(`${kind}-snapshot`, seeded.runId, candidate), /invalid review-analysis snapshot record/i);
  }
});

test("PostgreSQL 0019 enforces equivalent fresh-install and 0018-upgrade constraints", async () => {
  for (const mode of ["fresh", "upgrade"] as const) {
    const pool = await freshSchemaPool();
    if (mode === "upgrade") {
      for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_IMAGE_REMARK) {
        await applyPostgresMigrationSource(pool, version, name);
      }
    }
    await runPostgresMigrations(pool);
    await assertPostgresManualAlexaVocSchema(pool, mode);
  }
});

test("PostgreSQL 0020 replaces the VOC insert function with per-ASIN provenance checks", async () => {
  const sql = await readFile(
    new URL("0020_voc_snapshot_per_asin_provenance.sql", MIGRATIONS_URL),
    "utf8",
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION enforce_voc_data_snapshot_insert/i);
  assert.match(sql, /repository:\/\/manual-alexa-voc\/selected-revisions/i);
  assert.match(sql, /recordProvenance/i);
  assert.match(sql, /voc_sha256_jsonb/i);
  assert.match(
    sql,
    /jsonb_typeof\(provenance_value -> 'normalizedSchemaVersion'\).*string/i,
  );
  assert.match(
    sql,
    /jsonb_typeof\(provenance_value -> 'parserVersion'\).*string/i,
  );
});

test("PostgreSQL 0027 upgrades legacy empty dimensions for cumulative publication", async () => {
  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_MANUAL_VOC) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  const cutoff = "2026-09-01T00:00:00.000Z";
  const legacySubject = await seedSnapshotRun(pool, { asins: ["B000000001"], cutoff });
  const legacy = structuredClone(vocSnapshotFixture(cutoff));
  legacy.payload.records.alexaVoc[0]!.negatives = [];
  legacy.sources[0]!.checksum = canonicalJsonSha256({
    sourceId: "alexa-voc", marketplace: "US", records: legacy.payload.records.alexaVoc,
  });
  const legacyRecord = AlexaVocSnapshotRecordSchema.parse(legacy.payload.records.alexaVoc[0]);
  const legacyRecordHash = canonicalJsonSha256(legacyRecord);
  await pool.query(
    `INSERT INTO manual_alexa_voc_revisions (
       organization_id, marketplace, asin, revision, content_hash, captured_at,
       normalized_record, normalized_schema_version, parser_version,
       raw_report_sha256, raw_report_plaintext_bytes, created_by, created_at
     ) VALUES ($1, 'US', $2, 1, $3, $4, $5::jsonb,
               'alexa-voc-record/v2', 'deterministic-alexa-parser/v3',
               $6, 100, $7, $4)`,
    [legacySubject.organizationId, legacyRecord.asin, legacyRecordHash, cutoff,
      JSON.stringify(legacyRecord), "d".repeat(64), legacySubject.userId],
  );
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_DINGTALK.filter(([version]) => version > 19)) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  assert.equal((await pool.query<{ version: number }>(
    "SELECT MAX(version) AS version FROM schema_migrations",
  )).rows[0]?.version, 26);
  assert.deepEqual((await pool.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  )).rows.map(row => row.version), Array.from({ length: 26 }, (_, index) => index + 1));

  const oldRecord = legacyRecord;
  const siblingRecord = AlexaVocSnapshotRecordSchema.parse({
    ...oldRecord, asin: "B000000002", positives: ["new sibling"], negatives: ["sibling issue"],
    alexaReport: { ...oldRecord.alexaReport, asin: "B000000002", title: "Sibling" },
  });
  const records = [oldRecord, siblingRecord];
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US", asins: records.map(record => record.asin), dataCutoffAt: cutoff,
    sourceBundles: [{
      sourceId: "alexa-voc", type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.manualAlexaVocRepository,
      marketplace: "US", capturedAt: cutoff, records,
      recordProvenance: records.map((record) => ({
        asin: record.asin, revision: "1", contentHash: canonicalJsonSha256(record),
        normalizedSchemaVersion: "alexa-voc-record/v2",
        parserVersion: "deterministic-alexa-parser/v3",
        source: "repository" as const, generation: null, capturedAt: cutoff,
      })),
    }],
  });
  const subject = await seedSnapshotRun(pool, {
    organizationId: legacySubject.organizationId, asins: candidate.asins, cutoff,
  });
  for (const [index, record] of records.entries()) {
    if (index === 0) continue;
    const provenance = candidate.sources[0]!.recordProvenance![index]!;
    await pool.query(
      `INSERT INTO manual_alexa_voc_revisions (
         organization_id, marketplace, asin, revision, content_hash, captured_at,
         normalized_record, normalized_schema_version, parser_version,
         raw_report_sha256, raw_report_plaintext_bytes, created_by, created_at
       ) VALUES ($1, 'US', $2, 1, $3, $4, $5::jsonb, $6, $7, $8, 100, $9, $4)`,
      [subject.organizationId, record.asin, provenance.contentHash, cutoff,
        JSON.stringify(record), provenance.normalizedSchemaVersion, provenance.parserVersion,
        "d".repeat(64), subject.userId],
    );
  }
  const insert = (id: string, value: typeof candidate) => pool.query(
    `INSERT INTO data_snapshots (
       id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
       asins_json, data_cutoff_at, sources_json, payload_json, content_hash, created_at
     ) VALUES ($1, $2, 'voc', 'voc', $3, $4, $5::jsonb, $6::timestamptz,
               $7::jsonb, $8::jsonb, $9, $6::timestamptz)`,
    [id, subject.runId, value.schemaVersion, value.marketplace, JSON.stringify(value.asins),
      value.dataCutoffAt, JSON.stringify(value.sources), JSON.stringify(value.payload), value.contentHash],
  );
  await assert.rejects(insert("before-0027", candidate), /invalid Alexa VOC snapshot record/);
  await applyPostgresMigrationSource(pool, 27, "allow_empty_voc_dimensions");
  await insert("after-0027", candidate);
  assert.deepEqual((await pool.query<{ payload_json: typeof candidate.payload }>(
    "SELECT payload_json FROM data_snapshots WHERE id = 'after-0027'",
  )).rows[0]?.payload_json.records.alexaVoc.map(record => [record.asin, record.negatives]), [
    ["B000000001", []], ["B000000002", ["sibling issue"]],
  ]);

  for (const [name, negatives] of [
    ["non-string", [1]],
    ["oversize-text", ["x".repeat(16_385)]],
    ["oversize-count", Array.from({ length: 257 }, () => "x")],
  ] as const) {
    const invalid = structuredClone(candidate);
    invalid.payload.records.alexaVoc[0]!.negatives = negatives as never;
    invalid.contentHash = canonicalJsonSha256({
      schemaVersion: invalid.schemaVersion, marketplace: invalid.marketplace,
      asins: invalid.asins, dataCutoffAt: invalid.dataCutoffAt,
      sources: invalid.sources, payload: invalid.payload,
    });
    await assert.rejects(insert(`invalid-${name}`, invalid), /invalid Alexa VOC snapshot record/);
  }
  const applied = await runPostgresMigrations(pool);
  assert.equal(applied.at(-1)?.version, 30);
});

test("PostgreSQL 0021 supports fresh install and actual 0020 upgrade", async () => {
  const sql = await readFile(
    new URL("0021_comparison_project_scope.sql", MIGRATIONS_URL),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE project_creation_idempotency\b/i);
  assert.match(sql, /PRIMARY KEY \(organization_id, idempotency_key\)/i);
  assert.match(sql, /CREATE TABLE legacy_project_owner_bindings\b/i);
  assert.match(sql, /legacy_project_id TEXT PRIMARY KEY/i);

  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_VOC_PROVENANCE) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  assert.equal(
    (await pool.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )).rows[0]?.version,
    20,
  );

  await runPostgresMigrations(pool);
  assert.equal(
    (await pool.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )).rows[0]?.version,
    30,
  );
  assert.deepEqual(
    (
      await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN ('project_creation_idempotency', 'legacy_project_owner_bindings')
          ORDER BY table_name`,
      )
    ).rows,
    [
      { table_name: "legacy_project_owner_bindings" },
      { table_name: "project_creation_idempotency" },
    ],
  );
});

test("PostgreSQL 0022 admits the normalization stage and only paired input snapshots", async () => {
  const sql = await readFile(
    new URL("0022_alexa_voc_normalization_stage.sql", MIGRATIONS_URL),
    "utf8",
  );
  assert.match(sql, /DROP CONSTRAINT run_stages_stage_check/i);
  assert.match(sql, /alexa-voc-normalization/i);
  assert.match(sql, /alexa-voc-normalization-input/i);

  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const cutoff = "2026-09-01T00:00:00.000Z";
  const subject = await seedSnapshotRun(pool, {
    userId: "normalization-user",
    organizationId: "normalization-org",
    projectId: "normalization-project",
    runId: "normalization-run",
    cutoff,
  });
  await pool.query(
    `INSERT INTO run_stages
      (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
     VALUES ('normalization-stage', $1, 'alexa-voc-normalization', 'queued',
             0, 0, $2, $2)`,
    [subject.runId, cutoff],
  );
  await pool.query(
    `INSERT INTO data_snapshots
      (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
       asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
       created_at)
     VALUES ('normalization-input', $1, 'alexa-voc-normalization-input',
             'alexa-voc-normalization-input', '1.0.0', 'US',
             '["B07VY9Q95Q"]'::jsonb, $2, '[]'::jsonb, '{}'::jsonb, $3, $2)`,
    [subject.runId, cutoff, "c".repeat(64)],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
        (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
         asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
         created_at)
       VALUES ('normalization-mismatch', $1, 'alexa-voc-normalization-input',
               'voc', '1.0.0', 'US', '["B07VY9Q95Q"]'::jsonb, $2,
               '[]'::jsonb, '{}'::jsonb, $3, $2)`,
      [subject.runId, cutoff, "d".repeat(64)],
    ),
    /artifact kind is inconsistent/i,
  );
});

test("PostgreSQL upgrades an actual 0019 schema to strict 0020 provenance constraints", async () => {
  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_MANUAL_VOC) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  assert.equal(
    (await pool.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )).rows[0]?.version,
    19,
  );
  await runPostgresMigrations(pool);
  assert.ok(
    (
      await pool.query<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = 20",
      )
    ).rows[0],
  );
  assert.equal(
    (await pool.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )).rows[0]?.version,
    30,
  );
  const cutoff = "2026-08-31T08:00:00.000Z";
  const candidate = repositoryVocSnapshotFixture(cutoff);
  const subject = await seedSnapshotRun(pool, {
    asins: candidate.asins,
    cutoff,
  });
  const record = candidate.payload.records.alexaVoc[0]!;
  const provenance = candidate.sources[0]!.recordProvenance![0]!;
  await pool.query(
    `INSERT INTO manual_alexa_voc_revisions
       (organization_id, marketplace, asin, revision, content_hash,
        captured_at, normalized_record, normalized_schema_version,
        parser_version, raw_report_sha256, raw_report_plaintext_bytes,
        created_by, created_at)
     VALUES ($1, 'US', $2, 1, $3, $4, $5::jsonb,
             'alexa-voc-record/v2', 'deterministic-alexa-parser/v3',
             $6, 100, $7, $4)`,
    [
      subject.organizationId,
      record.asin,
      provenance.contentHash,
      cutoff,
      JSON.stringify(record),
      "d".repeat(64),
      subject.userId,
    ],
  );
  const insertCandidate = async (
    id: string,
    runId: string,
    value: typeof candidate,
  ) => pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
        asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
        created_at)
     VALUES ($1, $2, 'voc', 'voc', $3, $4, $5::jsonb, $6,
             $7::jsonb, $8::jsonb, $9, $6)`,
    [
      id,
      runId,
      value.schemaVersion,
      value.marketplace,
      JSON.stringify(value.asins),
      value.dataCutoffAt,
      JSON.stringify(value.sources),
      JSON.stringify(value.payload),
      value.contentHash,
    ],
  );
  await insertCandidate("provenance-valid", subject.runId, candidate);

  const invalidCases = [
    {
      name: "rewritten-revision",
      mutate: (provenance: Record<string, unknown>) => {
        provenance.revision = "2";
      },
    },
    {
      name: "missing-revision",
      mutate: (provenance: Record<string, unknown>) => {
        delete provenance.revision;
      },
    },
    {
      name: "null-revision",
      mutate: (provenance: Record<string, unknown>) => {
        provenance.revision = null;
      },
    },
    {
      name: "missing-parser",
      mutate: (provenance: Record<string, unknown>) => {
        delete provenance.parserVersion;
      },
    },
    {
      name: "null-parser",
      mutate: (provenance: Record<string, unknown>) => {
        provenance.source = "legacy-static-stale";
        provenance.generation = "1";
        provenance.parserVersion = null;
      },
    },
    {
      name: "missing-schema",
      mutate: (provenance: Record<string, unknown>) => {
        delete provenance.normalizedSchemaVersion;
      },
    },
    {
      name: "null-schema",
      mutate: (provenance: Record<string, unknown>) => {
        provenance.source = "legacy-static-stale";
        provenance.generation = "1";
        provenance.normalizedSchemaVersion = null;
      },
    },
  ] as const;
  for (const invalidCase of invalidCases) {
    const tampered = structuredClone(candidate);
    const source = tampered.sources[0]!;
    const recordProvenance = source.recordProvenance!;
    invalidCase.mutate(
      recordProvenance[0] as unknown as Record<string, unknown>,
    );
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
    const tamperedRunId = `run-${randomUUID()}`;
    await pool.query(
      `INSERT INTO analysis_runs
         (id, project_id, mode, status, created_by, data_cutoff_at,
          idempotency_scope, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, 'existing-data', 'running', $3, $4,
               $5, 'create', $4, $4)`,
      [
        tamperedRunId,
        subject.projectId,
        subject.userId,
        cutoff,
        `snapshot:${tamperedRunId}`,
      ],
    );
    await assert.rejects(
      insertCandidate(
        `provenance-${invalidCase.name}`,
        tamperedRunId,
        tampered,
      ),
      /per-ASIN VOC snapshot provenance/i,
      invalidCase.name,
    );
  }
});

test("PostgreSQL 0018 adds immutable standard-v2 with only the image cap expanded", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const policies = await pool.query<{
    policy_version: string;
    profile: string;
    whole_job_limit: number;
    seller_sprite_concurrency: number;
    sif_concurrency: number;
    sorftime_concurrency: number;
    model_concurrency: number;
    image_concurrency: number;
    seller_sprite_rolling_max_attempts: number;
    seller_sprite_rolling_window_ms: number;
  }>(
    `SELECT policy_version, profile, whole_job_limit, seller_sprite_concurrency,
            sif_concurrency, sorftime_concurrency, model_concurrency, image_concurrency,
            seller_sprite_rolling_max_attempts, seller_sprite_rolling_window_ms
       FROM concurrency_policy_versions
      WHERE policy_version IN ('standard-v1', 'standard-v2')
      ORDER BY policy_version`,
  );
  assert.deepEqual(policies.rows, [
    {
      policy_version: "standard-v1",
      profile: "standard",
      whole_job_limit: 4,
      seller_sprite_concurrency: 2,
      sif_concurrency: 1,
      sorftime_concurrency: 1,
      model_concurrency: 2,
      image_concurrency: 2,
      seller_sprite_rolling_max_attempts: 30,
      seller_sprite_rolling_window_ms: 60_000,
    },
    {
      policy_version: "standard-v2",
      profile: "standard",
      whole_job_limit: 4,
      seller_sprite_concurrency: 2,
      sif_concurrency: 1,
      sorftime_concurrency: 1,
      model_concurrency: 2,
      image_concurrency: 4,
      seller_sprite_rolling_max_attempts: 30,
      seller_sprite_rolling_window_ms: 60_000,
    },
  ]);
  const pointer = await pool.query<{ policy_version: string }>(
    `SELECT policy_version
       FROM concurrency_policy_current
      WHERE organization_id = '*'`,
  );
  assert.deepEqual(pointer.rows, [{ policy_version: "standard-v2" }]);
  const defaultValue = await pool.query<{ column_default: string | null }>(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'sync_jobs'
        AND column_name = 'policy_version'`,
  );
  assert.match(defaultValue.rows[0]?.column_default ?? "", /standard-v2/);
});

test("PostgreSQL 0014 preserves migration checksums, backfills history, and stores BYTEA attachments", async () => {
  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_CONCURRENCY) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  const before = (await pool.query<{
    version: number;
    name: string;
    checksum: string;
  }>("SELECT version, name, checksum FROM schema_migrations ORDER BY version")).rows;
  const timestamp = "2026-08-20T00:00:00.000Z";
  const organizationId = randomUUID();
  const userId = randomUUID();
  const feedbackId = randomUUID();
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, 'member@example.test', 'Member', 'member', 'active', $3, $3)`,
    [userId, organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO user_feedback
       (id, organization_id, actor_user_id, category, title, description,
        page_path, app_version, created_at)
     VALUES ($1, $2, $3, 'bug', 'Legacy feedback', 'Preserve me', '/projects', NULL, $4)`,
    [feedbackId, organizationId, userId, timestamp],
  );

  await applyPostgresMigrationSource(pool, 14, "help_feedback_center");

  assert.deepEqual(
    (await pool.query(
      "SELECT status, admin_seen_at, version, updated_at FROM user_feedback_workflow WHERE feedback_id = $1",
      [feedbackId],
    )).rows[0],
    { status: "new", admin_seen_at: null, version: 1, updated_at: new Date(timestamp) },
  );
  assert.deepEqual(
    (await pool.query(
      "SELECT id, event_type, from_status, to_status, created_at FROM user_feedback_events WHERE feedback_id = $1",
      [feedbackId],
    )).rows[0],
    {
      id: feedbackId,
      event_type: "created",
      from_status: null,
      to_status: "new",
      created_at: new Date(timestamp),
    },
  );
  await assert.rejects(pool.query(
    "UPDATE user_feedback_events SET to_status = 'closed' WHERE feedback_id = $1",
    [feedbackId],
  ), /immutable/i);
  await assert.rejects(pool.query(
    "DELETE FROM user_feedback_events WHERE feedback_id = $1",
    [feedbackId],
  ), /immutable/i);
  await assert.rejects(pool.query(
    `INSERT INTO user_feedback_events
       (id, feedback_id, organization_id, actor_user_id, event_type,
        from_status, to_status, created_at)
     VALUES ('no-op', $1, $2, $3, 'status_changed', 'new', 'new', $4)`,
    [feedbackId, organizationId, userId, timestamp],
  ));

  const attachment = Buffer.from([0, 1, 2, 255]);
  await pool.query(
    `INSERT INTO user_feedback_attachments
       (id, feedback_id, organization_id, created_by_user_id, file_name,
        media_type, byte_size, sha256, image_content, created_at)
     VALUES ('attachment-1', $1, $2, $3, 'evidence.webp', 'image/webp', $4, $5, $6, $7)`,
    [
      feedbackId,
      organizationId,
      userId,
      attachment.byteLength,
      "a".repeat(64),
      attachment,
      timestamp,
    ],
  );
  assert.deepEqual(
    (await pool.query("SELECT image_content FROM user_feedback_attachments WHERE id = 'attachment-1'"))
      .rows[0],
    { image_content: attachment },
  );
  assert.equal(
    (await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'user_feedback_attachments'
          AND column_name = 'image_content'`,
    )).rows[0]?.data_type,
    "bytea",
  );
  await assert.rejects(pool.query(
    `INSERT INTO user_feedback_attachments
       (id, feedback_id, organization_id, created_by_user_id, file_name,
        media_type, byte_size, sha256, image_content, created_at)
     VALUES ('attachment-bad-size', $1, $2, $3, 'bad.webp', 'image/webp', 5, $4, $5, $6)`,
    [feedbackId, organizationId, userId, "b".repeat(64), attachment, timestamp],
  ));

  const after = (await pool.query<{
    version: number;
    name: string;
    checksum: string;
  }>("SELECT version, name, checksum FROM schema_migrations ORDER BY version")).rows;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.at(-1), {
    version: 14,
    name: "help_feedback_center",
    checksum: createHash("sha256")
      .update(await readFile(new URL("0014_help_feedback_center.sql", MIGRATIONS_URL), "utf8"))
      .digest("hex"),
  });
});

test("PostgreSQL 0015 preserves existing run stages while adding partial status", async () => {
  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_FEEDBACK) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  const now = "2026-08-23T00:00:00.000Z";
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('partial-user', 'partial-org', 'partial@example.test', 'Partial',
             'admin', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ('partial-project', 'partial-org', 'Partial', 'US', '["B000000001"]',
             'partial-user', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('partial-run', 'partial-project', 'existing-data', 'running',
             'partial-user', $1, 'partial-org', 'partial-key', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
     VALUES
       ('partial-stage-a', 'partial-run', 'traffic-analysis', 'running', 25, 1, $1, $1),
       ('partial-stage-b', 'partial-run', 'voc-positioning', 'succeeded', 100, 1, $1, $1)`,
    [now],
  );
  const before = (await pool.query(
    `SELECT id, run_id, stage, status, progress, attempt_count, created_at, updated_at
       FROM run_stages ORDER BY id`,
  )).rows;

  await applyPostgresMigrationSource(pool, 15, "sync_run_stage_partial");

  assert.deepEqual((await pool.query(
    `SELECT id, run_id, stage, status, progress, attempt_count, created_at, updated_at
       FROM run_stages ORDER BY id`,
  )).rows, before);
  await pool.query(
    `UPDATE run_stages SET status = 'partial', updated_at = $1
      WHERE id = 'partial-stage-a'`,
    [now],
  );
  assert.equal(
    (await pool.query<{ status: string }>(
      "SELECT status FROM run_stages WHERE id = 'partial-stage-a'",
    )).rows[0]?.status,
    "partial",
  );
});

test("PostgreSQL 0017 backfills bounded dispatch identity and accepts transient retry", async () => {
  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_STAGE_OUTPUTS) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  const timestamp = "2026-08-25T00:00:00.000Z";
  const legacyPermitId = "p".repeat(187);
  await pool.query(
    `INSERT INTO concurrency_resource_permits (
       permit_id, organization_id, resource, job_id, attempt_kind, owner_id,
       lease_generation, policy_version, acquired_at, lease_expires_at, released_at
     ) VALUES (
       $3, 'legacy-org', 'sorftime', 'legacy-job', 'initial',
       'legacy-owner', 1, 'standard-v1', $1, $2, $2
     )`,
    [timestamp, "2026-08-25T00:01:00.000Z", legacyPermitId],
  );
  await pool.query(
    `INSERT INTO concurrency_physical_attempts (
       organization_id, resource, job_id, attempt_kind, policy_version, recorded_at
     ) VALUES ('legacy-org', 'sorftime', 'legacy-job', 'initial', 'standard-v1', $1)`,
    [timestamp],
  );

  await applyPostgresMigrationSource(pool, 17, "category_transient_retry");

  const legacy = await pool.query<{
    source: string;
    stage_id: string;
    logical_operation_key: string;
    dispatch_key: string;
  }>(
    `SELECT 'attempt' AS source, stage_id, logical_operation_key, dispatch_key
       FROM concurrency_physical_attempts
      WHERE organization_id = 'legacy-org'
     UNION ALL
     SELECT 'permit' AS source, stage_id, logical_operation_key, dispatch_key
       FROM concurrency_resource_permits
      WHERE organization_id = 'legacy-org'
      ORDER BY source`,
  );
  assert.equal(legacy.rows.length, 2);
  assert.equal(legacy.rows.every(row =>
    row.stage_id.length > 0 &&
    row.logical_operation_key.length > 0 &&
    row.dispatch_key.length > 0
  ), true);
  const legacyPermitIdentity = `legacy:permit:${createHash("sha256")
    .update(legacyPermitId)
    .digest("hex")}`;
  assert.deepEqual(
    legacy.rows.find(row => row.source === "permit"),
    {
      source: "permit",
      stage_id: "unknown-stage",
      logical_operation_key: legacyPermitIdentity,
      dispatch_key: legacyPermitIdentity,
    },
  );

  await pool.query(
    `INSERT INTO concurrency_resource_permits (
       permit_id, organization_id, resource, job_id, attempt_kind, stage_id,
       logical_operation_key, dispatch_key, owner_id, lease_generation,
       policy_version, acquired_at, lease_expires_at
     ) VALUES (
       'retry-permit', 'retry-org', 'sorftime', 'retry-job', 'transient-retry',
       'category', 'logical-key', 'logical-key:transient-retry', 'retry-owner', 1,
       'standard-v1', $1, $2
     )`,
    [timestamp, "2026-08-25T00:01:00.000Z"],
  );
  await pool.query(
    `INSERT INTO concurrency_physical_attempts (
       organization_id, resource, job_id, attempt_kind, stage_id,
       logical_operation_key, dispatch_key, policy_version, recorded_at
     ) VALUES (
       'retry-org', 'sorftime', 'retry-job', 'transient-retry', 'category',
       'logical-key', 'logical-key:transient-retry', 'standard-v1', $1
     )`,
    [timestamp],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO concurrency_physical_attempts (
         organization_id, resource, job_id, attempt_kind, stage_id,
         logical_operation_key, dispatch_key, policy_version, recorded_at
       ) VALUES (
         'retry-org', 'sorftime', 'oversized', 'initial', $1,
         'logical-key', 'logical-key:initial', 'standard-v1', $2
       )`,
      ["x".repeat(1_001), timestamp],
    ),
  );
  const index = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'concurrency_physical_attempts_logical_operation_idx'`,
  );
  assert.match(index.rows[0]?.indexdef ?? "", /organization_id, job_id, stage_id, logical_operation_key, recorded_at/i);
});

test("PostgreSQL 0014 rolls back every schema change when a later statement fails", async () => {
  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_CONCURRENCY) {
    await applyPostgresMigrationSource(pool, version, name);
  }
  await pool.query("CREATE TABLE user_feedback_events (id TEXT PRIMARY KEY)");

  await assert.rejects(runPostgresMigrations(pool), /PostgreSQL migration 14 failed/i);

  assert.equal(
    (await pool.query<{ relation: string | null }>(
      "SELECT to_regclass('user_feedback_workflow')::text AS relation",
    )).rows[0]?.relation,
    null,
  );
  assert.equal(
    (await pool.query<{ relation: string | null }>(
      "SELECT to_regclass('user_feedback_id_organization_idx')::text AS relation",
    )).rows[0]?.relation,
    null,
  );
  assert.equal(
    (await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations"))
      .rows[0]?.count,
    "13",
  );
});

test("concurrent PostgreSQL migration runners serialize on a fresh schema", async () => {
  const pool = await freshSchemaPool();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => runPostgresMigrations(pool)),
  );

  for (const migrations of results) {
    assert.deepEqual(migrations, results[0]);
    assert.deepEqual(
      migrations.map(({ version }) => version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    );
  }
  assert.equal(
    (await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations"))
      .rows[0]?.count,
    "30",
  );
});

test("PostgreSQL concurrency admin controls are tenant-scoped and quota snapshots are append-only", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const timestamp = "2026-08-22T08:00:00.000Z";
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES
       ('primary-org-1', 'org-1', 'admin@example.com', 'Primary', 'admin', 'active', $1, $1),
       ('other-org-admin', 'org-2', 'other-admin@example.com', 'Other', 'admin', 'active', $1, $1),
       ('disabled-org-1', 'org-1', 'disabled@example.com', 'Disabled', 'admin', 'disabled', $1, $1)`,
    [timestamp],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO seller_sprite_quota_settings
         (organization_id, manual_total, updated_by, updated_at)
       VALUES ('org-1', 100, 'other-org-admin', $1)`,
      [timestamp],
    ),
    /same active organization/i,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO seller_sprite_quota_settings
         (organization_id, manual_total, updated_by, updated_at)
       VALUES ('org-1', 100, 'disabled-org-1', $1)`,
      [timestamp],
    ),
    /same active organization/i,
  );
  await pool.query(
    `INSERT INTO seller_sprite_quota_settings
       (organization_id, manual_total, updated_by, updated_at)
     VALUES ('org-1', 100, 'primary-org-1', $1)`,
    [timestamp],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO concurrency_resource_circuits
         (organization_id, resource, manual_hold, updated_by, updated_at)
       VALUES ('org-1', 'sellerSprite', TRUE, 'other-org-admin', $1)`,
      [timestamp],
    ),
    /same active organization/i,
  );
  await pool.query(
    `INSERT INTO concurrency_resource_circuits
       (organization_id, resource, manual_hold, updated_by, updated_at)
     VALUES ('org-1', 'sellerSprite', TRUE, 'primary-org-1', $1)`,
    [timestamp],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO concurrency_resource_circuits
         (organization_id, resource, manual_hold, updated_by, updated_at)
       VALUES ('org-1', 'sif', TRUE, NULL, $1)`,
      [timestamp],
    ),
  );
  await pool.query(
    `INSERT INTO concurrency_resource_circuits
       (organization_id, resource, manual_hold, auto_paused, reason, updated_by, updated_at)
     VALUES ('org-1', 'sif', FALSE, TRUE, 'quota-exhausted', NULL, $1)`,
    [timestamp],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO seller_sprite_quota_snapshots
         (id, organization_id, actor_user_id, remaining, used_count, provider_total,
          configured_total, source, status, error_code, checked_at)
       VALUES ('snapshot-cross-org', 'org-1', 'other-org-admin', 10, 90, 100,
               100, 'provider', 'ok', NULL, $1)`,
      [timestamp],
    ),
    /same active organization/i,
  );
  await pool.query(
    `INSERT INTO seller_sprite_quota_snapshots
       (id, organization_id, actor_user_id, remaining, used_count, provider_total,
        configured_total, source, status, error_code, checked_at)
     VALUES
       ('snapshot-manual', 'org-1', 'primary-org-1', 10, 90, 100,
        100, 'provider', 'ok', NULL, $1),
       ('snapshot-scheduled', 'org-1', NULL, 9, 91, 100,
        100, 'provider', 'warning', NULL, $1)`,
    [timestamp],
  );

  await assert.rejects(
    pool.query(
      "UPDATE seller_sprite_quota_snapshots SET remaining = 7 WHERE id = 'snapshot-manual'",
    ),
    /quota snapshots are append-only/i,
  );
  await assert.rejects(
    pool.query(
      "DELETE FROM seller_sprite_quota_snapshots WHERE id = 'snapshot-scheduled'",
    ),
    /quota snapshots are append-only/i,
  );
});

test("PostgreSQL connector credentials enforce versioning and immutable audit history", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const timestamp = "2026-08-19T08:00:00.000Z";
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('admin-1', 'org-1', 'admin@example.com', 'Admin', 'admin', 'active', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('admin-2', 'org-2', 'admin-2@example.com', 'Other Admin',
             'admin', 'active', $1, $1)`,
    [timestamp],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO connector_credentials
         (id, organization_id, connector, version, status, ciphertext, nonce,
          auth_tag, key_id, created_by, created_at)
       VALUES ('cross-org-create', 'org-1', 'sorftime', 1, 'active',
               $1, $2, $3, 'master-v1', 'admin-2', $4)`,
      [Buffer.from("ciphertext"), Buffer.alloc(12, 1), Buffer.alloc(16, 2), timestamp],
    ),
  );
  assert.equal(
    (await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM connector_credentials WHERE id = 'cross-org-create'",
    )).rows[0]?.count,
    "0",
  );
  const insertCredential = async (id: string, version: number) =>
    await pool.query(
      `INSERT INTO connector_credentials
         (id, organization_id, connector, version, status, ciphertext, nonce,
          auth_tag, key_id, created_by, created_at)
       VALUES ($1, 'org-1', 'sif', $2, 'active', $3, $4, $5, 'master-v1',
               'admin-1', $6)`,
      [
        id,
        version,
        Buffer.from(`ciphertext-${version}`),
        Buffer.alloc(12, version),
        Buffer.alloc(16, version),
        timestamp,
      ],
    );

  await insertCredential("credential-1", 1);
  await assert.rejects(
    pool.query(
      `UPDATE connector_credentials
          SET status = 'revoked', revoked_by = 'admin-2', revoked_at = $1
        WHERE id = 'credential-1'`,
      [timestamp],
    ),
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT status, revoked_by, revoked_at
         FROM connector_credentials WHERE id = 'credential-1'`,
    )).rows[0],
    { status: "active", revoked_by: null, revoked_at: null },
  );
  await assert.rejects(insertCredential("credential-2", 2));
  await pool.query(
    `UPDATE connector_credentials
        SET status = 'revoked', revoked_by = 'admin-1', revoked_at = $1
      WHERE id = 'credential-1'`,
    [timestamp],
  );
  await insertCredential("credential-2", 2);
  assert.equal(
    (await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM connector_credentials
       WHERE organization_id = 'org-1' AND connector = 'sif' AND status = 'active'`,
    )).rows[0]?.count,
    "1",
  );
  await assert.rejects(
    pool.query("DELETE FROM connector_credentials WHERE id = 'credential-2'"),
  );
  await assert.rejects(
    pool.query(
      "UPDATE connector_credentials SET ciphertext = $1 WHERE id = 'credential-2'",
      [Buffer.from("tampered")],
    ),
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
    await assert.rejects(
      pool.query(
        `INSERT INTO connector_credentials
           (id, organization_id, connector, version, status, ciphertext, nonce,
            auth_tag, key_id, created_by, created_at)
         VALUES ($1, 'org-1', 'sellerSprite', $2, $3, $4, $5, $6, $7,
                 'admin-1', $8)`,
        [
          candidate.id,
          candidate.version,
          candidate.status,
          candidate.ciphertext,
          candidate.nonce,
          candidate.authTag,
          candidate.keyId,
          timestamp,
        ],
      ),
      candidate.id,
    );
  }
  assert.equal(
    (await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM connector_credentials WHERE connector = 'sellerSprite'",
    )).rows[0]?.count,
    "0",
  );

  await pool.query(
    `INSERT INTO audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id,
        metadata_json, created_at)
     VALUES ('audit-1', 'org-1', 'admin-1', 'connector.credential-rotated',
             'connector', 'sif', '{}'::jsonb, $1)`,
    [timestamp],
  );
  await assert.rejects(
    pool.query("UPDATE audit_events SET action = 'tampered' WHERE id = 'audit-1'"),
  );
  await assert.rejects(
    pool.query("DELETE FROM audit_events WHERE id = 'audit-1'"),
  );
});

test("PostgreSQL migration checksum drift fails closed without exposing connection data", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  await pool.query("UPDATE schema_migrations SET checksum = 'drifted'");

  await assert.rejects(
    runPostgresMigrations(pool),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /migration 1.*checksum/i);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i);
      assert.doesNotMatch(error.message, /agent_test_/i);
      return true;
    },
  );
  assert.equal(
    (await pool.query<{ checksum: string }>("SELECT checksum FROM schema_migrations"))
      .rows[0]?.checksum,
    "drifted",
  );
});

test("PostgreSQL migration checksums tolerate only LF and CRLF source differences", async () => {
  const source = await readFile(
    new URL("0010_user_feedback.sql", MIGRATIONS_URL),
    "utf8",
  );
  const lfSource = source.replaceAll("\r\n", "\n");
  const crlfSource = lfSource.replaceAll("\n", "\r\n");
  assert.ok(source === lfSource || source === crlfSource);
  const legacySource = source === lfSource ? crlfSource : lfSource;

  const pool = await freshSchemaPool();
  for (const [version, name] of POSTGRES_MIGRATIONS_THROUGH_CONCURRENCY.slice(
    0,
    10,
  )) {
    await applyPostgresMigrationSource(
      pool,
      version,
      name,
      version === 10 ? () => legacySource : undefined,
    );
  }

  const applied = await runPostgresMigrations(pool);
  const lfChecksum = createHash("sha256").update(lfSource).digest("hex");
  const crlfChecksum = createHash("sha256").update(crlfSource).digest("hex");
  const legacyChecksum = createHash("sha256").update(legacySource).digest("hex");
  assert.deepEqual(
    applied.map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
  );
  assert.equal(applied[9]?.checksum, legacyChecksum);

  const freshPool = await freshSchemaPool();
  const fresh = await runPostgresMigrations(freshPool);
  assert.equal(fresh[9]?.checksum, lfChecksum);
  assert.notEqual(fresh[9]?.checksum, crlfChecksum);

  await freshPool.query(
    "UPDATE schema_migrations SET checksum = $1 WHERE version = 10",
    [crlfChecksum],
  );
  assert.equal((await runPostgresMigrations(freshPool))[9]?.checksum, crlfChecksum);

  for (const changedSource of [
    `${lfSource} `,
    lfSource.replace("CREATE TABLE", "CREATE TEMPORARY TABLE"),
    `\uFEFF${lfSource}`,
    lfSource.replace("\n", "\r"),
  ]) {
    await freshPool.query(
      "UPDATE schema_migrations SET checksum = $1 WHERE version = 10",
      [createHash("sha256").update(changedSource).digest("hex")],
    );
    await assert.rejects(
      runPostgresMigrations(freshPool),
      /migration 10.*checksum/i,
    );
  }
});

test("PostgreSQL migration runner sanitizes pool connection failures", async () => {
  const failingPool = {
    async connect(): Promise<never> {
      throw new Error("PostgreSQL migration 1 sensitive connection details");
    },
  } as unknown as Pool;

  await assert.rejects(runPostgresMigrations(failingPool), {
    message: "PostgreSQL migration runner failed",
  });
});

test("query context destroys a client when rollback fails", async () => {
  let releaseArgument: Error | boolean | undefined;
  const client = {
    async query(text: string) {
      if (text === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    },
    release(argument?: Error | boolean) {
      releaseArgument = argument;
    },
  } as unknown as PoolClient;
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;
  const context = new PostgresQueryContext(pool);

  await assert.rejects(
    context.transaction(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  assert.equal(releaseArgument, true);
});

test("query context rejects close from inside its active transaction", async () => {
  const pool = await freshSchemaPool();
  const context = new PostgresQueryContext(pool);

  const closeResult = await context.transaction(async () =>
    Promise.race([
      context.close().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 100),
      ),
    ]),
  );

  assert.equal(closeResult, "rejected");
  await context.query("SELECT 1");
  await context.close();
});

test("query context rolls back outer work and reuses its client for nested transactions", async () => {
  const pool = await freshSchemaPool();
  const context = new PostgresQueryContext(pool);
  await context.query("CREATE TABLE transaction_probe (value TEXT NOT NULL)");

  await assert.rejects(
    context.transaction(async (outerClient) => {
      await context.query("INSERT INTO transaction_probe (value) VALUES ('rolled-back')");
      await context.transaction(async (nestedClient) => {
        assert.equal(nestedClient, outerClient);
        const directPid = await outerClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const contextualPid = await context.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        assert.equal(contextualPid.rows[0]?.pid, directPid.rows[0]?.pid);
      });
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(
    (await context.query<{ count: string }>("SELECT COUNT(*) AS count FROM transaction_probe"))
      .rows[0]?.count,
    "0",
  );

  await context.transaction(async () => {
    await context.transaction(async () => {
      await context.query("INSERT INTO transaction_probe (value) VALUES ('committed')");
    });
  });
  assert.equal(
    (await context.query<{ count: string }>("SELECT COUNT(*) AS count FROM transaction_probe"))
      .rows[0]?.count,
    "1",
  );

  await Promise.all([context.close(), context.close()]);
  await assert.rejects(context.query("SELECT 1"), /closed/i);
});

test("PostgreSQL 0001 enforces base uniqueness, foreign keys, checks, and report immutability", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('user-1', 'org-1', 'Owner@Example.com', 'Owner', 'admin', 'active', $1, $1)`,
    [now],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO users
         (id, organization_id, email, display_name, role, status, created_at, updated_at)
       VALUES ('user-2', 'org-1', 'owner@example.com', 'Other', 'member', 'active', $1, $1)`,
      [now],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES ('bad-session', 'missing-user', 'token', $1, $1)`,
      [now],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO users
         (id, organization_id, email, display_name, role, status, created_at, updated_at)
       VALUES ('bad-role', 'org-1', 'bad@example.com', 'Bad', 'owner', 'active', $1, $1)`,
      [now],
    ),
  );

  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ('project-1', 'org-1', 'Project', 'US', '["B000000001"]', 'user-1', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('run-1', 'project-1', 'existing-data', 'running', 'user-1', $1,
             'org-1', 'request-1', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, created_at, updated_at)
     VALUES ('stage-1', 'run-1', 'voc-positioning', 'succeeded', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ('skill-1', 'voc', '1.0.0', 'hash-1', '{}', $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO agent_runs
       (id, run_id, stage_id, skill_version_id, schema_version,
        snapshot_ids_json, provider, model, input_summary_json,
        output_schema_version, output_json, validation_status,
        data_cutoff_at, started_at, completed_at)
     VALUES ('agent-1', 'run-1', 'stage-1', 'skill-1', '1', '{}',
             'test', 'test-model', '{}', '1', '{}', 'passed', $1, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_reports
       (id, run_id, agent_run_id, version, stage, schema_version, status,
        snapshot_ids_json, evidence_json, result_json, data_cutoff_at, created_at)
     VALUES ('report-1', 'run-1', 'agent-1', 1, 'voc-positioning', '1', 'complete',
             '{}', '[]', '{}', $1, $1)`,
    [now],
  );

  await assert.rejects(
    pool.query("UPDATE analysis_reports SET status = 'stale' WHERE id = 'report-1'"),
    /immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM analysis_reports WHERE id = 'report-1'"),
    /immutable/i,
  );

  await insertVocSnapshot(pool, {
    id: "snapshot-1",
    runId: "run-1",
    dataCutoffAt: now,
  });
});

test("PostgreSQL 0004 enforces agent-run audit, snapshot, and budget immutability", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const acquiredAt = new Date();
  const leaseExpiresAt = new Date(acquiredAt.getTime() + 60_000);
  const completedAt = new Date(acquiredAt.getTime() + 1_000);
  const now = acquiredAt.toISOString();
  const expires = leaseExpiresAt.toISOString();

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('audit-user', 'audit-org', 'audit@example.com', 'Audit', 'admin',
             'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ('audit-project', 'audit-org', 'Audit', 'US', '["B000000001"]', 'audit-user',
             $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('audit-run', 'audit-project', 'existing-data', 'running',
             'audit-user', $1, 'audit', 'create', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, started_at,
        created_at, updated_at)
     VALUES ('audit-stage', 'audit-run', 'voc-positioning', 'running', 1, 1,
             $1, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id,
        status, available_at, leased_by, lease_expires_at, lease_generation,
        retryable, started_at, created_at, updated_at)
     VALUES ('audit-job', 'audit-stage', 1, 3, 1, $3, 'running', $1,
             'audit-worker', $2, 1, FALSE, $1, $1, $1)`,
    [now, expires, "d".repeat(64)],
  );
  await pool.query(
    `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ('audit-skill', 'voc', '1.0.0', 'audit-hash', '{}', $1)`,
    [now],
  );
  await insertVocSnapshot(pool, {
    id: "audit-snapshot",
    runId: "audit-run",
    dataCutoffAt: now,
  });

  const insertPending = (agentRunId: string, ownerId: string) =>
    pool.query(
      `INSERT INTO agent_runs (
         id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
         snapshot_ids_json, provider, model, response_id, input_summary_json,
         output_schema_version, output_json, validation_status, input_tokens,
         output_tokens, duration_ms, estimated_cost_micros, error_json,
         data_cutoff_at, started_at, completed_at, execution_fingerprint,
         output_schema_digest, terminal_status, usage_completeness,
         attempt_count, attempts_json, execution_claim_token,
         execution_claim_owner_id, execution_claim_generation,
         execution_claim_acquired_at, execution_claim_expires_at,
         terminal_metadata_json
       ) VALUES (
         $1, 'audit-run', 'audit-stage', 'audit-job', 'audit-skill', '1',
         '["audit-snapshot"]', 'test', 'test-model', NULL, '{}', '1', NULL,
         'pending', NULL, NULL, NULL, NULL, NULL, $2, $2, NULL, $3, $4,
         NULL, NULL, NULL, '[]', 'audit-claim', $5, 1, $2, $6, NULL
       )`,
      [agentRunId, now, "a".repeat(64), "b".repeat(64), ownerId, expires],
    );

  await assert.rejects(
    insertPending("audit-agent-invalid", "wrong-worker"),
    /job does not belong to stage/i,
  );
  await insertPending("audit-agent", "audit-worker");
  await assert.rejects(
    insertPending("audit-agent-duplicate", "audit-worker"),
  );

  await pool.query(
    `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
     VALUES ('audit-agent', 'audit-snapshot', 0)`,
  );
  await assert.rejects(
    pool.query(
      "UPDATE agent_run_snapshots SET ordinal = 1 WHERE agent_run_id = 'audit-agent'",
    ),
    /snapshot links are immutable/i,
  );
  await assert.rejects(
    pool.query(
      "DELETE FROM agent_run_snapshots WHERE agent_run_id = 'audit-agent'",
    ),
    /snapshot links are immutable/i,
  );
  await assert.rejects(
    pool.query(
      `UPDATE agent_runs
          SET execution_claim_token = 'replacement-claim',
              execution_claim_acquired_at = $1,
              execution_claim_expires_at = $2
        WHERE id = 'audit-agent'`,
      [now, expires],
    ),
    /same worker lease agent run claim cannot be replaced/i,
  );

  await pool.query(
    `UPDATE agent_runs
        SET response_id = 'response-a', output_json = '{}',
            validation_status = 'passed', input_tokens = 10,
            output_tokens = 20, duration_ms = 30, estimated_cost_micros = 40,
            completed_at = $1, terminal_status = 'succeeded',
            usage_completeness = 'complete', attempt_count = 1,
            attempts_json = '[{}]', terminal_metadata_json = '{"kind":"succeeded"}'
      WHERE id = 'audit-agent'`,
    [completedAt.toISOString()],
  );
  await assert.rejects(
    pool.query(
      "UPDATE agent_runs SET model = 'changed' WHERE id = 'audit-agent'",
    ),
    /completed agent runs are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM agent_runs WHERE id = 'audit-agent'"),
    /agent runs are immutable/i,
  );

  await pool.query(
    `INSERT INTO model_budget_reservations (
       id, idempotency_key, request_fingerprint, run_id, project_id,
       organization_id, utc_day, state, projected_input_tokens,
       projected_output_tokens, projected_cost_micros, lease_expires_at,
       created_at, updated_at, job_attempt_id, request_ordinal, attempt_kind,
       transient_retry_count, format_repair
     ) VALUES ('audit-budget', 'audit-budget', $1, 'audit-run', 'audit-project',
               'audit-org', $2::date, 'reserved', 10, 10, 20, $3, $2, $2,
               'audit-job', 0, 'initial', 0, FALSE)`,
    ["c".repeat(64), now, expires],
  );
  await pool.query(
    `UPDATE model_budget_reservations
        SET state = 'settled', actual_input_tokens = 5,
            actual_output_tokens = 5, actual_cost_micros = 10,
            lease_expires_at = NULL, response_id = 'response-a',
            settled_at = $1, updated_at = $1
      WHERE id = 'audit-budget'`,
    [completedAt.toISOString()],
  );
  await assert.rejects(
    pool.query(
      `UPDATE model_budget_reservations
          SET response_id = 'response-b'
        WHERE id = 'audit-budget'`,
    ),
    /response id may only be set once during settle/i,
  );
});

test("PostgreSQL 0005 enforces canonical VOC snapshot provenance and immutability", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const cutoff = "2026-08-15T08:00:00.000Z";

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('voc-user', 'voc-org', 'voc@example.com', 'VOC', 'member', 'active', $1, $1)`,
    [cutoff],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ('voc-project', 'voc-org', 'VOC', 'US', '["B000000001"]',
             'voc-user', $1, $1)`,
    [cutoff],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('voc-run', 'voc-project', 'existing-data', 'running', 'voc-user', $1,
             'voc-snapshot', 'create', $1, $1)`,
    [cutoff],
  );

  await insertVocSnapshot(pool, {
    id: "voc-snapshot",
    runId: "voc-run",
    dataCutoffAt: cutoff,
  });

  await assert.rejects(
    insertVocSnapshot(pool, {
      id: "voc-snapshot-duplicate",
      runId: "voc-run",
      dataCutoffAt: cutoff,
    }),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
          data_cutoff_at, sources_json, payload_json, content_hash, created_at)
       VALUES ('voc-legacy', 'voc-run', NULL, 'garbage', 'ZZ', '[]', $1,
               '[]', '{}', 'garbage', $1)`,
      [cutoff],
    ),
    /legacy data snapshot inserts are closed/i,
  );

  const invalid = vocSnapshotFixture(cutoff);
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version,
          marketplace, asins_json, data_cutoff_at, sources_json, payload_json,
          content_hash, created_at)
       VALUES ('voc-invalid-hash', 'voc-run', 'voc', 'voc', $1, $2, $3, $4,
               $5, $6, $7, $4)`,
      [
        invalid.schemaVersion,
        invalid.marketplace,
        JSON.stringify(invalid.asins),
        cutoff,
        JSON.stringify(invalid.sources),
        JSON.stringify(invalid.payload),
        "f".repeat(64),
      ],
    ),
    /invalid VOC data snapshot/i,
  );
  await assert.rejects(
    pool.query(
      "UPDATE data_snapshots SET marketplace = 'CA' WHERE id = 'voc-snapshot'",
    ),
    /data snapshots are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM data_snapshots WHERE id = 'voc-snapshot'"),
    /data snapshots are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM analysis_runs WHERE id = 'voc-run'"),
    /data snapshots are immutable/i,
  );
});

test("PostgreSQL 0007 upgrades v6 data snapshots to artifact kinds and accepts canonical traffic snapshots", async () => {
  const pool = await freshSchemaPool();
  const cutoff = "2026-08-15T08:00:00.000Z";

  await applyPostgresMigrationSource(pool, 1, "agent_runtime");
  await applyPostgresMigrationSource(pool, 2, "job_retry_cycles");
  await applyPostgresMigrationSource(pool, 3, "model_budget_ledger");
  await applyPostgresMigrationSource(pool, 4, "agent_run_audit");
  const vocSeed = await seedSnapshotRun(pool, {
    userId: "traffic-user",
    organizationId: "traffic-org",
    projectId: "traffic-project",
    runId: "traffic-run",
    asins: ["B000000001"],
    cutoff,
  });
  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
        sources_json, payload_json, content_hash, created_at)
     VALUES ('legacy-before-0005', $1, '1.0.0', 'US', $2::jsonb, $3,
             '[]'::jsonb, '{}'::jsonb, 'legacy-hash', $3)`,
    [vocSeed.runId, JSON.stringify(vocSeed.asins), cutoff],
  );
  await applyPostgresMigrationSource(pool, 5, "voc_data_snapshot");
  await insertVocSnapshot(pool, {
    id: "voc-before-0007",
    runId: vocSeed.runId,
    dataCutoffAt: cutoff,
  });
  await applyPostgresMigrationSource(pool, 6, "agent_run_logical_lineage");

  await runPostgresMigrations(pool);

  assert.deepEqual(
    (
      await pool.query<{ id: string; snapshot_kind: string | null; artifact_kind: string }>(
        `SELECT id, snapshot_kind, artifact_kind
           FROM data_snapshots
          ORDER BY id`,
      )
    ).rows,
    [
      {
        id: "legacy-before-0005",
        snapshot_kind: null,
        artifact_kind: "legacy",
      },
      { id: "voc-before-0007", snapshot_kind: "voc", artifact_kind: "voc" },
    ],
  );

  const traffic = trafficSnapshotFixture(cutoff);
  const trafficSeed = await seedSnapshotRun(pool, {
    userId: "traffic-actor",
    organizationId: "traffic-org",
    projectId: "traffic-project-two",
    runId: "traffic-run-two",
    cutoff,
  });
  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
        asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
        created_at)
     VALUES ('traffic-snapshot', $1, NULL, 'traffic', $2, $3, $4::jsonb, $5,
             $6::jsonb, $7::jsonb, $8, $9)`,
      [
      trafficSeed.runId,
      traffic.schemaVersion,
      traffic.marketplace,
      JSON.stringify(traffic.asins),
      traffic.dataCutoffAt,
      JSON.stringify(traffic.sources),
      JSON.stringify(traffic.payload),
      traffic.contentHash,
      cutoff,
    ],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
          asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
          created_at)
       VALUES ('traffic-duplicate', $1, NULL, 'traffic', $2, $3, $4::jsonb, $5,
               $6::jsonb, $7::jsonb, $8, $9)`,
      [
        trafficSeed.runId,
        traffic.schemaVersion,
        traffic.marketplace,
        JSON.stringify(traffic.asins),
        traffic.dataCutoffAt,
        JSON.stringify(traffic.sources),
        JSON.stringify(traffic.payload),
        traffic.contentHash,
        cutoff,
      ],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
          asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
          created_at)
       VALUES ('traffic-bad-payload', $1, NULL, 'traffic', '1.0.0', 'US',
               $2::jsonb, $3, $4::jsonb, '{"input":{"kind":"garbage"}}'::jsonb,
               $5, $3)`,
      [
        trafficSeed.runId,
        JSON.stringify(traffic.asins),
        traffic.dataCutoffAt,
        JSON.stringify(traffic.sources),
        traffic.contentHash,
      ],
    ),
    /invalid traffic data snapshot/i,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO data_snapshots
         (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
          asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
          created_at)
       VALUES ('traffic-kind-mismatch', $1, 'voc', 'traffic', $2, $3, $4::jsonb,
               $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        trafficSeed.runId,
        traffic.schemaVersion,
        traffic.marketplace,
        JSON.stringify(traffic.asins),
        traffic.dataCutoffAt,
        JSON.stringify(traffic.sources),
        JSON.stringify(traffic.payload),
        traffic.contentHash,
        cutoff,
      ],
    ),
    /artifact kind is inconsistent/i,
  );
  await assert.rejects(
    pool.query("UPDATE data_snapshots SET marketplace = 'CA' WHERE id = 'traffic-snapshot'"),
    /data snapshots are immutable/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM data_snapshots WHERE id = 'legacy-before-0005'"),
    /data snapshots are immutable/i,
  );
});

test("PostgreSQL 0008 creates immutable keyword analysis snapshots without a delete trigger", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const cutoff = "2026-08-15T08:00:00.000Z";
  const seeded = await seedSnapshotRun(pool, {
    userId: "keyword-user",
    organizationId: "keyword-org",
    projectId: "keyword-project",
    runId: "keyword-run",
    cutoff,
  });
  const keyword = keywordSnapshotFixture(cutoff);

  await pool.query(
    `INSERT INTO keyword_analysis_snapshots
       (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
        sources_json, payload_json, content_hash, created_at)
     VALUES ('keyword-snapshot', $1, $2, $3, $4::jsonb, $5, $6::jsonb,
             $7::jsonb, $8, $9)`,
    [
      seeded.runId,
      keyword.schemaVersion,
      keyword.marketplace,
      JSON.stringify(keyword.asins),
      keyword.dataCutoffAt,
      JSON.stringify(keyword.sources),
      JSON.stringify(keyword.payload),
      keyword.contentHash,
      cutoff,
    ],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-duplicate', $1, $2, $3, $4::jsonb, $5, $6::jsonb,
               $7::jsonb, $8, $9)`,
      [
        seeded.runId,
        keyword.schemaVersion,
        keyword.marketplace,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(keyword.sources),
        JSON.stringify(keyword.payload),
        keyword.contentHash,
        cutoff,
      ],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-nonus', $1, '1.0.0', 'CA', $2::jsonb, $3, $4::jsonb,
               $5::jsonb, $6, $3)`,
      [
        seeded.runId,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(keyword.sources),
        JSON.stringify(keyword.payload),
        keyword.contentHash,
      ],
    ),
    /invalid keyword analysis snapshot/i,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-empty-groups', $1, '1.0.0', 'US', $2::jsonb, $3,
               $4::jsonb, '{"groups":[],"evidence":[]}'::jsonb, $5, $3)`,
      [
        seeded.runId,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(keyword.sources),
        keyword.contentHash,
      ],
    ),
    /invalid keyword analysis snapshot/i,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-bad-json', $1, '1.0.0', 'US', $2::jsonb, $3, $4::jsonb,
               $5::jsonb, $6, $3)`,
      [
        seeded.runId,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(keyword.sources),
        '{"groups":',
        keyword.contentHash,
      ],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-bad-evidence', $1, '1.0.0', 'US', $2::jsonb, $3,
               $4::jsonb, '{"groups":[{}],"evidence":{}}'::jsonb, $5, $3)`,
      [
        seeded.runId,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(keyword.sources),
        keyword.contentHash,
      ],
    ),
    /invalid keyword analysis snapshot/i,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-bad-hash', $1, '1.0.0', 'US', $2::jsonb, $3,
               $4::jsonb, $5::jsonb, $6, $3)`,
      [
        seeded.runId,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(keyword.sources),
        JSON.stringify(keyword.payload),
        "F".repeat(64),
      ],
    ),
    /invalid keyword analysis snapshot/i,
  );
  const futureSource = [{ ...keyword.sources[0], capturedAt: "2026-08-16T08:00:00.000Z" }];
  await assert.rejects(
    pool.query(
      `INSERT INTO keyword_analysis_snapshots
         (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
          sources_json, payload_json, content_hash, created_at)
       VALUES ('keyword-future-source', $1, '1.0.0', 'US', $2::jsonb, $3,
               $4::jsonb, $5::jsonb, $6, $3)`,
      [
        seeded.runId,
        JSON.stringify(keyword.asins),
        keyword.dataCutoffAt,
        JSON.stringify(futureSource),
        JSON.stringify(keyword.payload),
        keyword.contentHash,
      ],
    ),
    /invalid keyword analysis snapshot/i,
  );
  await assert.rejects(
    pool.query(
      "UPDATE keyword_analysis_snapshots SET payload_json = '{}'::jsonb WHERE id = 'keyword-snapshot'",
    ),
    /keyword analysis snapshots are immutable/i,
  );
  assert.equal(
    (
      await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM pg_trigger
          WHERE tgrelid = 'keyword_analysis_snapshots'::regclass
            AND NOT tgisinternal
            AND lower(pg_get_triggerdef(oid)) LIKE '%before delete%'`,
      )
    ).rows[0]?.count,
    "0",
  );
  await pool.query("DELETE FROM keyword_analysis_snapshots WHERE id = 'keyword-snapshot'");
  assert.equal(
    (
      await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM keyword_analysis_snapshots",
      )
    ).rows[0]?.count,
    "0",
  );
});

test("PostgreSQL 0006 fences logical execution recovery and report publication state", async () => {
  const pool = await freshSchemaPool();
  await runPostgresMigrations(pool);
  const startedAt = "2026-08-15T08:00:00.000Z";
  const reclaimedAt = "2026-08-15T08:01:00.000Z";
  const expiresAt = "2026-08-15T08:10:00.000Z";
  const retryAt = "2026-08-15T08:02:00.000Z";
  const cycle = "1".repeat(64);
  const lineage = "2".repeat(64);

  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('lineage-user', 'lineage-org', 'lineage@example.com', 'Lineage',
             'member', 'active', $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by,
        created_at, updated_at)
     VALUES ('lineage-project', 'lineage-org', 'Lineage', 'US', '["B000000001"]',
             'lineage-user', $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ('lineage-run', 'lineage-project', 'existing-data', 'running',
             'lineage-user', $1, 'lineage', 'create', $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, attempt_count, started_at,
        created_at, updated_at)
     VALUES ('lineage-stage', 'lineage-run', 'voc-positioning', 'running', 1, 1,
             $1, $1, $1)`,
    [startedAt],
  );
  await pool.query(
    `INSERT INTO skill_versions
       (id, skill_id, version, content_hash, manifest_json, created_at)
     VALUES ('lineage-skill', 'voc', '1.0.0', 'lineage-hash', '{}', $1)`,
    [startedAt],
  );
  await insertVocSnapshot(pool, {
    id: "lineage-snapshot",
    runId: "lineage-run",
    dataCutoffAt: startedAt,
  });
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        status, available_at, lease_generation, retryable, completed_at,
        created_at, updated_at)
     VALUES ('derived-job-1', 'lineage-stage', 10, 12, 10, 'failed', $1, 0,
             FALSE, $1, $1, $1),
            ('derived-job-2', 'lineage-stage', 11, 12, 10, 'failed', $1, 0,
             FALSE, $1, $1, $1)`,
    [startedAt],
  );
  const derivedCycles = await pool.query<{
    id: string;
    logical_execution_cycle_id: string;
  }>(
    `SELECT id, logical_execution_cycle_id
       FROM job_attempts WHERE id LIKE 'derived-job-%' ORDER BY id`,
  );
  const expectedDerivedCycle = createHash("sha256")
    .update("lineage-stage:10")
    .digest("hex");
  assert.deepEqual(derivedCycles.rows, [
    { id: "derived-job-1", logical_execution_cycle_id: expectedDerivedCycle },
    { id: "derived-job-2", logical_execution_cycle_id: expectedDerivedCycle },
  ]);
  await assert.rejects(
    pool.query(
      `INSERT INTO job_attempts
         (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
          logical_execution_cycle_id, status, available_at, lease_generation,
          retryable, completed_at, created_at, updated_at)
       VALUES ('derived-job-invalid', 'lineage-stage', 12, 12, 12, $1, 'failed',
               $2, 0, FALSE, $2, $2, $2)`,
      ["A".repeat(64), startedAt],
    ),
  );
  await assert.rejects(
    pool.query(
      `UPDATE job_attempts SET logical_execution_cycle_id = $1
        WHERE id = 'derived-job-1'`,
      ["3".repeat(64)],
    ),
    /logical execution cycle is immutable/i,
  );
  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id, status, available_at, leased_by,
        lease_expires_at, lease_generation, retryable, started_at,
        created_at, updated_at)
     VALUES ('lineage-job-1', 'lineage-stage', 1, 3, 1, $1, 'running', $2,
             'lineage-worker-1', $3, 1, FALSE, $2, $2, $2)`,
    [cycle, startedAt, expiresAt],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO job_attempts
         (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
          logical_execution_cycle_id, status, available_at, lease_generation,
          retryable, created_at, updated_at)
       VALUES ('lineage-job-conflict', 'lineage-stage', 2, 3, 1, $1, 'queued',
               $2, 0, FALSE, $2, $2)`,
      [cycle, startedAt],
    ),
  );

  await pool.query(
    `INSERT INTO agent_runs (
       id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
       snapshot_ids_json, provider, model, response_id, input_summary_json,
       output_schema_version, output_json, validation_status, input_tokens,
       output_tokens, duration_ms, estimated_cost_micros, error_json,
       data_cutoff_at, started_at, completed_at, execution_fingerprint,
       output_schema_digest, logical_execution_lineage, logical_execution_cycle_id,
       active_job_attempt_id, terminal_status, usage_completeness, attempt_count,
       attempts_json, execution_claim_token, execution_claim_owner_id,
       execution_claim_generation, execution_claim_acquired_at,
       execution_claim_expires_at, terminal_metadata_json
     ) VALUES (
       'lineage-agent', 'lineage-run', 'lineage-stage', 'lineage-job-1',
       'lineage-skill', '1.1.0', '["lineage-snapshot"]', 'test', 'test-model',
       NULL, '{"contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","recordCount":1}',
       '1.0.0', NULL, 'pending', NULL, NULL, NULL, NULL, NULL, $1, $1, NULL,
       $2, $3, $4, $5, 'lineage-job-1', NULL, NULL, NULL, '[]', 'claim-1',
       'lineage-worker-1', 1, $1, $6, NULL
     )`,
    [startedAt, "a".repeat(64), "b".repeat(64), lineage, cycle, expiresAt],
  );
  await pool.query(
    `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
     VALUES ('lineage-agent', 'lineage-snapshot', 0)`,
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO agent_runs (
         id, run_id, stage_id, job_attempt_id, skill_version_id, schema_version,
         snapshot_ids_json, provider, model, input_summary_json,
         output_schema_version, validation_status, data_cutoff_at, started_at,
         execution_fingerprint, output_schema_digest, logical_execution_lineage,
         logical_execution_cycle_id, active_job_attempt_id, attempts_json,
         execution_claim_token, execution_claim_owner_id,
         execution_claim_generation, execution_claim_acquired_at,
         execution_claim_expires_at
       ) VALUES (
         'lineage-agent-untrusted', 'lineage-run', 'lineage-stage', 'lineage-job-1',
         'lineage-skill', '1.1.0', '["lineage-snapshot"]', 'test', 'test-model', '{}',
         '1.0.0', 'pending', $1, $1, $2, $3, $4, $5, 'lineage-job-1', '[]',
         'untrusted-claim', 'lineage-worker-1', 1, $1, $6
       )`,
      [
        startedAt,
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
        expiresAt,
      ],
    ),
    /logical cycle has no trusted job authority/i,
  );

  await pool.query(
    `UPDATE job_attempts
        SET report_publication_max_attempts = 2,
            report_publication_initial_delay_ms = 100,
            report_publication_max_delay_ms = 1_000
      WHERE id = 'lineage-job-1'`,
  );
  await pool.query(
    `UPDATE job_attempts
        SET status = 'failed', retryable = TRUE,
            report_publication_attempt_count = 1,
            report_publication_retry_at = $1
      WHERE id = 'lineage-job-1'`,
    [retryAt],
  );
  await assert.rejects(
    pool.query(
      `UPDATE job_attempts SET report_publication_attempt_count = 0
        WHERE id = 'lineage-job-1'`,
    ),
    /report publication transition is invalid/i,
  );
  await assert.rejects(
    pool.query(
      `UPDATE job_attempts SET report_publication_cycle = 2
        WHERE id = 'lineage-job-1'`,
    ),
    /report publication transition is invalid/i,
  );

  await pool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt,
        logical_execution_cycle_id, status, available_at, leased_by,
        lease_expires_at, lease_generation, retryable, started_at,
        created_at, updated_at)
     VALUES ('lineage-job-2', 'lineage-stage', 2, 3, 1, $1, 'running', $2,
             'lineage-worker-2', $3, 1, FALSE, $2, $2, $2)`,
    [cycle, reclaimedAt, expiresAt],
  );
  await pool.query(
    `UPDATE agent_runs
        SET active_job_attempt_id = 'lineage-job-2',
            execution_claim_token = 'claim-2',
            execution_claim_owner_id = 'lineage-worker-2',
            execution_claim_generation = 1,
            execution_claim_acquired_at = $1,
            execution_claim_expires_at = $2
      WHERE id = 'lineage-agent'`,
    [reclaimedAt, expiresAt],
  );
  await assert.rejects(
    pool.query(
      `UPDATE agent_runs
          SET active_job_attempt_id = 'lineage-job-1',
              execution_claim_token = 'stale-claim',
              execution_claim_owner_id = 'lineage-worker-1',
              execution_claim_generation = 1,
              execution_claim_acquired_at = $1,
              execution_claim_expires_at = $2
        WHERE id = 'lineage-agent'`,
      [reclaimedAt, expiresAt],
    ),
    /replacement agent run claim has no active job lease/i,
  );
  await assert.rejects(
    pool.query(
      `UPDATE agent_runs
          SET active_job_attempt_id = 'lineage-job-1',
              response_id = 'response', output_json = '{}',
              validation_status = 'passed', input_tokens = 1, output_tokens = 1,
              duration_ms = 1, estimated_cost_micros = 1, completed_at = $1,
              terminal_status = 'succeeded', usage_completeness = 'complete',
              attempt_count = 1, attempts_json = '[{}]',
              terminal_metadata_json = '{"kind":"succeeded"}'
        WHERE id = 'lineage-agent'`,
      [reclaimedAt],
    ),
    /active recovery authority is immutable at completion/i,
  );
});

test("PostgreSQL test container rejects pools created after close", async () => {
  const isolated = await startPostgresTestContainer();
  await isolated.close();
  let latePool: Pool | undefined;
  let closeError: unknown;
  try {
    latePool = isolated.createPool();
  } catch (error) {
    closeError = error;
  }
  await latePool?.end();

  assert.ok(closeError instanceof Error);
  assert.match(closeError.message, /clos/i);
});
