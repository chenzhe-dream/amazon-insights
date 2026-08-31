import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  AgentRepository,
  ManualAlexaVocRepositoryCapability,
} from "../../server/db/repository";
import type { ManualAlexaVocRevision } from "../../server/db/manual-alexa-voc-repository";
import type {
  ManualAlexaVocEncryptedRaw,
  ManualAlexaVocCipher,
} from "../../server/security/manual-alexa-voc-cipher";
import {
  ManualAlexaVocService,
  ManualAlexaVocServiceError,
} from "../../server/services/manual-alexa-voc-service";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";

const ASIN = "B0ALEXA001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const REPORT = readFileSync(
  new URL("../fixtures/alexa-real-report-anonymized.txt", import.meta.url),
  "utf8",
);

function reportWithUtf8Bytes(target: number) {
  let report = `${REPORT.trimEnd()}\n总体结论：bounded report\n`;
  while (Buffer.byteLength(report, "utf8") < target) {
    const remaining = target - Buffer.byteLength(report, "utf8");
    if (remaining <= 2_000) {
      report += "x".repeat(remaining);
    } else {
      report += `${"x".repeat(Math.min(1_999, remaining - 1))}\n`;
    }
  }
  assert.equal(Buffer.byteLength(report, "utf8"), target);
  return report;
}

const encryptedRaw: ManualAlexaVocEncryptedRaw = Object.freeze({
  algVersion: "AES-256-GCM/v1",
  keyId: "test-key",
  wrappedDek: new Uint8Array(60),
  nonce: new Uint8Array(12),
  ciphertext: new Uint8Array([1]),
  tag: new Uint8Array(16),
  aadSha256: "a".repeat(64),
  plaintextBytes: Buffer.byteLength(REPORT, "utf8"),
  plaintextSha256: "b".repeat(64),
});

function successfulHarness(options: Readonly<{
  listRecords?: readonly ManualAlexaVocRevision[];
}> = {}) {
  let putInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["put"]>[0] | null = null;
  let encryptionInput: Parameters<ManualAlexaVocCipher["encrypt"]>[0] | null = null;
  let listInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["listCurrent"]>[0] | null = null;
  let transactionCalls = 0;
  const manualAlexaVoc = {
    async lockScopes() {},
    async peekNextRevision() { return "1"; },
    encrypt: undefined,
    async put(input: NonNullable<typeof putInput>) {
      putInput = input;
      return {
        record: {
          organizationId: input.organizationId,
          marketplace: input.marketplace,
          asin: input.asin,
          revision: input.expectedRevision,
          contentHash: input.contentHash,
          capturedAt: "2026-08-31T01:02:03.456Z",
          normalizedRecord: input.normalizedRecord,
          normalizedSchemaVersion: input.normalizedSchemaVersion,
          parserVersion: input.parserVersion,
        },
        idempotent: false,
        publication: { status: "pending" as const, generation: "1" },
      };
    },
    async listCurrent(input: NonNullable<typeof listInput>) {
      listInput = input;
      return options.listRecords ?? [];
    },
  };
  const repository = {
    manualAlexaVoc,
    async transaction<T>(operation: (repository: unknown) => Promise<T>) {
      transactionCalls += 1;
      return operation(repository);
    },
  } as unknown as AgentRepository & ManualAlexaVocRepositoryCapability;
  const cipher: ManualAlexaVocCipher = {
    activeKeyId: "test-key",
    encrypt(input) {
      encryptionInput = input;
      return encryptedRaw;
    },
    decrypt() { throw new Error("not used"); },
    rewrap() { throw new Error("not used"); },
  };
  return {
    service: new ManualAlexaVocService({ repository, cipher }),
    putInput: () => putInput,
    encryptionInput: () => encryptionInput,
    listInput: () => listInput,
    transactionCalls: () => transactionCalls,
  };
}

