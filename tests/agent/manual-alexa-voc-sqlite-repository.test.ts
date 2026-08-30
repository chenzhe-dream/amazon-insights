import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ManualAlexaVocRepositoryError,
  type PutManualAlexaVocInput,
} from "../../server/db/manual-alexa-voc-repository";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import type { ManualAlexaVocEncryptedRaw } from "../../server/security/manual-alexa-voc-cipher";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";

const ASIN = "B0AAAA0001";
const OTHER_ASIN = "B0BBBB0002";
const THIRD_ASIN = "B0CCCC0003";
const CREATED_AT = "2026-08-31T08:00:00.000Z";
const NORMALIZED_SCHEMA_VERSION = "alexa-voc-record/v2" as const;
const PARSER_VERSION = "deterministic-alexa-parser/v3" as const;

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "manual-alexa-voc-sqlite-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

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
  const canonicalAsin = (input.asin ?? ASIN).trim().toUpperCase();
  return {
    organizationId: input.organizationId,
    marketplace: "US",
    asin: input.asin ?? ASIN,
    createdBy: input.createdBy,
    expectedRevision: input.expectedRevision,
    normalizedRecord: normalizedRecord(canonicalAsin, input.marker),
    normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    contentHash: input.contentHash,
    raw: encryptedRaw(input.rawSeed ?? 1),
  };
}

async function seedUser(
  repository: SqliteAgentRepository,
  organizationId: string,
  status: "active" | "disabled" = "active",
) {
  const id = randomUUID();
  await repository.createUser({
    id,
    organizationId,
    email: `${id}@example.com`,
    displayName: "Manual Alexa VOC fixture",
    role: "admin",
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return id;
}

async function write(
  repository: SqliteAgentRepository,
  input: Omit<Parameters<typeof putInput>[0], "expectedRevision"> &
    Readonly<{ expectedRevision?: string }>,
) {
  return repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId: input.organizationId,
      marketplace: "US",
      asins: [input.asin ?? ASIN],
    });
    const expectedRevision =
      input.expectedRevision ??
      (await repository.manualAlexaVoc.peekNextRevision({
        organizationId: input.organizationId,
        marketplace: "US",
        asin: input.asin ?? ASIN,
      }));
    return repository.manualAlexaVoc.put(putInput({ ...input, expectedRevision }));
  });
}

async function waitForLaterDatabaseClock(
  repository: SqliteAgentRepository,
  earlier: string,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const clock = await repository.transaction(() =>
      repository.manualAlexaVoc.readDatabaseClock(),
    );
    if (clock > earlier) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("SQLite database clock did not advance");
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

test("writes tenant-scoped decimal revisions, deduplicates only the head, and lists at cutoff", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const actorA = await seedUser(repository, organizationA);
  await seedUser(repository, organizationB);

  const first = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    asin: ` ${ASIN.toLowerCase()} `,
    contentHash: hash("a"),
    marker: "first",
  });
  assert.deepEqual([first.record.revision, first.idempotent], ["1", false]);
  assert.equal(typeof first.record.revision, "string");
  assert.equal(first.record.asin, ASIN);

  const same = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("a"),
    marker: "ignored-idempotent-payload",
    rawSeed: 9,
  });
  assert.deepEqual(
    [same.record.revision, same.record.capturedAt, same.idempotent],
    ["1", first.record.capturedAt, true],
  );
  assert.deepEqual(same.record.normalizedRecord, first.record.normalizedRecord);

  await waitForLaterDatabaseClock(repository, first.record.capturedAt);
  const second = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("b"),
    marker: "second",
    rawSeed: 2,
  });
  assert.equal(second.record.revision, "2");
  assert.ok(second.record.capturedAt > first.record.capturedAt);

  assert.deepEqual(
    await repository.manualAlexaVoc.listCurrent({
      organizationId: organizationB,
      marketplace: "US",
      asins: [ASIN],
    }),
    [],
  );
  const atFirstCutoff = await repository.manualAlexaVoc.listAtCutoff({
    organizationId: organizationA,
    marketplace: "US",
    asins: [ASIN],
    dataCutoffAt: first.record.capturedAt,
  });
  assert.deepEqual(atFirstCutoff.map((record) => record.revision), ["1"]);

  const rollbackToEarlierContent = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("a"),
    marker: "third",
    rawSeed: 3,
  });
  assert.deepEqual(
    [rollbackToEarlierContent.record.revision, rollbackToEarlierContent.idempotent],
    ["3", false],
  );
  assert.equal(
    (await repository.manualAlexaVoc.getCurrent({
      organizationId: organizationA,
      marketplace: "US",
      asin: ASIN,
    }))?.revision,
    "3",
  );
});

