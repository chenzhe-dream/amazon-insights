import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ManualAlexaVocProjectionStore,
  type ManualAlexaVocProjectionManifest,
} from "../../server/data/manual-alexa-voc-projection-store";
import type {
  ManualAlexaVocRevision,
  PutManualAlexaVocInput,
} from "../../server/db/manual-alexa-voc-repository";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import {
  loadManualAlexaVocFeatureFlags,
  loadManualAlexaVocPublicationConfig,
} from "../../server/config";
import type { ManualAlexaVocEncryptedRaw } from "../../server/security/manual-alexa-voc-cipher";
import {
  ManualAlexaVocPublicationService,
  type ManualAlexaVocTelemetry,
} from "../../server/services/manual-alexa-voc-publication-service";

const ASIN = "B0AAAA0001";
const SECOND_ASIN = "B0BBBB0002";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PROJECTION_PATH_KEY = "publication-path-key-32-bytes!!!";
const CREATED_AT = "2026-08-31T08:00:00.000Z";

function temporaryRoot(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function normalizedRecord(asin = ASIN, marker = "one") {
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

function revision(input: Readonly<{
  organizationId: string;
  asin?: string;
  revision?: string;
  contentHash?: string;
  capturedAt?: string;
  marker?: string;
}>): ManualAlexaVocRevision {
  const asin = input.asin ?? ASIN;
  return Object.freeze({
    organizationId: input.organizationId,
    marketplace: "US" as const,
    asin,
    revision: input.revision ?? "1",
    contentHash: input.contentHash ?? HASH_A,
    capturedAt: input.capturedAt ?? "2026-08-31T08:00:00.123Z",
    normalizedRecord: normalizedRecord(asin, input.marker),
    normalizedSchemaVersion: "alexa-voc-record/v2" as const,
    parserVersion: "deterministic-alexa-parser/v3" as const,
  });
}

function encryptedRaw(seed: number): ManualAlexaVocEncryptedRaw {
  return Object.freeze({
    algVersion: "AES-256-GCM/v1",
    keyId: `fixture-key-${seed}`,
    wrappedDek: Uint8Array.from({ length: 60 }, (_, index) => (seed + index) % 256),
    nonce: Uint8Array.from({ length: 12 }, (_, index) => (seed * 3 + index) % 256),
    ciphertext: Uint8Array.from([seed, seed + 1, seed + 2, seed + 3]),
    tag: Uint8Array.from({ length: 16 }, (_, index) => (seed * 7 + index) % 256),
    aadSha256: "d".repeat(64),
    plaintextBytes: 4,
    plaintextSha256: "e".repeat(64),
  });
}

function putInput(input: Readonly<{
  organizationId: string;
  createdBy: string;
  expectedRevision: string;
  contentHash: string;
  marker: string;
  rawSeed: number;
}>): PutManualAlexaVocInput {
  return Object.freeze({
    organizationId: input.organizationId,
    marketplace: "US" as const,
    asin: ASIN,
    createdBy: input.createdBy,
    expectedRevision: input.expectedRevision,
    normalizedRecord: normalizedRecord(ASIN, input.marker),
    normalizedSchemaVersion: "alexa-voc-record/v2" as const,
    parserVersion: "deterministic-alexa-parser/v3" as const,
    contentHash: input.contentHash,
    raw: encryptedRaw(input.rawSeed),
  });
}

async function seedUser(
  repository: SqliteAgentRepository,
  organizationId: string,
) {
  const id = randomUUID();
  await repository.createUser({
    id,
    organizationId,
    email: `${id}@example.com`,
    displayName: "Publication fixture",
    role: "admin",
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return id;
}

async function write(
  repository: SqliteAgentRepository,
  input: Omit<Parameters<typeof putInput>[0], "expectedRevision">,
) {
  return repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId: input.organizationId,
      marketplace: "US",
      asins: [ASIN],
    });
    const expectedRevision = await repository.manualAlexaVoc.peekNextRevision({
      organizationId: input.organizationId,
      marketplace: "US",
      asin: ASIN,
    });
    return repository.manualAlexaVoc.put(putInput({ ...input, expectedRevision }));
  });
}