test("imports a real report as one canonical encrypted revision without returning raw data", async () => {
  const harness = successfulHarness();

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: { asin: ASIN, marketplace: "US", rawText: REPORT },
  });

  assert.equal(response.record.revision, "1");
  assert.equal(response.record.contentHash, "1fba4e6d63cd8fbfdae49b875b61ab14b6caafeb491bfb749b5f605571cadf14");
  assert.equal(response.record.capturedAt, "2026-08-31T01:02:03.456Z");
  assert.equal(response.record.source, "postgres");
  assert.equal(response.record.generation, "1");
  assert.equal(response.record.normalizedRecord.asin, ASIN);
  assert.equal(response.record.normalizedRecord.alexaReport.asin, ASIN);
  assert.equal(response.record.normalizedRecord.captureStatus, "dialog");
  assert.deepEqual(
    Object.keys(response.record.normalizedRecord).sort(),
    [
      "alexaReport",
      "asin",
      "attention",
      "audiences",
      "captureStatus",
      "motives",
      "negatives",
      "positives",
      "scenarios",
      "unmet",
    ],
  );
  assert.equal(JSON.stringify(response).includes(REPORT), false);
  assert.doesNotMatch(JSON.stringify(response), /rawText|rawReport|createdBy|organizationId/);
  assert.equal(JSON.stringify(response).includes(ORGANIZATION_ID), false);
  assert.equal(JSON.stringify(response).includes(USER_ID), false);

  const written = harness.putInput();
  assert.ok(written);
  assert.equal(written.createdBy, USER_ID);
  assert.equal(written.expectedRevision, "1");
  const rawReportSha256 = createHash("sha256")
    .update(Buffer.from(REPORT, "utf8"))
    .digest("hex");
  assert.equal(
    rawReportSha256,
    "31e815bdef664f83b93637c073310a98284c51ac5fb023a320b3fe071855de69",
  );
  assert.equal(
    written.contentHash,
    canonicalJsonSha256({
      marketplace: "US",
      asin: ASIN,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
      normalizedRecord: written.normalizedRecord,
      rawReportSha256,
    }),
  );
  assert.equal(
    written.contentHash,
    "1fba4e6d63cd8fbfdae49b875b61ab14b6caafeb491bfb749b5f605571cadf14",
  );
  assert.equal(written.raw, encryptedRaw);
  assert.deepEqual(harness.encryptionInput(), {
    identity: {
      organizationId: ORGANIZATION_ID,
      marketplace: "US",
      asin: ASIN,
      revision: "1",
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
    },
    plaintext: REPORT,
  });
});

test("lists only requested current reports in the principal organization and tolerates missing ASINs", async () => {
  const seeded = successfulHarness();
  await seeded.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: { asin: ASIN, marketplace: "US", rawText: REPORT },
  });
  const normalizedRecord = seeded.putInput()?.normalizedRecord;
  assert.ok(normalizedRecord);
  const revision = (overrides: Partial<ManualAlexaVocRevision>): ManualAlexaVocRevision => ({
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asin: ASIN,
    revision: "1",
    contentHash: "c".repeat(64),
    capturedAt: "2026-08-31T01:02:03.456Z",
    normalizedRecord,
    normalizedSchemaVersion: "alexa-voc-record/v2",
    parserVersion: "deterministic-alexa-parser/v3",
    ...overrides,
  });
  const requestedMissingAsin = "B07VY9Q95Q";
  const harness = successfulHarness({
    listRecords: [
      revision({}),
      revision({ organizationId: "other-organization", revision: "2" }),
      revision({ asin: "B0UNASKED1", revision: "3" }),
    ],
  });

  const response = await harness.service.listReports({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    query: { marketplace: "US", asins: [ASIN, requestedMissingAsin] },
  });

  assert.deepEqual(harness.listInput(), {
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asins: [ASIN, requestedMissingAsin],
  });
  assert.deepEqual(response.records.map(record => record.asin), [ASIN]);
  assert.equal(response.records[0]?.contentHash, "c".repeat(64));
  assert.equal(JSON.stringify(response).includes("other-organization"), false);
  assert.equal(JSON.stringify(response).includes("B0UNASKED1"), false);
});

