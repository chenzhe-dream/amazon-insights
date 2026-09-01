import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocOutboxLease,
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
import {
  LegacyManualAlexaVocSource,
  type LegacyManualVocOwnerManifest,
} from "../../server/data/legacy-manual-alexa-voc-source";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";

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

function addMilliseconds(timestamp: string, milliseconds: number) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
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

test("normalization input is ciphertext-only, run-scoped, idempotent while active, and requeues after terminal", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actorUserId = await seedUser(repository, organizationId);
  const projectId = randomUUID();
  const runId = randomUUID();
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Alexa normalization",
    marketplace: "US",
    asins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    createdBy: actorUserId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorUserId,
    dataCutoffAt: CREATED_AT,
    idempotencyScope: `normalization:${runId}`,
    idempotencyKey: "create",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const rawText = "secret Alexa report";
  const rawReportSha256 = canonicalJsonSha256(rawText);
  const executionFingerprint = hash("f");
  const envelope = {
    algVersion: "AES-256-GCM/v1" as const,
    keyId: "normalization-test",
    wrappedDek: "AA",
    nonce: "AA",
    ciphertext: "c2VjcmV0",
    tag: "AA",
    aadSha256: hash("a"),
    plaintextBytes: Buffer.byteLength(rawText, "utf8"),
    plaintextSha256: rawReportSha256,
  };
  const queue = (queuedAt: string) => repository.transaction(() =>
    repository.manualAlexaVoc.queueNormalizationInput({
      actorUserId,
      actorOrganizationId: organizationId,
      projectId,
      runId,
      marketplace: "US",
      asin: ASIN,
      snapshotId: randomUUID(),
      stageId: randomUUID(),
      jobId: randomUUID(),
      rawReportSha256,
      plaintextBytes: envelope.plaintextBytes,
      executionFingerprint,
      envelope,
      queuedAt,
    }));

  const first = await queue(CREATED_AT);
  const replay = await queue(addMilliseconds(CREATED_AT, 1));
  assert.equal(first.snapshotCreated, true);
  assert.equal(replay.snapshotCreated, false);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(replay.jobId, first.jobId);
  assert.equal(replay.jobCreated, false);
  assert.equal(JSON.stringify(first.snapshot).includes(rawText), false);
  assert.equal((await repository.listDataSnapshotsByRun({ actorOrganizationId: organizationId, runId })).length, 0);

  const leased = await repository.claimNextJob({
    ownerId: "normalizer",
    stage: "alexa-voc-normalization",
    claimedAt: addMilliseconds(CREATED_AT, 2),
    leaseDurationMs: 30_000,
  });
  assert.equal(leased?.id, first.jobId);
  await repository.completeJob({
    jobId: first.jobId,
    ownerId: "normalizer",
    leaseGeneration: leased!.leaseGeneration,
    completedAt: addMilliseconds(CREATED_AT, 3),
  });
  const requeued = await queue(addMilliseconds(CREATED_AT, 4));
  assert.equal(requeued.snapshot.id, first.snapshot.id);
  assert.equal(requeued.jobCreated, true);
  assert.notEqual(requeued.jobId, first.jobId);
  assert.deepEqual((await repository.listRunStages(runId)).map(stage => stage.stage), ["alexa-voc-normalization"]);
});

