import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  AgentRepository,
  ManualAlexaVocRepositoryCapability,
} from "../../server/db/repository";
import type { ManualAlexaVocRevision } from "../../server/db/manual-alexa-voc-repository";
import type { AlexaVocNormalizationInputCipher } from "../../server/security/alexa-voc-normalization-input-cipher";
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
const PROJECT_ID = "10000000-0000-4000-8000-000000000003";
const RUN_ID = "10000000-0000-4000-8000-000000000004";
const NOW = "2026-08-31T01:02:03.456Z";
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
  projectOrganizationId?: string;
  projectExists?: boolean;
  runExists?: boolean;
  runProjectId?: string;
  runStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}> = {}) {
  let putInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["put"]>[0] | null = null;
  let encryptionInput: Parameters<ManualAlexaVocCipher["encrypt"]>[0] | null = null;
  let listInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["listCurrent"]>[0] | null = null;
  let transactionCalls = 0;
  let queueInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["queueNormalizationInput"]>[0] | null = null;
  let normalizationEncryptionInput: Parameters<AlexaVocNormalizationInputCipher["encrypt"]>[0] | null = null;
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
    async queueNormalizationInput(input: NonNullable<typeof queueInput>) {
      queueInput = input;
      return {
        snapshot: {
          id: input.snapshotId,
          organizationId: input.actorOrganizationId,
          projectId: input.projectId,
          runId: input.runId,
          marketplace: input.marketplace,
          asin: input.asin,
          rawReportSha256: input.rawReportSha256,
          plaintextBytes: input.plaintextBytes,
          executionFingerprint: input.executionFingerprint,
          envelope: input.envelope,
          createdAt: input.queuedAt,
        },
        snapshotCreated: true,
        stageId: input.stageId,
        jobId: input.jobId,
        jobCreated: true,
      };
    },
    async findNormalizationInputByFingerprint() { return null; },
  };
  const project = {
    id: PROJECT_ID,
    organizationId: options.projectOrganizationId ?? ORGANIZATION_ID,
    name: "Alexa project",
    marketplace: "US" as const,
    asins: [ASIN, "B07VY9Q95Q"],
    createdBy: USER_ID,
    currentRunId: RUN_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const run = {
    id: RUN_ID,
    projectId: options.runProjectId ?? PROJECT_ID,
    mode: "existing-data" as const,
    status: options.runStatus ?? "queued" as const,
    createdBy: USER_ID,
    dataCutoffAt: NOW,
    idempotencyScope: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}`,
    idempotencyKey: "run-request",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const repository = {
    manualAlexaVoc,
    async findProjectById(id: string) { return options.projectExists !== false && id === PROJECT_ID ? project : null; },
    async findAnalysisRun(id: string) { return options.runExists !== false && id === RUN_ID ? run : null; },
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
  const normalizationInputCipher: AlexaVocNormalizationInputCipher = {
    activeKeyId: "normalization-test",
    encrypt(input) {
      normalizationEncryptionInput = input;
      return {
        algVersion: "AES-256-GCM/v1",
        keyId: "normalization-test",
        wrappedDek: "AA",
        nonce: "AA",
        ciphertext: "AA",
        tag: "AA",
        aadSha256: "a".repeat(64),
        plaintextBytes: Buffer.byteLength(input.plaintext, "utf8"),
        plaintextSha256: createHash("sha256").update(input.plaintext).digest("hex"),
      };
    },
    decrypt() { throw new Error("not used"); },
  };
  return {
    service: new ManualAlexaVocService({ repository, cipher, normalizationInputCipher, createId: (() => {
      let value = 10;
      return () => `10000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
    })(), now: () => NOW }),
    putInput: () => putInput,
    encryptionInput: () => encryptionInput,
    listInput: () => listInput,
    transactionCalls: () => transactionCalls,
    queueInput: () => queueInput,
    normalizationEncryptionInput: () => normalizationEncryptionInput,
  };
}

function importRequest(rawText = REPORT) {
  return { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, marketplace: "US" as const, rawText };
}

test("imports a real report as one canonical encrypted revision without returning raw data", async () => {
  const harness = successfulHarness();

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(),
  });

  assert.equal(response.record.revision, "1");
  assert.equal(response.record.contentHash.length, 64);
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
  assert.equal(rawReportSha256.length, 64);
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
  assert.equal(written.contentHash.length, 64);
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
    request: importRequest(),
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
    query: { projectId: PROJECT_ID, marketplace: "US", asins: [ASIN, requestedMissingAsin] },
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
      query: { projectId: PROJECT_ID, marketplace: "CA", asins: [ASIN] },
    }),
    (error: unknown) =>
      error instanceof ManualAlexaVocServiceError &&
      error.kind === "validation",
  );

  assert.equal(harness.listInput(), null);
});