test("rejects cross-organization and disabled actors without partial writes", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const foreignActor = await seedUser(repository, organizationB);
  const disabledActor = await seedUser(repository, organizationA, "disabled");

  await expectRepositoryError(
    write(repository, {
      organizationId: organizationA,
      createdBy: foreignActor,
      contentHash: hash("a"),
    }),
    "permission",
  );
  await expectRepositoryError(
    write(repository, {
      organizationId: organizationA,
      createdBy: disabledActor,
      contentHash: hash("b"),
    }),
    "permission",
  );
  assert.deepEqual(
    await repository.manualAlexaVoc.listCurrent({
      organizationId: organizationA,
      marketplace: "US",
      asins: [ASIN],
    }),
    [],
  );
  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  assert.equal(
    Number(
      (inspector.prepare("SELECT COUNT(*) AS count FROM manual_alexa_voc_publication_outbox").get() as { count: number }).count,
    ),
    0,
  );
  inspector.close();
});

test("persists the Task 3 envelope and repairs only missing or failed idempotent outbox work", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const raw = encryptedRaw(4);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("c"),
    rawSeed: 4,
  });
  assert.equal(first.publication.status, "pending");
  assert.equal(first.publication.generation, "1");

  const inspector = new DatabaseSync(temporary.path);
  inspector.exec("PRAGMA foreign_keys = ON");
  const stored = inspector
    .prepare(
      `SELECT raw_report_alg_version, raw_report_key_id, raw_report_wrapped_dek,
              raw_report_nonce, raw_report_ciphertext, raw_report_tag,
              raw_report_aad_sha256, raw_report_plaintext_bytes, raw_report_sha256
         FROM manual_alexa_voc_revisions
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .get(organizationId, ASIN) as Record<string, string | number | Uint8Array>;
  assert.equal(stored.raw_report_alg_version, raw.algVersion);
  assert.equal(stored.raw_report_key_id, raw.keyId);
  assert.deepEqual(Buffer.from(stored.raw_report_wrapped_dek as Uint8Array), Buffer.from(raw.wrappedDek));
  assert.deepEqual(Buffer.from(stored.raw_report_nonce as Uint8Array), Buffer.from(raw.nonce));
  assert.deepEqual(Buffer.from(stored.raw_report_ciphertext as Uint8Array), Buffer.from(raw.ciphertext));
  assert.deepEqual(Buffer.from(stored.raw_report_tag as Uint8Array), Buffer.from(raw.tag));
  assert.equal(stored.raw_report_aad_sha256, raw.aadSha256);
  assert.equal(stored.raw_report_plaintext_bytes, raw.plaintextBytes);
  assert.equal(stored.raw_report_sha256, raw.plaintextSha256);

  inspector
    .prepare(
      `DELETE FROM manual_alexa_voc_publication_outbox
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .run(organizationId, ASIN);
  const repairedMissing = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("c"),
    rawSeed: 8,
  });
  assert.deepEqual(
    [repairedMissing.idempotent, repairedMissing.publication.status],
    [true, "pending"],
  );

  inspector
    .prepare(
      `UPDATE manual_alexa_voc_publication_outbox
          SET status = 'failed', last_error_json = '{"code":"fixture"}',
              updated_at = ?
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .run(CREATED_AT, organizationId, ASIN);
  const repairedFailed = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("c"),
    rawSeed: 9,
  });
  assert.deepEqual(
    [repairedFailed.idempotent, repairedFailed.publication.status],
    [true, "pending"],
  );
  const outbox = inspector
    .prepare(
      `SELECT status, leased_by, lease_expires_at, last_error_json, applied_at
         FROM manual_alexa_voc_publication_outbox
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .get(organizationId, ASIN) as Record<string, string | null>;
  assert.deepEqual({ ...outbox }, {
    status: "pending",
    leased_by: null,
    lease_expires_at: null,
    last_error_json: null,
    applied_at: null,
  });
  inspector.close();
});

