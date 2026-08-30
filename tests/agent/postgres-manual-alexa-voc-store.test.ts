import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import {
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocOutboxLease,
  type PutManualAlexaVocInput,
} from "../../server/db/manual-alexa-voc-repository";
import {
  PostgresAgentRepository,
} from "../../server/db/postgres-repository";
import {
  PostgresManualAlexaVocStore,
  type PostgresQueryExecutor,
} from "../../server/db/postgres/manual-alexa-voc-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import type { ManualAlexaVocEncryptedRaw } from "../../server/security/manual-alexa-voc-cipher";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const ASIN = "B0AAAA0001";
const OTHER_ASIN = "B0BBBB0002";
const THIRD_ASIN = "B0CCCC0003";
const CREATED_AT = "2026-08-31T08:00:00.000Z";
const NORMALIZED_SCHEMA_VERSION = "alexa-voc-record/v2" as const;
const PARSER_VERSION = "deterministic-alexa-parser/v3" as const;

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

function hash(character: "a" | "b" | "c" | "d" | "e" | "f") {
  return character.repeat(64);
}

function normalizedRecord(asin = ASIN, marker = "fixture") {
  return {
    asin,
    attention: [`attention-${marker}`],
    positives: [`positive-${marker}`],
    negatives: [`negative-${marker}`],
    unmet: [`unmet-${marker}`],
    audiences: [`audience-${marker}`],
    scenarios: [`scenario-${marker}`],
    motives: [`motive-${marker}`],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: `Report ${marker}`,
      asin,
      rating: 4.5,
      reviewCount: 42,
      prompt: "fixture prompt",
      overallConclusion: `conclusion-${marker}`,
    },
  };
}

function encryptedRaw(seed: number): ManualAlexaVocEncryptedRaw {
  return Object.freeze({
    algVersion: "AES-256-GCM/v1",
    keyId: `fixture-key-${seed}`,
    wrappedDek: Uint8Array.from({ length: 60 }, (_, index) => (seed + index) % 256),
    nonce: Uint8Array.from({ length: 12 }, (_, index) => (seed * 3 + index) % 256),
    ciphertext: Uint8Array.from([seed, seed + 1, seed + 2, seed + 3]),
    tag: Uint8Array.from({ length: 16 }, (_, index) => (seed * 7 + index) % 256),
    aadSha256: hash("d"),
    plaintextBytes: 4,
    plaintextSha256: hash("e"),
  });
}

function putInput(input: Readonly<{
  organizationId: string;
  createdBy: string;
  asin?: string;
  expectedRevision: string;
  contentHash: string;
  marker?: string;
  rawSeed?: number;
}>): PutManualAlexaVocInput {
  const asin = (input.asin ?? ASIN).trim().toUpperCase();
  return {
    organizationId: input.organizationId,
    marketplace: "US",
    asin: input.asin ?? ASIN,
    createdBy: input.createdBy,
    expectedRevision: input.expectedRevision,
    normalizedRecord: normalizedRecord(asin, input.marker),
    normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    contentHash: input.contentHash,
    raw: encryptedRaw(input.rawSeed ?? 1),
  };
}

function addMilliseconds(timestamp: string, milliseconds: number) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

async function createSchema(): Promise<string> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const migrationPool = postgres.createPool({ searchPath: schema });
  try {
    await runPostgresMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }
  return schema;
}

function openRepository(t: test.TestContext, schema: string) {
  const pool = postgres.createPool({ searchPath: schema });
  const repository = new PostgresAgentRepository(pool);
  t.after(async () => {
    await repository.close();
  });
  return { pool, repository };
}

async function seedUser(
  repository: PostgresAgentRepository,
  organizationId: string,
  status: "active" | "disabled" = "active",
) {
  const id = randomUUID();
  await repository.createUser({
    id,
    organizationId,
    email: `${id}@example.com`,
    displayName: "Manual Alexa VOC PostgreSQL fixture",
    role: "admin",
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return id;
}

async function write(
  repository: PostgresAgentRepository,
  input: Omit<Parameters<typeof putInput>[0], "expectedRevision"> &
    Readonly<{ expectedRevision?: string }>,
) {
  return repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId: input.organizationId,
      marketplace: "US",
      asins: [input.asin ?? ASIN],
    });
    const expectedRevision = input.expectedRevision ??
      await repository.manualAlexaVoc.peekNextRevision({
        organizationId: input.organizationId,
        marketplace: "US",
        asin: input.asin ?? ASIN,
      });
    return repository.manualAlexaVoc.put(putInput({ ...input, expectedRevision }));
  });
}