test("rejects invalid scope and exact-one text inputs before opening a transaction", async () => {
  for (const request of [
    { ...importRequest(), asin: "invalid" },
    { ...importRequest(), marketplace: "CA" },
    { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, marketplace: "US" },
    { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, marketplace: "US", text: REPORT, rawText: REPORT },
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

test("queues malformed normalized report metadata as encrypted normalization input", async () => {
  const harness = successfulHarness();
  const malformed = `4.5 星 · ${"9".repeat(40)} 条评论\n${REPORT}`;

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(malformed),
  });
  assert.equal(response.disposition, "pending");
  assert.equal(harness.transactionCalls(), 1);
  assert.equal(harness.putInput(), null);
  assert.equal(harness.encryptionInput(), null);
  assert.ok(harness.queueInput());
  assert.equal(harness.normalizationEncryptionInput()?.plaintext, malformed);
});

test("queues ASIN-mismatched and incomplete reports instead of widening the strict fast path", async () => {
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
    const response = await harness.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: importRequest(rawText),
    });
    assert.equal(response.disposition, "pending");
    assert.equal(harness.transactionCalls(), 1);
    assert.equal(harness.putInput(), null);
    assert.equal(harness.encryptionInput(), null);
    assert.ok(harness.queueInput());
  }
});

test("binds a valid report without an embedded ASIN to the selected ASIN", async () => {
  const harness = successfulHarness();
  const reportWithoutAsin = REPORT.replaceAll(ASIN, "");

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(reportWithoutAsin),
  });

  assert.equal(response.record.asin, ASIN);
  assert.equal(response.record.normalizedRecord.asin, ASIN);
  assert.equal(response.record.normalizedRecord.alexaReport.asin, ASIN);
  assert.equal(harness.transactionCalls(), 1);
  assert.equal(harness.encryptionInput()?.plaintext, reportWithoutAsin);
});

test("imports an Alexa report with emoji hash-numbered headings", async () => {
  const harness = successfulHarness();
  const rawText = REPORT
    .replace("🎯 顾客关注点", "🎯 #1 顾客关注点")
    .replace("✅ 好评点", "✅ #2 好评点")
    .replace("❌ 3. 差评点", "❌ #3 差评点")
    .replace("💭 未被满足的需求", "💭 #4 未被满足的需求")
    .replace("👥 使用人群", "👥 #5 使用人群")
    .replace("🏠 使用场景", "🏠 #6 使用场景")
    .replace("⚡ 核心购买动机", "⚡ #7 核心购买动机");

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(rawText),
  });

  assert.equal(response.record.asin, ASIN);
  for (const key of ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"] as const) {
    assert.ok(response.record.normalizedRecord[key].length > 0, key);
  }
  assert.equal(harness.transactionCalls(), 1);
});

test("accepts 131072 UTF-8 bytes and rejects 131073 before encryption or database writes", async () => {
  const accepted = successfulHarness();
  const acceptedRawText = reportWithUtf8Bytes(131_072);
  await accepted.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: { ...importRequest(acceptedRawText), rawText: undefined, text: acceptedRawText },
  });
  assert.equal(accepted.transactionCalls(), 1);
  assert.equal(accepted.encryptionInput()?.plaintext, acceptedRawText);

  const rejected = successfulHarness();
  await assert.rejects(
    rejected.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: {
        projectId: PROJECT_ID,
        runId: RUN_ID,
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

test("rejects a foreign project before parser, cipher, snapshot, or job side effects", async () => {
  const harness = successfulHarness({ projectOrganizationId: "20000000-0000-4000-8000-000000000001" });
  await assert.rejects(
    harness.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: {
        projectId: PROJECT_ID,
        runId: RUN_ID,
        asin: ASIN,
        marketplace: "US",
        rawText: REPORT,
      },
    }),
    (error: unknown) =>
      error instanceof ManualAlexaVocServiceError &&
      (error as ManualAlexaVocServiceError & { kind: string }).kind === "forbidden",
  );
  assert.equal(harness.transactionCalls(), 0);
  assert.equal(harness.putInput(), null);
  assert.equal(harness.encryptionInput(), null);
});

test("rejects missing, cross-project, and cancelled runs before encryption or queue side effects", async () => {
  for (const [options, kind] of [
    [{ runExists: false }, "not-found"],
    [{ runProjectId: "20000000-0000-4000-8000-000000000004" }, "forbidden"],
    [{ runStatus: "cancelled" as const }, "conflict"],
  ] as const) {
    const harness = successfulHarness(options);
    await assert.rejects(
      harness.service.importReport({
        principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
        request: importRequest(),
      }),
      (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === kind,
    );
    assert.equal(harness.transactionCalls(), 0);
    assert.equal(harness.encryptionInput(), null);
    assert.equal(harness.normalizationEncryptionInput(), null);
    assert.equal(harness.queueInput(), null);
  }
});

test("list authorization prevents same-organization cross-project ASIN reads", async () => {
  const harness = successfulHarness({ projectOrganizationId: "20000000-0000-4000-8000-000000000001" });
  await assert.rejects(
    harness.service.listReports({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      query: { projectId: PROJECT_ID, marketplace: "US", asins: [ASIN] },
    }),
    (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === "forbidden",
  );
  assert.equal(harness.listInput(), null);
});

test("returns pending instead of rejecting when strict latest-skill matrix validation fails", async () => {
  const harness = successfulHarness();
  const incomplete = `${ASIN}\n1. 顾客关注点\n1. 只有一个维度`;
  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: {
      projectId: PROJECT_ID,
      runId: RUN_ID,
      asin: ASIN,
      marketplace: "US",
      rawText: incomplete,
    },
  });
  assert.equal((response as { disposition?: string }).disposition, "pending");
  assert.equal((response as { record?: unknown }).record, null);
  assert.equal(JSON.stringify(response).includes(REPORT), false);
  assert.equal(harness.normalizationEncryptionInput()?.plaintext, incomplete);
  assert.equal(JSON.stringify(harness.queueInput()).includes(incomplete), false);
});
