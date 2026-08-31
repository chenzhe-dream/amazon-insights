import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import type { RequestPrincipal } from "../../server/auth/authorization";
import {
  loadManualAlexaVocRetentionConfig,
} from "../../server/config";
import type { PutManualAlexaVocInput } from "../../server/db/manual-alexa-voc-repository";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import {
  createManualAlexaVocCipher,
  type ManualAlexaVocCipher,
} from "../../server/security/manual-alexa-voc-cipher";
import {
  rewrapManualAlexaVocKeys,
} from "../../server/cli/rewrap-manual-alexa-voc-keys";
import {
  ManualAlexaVocRawAccessError,
  ManualAlexaVocRetentionService,
} from "../../server/services/manual-alexa-voc-retention-service";

const ASIN = "B0AAAA0001";
const SECOND_ASIN = "B0BBBB0002";
const REPORT_SENTINEL = "RAW_ALEXA_REPORT_SENTINEL: customer verbatim";
const OLD_KEY = Buffer.alloc(32, 11).toString("base64url");
const NEW_KEY = Buffer.alloc(32, 22).toString("base64url");
function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-retention-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  return {
    directory,
    path,
    repository,
  };
}

function keyring(activeKeyId: "old" | "new") {
  return JSON.stringify({
    activeKeyId,
    keys: { old: OLD_KEY, new: NEW_KEY },
  });
}

function cipher(activeKeyId: "old" | "new") {
  return createManualAlexaVocCipher({
    MANUAL_VOC_RAW_REPORT_KEYRING: keyring(activeKeyId),
  });
}

function principal(input: Readonly<{
  userId: string;
  organizationId: string;
  role: "admin" | "member";
}>): Extract<RequestPrincipal, { kind: "user" }> {
  return Object.freeze({
    kind: "user" as const,
    userId: input.userId,
    organizationId: input.organizationId,
    role: input.role,
    email: `${input.userId}@example.com`,
    sessionId: randomUUID(),
  });
}