async function expectRepositoryError(
  operation: Promise<unknown>,
  kind: ManualAlexaVocRepositoryError["kind"],
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ManualAlexaVocRepositoryError);
    assert.equal(error.kind, kind);
    return true;
  });
}

test("serializes concurrent revisions by tenant scope and binds the runtime capability", async (t) => {
  const schema = await createSchema();
  const first = openRepository(t, schema);
  const second = openRepository(t, schema);
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const actor = await seedUser(first.repository, organizationA);
  await seedUser(first.repository, organizationB);

  const results = await Promise.all([
    write(first.repository, {
      organizationId: organizationA,
      createdBy: actor,
      contentHash: hash("a"),
      marker: "concurrent-a",
      rawSeed: 1,
    }),
    write(second.repository, {
      organizationId: organizationA,
      createdBy: actor,
      contentHash: hash("b"),
      marker: "concurrent-b",
      rawSeed: 2,
    }),
  ]);

  assert.deepEqual(results.map((result) => result.record.revision).sort(), ["1", "2"]);
  assert.deepEqual(
    await first.repository.manualAlexaVoc.listCurrent({
      organizationId: organizationB,
      marketplace: "US",
      asins: [ASIN],
    }),
    [],
  );
  const history = await first.pool.query<{ revision: string }>(
    `SELECT revision::text AS revision
       FROM manual_alexa_voc_revisions
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2
      ORDER BY revision`,
    [organizationA, ASIN],
  );
  assert.deepEqual(history.rows.map((row) => row.revision), ["1", "2"]);
  const outboxForHead = await first.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM manual_alexa_voc_publication_outbox o
       JOIN manual_alexa_voc_heads h
         ON h.organization_id = o.organization_id
        AND h.marketplace = o.marketplace AND h.asin = o.asin
        AND h.latest_revision = o.revision
        AND h.latest_content_hash = o.content_hash
      WHERE h.organization_id = $1 AND h.marketplace = 'US' AND h.asin = $2`,
    [organizationA, ASIN],
  );
  assert.equal(outboxForHead.rows[0]?.count, "1");
});

test("deduplicates only the current hash and repairs missing or failed outbox work", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    marker: "first",
    rawSeed: 1,
  });

  await pool.query(
    `DELETE FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  const repairedMissing = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    marker: "ignored",
    rawSeed: 8,
  });
  assert.deepEqual(
    [repairedMissing.record.revision, repairedMissing.idempotent, repairedMissing.publication.status],
    ["1", true, "pending"],
  );
  assert.deepEqual(repairedMissing.record.normalizedRecord, first.record.normalizedRecord);

  await pool.query(
    `UPDATE manual_alexa_voc_publication_outbox
        SET status = 'failed', last_error_json = '{"code":"fixture"}'::jsonb
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  const repairedFailed = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 9,
  });
  assert.equal(repairedFailed.publication.status, "pending");
  const outbox = await pool.query<{
    status: string;
    leased_by: string | null;
    lease_expires_at: Date | null;
    last_error_json: unknown;
    applied_at: Date | null;
  }>(
    `SELECT status, leased_by, lease_expires_at, last_error_json, applied_at
       FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.deepEqual(outbox.rows[0], {
    status: "pending",
    leased_by: null,
    lease_expires_at: null,
    last_error_json: null,
    applied_at: null,
  });

  const second = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("b"),
    marker: "second",
    rawSeed: 2,
  });
  const rollbackHash = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    marker: "third",
    rawSeed: 3,
  });
  assert.deepEqual([second.record.revision, rollbackHash.record.revision], ["2", "3"]);
  assert.equal(rollbackHash.idempotent, false);
});