test("requires transaction scope locks, preserves rollback, and protects the persisted head tuple", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const scope = { organizationId, marketplace: "US" as const, asin: ASIN };

  await expectRepositoryError(repository.manualAlexaVoc.peekNextRevision(scope), "conflict");
  await expectRepositoryError(
    repository.transaction(() =>
      repository.manualAlexaVoc.put(
        putInput({
          organizationId,
          createdBy: actor,
          expectedRevision: "1",
          contentHash: hash("a"),
        }),
      ),
    ),
    "conflict",
  );
  assert.equal(await repository.manualAlexaVoc.getCurrent(scope), null);
  await repository.transaction(async () => {
    await expectRepositoryError(repository.manualAlexaVoc.peekNextRevision(scope), "conflict");
    await repository.manualAlexaVoc.lockScopes({
      organizationId,
      marketplace: "US",
      asins: [ASIN],
    });
    assert.equal(await repository.manualAlexaVoc.peekNextRevision(scope), "1");
  });

  await assert.rejects(
    repository.transaction(async () => {
      await repository.manualAlexaVoc.lockScopes({
        organizationId,
        marketplace: "US",
        asins: [ASIN],
      });
      await repository.manualAlexaVoc.put(
        putInput({
          organizationId,
          createdBy: actor,
          expectedRevision: "1",
          contentHash: hash("a"),
        }),
      );
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal(await repository.manualAlexaVoc.getCurrent(scope), null);

  await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  await expectRepositoryError(
    write(repository, {
      organizationId,
      createdBy: actor,
      contentHash: hash("b"),
      expectedRevision: "9",
    }),
    "conflict",
  );
  assert.equal((await repository.manualAlexaVoc.getCurrent(scope))?.revision, "1");

  const inspector = new DatabaseSync(temporary.path);
  inspector.exec("PRAGMA foreign_keys = ON");
  assert.throws(() =>
    inspector
      .prepare(
        `UPDATE manual_alexa_voc_heads
            SET latest_content_hash = ?
          WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
      )
      .run(hash("f"), organizationId, ASIN),
  );
  inspector.close();
});

test("retries one injected first-write revision primary-key conflict", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const injector = new DatabaseSync(temporary.path);
  injector.exec(`
    CREATE TABLE manual_alexa_voc_first_write_retry_fixture (
      armed INTEGER NOT NULL CHECK (armed IN (0, 1))
    ) STRICT;
    INSERT INTO manual_alexa_voc_first_write_retry_fixture (armed) VALUES (1);
    CREATE TRIGGER manual_alexa_voc_first_write_retry_fixture_trigger
    BEFORE INSERT ON manual_alexa_voc_revisions
    WHEN (SELECT armed FROM manual_alexa_voc_first_write_retry_fixture) = 1
    BEGIN
      UPDATE manual_alexa_voc_first_write_retry_fixture SET armed = 0;
      SELECT RAISE(FAIL,
        'UNIQUE constraint failed: manual_alexa_voc_revisions.organization_id, manual_alexa_voc_revisions.marketplace, manual_alexa_voc_revisions.asin, manual_alexa_voc_revisions.revision');
    END;
  `);
  injector.close();

  const result = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  assert.deepEqual([result.record.revision, result.idempotent], ["1", false]);
  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT armed FROM manual_alexa_voc_first_write_retry_fixture").get() as { armed: number }).armed,
    0,
  );
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM manual_alexa_voc_revisions").get() as { count: number }).count,
    1,
  );
  inspector.close();
});

test("serializes concurrent writers across SQLite repository connections", async (t) => {
  const temporary = temporaryDatabase();
  const firstRepository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  const secondRepository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    secondRepository.close();
    firstRepository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(firstRepository, organizationId);

  const results = await Promise.all([
    write(firstRepository, {
      organizationId,
      createdBy: actor,
      contentHash: hash("a"),
      marker: "concurrent-a",
      rawSeed: 1,
    }),
    write(secondRepository, {
      organizationId,
      createdBy: actor,
      contentHash: hash("b"),
      marker: "concurrent-b",
      rawSeed: 2,
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.record.revision).sort(),
    ["1", "2"],
  );
  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  const counts = inspector
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM manual_alexa_voc_revisions) AS revisions,
         (SELECT COUNT(*) FROM manual_alexa_voc_heads) AS heads,
         (SELECT COUNT(*) FROM manual_alexa_voc_publication_outbox) AS outbox`,
    )
    .get() as Record<string, number>;
  assert.deepEqual({ ...counts }, { revisions: 2, heads: 1, outbox: 2 });
  inspector.close();
});

test("round-trips SQLite INTEGER revisions above Number.MAX_SAFE_INTEGER as decimal strings", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const revision = "9007199254740993";
  const inspector = new DatabaseSync(temporary.path);
  inspector.exec("PRAGMA foreign_keys = ON");
  inspector
    .prepare(
      `INSERT INTO manual_alexa_voc_revisions (
         organization_id, marketplace, asin, revision, content_hash, captured_at,
         normalized_record, normalized_schema_version, parser_version,
         raw_report_sha256, raw_report_alg_version, raw_report_key_id,
         raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
         raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
         created_by, created_at
       ) VALUES (?, 'US', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, 1, ?, ?)` ,
    )
    .run(
      organizationId,
      OTHER_ASIN,
      BigInt(revision),
      hash("a"),
      CREATED_AT,
      JSON.stringify(normalizedRecord(OTHER_ASIN, "large-revision")),
      NORMALIZED_SCHEMA_VERSION,
      PARSER_VERSION,
      hash("b"),
      actor,
      CREATED_AT,
    );
  inspector
    .prepare(
      `INSERT INTO manual_alexa_voc_heads (
         organization_id, marketplace, asin, latest_revision,
         latest_content_hash, latest_captured_at, generation, updated_at
       ) VALUES (?, 'US', ?, ?, ?, ?, 1, ?)` ,
    )
    .run(
      organizationId,
      OTHER_ASIN,
      BigInt(revision),
      hash("a"),
      CREATED_AT,
      CREATED_AT,
    );
  inspector.close();

  const current = await repository.manualAlexaVoc.getCurrent({
    organizationId,
    marketplace: "US",
    asin: OTHER_ASIN,
  });
  assert.equal(current?.revision, revision);
  assert.equal(typeof current?.revision, "string");
  await repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId,
      marketplace: "US",
      asins: [OTHER_ASIN],
    });
    assert.equal(
      await repository.manualAlexaVoc.peekNextRevision({
        organizationId,
        marketplace: "US",
        asin: OTHER_ASIN,
      }),
      "9007199254740994",
    );
  });
});