async function seedUser(
  repository: SqliteAgentRepository,
  organizationId: string,
  role: "admin" | "member" = "admin",
) {
  const id = randomUUID();
  await repository.createUser({
    id,
    organizationId,
    email: `${id}@example.com`,
    displayName: `Retention ${role}`,
    role,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return id;
}

function normalizedRecord(asin: string, marker: string) {
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

async function writeRaw(input: Readonly<{
  repository: SqliteAgentRepository;
  encryption: ManualAlexaVocCipher;
  organizationId: string;
  actorUserId: string;
  asin: string;
  marker: string;
  report?: string;
}>) {
  return input.repository.transaction(async () => {
    await input.repository.manualAlexaVoc.lockScopes({
      organizationId: input.organizationId,
      marketplace: "US",
      asins: [input.asin],
    });
    const expectedRevision = await input.repository.manualAlexaVoc.peekNextRevision({
      organizationId: input.organizationId,
      marketplace: "US",
      asin: input.asin,
    });
    const identity = {
      organizationId: input.organizationId,
      marketplace: "US",
      asin: input.asin,
      revision: expectedRevision,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
    } as const;
    const raw = input.encryption.encrypt({
      identity,
      plaintext: input.report ?? `${REPORT_SENTINEL}:${input.marker}`,
    });
    const put: PutManualAlexaVocInput = {
      ...identity,
      createdBy: input.actorUserId,
      expectedRevision,
      normalizedRecord: normalizedRecord(input.asin, input.marker),
      contentHash: createHash("sha256")
        .update(`${input.organizationId}:${input.asin}:${input.marker}`)
        .digest("hex"),
      raw,
    };
    return input.repository.manualAlexaVoc.put(put);
  });
}

function inspectRevision(
  databasePath: string,
  organizationId: string,
  asin: string,
  revision = "1",
) {
  const inspector = new DatabaseSync(databasePath);
  try {
    return inspector.prepare(
      `SELECT CAST(revision AS TEXT) AS revision, content_hash, captured_at,
              normalized_record, raw_report_sha256, raw_report_plaintext_bytes,
              raw_report_alg_version, raw_report_key_id, raw_report_wrapped_dek,
              raw_report_nonce, raw_report_ciphertext, raw_report_tag,
              raw_report_aad_sha256
         FROM manual_alexa_voc_revisions
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?
          AND revision = ?`,
    ).get(organizationId, asin, BigInt(revision)) as Record<string, unknown>;
  } finally {
    inspector.close();
  }
}

function inspectCounts(databasePath: string, organizationId: string) {
  const inspector = new DatabaseSync(databasePath);
  try {
    const revisionCount = inspector.prepare(
      "SELECT count(*) AS count FROM manual_alexa_voc_revisions WHERE organization_id = ?",
    ).get(organizationId) as { count: number };
    const headCount = inspector.prepare(
      "SELECT count(*) AS count FROM manual_alexa_voc_heads WHERE organization_id = ?",
    ).get(organizationId) as { count: number };
    return { revisions: revisionCount.count, heads: headCount.count };
  } finally {
    inspector.close();
  }
}

function rawEnvelope(row: Record<string, unknown>) {
  return {
    algVersion: row.raw_report_alg_version,
    keyId: row.raw_report_key_id,
    wrappedDek: Buffer.from(row.raw_report_wrapped_dek as Uint8Array),
    nonce: Buffer.from(row.raw_report_nonce as Uint8Array),
    ciphertext: Buffer.from(row.raw_report_ciphertext as Uint8Array),
    tag: Buffer.from(row.raw_report_tag as Uint8Array),
    aadSha256: row.raw_report_aad_sha256,
    plaintextBytes: row.raw_report_plaintext_bytes,
    plaintextSha256: row.raw_report_sha256,
  };
}

test("retention config defaults to 365 days and rejects permissive tenant policies", () => {
  assert.equal(loadManualAlexaVocRetentionConfig({}), null);
  const organizationId = randomUUID();
  assert.deepEqual(loadManualAlexaVocRetentionConfig({
    AGENT_MANUAL_ALEXA_VOC_RETENTION_ENABLED: "1",
    MANUAL_VOC_RAW_REPORT_RETENTION_DAYS_BY_ORG: JSON.stringify({
      [organizationId]: 400,
    }),
    AGENT_MANUAL_ALEXA_VOC_RETENTION_POLL_MS: "60000",
    AGENT_MANUAL_ALEXA_VOC_RETENTION_BATCH_SIZE: "25",
  }), {
    enabled: true,
    pollIntervalMs: 60_000,
    batchSize: 25,
    policyByOrganization: { [organizationId]: 400 },
  });
  for (const configured of [
    "[]",
    JSON.stringify({ [organizationId]: 364 }),
    JSON.stringify({ [organizationId]: 365.5 }),
    JSON.stringify({ "*": 365 }),
  ]) {
    assert.throws(
      () => loadManualAlexaVocRetentionConfig({
        AGENT_MANUAL_ALEXA_VOC_RETENTION_ENABLED: "1",
        MANUAL_VOC_RAW_REPORT_RETENTION_DAYS_BY_ORG: configured,
      }),
      /Manual Alexa VOC retention configuration is invalid/,
    );
  }
});

test("retention uses an exact UTC boundary, isolates tenants, and clears envelopes idempotently", async (t) => {
  const temporary = temporaryDatabase();
  t.after(() => {
    temporary.repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const adminA = await seedUser(temporary.repository, organizationA);
  const adminB = await seedUser(temporary.repository, organizationB);
  const oldCipher = cipher("old");
  const expired = await writeRaw({
    repository: temporary.repository,
    encryption: oldCipher,
    organizationId: organizationA,
    actorUserId: adminA,
    asin: ASIN,
    marker: "expired",
  });
  while (Date.now() <= new Date(expired.record.capturedAt).getTime()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const boundary = await writeRaw({
    repository: temporary.repository,
    encryption: oldCipher,
    organizationId: organizationA,
    actorUserId: adminA,
    asin: SECOND_ASIN,
    marker: "boundary",
  });
  await writeRaw({
    repository: temporary.repository,
    encryption: oldCipher,
    organizationId: organizationB,
    actorUserId: adminB,
    asin: ASIN,
    marker: "long-policy",
  });
  const asOf = new Date(
    new Date(boundary.record.capturedAt).getTime() + 365 * 86_400_000,
  ).toISOString();
  const expiredBefore = inspectRevision(
    temporary.path,
    organizationA,
    ASIN,
    expired.record.revision,
  );

  const service = new ManualAlexaVocRetentionService({
    repository: temporary.repository,
    cipher: oldCipher,
    policyByOrganization: { [organizationB]: 400 },
    batchSize: 1,
  });
  assert.equal(await service.clearExpired({
    organizationId: organizationA,
    asOf,
    actorUserId: adminA,
  }), 1);
  assert.equal(await service.clearExpired({
    organizationId: organizationA,
    asOf,
    actorUserId: adminA,
  }), 0);
  assert.equal(await service.clearExpired({
    organizationId: organizationB,
    asOf,
    actorUserId: adminB,
  }), 0);

  const cleared = inspectRevision(
    temporary.path,
    organizationA,
    ASIN,
    expired.record.revision,
  );
  for (const column of [
    "raw_report_alg_version",
    "raw_report_key_id",
    "raw_report_wrapped_dek",
    "raw_report_nonce",
    "raw_report_ciphertext",
    "raw_report_tag",
    "raw_report_aad_sha256",
  ]) assert.equal(cleared[column], null);
  assert.equal(cleared.raw_report_sha256, expiredBefore.raw_report_sha256);
  assert.equal(cleared.content_hash, expiredBefore.content_hash);
  assert.equal(cleared.captured_at, expiredBefore.captured_at);
  assert.equal(cleared.raw_report_plaintext_bytes, Buffer.byteLength(`${REPORT_SENTINEL}:expired`));
  assert.deepEqual(JSON.parse(String(cleared.normalized_record)), expired.record.normalizedRecord);
  assert.deepEqual(inspectCounts(temporary.path, organizationA), {
    revisions: 2,
    heads: 2,
  });
  assert.notEqual(
    inspectRevision(temporary.path, organizationA, SECOND_ASIN).raw_report_ciphertext,
    null,
  );
  assert.notEqual(
    inspectRevision(temporary.path, organizationB, ASIN).raw_report_ciphertext,
    null,
  );

  const events = await service.listAudit({
    principal: principal({
      userId: adminA,
      organizationId: organizationA,
      role: "admin",
    }),
    limit: 20,
  });
  assert.deepEqual(events.map((event) => event.purpose), [
    "delete-policy",
    "create",
    "create",
  ]);
  assert.equal(JSON.stringify(events).includes(REPORT_SENTINEL), false);
});

test("raw decrypt and audit reads require same-tenant admin authority and audit denied or failed attempts", async (t) => {
  const temporary = temporaryDatabase();
  t.after(() => {
    temporary.repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const admin = await seedUser(temporary.repository, organizationId, "admin");
  const member = await seedUser(temporary.repository, organizationId, "member");
  const encryption = cipher("old");
  const written = await writeRaw({
    repository: temporary.repository,
    encryption,
    organizationId,
    actorUserId: admin,
    asin: ASIN,
    marker: "audit",
  });
  const service = new ManualAlexaVocRetentionService({
    repository: temporary.repository,
    cipher: encryption,
  });
  const memberPrincipal = principal({
    userId: member,
    organizationId,
    role: "member",
  });
  await assert.rejects(service.decryptRaw({
    principal: memberPrincipal,
    marketplace: "US",
    asin: ASIN,
    revision: written.record.revision,
    purpose: "decrypt",
  }), ManualAlexaVocRawAccessError);
  await assert.rejects(service.listAudit({
    principal: memberPrincipal,
    limit: 20,
  }), ManualAlexaVocRawAccessError);

  const adminPrincipal = principal({
    userId: admin,
    organizationId,
    role: "admin",
  });
  assert.equal(await service.decryptRaw({
    principal: adminPrincipal,
    marketplace: "US",
    asin: ASIN,
    revision: written.record.revision,
    purpose: "reparse",
  }), `${REPORT_SENTINEL}:audit`);

  const inspector = new DatabaseSync(temporary.path);
  try {
    inspector.prepare(
      `UPDATE manual_alexa_voc_revisions
          SET raw_report_tag = ?
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?
          AND revision = ?`,
    ).run(Buffer.alloc(16, 255), organizationId, ASIN, BigInt(written.record.revision));
  } finally {
    inspector.close();
  }
  let failure: unknown;
  try {
    await service.decryptRaw({
      principal: adminPrincipal,
      marketplace: "US",
      asin: ASIN,
      revision: written.record.revision,
      purpose: "decrypt",
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ManualAlexaVocRawAccessError);
  assert.equal(String(failure).includes(REPORT_SENTINEL), false);
  const events = await service.listAudit({ principal: adminPrincipal, limit: 20 });
  assert.deepEqual(events.map(({ purpose, result }) => `${purpose}:${result}`).sort(), [
    "create:succeeded",
    "decrypt:denied",
    "decrypt:failed",
    "reparse:succeeded",
  ].sort());
  assert.equal(JSON.stringify(events).includes(REPORT_SENTINEL), false);
});

test("key rewrap changes only key id and wrapped DEK, is recoverable, tenant-scoped, and idempotent", async (t) => {
  const temporary = temporaryDatabase();
  t.after(() => {
    temporary.repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const adminA = await seedUser(temporary.repository, organizationA);
  const adminB = await seedUser(temporary.repository, organizationB);
  const oldCipher = cipher("old");
  const newCipher = cipher("new");
  const written = await writeRaw({
    repository: temporary.repository,
    encryption: oldCipher,
    organizationId: organizationA,
    actorUserId: adminA,
    asin: ASIN,
    marker: "rewrap",
  });
  await writeRaw({
    repository: temporary.repository,
    encryption: oldCipher,
    organizationId: organizationB,
    actorUserId: adminB,
    asin: ASIN,
    marker: "other-tenant",
  });
  const before = inspectRevision(temporary.path, organizationA, ASIN);
  const otherBefore = inspectRevision(temporary.path, organizationB, ASIN);

  assert.deepEqual(await rewrapManualAlexaVocKeys({
    repository: temporary.repository,
    cipher: newCipher,
    organizationId: organizationA,
    actorUserId: adminA,
    occurredAt: "2027-01-01T00:00:00.000Z",
    batchSize: 1,
  }), { scanned: 1, rewrapped: 1 });
  assert.deepEqual(await rewrapManualAlexaVocKeys({
    repository: temporary.repository,
    cipher: newCipher,
    organizationId: organizationA,
    actorUserId: adminA,
    occurredAt: "2027-01-01T00:01:00.000Z",
    batchSize: 1,
  }), { scanned: 0, rewrapped: 0 });

  const after = inspectRevision(temporary.path, organizationA, ASIN);
  const changed = Object.keys(after).filter((key) => {
    const left = before[key];
    const right = after[key];
    if (left instanceof Uint8Array && right instanceof Uint8Array) {
      return !Buffer.from(left).equals(Buffer.from(right));
    }
    return left !== right;
  });
  assert.deepEqual(changed.sort(), [
    "raw_report_key_id",
    "raw_report_wrapped_dek",
  ]);
  assert.equal(after.raw_report_key_id, "new");
  assert.deepEqual(
    rawEnvelope(inspectRevision(temporary.path, organizationB, ASIN)),
    rawEnvelope(otherBefore),
  );
  const service = new ManualAlexaVocRetentionService({
    repository: temporary.repository,
    cipher: newCipher,
  });
  assert.equal(await service.decryptRaw({
    principal: principal({
      userId: adminA,
      organizationId: organizationA,
      role: "admin",
    }),
    marketplace: "US",
    asin: ASIN,
    revision: written.record.revision,
    purpose: "decrypt",
  }), `${REPORT_SENTINEL}:rewrap`);
  const events = await service.listAudit({
    principal: principal({
      userId: adminA,
      organizationId: organizationA,
      role: "admin",
    }),
    limit: 20,
  });
  assert.equal(events.filter((event) => event.purpose === "key-rewrap").length, 1);
});

test("rewrap tamper failure leaves the retained envelope unchanged and records only safe audit metadata", async (t) => {
  const temporary = temporaryDatabase();
  t.after(() => {
    temporary.repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const admin = await seedUser(temporary.repository, organizationId);
  await writeRaw({
    repository: temporary.repository,
    encryption: cipher("old"),
    organizationId,
    actorUserId: admin,
    asin: ASIN,
    marker: "tamper",
  });
  const inspector = new DatabaseSync(temporary.path);
  try {
    inspector.prepare(
      `UPDATE manual_alexa_voc_revisions
          SET raw_report_wrapped_dek = ?
        WHERE organization_id = ? AND marketplace = 'US' AND asin = ?`,
    ).run(Buffer.alloc(60, 199), organizationId, ASIN);
  } finally {
    inspector.close();
  }
  const before = inspectRevision(temporary.path, organizationId, ASIN);
  await assert.rejects(rewrapManualAlexaVocKeys({
    repository: temporary.repository,
    cipher: cipher("new"),
    organizationId,
    actorUserId: admin,
    occurredAt: "2027-01-01T00:00:00.000Z",
    batchSize: 10,
  }), /Manual Alexa VOC key rewrap failed/);
  assert.deepEqual(
    rawEnvelope(inspectRevision(temporary.path, organizationId, ASIN)),
    rawEnvelope(before),
  );
  const service = new ManualAlexaVocRetentionService({
    repository: temporary.repository,
    cipher: cipher("new"),
  });
  const events = await service.listAudit({
    principal: principal({
      userId: admin,
      organizationId,
      role: "admin",
    }),
    limit: 20,
  });
  assert.deepEqual(events.map(({ purpose, result }) => ({ purpose, result })), [
    { purpose: "key-rewrap", result: "failed" },
    { purpose: "create", result: "succeeded" },
  ]);
  assert.equal(JSON.stringify(events).includes(REPORT_SENTINEL), false);
});

test("retention sweep owns one non-overlapping timer and drains in-flight work on stop", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  interface FakeRepository {
    transaction<Result>(
      operation: (repository: FakeRepository) => Promise<Result>,
    ): Promise<Result>;
    manualAlexaVoc: Readonly<{
      clearExpiredRaw(): Promise<number>;
    }>;
  }
  const repository: FakeRepository = {
    transaction: (operation) => operation(repository),
    manualAlexaVoc: {
      async clearExpiredRaw() {
        calls += 1;
        await blocked;
        return 0;
      },
    },
  };
  const service = new ManualAlexaVocRetentionService({
    repository: repository as never,
    cipher: cipher("old"),
    sweepTargets: [{
      organizationId: randomUUID(),
      actorUserId: randomUUID(),
    }],
    pollIntervalMs: 10,
    setInterval: (callback) => {
      callbacks.push(callback);
      return { timer: callbacks.length };
    },
    clearInterval: (handle) => cleared.push(handle),
  });
  service.start();
  service.start();
  assert.equal(callbacks.length, 1);
  callbacks[0]!();
  callbacks[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const stop = service.stop();
  assert.equal(cleared.length, 1);
  release();
  await stop;
  await service.stop();
  assert.equal(calls, 1);
  assert.equal(cleared.length, 1);
});

test("Agent Service starts and stops retention only when explicitly enabled", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-retention-agent-"));
  const databasePath = join(directory, "agent.sqlite");
  const repository = await openRuntimeAgentRepository({
    kind: "sqlite",
    sqlite: { path: databasePath, busyTimeoutMs: 5_000 },
  });
  let service: Awaited<ReturnType<typeof createAgentService>> | null = null;
  t.after(async () => {
    await service?.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const organizationId = randomUUID();
  const sqliteRepository = repository as unknown as SqliteAgentRepository;
  const admin = await seedUser(sqliteRepository, organizationId);
  const written = await writeRaw({
    repository: sqliteRepository,
    encryption: cipher("old"),
    organizationId,
    actorUserId: admin,
    asin: ASIN,
    marker: "agent-runtime",
  });
  service = await createAgentService({
    repository,
    logger: false,
    clock: () => new Date(
      new Date(written.record.capturedAt).getTime() + 366 * 86_400_000,
    ),
    env: {
      NODE_ENV: "test",
      AGENT_SERVICE_PROXY_TOKEN: "manual-voc-retention-test-token",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
      AGENT_EXECUTION_ACTOR_ID: admin,
      AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
      AGENT_MANUAL_ALEXA_VOC_RETENTION_ENABLED: "1",
      AGENT_MANUAL_ALEXA_VOC_RETENTION_POLL_MS: "10",
      AGENT_MANUAL_ALEXA_VOC_RETENTION_BATCH_SIZE: "10",
      MANUAL_VOC_RAW_REPORT_KEYRING: keyring("old"),
    },
  });
  await service.start({ host: "127.0.0.1", port: 0 });
  const deadline = Date.now() + 5_000;
  while (
    inspectRevision(databasePath, organizationId, ASIN).raw_report_ciphertext !==
      null &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    inspectRevision(databasePath, organizationId, ASIN).raw_report_ciphertext,
    null,
  );
  await service.stop();
});