test("uses clock_timestamp Z serialization, cutoff ordering, and bigint text revisions", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const clock = await repository.transaction(() =>
    repository.manualAlexaVoc.readDatabaseClock(),
  );
  assert.match(clock, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(clock).toISOString(), clock);

  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 1,
  });
  const second = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("b"),
    rawSeed: 2,
  });
  assert.deepEqual(
    (await repository.manualAlexaVoc.listAtCutoff({
      organizationId,
      marketplace: "US",
      asins: [ASIN],
      dataCutoffAt: first.record.capturedAt,
    })).map((record) => record.revision),
    ["1"],
  );
  assert.equal(
    (await repository.manualAlexaVoc.getCurrent({
      organizationId,
      marketplace: "US",
      asin: ASIN,
    }))?.revision,
    second.record.revision,
  );

  const largeRevision = "9007199254740993";
  await pool.query(
    `INSERT INTO manual_alexa_voc_revisions (
       organization_id, marketplace, asin, revision, content_hash, captured_at,
       normalized_record, normalized_schema_version, parser_version,
       raw_report_sha256, raw_report_alg_version, raw_report_key_id,
       raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
       raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
       created_by, created_at
     ) VALUES ($1, 'US', $2, $3::bigint, $4, $5::timestamptz, $6::jsonb, $7, $8,
               $9, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, $10, $5::timestamptz)`,
    [
      organizationId,
      OTHER_ASIN,
      largeRevision,
      hash("c"),
      CREATED_AT,
      JSON.stringify(normalizedRecord(OTHER_ASIN, "large")),
      NORMALIZED_SCHEMA_VERSION,
      PARSER_VERSION,
      hash("d"),
      actor,
    ],
  );
  await pool.query(
    `INSERT INTO manual_alexa_voc_heads (
       organization_id, marketplace, asin, latest_revision,
       latest_content_hash, latest_captured_at, generation, updated_at
     ) VALUES ($1, 'US', $2, $3::bigint, $4, $5::timestamptz, 1, $5::timestamptz)`,
    [organizationId, OTHER_ASIN, largeRevision, hash("c"), CREATED_AT],
  );
  const large = await repository.manualAlexaVoc.getCurrent({
    organizationId,
    marketplace: "US",
    asin: OTHER_ASIN,
  });
  assert.equal(large?.revision, largeRevision);
  assert.equal(typeof large?.revision, "string");
});