test("maps invalid list input to the service validation error before repository access", async () => {
  const harness = successfulHarness();

  await assert.rejects(
    harness.service.listReports({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      query: { marketplace: "CA", asins: [ASIN] },
    }),
    (error: unknown) =>
      error instanceof ManualAlexaVocServiceError &&
      error.kind === "validation",
  );

  assert.equal(harness.listInput(), null);
});

test("rejects invalid scope and exact-one text inputs before opening a transaction", async () => {
  for (const request of [
    { asin: "invalid", marketplace: "US", rawText: REPORT },
    { asin: ASIN, marketplace: "CA", rawText: REPORT },
    { asin: ASIN, marketplace: "US" },
    { asin: ASIN, marketplace: "US", text: REPORT, rawText: REPORT },
  ]) {
    const harness = successfulHarness();
    await assert.rejects(
      harness.service.importReport({
        principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
        request,
      }),
      (error: unknown) =>
        error instanceof ManualAlexaVocServiceError &&
        error.kind === "validation",
    );
    assert.equal(harness.transactionCalls(), 0);
    assert.equal(harness.putInput(), null);
    assert.equal(harness.encryptionInput(), null);
  }
});

test("rejects malformed normalized report metadata before encryption or database writes", async () => {
  const harness = successfulHarness();
  const malformed = `4.5 星 · ${"9".repeat(40)} 条评论\n${REPORT}`;

  await assert.rejects(
    harness.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: { asin: ASIN, marketplace: "US", rawText: malformed },
    }),
    (error: unknown) =>
      error instanceof ManualAlexaVocServiceError &&
      error.kind === "incomplete",
  );
  assert.equal(harness.transactionCalls(), 0);
  assert.equal(harness.putInput(), null);
  assert.equal(harness.encryptionInput(), null);
});

test("validates report ASIN and three usable dimensions before any transaction", async () => {
  const incomplete = [
    `${ASIN} — 顾客洞察`,
    "1. 顾客关注点",
    "1. 安装稳固与长期可靠性表现",
    "2. 好评点",
    "1. 材料和整体质量值得信赖",
  ].join("\n");
  for (const rawText of [
    REPORT.replaceAll(ASIN, "B07VY9Q95Q"),
    incomplete,
  ]) {
    const harness = successfulHarness();
    await assert.rejects(
      harness.service.importReport({
        principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
        request: { asin: ASIN, marketplace: "US", rawText },
      }),
      (error: unknown) =>
        error instanceof ManualAlexaVocServiceError &&
        error.kind === "incomplete",
    );
    assert.equal(harness.transactionCalls(), 0);
    assert.equal(harness.putInput(), null);
    assert.equal(harness.encryptionInput(), null);
  }
});

test("accepts 131072 UTF-8 bytes and rejects 131073 before encryption or database writes", async () => {
  const accepted = successfulHarness();
  const acceptedRawText = reportWithUtf8Bytes(131_072);
  await accepted.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: { asin: ASIN, marketplace: "US", text: acceptedRawText },
  });
  assert.equal(accepted.transactionCalls(), 1);
  assert.equal(accepted.encryptionInput()?.plaintext, acceptedRawText);

  const rejected = successfulHarness();
  await assert.rejects(
    rejected.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: {
        asin: ASIN,
        marketplace: "US",
        rawText: reportWithUtf8Bytes(131_073),
      },
    }),
    (error: unknown) =>
      error instanceof ManualAlexaVocServiceError &&
      error.kind === "too-large",
  );
  assert.equal(rejected.transactionCalls(), 0);
  assert.equal(rejected.putInput(), null);
  assert.equal(rejected.encryptionInput(), null);
});