function projectionDirectory(root: string, organizationId: string) {
  const ownerPartition = createHmac("sha256", PROJECTION_PATH_KEY)
    .update(organizationId)
    .digest("base64url");
  return join(root, ownerPartition, "US");
}

function readManifest(root: string, organizationId: string) {
  return JSON.parse(readFileSync(
    join(projectionDirectory(root, organizationId), "manifest.json"),
    "utf8",
  )) as ManualAlexaVocProjectionManifest;
}

function generationFiles(root: string, organizationId: string) {
  return readdirSync(projectionDirectory(root, organizationId))
    .filter(name => /^generation-[1-9]\d*\.json$/.test(name))
    .sort();
}

function inspectOutbox(databasePath: string) {
  const inspector = new DatabaseSync(databasePath);
  try {
    return inspector.prepare(
      `SELECT status, available_at, lease_generation, attempt_count,
              last_error_json, applied_at
         FROM manual_alexa_voc_publication_outbox
        WHERE asin = ?
        ORDER BY generation DESC
        LIMIT 1`,
    ).get(ASIN) as Record<string, unknown>;
  } finally {
    inspector.close();
  }
}

test("projection store publishes immutable tenant-scoped epochs outside the client build tree", async (t) => {
  const root = temporaryRoot("manual-voc-projection-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const store = new ManualAlexaVocProjectionStore({
    root,
    projectionPathKey: PROJECTION_PATH_KEY,
  });

  const first = await store.publish(revision({ organizationId: organizationA }));
  assert.deepEqual(first, { artifactGeneration: "1", changed: true });
  const duplicate = await store.publish(revision({ organizationId: organizationA }));
  assert.deepEqual(duplicate, { artifactGeneration: "1", changed: false });
  const second = await store.publish(revision({
    organizationId: organizationA,
    revision: "2",
    contentHash: HASH_B,
    capturedAt: "2026-08-31T08:01:00.456Z",
    marker: "two",
  }));
  assert.deepEqual(second, { artifactGeneration: "2", changed: true });
  const stale = await store.publish(revision({ organizationId: organizationA }));
  assert.deepEqual(stale, { artifactGeneration: "2", changed: false });
  await store.publish(revision({
    organizationId: organizationB,
    asin: SECOND_ASIN,
  }));

  assert.deepEqual(generationFiles(root, organizationA), [
    "generation-1.json",
    "generation-2.json",
  ]);
  assert.deepEqual(generationFiles(root, organizationB), ["generation-1.json"]);
  assert.notEqual(
    projectionDirectory(root, organizationA),
    projectionDirectory(root, organizationB),
  );
  const manifest = readManifest(root, organizationA);
  assert.equal(manifest.ownerOrganizationId, organizationA);
  assert.equal(manifest.artifactGeneration, "2");
  assert.equal(manifest.records[ASIN]?.revision, "2");
  assert.equal(manifest.records[ASIN]?.capturedAt, "2026-08-31T08:01:00.456Z");
  const artifact = JSON.parse(readFileSync(
    join(projectionDirectory(root, organizationA), "generation-2.json"),
    "utf8",
  ));
  assert.deepEqual(artifact.invalidation.scope, {
    organizationId: organizationA,
    marketplace: "US",
  });
  assert.equal(artifact.invalidation.epoch, "2");
  assert.equal(artifact.invalidation.revisions[ASIN], "2");
  assert.equal(artifact.records[ASIN].capturedAt, "2026-08-31T08:01:00.456Z");
  assert.equal(JSON.stringify(artifact).includes("fixture-key"), false);
  assert.equal(JSON.stringify(artifact).includes("raw_report"), false);

  assert.throws(
    () => new ManualAlexaVocProjectionStore({
      root: join(process.cwd(), "app", "manual-voc-projections"),
      projectionPathKey: PROJECTION_PATH_KEY,
    }),
    /outside the application build tree/,
  );
});