test("sorts two-ASIN advisory locks and completes opposite-order transactions without deadlock", async (t) => {
  const schema = await createSchema();
  const first = openRepository(t, schema);
  const second = openRepository(t, schema);
  const organizationId = randomUUID();
  const actor = await seedUser(first.repository, organizationId);

  await Promise.all([
    first.repository.transaction(async () => {
      await first.repository.manualAlexaVoc.lockScopes({
        organizationId,
        marketplace: "US",
        asins: [OTHER_ASIN, ASIN],
      });
      await first.repository.manualAlexaVoc.put(putInput({
        organizationId,
        createdBy: actor,
        asin: ASIN,
        expectedRevision: "1",
        contentHash: hash("a"),
        rawSeed: 1,
      }));
    }),
    second.repository.transaction(async () => {
      await second.repository.manualAlexaVoc.lockScopes({
        organizationId,
        marketplace: "US",
        asins: [ASIN, OTHER_ASIN],
      });
      await second.repository.manualAlexaVoc.put(putInput({
        organizationId,
        createdBy: actor,
        asin: OTHER_ASIN,
        expectedRevision: "1",
        contentHash: hash("b"),
        rawSeed: 2,
      }));
    }),
  ]);
  assert.deepEqual(
    (await first.repository.manualAlexaVoc.listCurrent({
      organizationId,
      marketplace: "US",
      asins: [OTHER_ASIN, ASIN],
    })).map((record) => record.asin),
    [ASIN, OTHER_ASIN],
  );

  const lockKeys: string[] = [];
  const executor: PostgresQueryExecutor = {
    async query<Row extends QueryResultRow>(text: string, values?: unknown[]) {
      if (text.includes("pg_advisory_xact_lock")) {
        lockKeys.push(Buffer.from(values?.[0] as Uint8Array).toString("utf8"));
      }
      return queryResult<Row>([]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  };
  const store = new PostgresManualAlexaVocStore(executor);
  await store.transaction(() => store.lockScopes({
    organizationId,
    marketplace: "US",
    asins: [OTHER_ASIN, ASIN],
  }));
  assert.deepEqual(lockKeys, [
    `manual-voc\0${organizationId}\0US\0${ASIN}`,
    `manual-voc\0${organizationId}\0US\0${OTHER_ASIN}`,
  ]);
});

test("requires scoped locks, rolls back atomically, enforces head CAS, and rejects cross-tenant actors", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const actorA = await seedUser(repository, organizationA);
  const actorB = await seedUser(repository, organizationB);
  const disabledActor = await seedUser(repository, organizationA, "disabled");
  const scope = { organizationId: organizationA, marketplace: "US" as const, asin: ASIN };

  await expectRepositoryError(repository.manualAlexaVoc.peekNextRevision(scope), "conflict");
  await expectRepositoryError(
    repository.transaction(() => repository.manualAlexaVoc.put(putInput({
      organizationId: organizationA,
      createdBy: actorA,
      expectedRevision: "1",
      contentHash: hash("a"),
    }))),
    "conflict",
  );
  await assert.rejects(
    repository.transaction(async () => {
      await repository.manualAlexaVoc.lockScopes({
        organizationId: organizationA,
        marketplace: "US",
        asins: [ASIN],
      });
      await repository.manualAlexaVoc.put(putInput({
        organizationId: organizationA,
        createdBy: actorA,
        expectedRevision: "1",
        contentHash: hash("a"),
      }));
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(await repository.manualAlexaVoc.getCurrent(scope), null);

  await expectRepositoryError(write(repository, {
    organizationId: organizationA,
    createdBy: actorB,
    contentHash: hash("a"),
  }), "permission");
  await expectRepositoryError(write(repository, {
    organizationId: organizationA,
    createdBy: disabledActor,
    contentHash: hash("a"),
  }), "permission");
  const first = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("a"),
  });
  await expectRepositoryError(write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("b"),
    expectedRevision: "9",
    rawSeed: 2,
  }), "conflict");
  assert.equal((await repository.manualAlexaVoc.getCurrent(scope))?.revision, first.record.revision);
  await assert.rejects(
    pool.query(
      `UPDATE manual_alexa_voc_heads SET latest_content_hash = $1
        WHERE organization_id = $2 AND marketplace = 'US' AND asin = $3`,
      [hash("f"), organizationA, ASIN],
    ),
    (error: unknown) => (error as { code?: string }).code === "23503",
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO manual_alexa_voc_revisions (
         organization_id, marketplace, asin, revision, content_hash, captured_at,
         normalized_record, normalized_schema_version, parser_version,
         raw_report_sha256, raw_report_alg_version, raw_report_key_id,
         raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
         raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
         created_by, created_at
       ) VALUES ($1, 'US', $2, 1, $3, $4::timestamptz, $5::jsonb, $6, $7,
                 $8, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, $9, $4::timestamptz)`,
      [
        organizationA,
        OTHER_ASIN,
        hash("b"),
        CREATED_AT,
        JSON.stringify(normalizedRecord(OTHER_ASIN, "foreign-actor")),
        NORMALIZED_SCHEMA_VERSION,
        PARSER_VERSION,
        hash("c"),
        actorB,
      ],
    ),
    (error: unknown) => (error as { code?: string }).code === "23503",
  );
});

test("maps SQLSTATE and deserialize failures without converting them into missing results", async () => {
  const scope = { organizationId: randomUUID(), marketplace: "US" as const, asin: ASIN };
  for (const [code, kind] of [
    ["ECONNRESET", "connection"],
    ["08006", "connection"],
    ["57014", "timeout"],
    ["42501", "permission"],
    ["42P01", "schema"],
    ["42703", "schema"],
    ["23514", "schema"],
  ] as const) {
    const executor = throwingExecutor(code);
    const store = new PostgresManualAlexaVocStore(executor);
    await expectRepositoryError(store.getCurrent(scope), kind);
    await expectRepositoryError(store.listCurrent({ ...scope, asins: [ASIN] }), kind);
  }

  const malformed = new PostgresManualAlexaVocStore({
    async query<Row extends QueryResultRow>() {
      return queryResult<Row>([{
        organization_id: scope.organizationId,
        marketplace: "US",
        asin: ASIN,
        revision: "1",
        content_hash: hash("a"),
        captured_at: new Date(CREATED_AT),
        normalized_record: {},
        normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
        parser_version: PARSER_VERSION,
      } as unknown as Row]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  });
  await expectRepositoryError(malformed.getCurrent(scope), "deserialize");

  const empty = new PostgresManualAlexaVocStore({
    async query<Row extends QueryResultRow>() {
      return queryResult<Row>([]);
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  });
  assert.equal(await empty.getCurrent(scope), null);
  assert.deepEqual(await empty.listCurrent({ ...scope, asins: [ASIN] }), []);
});

test("maps exhausted revision and head uniqueness conflicts separately from constraint drift", async () => {
  const scope = { organizationId: randomUUID(), marketplace: "US" as const, asin: ASIN };
  for (const constraint of [
    "manual_alexa_voc_revisions_pkey",
    "manual_alexa_voc_heads_pkey",
  ]) {
    const store = new PostgresManualAlexaVocStore(
      throwingExecutor("23505", constraint),
    );
    await expectRepositoryError(store.getCurrent(scope), "conflict");
  }
  await expectRepositoryError(
    new PostgresManualAlexaVocStore(
      throwingExecutor("23505", "unexpected_unique_constraint"),
    ).getCurrent(scope),
    "schema",
  );
});

test("leases, fails, retries, applies, and reconciles publication work", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const leasedAt = addMilliseconds(first.record.capturedAt, 1_000);
  const firstLease: ManualAlexaVocOutboxLease | null =
    await repository.manualAlexaVoc.leasePublication({
      ownerId: "publisher-a",
      leasedAt,
      leaseDurationMs: 60_000,
    });
  assert.ok(firstLease);
  assert.deepEqual(
    [firstLease.organizationId, firstLease.asin, firstLease.revision, firstLease.generation, firstLease.leaseOwner],
    [organizationId, ASIN, "1", "1", "publisher-a"],
  );

  const failedAt = addMilliseconds(leasedAt, 1_000);
  const nextAttemptAt = addMilliseconds(failedAt, 10_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt,
    nextAttemptAt,
    errorCode: "PROJECTION_WRITE_FAILED",
  });
  assert.equal(await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: addMilliseconds(nextAttemptAt, -1),
    leaseDurationMs: 60_000,
  }), null);
  const retryLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: nextAttemptAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(retryLease);
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...firstLease,
    appliedAt: addMilliseconds(nextAttemptAt, 1_000),
  }), "conflict");
  const appliedAt = addMilliseconds(nextAttemptAt, 2_000);
  await repository.manualAlexaVoc.markPublicationApplied({ ...retryLease, appliedAt });
  const applied = await pool.query<{
    status: string;
    attempt_count: number;
    leased_by: string | null;
    lease_expires_at: Date | null;
    last_error_json: unknown;
    applied_at: Date;
  }>(
    `SELECT status, attempt_count, leased_by, lease_expires_at,
            last_error_json, applied_at
       FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.equal(applied.rows[0]?.status, "applied");
  assert.equal(applied.rows[0]?.attempt_count, 2);
  assert.equal(applied.rows[0]?.leased_by, null);
  assert.equal(applied.rows[0]?.lease_expires_at, null);
  assert.equal(applied.rows[0]?.last_error_json, null);
  assert.equal(applied.rows[0]?.applied_at.toISOString(), appliedAt);

  await pool.query(
    `DELETE FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  const reconciledAt = addMilliseconds(appliedAt, 1_000);
  assert.equal(await repository.manualAlexaVoc.reconcilePublication({ reconciledAt }), 1);
  assert.equal((await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-c",
    leasedAt: reconciledAt,
    leaseDurationMs: 60_000,
  }))?.revision, "1");
});

test("records access audit and clears expired raw envelopes transactionally", async (t) => {
  const { pool, repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 4,
  });
  const occurredAt = addMilliseconds(first.record.capturedAt, 1_000);
  await repository.transaction(() => repository.manualAlexaVoc.recordRawAccess({
    id: randomUUID(),
    organizationId,
    marketplace: "US",
    asin: ASIN,
    revision: "1",
    actorUserId: actor,
    purpose: "decrypt",
    occurredAt,
    result: "succeeded",
  }));
  const before = addMilliseconds(first.record.capturedAt, 2_000);
  const clearedAt = addMilliseconds(first.record.capturedAt, 3_000);
  assert.equal(await repository.transaction(() => repository.manualAlexaVoc.clearExpiredRaw({
    organizationId,
    before,
    clearedAt,
    actorUserId: actor,
  })), 1);
  assert.equal(await repository.transaction(() => repository.manualAlexaVoc.clearExpiredRaw({
    organizationId,
    before,
    clearedAt: addMilliseconds(clearedAt, 1_000),
    actorUserId: actor,
  })), 0);

  const stored = await pool.query<Record<string, unknown>>(
    `SELECT normalized_record, raw_report_sha256, raw_report_plaintext_bytes,
            raw_report_alg_version, raw_report_key_id, raw_report_wrapped_dek,
            raw_report_nonce, raw_report_ciphertext, raw_report_tag,
            raw_report_aad_sha256
       FROM manual_alexa_voc_revisions
      WHERE organization_id = $1 AND marketplace = 'US' AND asin = $2`,
    [organizationId, ASIN],
  );
  assert.deepEqual(stored.rows[0]?.normalized_record, first.record.normalizedRecord);
  assert.equal(stored.rows[0]?.raw_report_sha256, hash("e"));
  assert.equal(stored.rows[0]?.raw_report_plaintext_bytes, 4);
  for (const key of [
    "raw_report_alg_version",
    "raw_report_key_id",
    "raw_report_wrapped_dek",
    "raw_report_nonce",
    "raw_report_ciphertext",
    "raw_report_tag",
    "raw_report_aad_sha256",
  ]) assert.equal(stored.rows[0]?.[key], null);
  const audit = await pool.query<{ purpose: string; result: string; created_at: Date }>(
    `SELECT purpose, result, created_at
       FROM manual_alexa_voc_access_audit
      WHERE organization_id = $1 ORDER BY created_at`,
    [organizationId],
  );
  assert.deepEqual(audit.rows.map((row) => ({
    purpose: row.purpose,
    result: row.result,
    createdAt: row.created_at.toISOString(),
  })), [
    { purpose: "decrypt", result: "allowed", createdAt: occurredAt },
    { purpose: "delete-policy", result: "allowed", createdAt: clearedAt },
  ]);
});

test("claims and completes run creation idempotently in the caller transaction", async (t) => {
  const { repository } = openRepository(t, await createSchema());
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const projectId = randomUUID();
  const runId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "PostgreSQL run creation fixture",
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    createdBy: actor,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actor,
    dataCutoffAt: CREATED_AT,
    idempotencyScope: `manual-voc-run:${runId}`,
    idempotencyKey: "create",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    dataCutoffAt: CREATED_AT,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: CREATED_AT,
      records: [normalizedRecord()],
    }],
  });
  await repository.createDataSnapshotForRun({
    actorId: actor,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    expectedRunCutoffAt: CREATED_AT,
    candidateId: snapshotId,
    createdAt: CREATED_AT,
    candidate,
  });
  const claim = {
    organizationId,
    idempotencyKey: "run-key",
    fingerprint: hash("f"),
  };
  await repository.transaction(async () => {
    assert.deepEqual(await repository.manualAlexaVoc.claimRunCreation(claim), { kind: "winner" });
    await repository.manualAlexaVoc.completeRunCreation({
      ...claim,
      runId,
      snapshotId,
      completedAt: CREATED_AT,
    });
  });
  await repository.transaction(async () => {
    assert.deepEqual(await repository.manualAlexaVoc.claimRunCreation(claim), {
      kind: "replay",
      runId,
      snapshotId,
    });
    assert.deepEqual(await repository.manualAlexaVoc.claimRunCreation({
      ...claim,
      fingerprint: hash("e"),
    }), { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
  });
});

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function throwingExecutor(code: string, constraint?: string): PostgresQueryExecutor {
  return {
    async query() {
      throw Object.assign(new Error("typed PostgreSQL fixture"), { code, constraint });
    },
    async transaction<Result>(operation: () => Promise<Result>) {
      return operation();
    },
  };
}