test("real SQLite reader is DB-first, persists exact provenance, isolates organizations, and owner-gates misses", async (t) => {
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
  const dynamic = await write(repository, {
    organizationId: organizationA,
    createdBy: actorA,
    contentHash: hash("a"),
    marker: "sqlite-reader-dynamic",
  });
  const legacyRecord = normalizedRecord(OTHER_ASIN, "sqlite-reader-legacy");
  const legacyRecords = {
    [OTHER_ASIN]: {
      revision: "4",
      contentHash: canonicalJsonSha256(legacyRecord),
      capturedAt: "2026-08-30T04:05:06.789Z",
      generation: "1",
    },
  };
  const ownerManifest = {
    schemaVersion: "manual-voc-owner-manifest/v1",
    ownerOrganizationId: organizationA,
    marketplace: "US",
    artifactGeneration: "1",
    sourceHeadsHash: canonicalJsonSha256(legacyRecords),
    generatedAt: "2026-08-31T00:00:00.000Z",
    bindingAuditId: "70000000-0000-4000-8000-000000000077",
    bindingActorUserId: actorA,
    records: legacyRecords,
  } satisfies LegacyManualVocOwnerManifest;
  let legacyDataLoads = 0;
  const legacySource = new LegacyManualAlexaVocSource({
    loadManifest: async () => ownerManifest,
    loadLegacyData: async () => {
      legacyDataLoads += 1;
      return {
        artifactGeneration: "1",
        capturedAt: "2026-08-30T04:05:06.789Z",
        marketplace: "US",
        data: { [OTHER_ASIN]: legacyRecord },
      };
    },
  });
  const reader = new RepositoryVocSourceReader({
    manualVoc: repository.manualAlexaVoc,
    legacySource,
    reviewSources: {
      sorftime: { meta: { marketplace: "US" }, data: {} },
      sellerSprite: { meta: { marketplace: "US" }, data: {} },
    },
  });
  const previousDefault = process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
  process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID = organizationA;
  t.after(() => {
    if (previousDefault === undefined) delete process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
    else process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID = previousDefault;
  });
  const cutoff = addMilliseconds(dynamic.record.capturedAt, 1);
  const asins = [ASIN, OTHER_ASIN, THIRD_ASIN];

  const selected = await reader.read({
    organizationId: organizationA,
    marketplace: "US",
    asins,
    dataCutoffAt: cutoff,
  });
  assert.ok(selected.candidate);
  assert.equal(legacyDataLoads, 1);
  assert.deepEqual(Reflect.get(selected.candidate.sources[0]!, "recordProvenance"), [
    {
      asin: ASIN,
      revision: dynamic.record.revision,
      contentHash: dynamic.record.contentHash,
      source: "repository",
      generation: null,
      capturedAt: dynamic.record.capturedAt,
      normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
    },
    {
      asin: OTHER_ASIN,
      revision: "4",
      contentHash: legacyRecords[OTHER_ASIN].contentHash,
      source: "legacy-static-stale",
      generation: "1",
      capturedAt: legacyRecords[OTHER_ASIN].capturedAt,
      normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
    },
  ]);

  const projectId = randomUUID();
  const runId = randomUUID();
  await repository.createProject({
    id: projectId,
    organizationId: organizationA,
    name: "Reader integration",
    marketplace: "US",
    asins,
    createdBy: actorA,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorA,
    dataCutoffAt: cutoff,
    idempotencyScope: `reader:${runId}`,
    idempotencyKey: "create",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const persisted = await repository.createDataSnapshotForRun({
    actorId: actorA,
    actorOrganizationId: organizationA,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: asins,
    expectedRunCutoffAt: cutoff,
    candidateId: randomUUID(),
    createdAt: CREATED_AT,
    candidate: selected.candidate,
  });
  assert.deepEqual(
    Reflect.get(persisted.snapshot.sources[0]!, "recordProvenance"),
    Reflect.get(selected.candidate.sources[0]!, "recordProvenance"),
  );
  const facts = preprocessVocSnapshot(persisted.snapshot);
  assert.deepEqual(
    facts.availability.slice(0, 1).map(source => ({
      sourceId: source.sourceId,
      status: source.status,
      reference: source.reference,
      recordCount: source.recordCount,
    })),
    [{
      sourceId: "alexa-voc",
      status: "partial",
      reference: VOC_SOURCE_REFERENCES.manualAlexaVocRepository,
      recordCount: 2,
    }],
  );
  const persistedProvenance = persisted.snapshot.sources[0]!.recordProvenance;
  assert.ok(persistedProvenance);
  const expectedCaptureByAsin = new Map(
    persistedProvenance.map(provenance => [
      provenance.asin,
      provenance.capturedAt,
    ]),
  );
  assert.equal(
    facts.evidenceIndex
      .filter(evidence => evidence.sourceId === "alexa-voc")
      .every(evidence =>
        evidence.capturedAt === expectedCaptureByAsin.get(evidence.asin),
      ),
    true,
  );

  const crossOrganization = await reader.read({
    organizationId: organizationB,
    marketplace: "US",
    asins,
    dataCutoffAt: cutoff,
  });
  assert.equal(crossOrganization.candidate, null);
  assert.equal(legacyDataLoads, 1);
});

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

test("re-reads once in a new transaction after a real first-write revision primary-key conflict", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const injector = new DatabaseSync(temporary.path);
  injector.exec("PRAGMA foreign_keys = ON");
  injector
    .prepare(
      `INSERT INTO manual_alexa_voc_revisions (
         organization_id, marketplace, asin, revision, content_hash, captured_at,
         normalized_record, normalized_schema_version, parser_version,
         raw_report_sha256, raw_report_alg_version, raw_report_key_id,
         raw_report_wrapped_dek, raw_report_nonce, raw_report_ciphertext,
         raw_report_tag, raw_report_aad_sha256, raw_report_plaintext_bytes,
         created_by, created_at
       ) VALUES (?, 'US', ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, 1, ?, ?)`,
    )
    .run(
      organizationId,
      ASIN,
      hash("a"),
      CREATED_AT,
      JSON.stringify(normalizedRecord(ASIN, "orphaned-real-row")),
      NORMALIZED_SCHEMA_VERSION,
      PARSER_VERSION,
      hash("b"),
      actor,
      CREATED_AT,
    );
  injector.close();

  let transactionAttempts = 0;
  await expectRepositoryError(
    repository.transaction(async () => {
      transactionAttempts += 1;
      await repository.manualAlexaVoc.lockScopes({
        organizationId,
        marketplace: "US",
        asins: [ASIN],
      });
      const expectedRevision = await repository.manualAlexaVoc.peekNextRevision({
        organizationId,
        marketplace: "US",
        asin: ASIN,
      });
      return repository.manualAlexaVoc.put(
        putInput({
          organizationId,
          createdBy: actor,
          expectedRevision,
          contentHash: hash("c"),
        }),
      );
    }),
    "conflict",
  );
  assert.equal(transactionAttempts, 2);

  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM manual_alexa_voc_revisions").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM manual_alexa_voc_heads").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM manual_alexa_voc_publication_outbox").get() as { count: number }).count,
    0,
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

test("deduplicates concurrent same-hash writers across SQLite repository connections", async (t) => {
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
      marker: "same-content",
      rawSeed: 1,
    }),
    write(secondRepository, {
      organizationId,
      createdBy: actor,
      contentHash: hash("a"),
      marker: "same-content",
      rawSeed: 1,
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.idempotent).sort(),
    [false, true],
  );
  assert.deepEqual(
    results.map((result) => result.record.revision),
    ["1", "1"],
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
  assert.deepEqual({ ...counts }, { revisions: 1, heads: 1, outbox: 1 });
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

test("normalizes offset cutoffs to UTC before SQLite TEXT comparison", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
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
       ) VALUES (?, 'US', ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, 1, ?, ?)`,
    )
    .run(
      organizationId,
      ASIN,
      hash("a"),
      "2026-08-31T00:00:00.000Z",
      JSON.stringify(normalizedRecord(ASIN, "offset-cutoff")),
      NORMALIZED_SCHEMA_VERSION,
      PARSER_VERSION,
      hash("b"),
      actor,
      "2026-08-31T00:00:00.000Z",
    );
  inspector.close();

  const included = await repository.manualAlexaVoc.listAtCutoff({
    organizationId,
    marketplace: "US",
    asins: [ASIN],
    dataCutoffAt: "2026-08-30T20:30:00-04:00",
  });
  assert.deepEqual(included.map((record) => record.revision), ["1"]);
  assert.deepEqual(
    await repository.manualAlexaVoc.listAtCutoff({
      organizationId,
      marketplace: "US",
      asins: [ASIN],
      dataCutoffAt: "2026-08-30T19:30:00-04:00",
    }),
    [],
  );
});

test("maps BEGIN, COMMIT, and ROLLBACK SQLite boundary failures to repository errors", async () => {
  const busyTemporary = temporaryDatabase();
  const busyRepository = openSqliteAgentRepository({
    path: busyTemporary.path,
    busyTimeoutMs: 10,
  });
  const locker = new DatabaseSync(busyTemporary.path);
  locker.exec("BEGIN IMMEDIATE");
  try {
    await expectRepositoryError(
      busyRepository.transaction(async () => undefined),
      "timeout",
    );
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
    busyRepository.close();
    rmSync(busyTemporary.directory, { recursive: true, force: true });
  }

  const beginTemporary = temporaryDatabase();
  const beginRepository = openSqliteAgentRepository({
    path: beginTemporary.path,
    busyTimeoutMs: 5_000,
  });
  beginRepository.close();
  await expectRepositoryError(
    beginRepository.transaction(async () => undefined),
    "connection",
  );
  rmSync(beginTemporary.directory, { recursive: true, force: true });

  const commitTemporary = temporaryDatabase();
  const commitRepository = openSqliteAgentRepository({
    path: commitTemporary.path,
    busyTimeoutMs: 5_000,
  });
  await expectRepositoryError(
    commitRepository.transaction(async () => {
      commitRepository.close();
    }),
    "connection",
  );
  rmSync(commitTemporary.directory, { recursive: true, force: true });

  const rollbackTemporary = temporaryDatabase();
  const rollbackRepository = openSqliteAgentRepository({
    path: rollbackTemporary.path,
    busyTimeoutMs: 5_000,
  });
  await expectRepositoryError(
    rollbackRepository.transaction(async () => {
      rollbackRepository.close();
      throw new Error("operation failure must not expose raw rollback errors");
    }),
    "connection",
  );
  rmSync(rollbackTemporary.directory, { recursive: true, force: true });
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

test("leases, retries, applies, and reconciles publication outbox work", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
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
    {
      organizationId: firstLease.organizationId,
      marketplace: firstLease.marketplace,
      asin: firstLease.asin,
      revision: firstLease.revision,
      contentHash: firstLease.contentHash,
      generation: firstLease.generation,
      leaseGeneration: firstLease.leaseGeneration,
      leaseOwner: firstLease.leaseOwner,
    },
    {
      organizationId,
      marketplace: "US",
      asin: ASIN,
      revision: "1",
      contentHash: hash("a"),
      generation: "1",
      leaseGeneration: "1",
      leaseOwner: "publisher-a",
    },
  );

  const failedAt = addMilliseconds(leasedAt, 1_000);
  const nextAttemptAt = addMilliseconds(failedAt, 10_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt,
    nextAttemptAt,
    errorCode: "PROJECTION_WRITE_FAILED",
  });
  assert.equal(
    await repository.manualAlexaVoc.leasePublication({
      ownerId: "publisher-b",
      leasedAt: addMilliseconds(nextAttemptAt, -1),
      leaseDurationMs: 60_000,
    }),
    null,
  );

  const retryLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: nextAttemptAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(retryLease);
  await expectRepositoryError(
    repository.manualAlexaVoc.markPublicationApplied({
      ...firstLease,
      appliedAt: addMilliseconds(nextAttemptAt, 1_000),
    }),
    "conflict",
  );
  const appliedAt = addMilliseconds(nextAttemptAt, 2_000);
  await repository.manualAlexaVoc.markPublicationApplied({
    ...retryLease,
    appliedAt,
  });

  const inspector = new DatabaseSync(temporary.path);
  const applied = inspector
    .prepare(
      `SELECT status, attempt_count, leased_by, lease_expires_at,
              last_error_json, applied_at
         FROM manual_alexa_voc_publication_outbox
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .get(organizationId, ASIN) as Record<string, string | number | null>;
  assert.deepEqual({ ...applied }, {
    status: "applied",
    attempt_count: 2,
    leased_by: null,
    lease_expires_at: null,
    last_error_json: null,
    applied_at: appliedAt,
  });
  inspector
    .prepare(
      `DELETE FROM manual_alexa_voc_publication_outbox
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .run(organizationId, ASIN);
  inspector.close();

  const reconciledAt = addMilliseconds(appliedAt, 1_000);
  assert.equal(
    await repository.manualAlexaVoc.reconcilePublication({ reconciledAt }),
    1,
  );
  const repairedLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-c",
    leasedAt: reconciledAt,
    leaseDurationMs: 60_000,
  });
  assert.equal(repairedLease?.revision, "1");
});

test("fences SQLite publication completion by lease generation, owner, and database expiry", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const leasedAt = addMilliseconds(first.record.capturedAt, 1_000);
  const firstLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-a",
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(firstLease);
  assert.equal(firstLease.leaseGeneration, "1");
  const failedAt = addMilliseconds(leasedAt, 1_000);
  const retryAt = addMilliseconds(failedAt, 1_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt,
    nextAttemptAt: retryAt,
    errorCode: "RETRY",
  });

  const sameOwnerReplacement = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-a",
    leasedAt: retryAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(sameOwnerReplacement);
  assert.equal(sameOwnerReplacement.leaseGeneration, "2");
  const abaLease = {
    ...sameOwnerReplacement,
    leaseGeneration: firstLease.leaseGeneration,
  };
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...abaLease,
    appliedAt: addMilliseconds(retryAt, 1_000),
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...abaLease,
    failedAt: addMilliseconds(retryAt, 1_000),
    nextAttemptAt: addMilliseconds(retryAt, 2_000),
    errorCode: "ABA",
  }), "conflict");

  const replacementFailedAt = addMilliseconds(retryAt, 2_000);
  const replacementRetryAt = addMilliseconds(replacementFailedAt, 1_000);
  await repository.manualAlexaVoc.markPublicationFailed({
    ...sameOwnerReplacement,
    failedAt: replacementFailedAt,
    nextAttemptAt: replacementRetryAt,
    errorCode: "REPLACE_OWNER",
  });
  const replacementOwner = await repository.manualAlexaVoc.leasePublication({
    ownerId: "publisher-b",
    leasedAt: replacementRetryAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(replacementOwner);
  assert.equal(replacementOwner.leaseGeneration, "3");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...sameOwnerReplacement,
    appliedAt: addMilliseconds(replacementRetryAt, 1_000),
  }), "conflict");
  const afterReplacementExpiry = addMilliseconds(
    replacementOwner.leaseExpiresAt,
    1,
  );
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...replacementOwner,
    appliedAt: afterReplacementExpiry,
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...replacementOwner,
    failedAt: afterReplacementExpiry,
    nextAttemptAt: afterReplacementExpiry,
    errorCode: "LATE_TERMINAL_TIMESTAMP",
  }), "conflict");

  const inspector = new DatabaseSync(temporary.path);
  const expiredAt = "2000-01-01T00:00:00.000Z";
  inspector.prepare(
    `UPDATE manual_alexa_voc_publication_outbox
        SET lease_expires_at = ?
      WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
  ).run(expiredAt, organizationId, ASIN);
  inspector.close();
  const expiredLease = { ...replacementOwner, leaseExpiresAt: expiredAt };
  const backdatedAt = "1999-12-31T23:59:59.000Z";
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...expiredLease,
    appliedAt: backdatedAt,
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...expiredLease,
    failedAt: backdatedAt,
    nextAttemptAt: backdatedAt,
    errorCode: "BACKDATED",
  }), "conflict");

  const finalInspector = new DatabaseSync(temporary.path);
  const stored = finalInspector.prepare(
    `SELECT status, CAST(lease_generation AS TEXT) AS lease_generation
       FROM manual_alexa_voc_publication_outbox
      WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
  ).get(organizationId, ASIN) as Record<string, string>;
  finalInspector.close();
  assert.deepEqual({ ...stored }, { status: "leased", lease_generation: "3" });
});

test("preserves SQLite lease generation through same-hash failed outbox repair", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
  });
  const leasedAt = addMilliseconds(first.record.capturedAt, 1_000);
  const firstLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "stable-publisher",
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(firstLease);
  assert.equal(firstLease.leaseGeneration, "1");
  await repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt: addMilliseconds(leasedAt, 1_000),
    nextAttemptAt: addMilliseconds(leasedAt, 2_000),
    errorCode: "REPAIR_ME",
  });

  const repaired = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 2,
  });
  assert.equal(repaired.idempotent, true);
  assert.equal(repaired.publication.status, "pending");
  const secondLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: firstLease.leaseOwner,
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(secondLease);
  assert.equal(secondLease.leaseGeneration, "2");
  assert.equal(secondLease.leaseOwner, firstLease.leaseOwner);
  assert.equal(secondLease.leaseExpiresAt, firstLease.leaseExpiresAt);
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationApplied({
    ...firstLease,
    appliedAt: addMilliseconds(leasedAt, 3_000),
  }), "conflict");
  await expectRepositoryError(repository.manualAlexaVoc.markPublicationFailed({
    ...firstLease,
    failedAt: addMilliseconds(leasedAt, 3_000),
    nextAttemptAt: addMilliseconds(leasedAt, 3_000),
    errorCode: "STALE_AFTER_REPAIR",
  }), "conflict");

  await repository.manualAlexaVoc.markPublicationFailed({
    ...secondLease,
    failedAt: addMilliseconds(leasedAt, 4_000),
    nextAttemptAt: addMilliseconds(leasedAt, 5_000),
    errorCode: "REPAIR_AGAIN",
  });
  await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 3,
  });
  const thirdLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: firstLease.leaseOwner,
    leasedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(thirdLease);
  assert.equal(thirdLease.leaseGeneration, "3");
  assert.equal(thirdLease.leaseExpiresAt, firstLease.leaseExpiresAt);
});

test("records canonical raw access and clears expired envelopes transactionally", async (t) => {
  const temporary = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path: temporary.path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actor = await seedUser(repository, organizationId);
  const first = await write(repository, {
    organizationId,
    createdBy: actor,
    contentHash: hash("a"),
    rawSeed: 4,
  });
  const occurredAt = addMilliseconds(first.record.capturedAt, 1_000);
  await repository.transaction(() =>
    repository.manualAlexaVoc.recordRawAccess({
      id: randomUUID(),
      organizationId,
      marketplace: "US",
      asin: ASIN,
      revision: first.record.revision,
      actorUserId: actor,
      purpose: "decrypt",
      occurredAt,
      result: "succeeded",
    }),
  );
  const before = addMilliseconds(first.record.capturedAt, 2_000);
  const clearedAt = addMilliseconds(first.record.capturedAt, 3_000);
  assert.equal(
    await repository.transaction(() =>
      repository.manualAlexaVoc.clearExpiredRaw({
        organizationId,
        before,
        clearedAt,
        actorUserId: actor,
      }),
    ),
    1,
  );
  assert.equal(
    await repository.transaction(() =>
      repository.manualAlexaVoc.clearExpiredRaw({
        organizationId,
        before,
        clearedAt: addMilliseconds(clearedAt, 1_000),
        actorUserId: actor,
      }),
    ),
    0,
  );

  const inspector = new DatabaseSync(temporary.path, { readOnly: true });
  const stored = inspector
    .prepare(
      `SELECT normalized_record, raw_report_sha256, raw_report_plaintext_bytes,
              raw_report_alg_version, raw_report_key_id,
              raw_report_wrapped_dek, raw_report_nonce,
              raw_report_ciphertext, raw_report_tag, raw_report_aad_sha256
         FROM manual_alexa_voc_revisions
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    )
    .get(organizationId, ASIN) as Record<string, string | number | Uint8Array | null>;
  assert.deepEqual(JSON.parse(String(stored.normalized_record)), first.record.normalizedRecord);
  assert.equal(stored.raw_report_sha256, hash("e"));
  assert.equal(stored.raw_report_plaintext_bytes, 4);
  for (const key of [
    "raw_report_alg_version",
    "raw_report_key_id",
    "raw_report_wrapped_dek",
    "raw_report_nonce",
    "raw_report_ciphertext",
    "raw_report_tag",
    "raw_report_aad_sha256",
  ]) {
    assert.equal(stored[key], null);
  }
  const audit = inspector
    .prepare(
      `SELECT purpose, result, created_at
         FROM manual_alexa_voc_access_audit
        WHERE organization_id = ? ORDER BY created_at`,
    )
    .all(organizationId) as Array<Record<string, string>>;
  assert.deepEqual(audit.map((event) => ({ ...event })), [
    {
      purpose: "create",
      result: "allowed",
      created_at: first.record.capturedAt,
    },
    { purpose: "decrypt", result: "allowed", created_at: occurredAt },
    { purpose: "delete-policy", result: "allowed", created_at: clearedAt },
  ]);
  assert.equal(
    (inspector.prepare("SELECT COUNT(*) AS count FROM manual_alexa_voc_heads").get() as { count: number }).count,
    1,
  );
  inspector.close();
  assert.equal(
    (await repository.manualAlexaVoc.getCurrent({
      organizationId,
      marketplace: "US",
      asin: ASIN,
    }))?.revision,
    "1",
  );
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