test("outbox crash replay applies once without duplicating projection side effects", async (t) => {
  const directory = temporaryRoot("manual-voc-publication-");
  const databasePath = join(directory, "agent.sqlite");
  const projectionRoot = temporaryRoot("manual-voc-projection-");
  const repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(projectionRoot, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actorId = await seedUser(repository, organizationId);
  const committed = await write(repository, {
    organizationId,
    createdBy: actorId,
    contentHash: HASH_A,
    marker: "crash-replay",
    rawSeed: 1,
  });
  assert.equal(committed.publication.status, "pending");
  const store = new ManualAlexaVocProjectionStore({
    root: projectionRoot,
    projectionPathKey: PROJECTION_PATH_KEY,
  });
  const base = Date.now() + 60_000;
  const firstLease = await repository.manualAlexaVoc.leasePublication({
    ownerId: "crashed-worker",
    leasedAt: new Date(base).toISOString(),
    leaseDurationMs: 1_000,
  });
  assert.ok(firstLease);
  const head = await repository.manualAlexaVoc.getCurrent({
    organizationId,
    marketplace: "US",
    asin: ASIN,
  });
  assert.ok(head);
  await store.publish(head);
  assert.equal(inspectOutbox(databasePath).status, "leased");

  const now = base + 2_000;
  const telemetryEntries: Array<Readonly<{
    kind: "increment" | "observe";
    name: string;
    labels: Readonly<Record<string, string>>;
  }>> = [];
  const telemetry: ManualAlexaVocTelemetry = {
    increment(name, labels = {}) {
      telemetryEntries.push({ kind: "increment", name, labels });
    },
    observe(name, _value, labels = {}) {
      telemetryEntries.push({ kind: "observe", name, labels });
    },
  };
  const service = new ManualAlexaVocPublicationService({
    repository: repository.manualAlexaVoc,
    projectionStore: store,
    ownerId: "replacement-worker",
    leaseDurationMs: 60_000,
    retryInitialDelayMs: 100,
    retryMaxDelayMs: 1_000,
    retryMaxAttempts: 3,
    clock: () => new Date(now),
    telemetry,
  });
  assert.equal(await service.reconcileOnce(), 1);
  const replay = await service.dispatchOnce();
  assert.equal(replay.status, "applied");
  assert.equal(inspectOutbox(databasePath).status, "applied");
  assert.deepEqual(generationFiles(projectionRoot, organizationId), [
    "generation-1.json",
  ]);
  assert.equal((await service.dispatchOnce()).status, "idle");
  assert.equal(readManifest(projectionRoot, organizationId).records[ASIN]?.capturedAt, committed.record.capturedAt);
  for (const entry of telemetryEntries) {
    assert.equal(Object.keys(entry.labels).every(key => ["result", "source", "status"].includes(key)), true);
    assert.equal(JSON.stringify(entry).includes(organizationId), false);
    assert.equal(JSON.stringify(entry).includes(projectionRoot), false);
  }
});

test("publication retries with bounded backoff, dead-letters, and resumes after same-content repair", async (t) => {
  const directory = temporaryRoot("manual-voc-publication-retry-");
  const databasePath = join(directory, "agent.sqlite");
  const projectionRoot = temporaryRoot("manual-voc-projection-retry-");
  const repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(projectionRoot, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const actorId = await seedUser(repository, organizationId);
  const committed = await write(repository, {
    organizationId,
    createdBy: actorId,
    contentHash: HASH_A,
    marker: "retry",
    rawSeed: 2,
  });
  let now = Date.now() + 60_000;
  const failingStore = {
    async publish() {
      throw new Error("TENANT_REPORT_SENTINEL must not be persisted");
    },
  };
  const failingService = new ManualAlexaVocPublicationService({
    repository: repository.manualAlexaVoc,
    projectionStore: failingStore,
    ownerId: "failing-worker",
    leaseDurationMs: 60_000,
    retryInitialDelayMs: 100,
    retryMaxDelayMs: 150,
    retryMaxAttempts: 2,
    clock: () => new Date(now),
  });

  const first = await failingService.dispatchOnce();
  assert.equal(first.status, "failed");
  let outbox = inspectOutbox(databasePath);
  assert.equal(outbox.status, "failed");
  assert.equal(outbox.available_at, new Date(now + 100).toISOString());
  assert.equal(String(outbox.last_error_json).includes("TENANT_REPORT_SENTINEL"), false);
  assert.equal((await repository.manualAlexaVoc.getCurrent({
    organizationId,
    marketplace: "US",
    asin: ASIN,
  }))?.revision, committed.record.revision);

  now += 100;
  const second = await failingService.dispatchOnce();
  assert.equal(second.status, "dead-letter");
  outbox = inspectOutbox(databasePath);
  assert.equal(outbox.status, "failed");
  assert.equal(outbox.available_at, "9999-12-31T23:59:59.999Z");
  assert.match(String(outbox.last_error_json), /MANUAL_VOC_PUBLICATION_DEAD_LETTER/);
  assert.equal(String(outbox.last_error_json).includes("TENANT_REPORT_SENTINEL"), false);

  const repaired = await repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId,
      marketplace: "US",
      asins: [ASIN],
    });
    return repository.manualAlexaVoc.put(putInput({
      organizationId,
      createdBy: actorId,
      expectedRevision: "2",
      contentHash: HASH_A,
      marker: "retry",
      rawSeed: 2,
    }));
  });
  assert.equal(repaired.idempotent, true);
  assert.equal(repaired.publication.status, "pending");
  const healthyService = new ManualAlexaVocPublicationService({
    repository: repository.manualAlexaVoc,
    projectionStore: new ManualAlexaVocProjectionStore({
      root: projectionRoot,
      projectionPathKey: PROJECTION_PATH_KEY,
    }),
    ownerId: "healthy-worker",
    leaseDurationMs: 60_000,
    retryInitialDelayMs: 100,
    retryMaxDelayMs: 150,
    retryMaxAttempts: 2,
    clock: () => new Date(now),
  });
  assert.equal((await healthyService.dispatchOnce()).status, "applied");
  assert.equal(inspectOutbox(databasePath).status, "applied");
});