test("distinguishes missing records from deserialize, schema, and connection failures", async () => {
  const missingTemporary = temporaryDatabase();
  const missingRepository = openSqliteAgentRepository({
    path: missingTemporary.path,
    busyTimeoutMs: 5_000,
  });
  const organizationId = randomUUID();
  const actor = await seedUser(missingRepository, organizationId);
  assert.equal(
    await missingRepository.manualAlexaVoc.getCurrent({
      organizationId,
      marketplace: "US",
      asin: ASIN,
    }),
    null,
  );
  await write(missingRepository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const corruptor = new DatabaseSync(missingTemporary.path);
  corruptor
    .prepare(
      `UPDATE manual_alexa_voc_revisions
          SET normalized_record = '{}'
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .run(organizationId, ASIN);
  corruptor.close();
  await expectRepositoryError(
    missingRepository.manualAlexaVoc.getCurrent({
      organizationId,
      marketplace: "US",
      asin: ASIN,
    }),
    "deserialize",
  );
  missingRepository.close();
  rmSync(missingTemporary.directory, { recursive: true, force: true });

  const schemaTemporary = temporaryDatabase();
  const schemaRepository = openSqliteAgentRepository({
    path: schemaTemporary.path,
    busyTimeoutMs: 5_000,
  });
  const schemaInspector = new DatabaseSync(schemaTemporary.path);
  schemaInspector.exec("PRAGMA foreign_keys = OFF");
  schemaInspector.exec("DROP TABLE manual_alexa_voc_heads");
  schemaInspector.exec("DROP TABLE manual_alexa_voc_revisions");
  schemaInspector.close();
  await expectRepositoryError(
    schemaRepository.manualAlexaVoc.listCurrent({
      organizationId: randomUUID(),
      marketplace: "US",
      asins: [ASIN],
    }),
    "schema",
  );
  schemaRepository.close();
  rmSync(schemaTemporary.directory, { recursive: true, force: true });

  const connectionTemporary = temporaryDatabase();
  const connectionRepository = openSqliteAgentRepository({
    path: connectionTemporary.path,
    busyTimeoutMs: 5_000,
  });
  connectionRepository.close();
  await expectRepositoryError(
    connectionRepository.manualAlexaVoc.listCurrent({
      organizationId: randomUUID(),
      marketplace: "US",
      asins: [ASIN],
    }),
    "connection",
  );
  rmSync(connectionTemporary.directory, { recursive: true, force: true });
});

test("claims and completes run creation idempotently inside the caller transaction", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const projectId = randomUUID();
  const runId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Run creation fixture",
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
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: "US",
        capturedAt: CREATED_AT,
        records: [normalizedRecord()],
      },
    ],
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
  const claimInput = {
    organizationId,
    idempotencyKey: "run-key",
    fingerprint: hash("f"),
  };

  await repository.transaction(async () => {
    assert.deepEqual(
      await repository.manualAlexaVoc.claimRunCreation(claimInput),
      { kind: "winner" },
    );
    await repository.manualAlexaVoc.completeRunCreation({
      ...claimInput,
      runId,
      snapshotId,
      completedAt: CREATED_AT,
    });
  });
  await repository.transaction(async () => {
    assert.deepEqual(
      await repository.manualAlexaVoc.claimRunCreation(claimInput),
      { kind: "replay", runId, snapshotId },
    );
    assert.deepEqual(
      await repository.manualAlexaVoc.claimRunCreation({
        ...claimInput,
        fingerprint: hash("e"),
      }),
      { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" },
    );
  });
});