test("manual VOC publication and dependent feature flags default off and validate explicit config", () => {
  assert.deepEqual(loadManualAlexaVocFeatureFlags({}), {
    writeEnabled: false,
    dynamicReadEnabled: false,
    legacyFallbackEnabled: false,
    publicationEnabled: false,
    uiEnabled: false,
  });
  assert.equal(loadManualAlexaVocPublicationConfig({}), null);
  assert.throws(
    () => loadManualAlexaVocFeatureFlags({
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED: "true",
    }),
    /Manual Alexa VOC feature flag configuration is invalid/,
  );
  assert.throws(
    () => loadManualAlexaVocPublicationConfig({
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED: "1",
    }),
    /Manual Alexa VOC publication configuration is invalid/,
  );
  const root = temporaryRoot("manual-voc-config-");
  try {
    assert.deepEqual(loadManualAlexaVocPublicationConfig({
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED: "1",
      AGENT_MANUAL_ALEXA_VOC_PROJECTION_ROOT: root,
      AGENT_MANUAL_ALEXA_VOC_PROJECTION_PATH_KEY: PROJECTION_PATH_KEY,
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_OWNER_ID: "publication-worker-a",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_LEASE_MS: "60000",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_POLL_MS: "250",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_RECONCILE_MS: "1000",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_BACKOFF_INITIAL_MS: "100",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_BACKOFF_MAX_MS: "1000",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_MAX_ATTEMPTS: "5",
    }), {
      enabled: true,
      projectionRoot: root,
      projectionPathKey: PROJECTION_PATH_KEY,
      ownerId: "publication-worker-a",
      leaseDurationMs: 60_000,
      pollIntervalMs: 250,
      reconcileIntervalMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 1_000,
      retryMaxAttempts: 5,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DE and US projections for the same ASIN retain separate manifests", async t => {
  const root=temporaryRoot("manual-voc-markets-");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new ManualAlexaVocProjectionStore({root,projectionPathKey:PROJECTION_PATH_KEY});
  const us=revision({organizationId:randomUUID(),marker:"US-only"});
  const de={...revision({organizationId:us.organizationId,marker:"DE-only"}),marketplace:"DE" as const};
  await store.publish(us); await store.publish(de);
  const owner=createHmac("sha256",PROJECTION_PATH_KEY).update(us.organizationId).digest("base64url");
  for (const marketplace of ["US","DE"]) {
    const artifact=JSON.parse(readFileSync(join(root,owner,marketplace,"generation-1.json"),"utf8"));
    assert.equal(artifact.marketplace,marketplace);
    assert.match(JSON.stringify(artifact.records),new RegExp(`${marketplace}-only`));
    assert.doesNotMatch(JSON.stringify(artifact.records),new RegExp(`${marketplace==="US"?"DE":"US"}-only`));
  }
});
