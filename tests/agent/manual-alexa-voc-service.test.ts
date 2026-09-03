import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  AgentRepository,
  ManualAlexaVocRepositoryCapability,
} from "../../server/db/repository";
import type { AlexaVocNormalizationStatus } from "../../shared/agent-contracts";
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
const DEFAULT_EXECUTION_IDENTITY = {
  providerName: "openai:responses-strict",
  model: { name: "gpt-test", estimatedInputTokens: 100, maxOutputTokens: 200, timeoutMs: 1_000,
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
} as const;
const REPORT = readFileSync(
  new URL("../fixtures/alexa-real-report-anonymized.txt", import.meta.url),
  "utf8",
);
const STRICT_REPORT = `示例品牌 (${ASIN}) — 顾客评价深度分析
🎯 顾客关注点
1. 产品质量：买家关注耐用性（Quality 1264次提及，6.1%）
✅ 好评点
耐用（正面维度1264次提及，6.1%）
❌ 差评点
重量（负面维度306条负面，占1.5%）
💭 未被满足的需求
1. 希望产品更轻。
👥 使用人群
人群分类｜特征
家庭用户｜重视耐用性
🏠 使用场景：
场景｜说明与示例
家庭使用｜日常高频使用
⚡ 核心购买动机
动机｜重要性｜说明
可靠性｜⭐⭐⭐⭐⭐｜耐用证据
💡 综合结论
买家重视耐用性。`;

function reportWithUtf8Bytes(target: number) {
  let report = `${STRICT_REPORT.trimEnd()}\n总体结论：bounded report\n`;
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
  committedNormalization?: ManualAlexaVocRevision | null;
  committedNormalizationHistory?: readonly ManualAlexaVocRevision[];
  committedFingerprint?: string;
  executionIdentity?: Readonly<{
    providerName: string;
    model: Readonly<{
      name: string; estimatedInputTokens: number; maxOutputTokens: number; timeoutMs: number;
      pricing: Readonly<{ inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }>;
    }>;
  }>;
  projectId?: string;
  runId?: string;
  existingQueueIdentity?: Readonly<{ snapshotId: string; jobId: string }>;
  projectOrganizationId?: string;
  projectExists?: boolean;
  runExists?: boolean;
  runProjectId?: string;
  runStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  normalizationStatuses?: readonly AlexaVocNormalizationStatus[];
  normalizationDispatch?: () => Promise<void> | void;
}> = {}) {
  let putInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["put"]>[0] | null = null;
  let encryptionInput: Parameters<ManualAlexaVocCipher["encrypt"]>[0] | null = null;
  let listInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["listCurrent"]>[0] | null = null;
  let transactionCalls = 0;
  let queueInput: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["queueNormalizationInput"]>[0] | null = null;
  let normalizationEncryptionInput: Parameters<AlexaVocNormalizationInputCipher["encrypt"]>[0] | null = null;
  let committedNormalizationLookup: Readonly<{
    actorOrganizationId: string;
    marketplace: "US";
    asin: string;
    executionFingerprint: string;
    dataCutoffAt?: string;
  }> | null = null;
  let normalizationStatusLookup: Parameters<ManualAlexaVocRepositoryCapability["manualAlexaVoc"]["listNormalizationStatuses"]>[0] | null = null;
  const cumulativePublications: unknown[] = [];
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
      await options.normalizationDispatch?.();
      return {
        snapshot: {
          id: options.existingQueueIdentity?.snapshotId ?? input.snapshotId,
          organizationId: input.actorOrganizationId,
          projectId: input.projectId,
          runId: input.runId,
          marketplace: input.marketplace,
          asin: input.asin,
          rawReportSha256: input.rawReportSha256,
          plaintextBytes: input.plaintextBytes,
          executionFingerprint: input.executionFingerprint,
          executionIdentity: input.executionIdentity,
          envelope: input.envelope,
          createdAt: input.queuedAt,
        },
        snapshotCreated: options.existingQueueIdentity ? false : true,
        stageId: input.stageId,
        jobId: options.existingQueueIdentity?.jobId ?? input.jobId,
        jobCreated: options.existingQueueIdentity ? false : true,
      };
    },
    async findNormalizationInputByFingerprint() { return null; },
    async findCommittedNormalizationByFingerprint(input: NonNullable<typeof committedNormalizationLookup>) {
      committedNormalizationLookup = input;
      if (options.committedNormalizationHistory) {
        const authoritative = options.committedNormalizationHistory
          .filter((revision) => revision.organizationId === input.actorOrganizationId
            && revision.marketplace === input.marketplace
            && revision.asin === input.asin
            && (!input.dataCutoffAt || revision.capturedAt <= input.dataCutoffAt))
          .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)
            || (BigInt(right.revision) > BigInt(left.revision) ? 1 : -1))[0];
        return authoritative?.contentHash === input.executionFingerprint ? authoritative : null;
      }
      return options.committedNormalization?.organizationId === input.actorOrganizationId
        && (!options.committedFingerprint || options.committedFingerprint === input.executionFingerprint)
        && (!input.dataCutoffAt || options.committedNormalization.capturedAt <= input.dataCutoffAt)
        ? options.committedNormalization
        : null;
    },
    async listNormalizationStatuses(input: NonNullable<typeof normalizationStatusLookup>) {
      normalizationStatusLookup = input;
      return options.normalizationStatuses ?? [];
    },
  };
  const project = {
    id: options.projectId ?? PROJECT_ID,
    organizationId: options.projectOrganizationId ?? ORGANIZATION_ID,
    name: "Alexa project",
    marketplace: "US" as const,
    asins: [ASIN, "B07VY9Q95Q"],
    createdBy: USER_ID,
    currentRunId: options.runId ?? RUN_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const run = {
    id: options.runId ?? RUN_ID,
    projectId: options.runProjectId ?? options.projectId ?? PROJECT_ID,
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
    async findProjectById(id: string) { return options.projectExists !== false && id === project.id ? project : null; },
    async findAnalysisRun(id: string) { return options.runExists !== false && id === run.id ? run : null; },
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
    service: new ManualAlexaVocService({ repository, cipher, normalizationInputCipher,
      normalizationExecutionIdentity: options.executionIdentity ?? DEFAULT_EXECUTION_IDENTITY, createId: (() => {
      let value = 10;
      return () => `10000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
    })(), now: () => NOW,
      publishCumulativeVocSnapshotAndWake: async (_repository: unknown, publication: unknown) => {
        cumulativePublications.push(publication);
        return { snapshotCreated: true, wakeCreated: true };
      },
    }),
    putInput: () => putInput,
    encryptionInput: () => encryptionInput,
    listInput: () => listInput,
    transactionCalls: () => transactionCalls,
    queueInput: () => queueInput,
    normalizationEncryptionInput: () => normalizationEncryptionInput,
    committedNormalizationLookup: () => committedNormalizationLookup,
    normalizationStatusLookup: () => normalizationStatusLookup,
    cumulativePublications: () => cumulativePublications,
  };
}

function importRequest(rawText = REPORT) {
  return { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, marketplace: "US" as const, rawText };
}

async function reusableNormalizationRevision(
  overrides: Partial<ManualAlexaVocRevision> = {},
): Promise<ManualAlexaVocRevision> {
  const seeded = successfulHarness();
  await seeded.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(STRICT_REPORT),
  });
  const normalizedRecord = seeded.putInput()?.normalizedRecord;
  assert.ok(normalizedRecord);
  return {
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asin: ASIN,
    revision: "7",
    contentHash: "e".repeat(64),
    capturedAt: NOW,
    normalizedRecord,
    normalizedSchemaVersion: "alexa-voc-record/v2",
    parserVersion: "deterministic-alexa-parser/v3",
    ...overrides,
  };
}

test("imports a strict latest-Skill report as one canonical encrypted revision without returning raw data", async () => {
  const harness = successfulHarness();

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(STRICT_REPORT),
  });

  assert.equal(response.disposition, "success");
  assert.ok(response.record);
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
    .update(Buffer.from(STRICT_REPORT, "utf8"))
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
    plaintext: STRICT_REPORT,
  });
});

test("lists only requested current reports in the principal organization and tolerates missing ASINs", async () => {
  const seeded = successfulHarness();
  await seeded.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(STRICT_REPORT),
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

test("strict fast-path import publishes a cutoff-visible cumulative snapshot and wakes downstream", async () => {
  const harness = successfulHarness();
  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(STRICT_REPORT),
  });
  assert.equal(response.disposition, "success");
  assert.equal((harness.putInput() as unknown as { capturedAt?: string })?.capturedAt, NOW);
  assert.deepEqual(harness.cumulativePublications(), [{
    actorId: USER_ID,
    actorOrganizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asins: [ASIN, "B07VY9Q95Q"],
    dataCutoffAt: NOW,
    createdAt: NOW,
  }]);
});

test("queues an explicitly different report ASIN under the selected target", async () => {
  const harness = successfulHarness();
  const rawText = `Other lamp (B07VY9Q95Q) — 顾客分析
1. 顾客关注点
1. Buyers value brightness control.`;

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(rawText),
  });

  assert.equal(response.disposition, "pending");
  assert.equal(response.normalization.asin, ASIN);
  assert.equal(harness.queueInput()?.asin, ASIN);
  assert.equal(harness.normalizationEncryptionInput()?.identity.asin, ASIN);
  assert.equal(harness.normalizationEncryptionInput()?.plaintext, rawText);
});

test("the same report text remains isolated under each selected ASIN", async () => {
  let providerCalls = 0;
  const normalizationDispatch = () => { providerCalls += 1; };
  const report = `Other lamp (B0NORM0001) — 顾客分析
1. 顾客关注点
1. Buyers value brightness control.`;

  for (const asin of [ASIN, "B07VY9Q95Q"]) {
    const harness = successfulHarness({ normalizationDispatch });
    const response = await harness.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: { ...importRequest(report), asin },
    });
    assert.equal(response.disposition, "pending");
    assert.equal(response.normalization.asin, asin);
    assert.equal(harness.queueInput()?.asin, asin);
    assert.equal(harness.normalizationEncryptionInput()?.identity.asin, asin);
  }

  assert.equal(providerCalls, 2);
});

test("queues incomplete reports instead of widening the strict fast path", async () => {
  const incomplete = [
    `${ASIN} — 顾客洞察`,
    "1. 顾客关注点",
    "1. 安装稳固与长期可靠性表现",
    "2. 好评点",
    "1. 材料和整体质量值得信赖",
  ].join("\n");
  const harness = successfulHarness();
  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(incomplete),
  });
  assert.equal(response.disposition, "pending");
  assert.equal(harness.transactionCalls(), 1);
  assert.equal(harness.putInput(), null);
  assert.equal(harness.encryptionInput(), null);
  assert.ok(harness.queueInput());
});

test("binds a valid report without an embedded ASIN to the selected ASIN", async () => {
  const harness = successfulHarness();
  const reportWithoutAsin = STRICT_REPORT.replaceAll(ASIN, "");

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(reportWithoutAsin),
  });

  assert.equal(response.disposition, "success");
  assert.ok(response.record);
  assert.equal(response.record.asin, ASIN);
  assert.equal(response.record.normalizedRecord.asin, ASIN);
  assert.equal(response.record.normalizedRecord.alexaReport.asin, ASIN);
  assert.equal(harness.transactionCalls(), 1);
  assert.equal(harness.encryptionInput()?.plaintext, reportWithoutAsin);
});

test("imports an Alexa report with emoji hash-numbered headings", async () => {
  const harness = successfulHarness();
  const rawText = STRICT_REPORT
    .replace("🎯 顾客关注点", "🎯 #1 顾客关注点")
    .replace("✅ 好评点", "✅ #2 好评点")
    .replace("❌ 差评点", "❌ #3 差评点")
    .replace("💭 未被满足的需求", "💭 #4 未被满足的需求")
    .replace("👥 使用人群", "👥 #5 使用人群")
    .replace("🏠 使用场景", "🏠 #6 使用场景")
    .replace("⚡ 核心购买动机", "⚡ #7 核心购买动机");

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(rawText),
  });

  assert.equal(response.disposition, "success");
  assert.ok(response.record);
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
  assert.equal(JSON.stringify(response).includes(STRICT_REPORT), false);
  assert.equal(harness.normalizationEncryptionInput()?.plaintext, incomplete);
  assert.equal(JSON.stringify(harness.queueInput()).includes(incomplete), false);
});

test("reuses a successful normalization fingerprint in the same project without snapshot, stage, or job writes", async () => {
  const committed = await reusableNormalizationRevision();
  const harness = successfulHarness({ committedNormalization: committed });
  const incomplete = `${ASIN}\n1. 顾客关注点\n1. 只有一个维度`;

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(incomplete),
  });

  assert.equal(response.disposition, "success");
  assert.equal(response.record?.revision, committed.revision);
  assert.equal(response.normalization.status, "success");
  assert.equal(response.normalization.fingerprint, harness.committedNormalizationLookup()?.executionFingerprint);
  assert.deepEqual(harness.committedNormalizationLookup(), {
    actorOrganizationId: ORGANIZATION_ID,
    marketplace: "US",
    asin: ASIN,
    executionFingerprint: response.normalization.fingerprint,
    dataCutoffAt: NOW,
  });
  assert.equal(harness.queueInput(), null);
  assert.equal(harness.normalizationEncryptionInput(), null);
});

test("reuses one successful fingerprint for an authorized new run and same-organization project", async () => {
  const targetProjectId = "10000000-0000-4000-8000-000000000013";
  const targetRunId = "10000000-0000-4000-8000-000000000014";
  const committed = await reusableNormalizationRevision();
  const harness = successfulHarness({
    committedNormalization: committed,
    projectId: targetProjectId,
    runId: targetRunId,
  });

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: {
      ...importRequest(`${ASIN}\n1. 顾客关注点\n1. 只有一个维度`),
      projectId: targetProjectId,
      runId: targetRunId,
    },
  });

  assert.equal(response.disposition, "success");
  assert.equal(response.record?.revision, committed.revision);
  assert.equal(harness.queueInput(), null);
  assert.equal(harness.normalizationEncryptionInput(), null);
  assert.deepEqual(harness.cumulativePublications(), [{
    actorId: USER_ID,
    actorOrganizationId: ORGANIZATION_ID,
    projectId: targetProjectId,
    runId: targetRunId,
    asins: [ASIN, "B07VY9Q95Q"],
    dataCutoffAt: NOW,
    createdAt: NOW,
  }]);
});

test("does not return or publish a successful fingerprint revision newer than the target run cutoff", async () => {
  const future = await reusableNormalizationRevision({
    capturedAt: "2026-09-02T00:00:00.000Z",
  });
  const harness = successfulHarness({ committedNormalization: future });
  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(`${ASIN}\n1. 顾客关注点\n1. 只有一个维度`),
  });
  assert.equal(response.disposition, "pending");
  assert.equal(response.record, null);
  assert.ok(harness.queueInput());
  assert.deepEqual(harness.cumulativePublications(), []);
  assert.equal(harness.committedNormalizationLookup()?.dataCutoffAt, NOW);
});

test("queues F again when cutoff-authoritative G supersedes historical successful F", async () => {
  const rawText = `${ASIN}\n1. 顾客关注点\n1. 只有一个维度`;
  const first = successfulHarness();
  const firstResponse = await first.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(rawText),
  });
  const fingerprintF = firstResponse.normalization.fingerprint;
  const historicalF = await reusableNormalizationRevision({
    revision: "7",
    contentHash: fingerprintF,
    capturedAt: NOW,
  });
  const authoritativeG = await reusableNormalizationRevision({
    revision: "8",
    contentHash: "a".repeat(64),
    capturedAt: NOW,
  });
  const resubmission = successfulHarness({
    committedNormalizationHistory: [historicalF, authoritativeG],
  });

  const response = await resubmission.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(rawText),
  });

  assert.equal(response.normalization.fingerprint, fingerprintF);
  assert.equal(response.disposition, "pending");
  assert.equal(response.record, null);
  assert.ok(resubmission.queueInput());
  assert.deepEqual(resubmission.cumulativePublications(), []);
});

test("a runtime model identity change does not reuse the previous normalization fingerprint", async () => {
  const incomplete = `${ASIN}\n1. 顾客关注点\n1. 只有一个维度`;
  const first = successfulHarness({
    executionIdentity: {
      providerName: "openai:responses-strict",
      model: { name: "model-a", estimatedInputTokens: 100, maxOutputTokens: 200, timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
    },
  });
  const firstResponse = await first.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(incomplete),
  });
  const previousFingerprint = firstResponse.normalization.fingerprint;
  const changed = successfulHarness({
    committedNormalization: await reusableNormalizationRevision({ contentHash: previousFingerprint }),
    committedFingerprint: previousFingerprint,
    executionIdentity: {
      providerName: "openai:responses-strict",
      model: { name: "model-b", estimatedInputTokens: 100, maxOutputTokens: 200, timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
    },
  });
  const changedResponse = await changed.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(incomplete),
  });
  assert.equal(changedResponse.disposition, "pending");
  assert.notEqual(changedResponse.normalization.fingerprint, previousFingerprint);
});

test("does not reuse a successful normalization fingerprint across organizations", async () => {
  const foreign = await reusableNormalizationRevision({
    organizationId: "20000000-0000-4000-8000-000000000001",
  });
  const harness = successfulHarness({ committedNormalization: foreign });

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(`${ASIN}\n1. 顾客关注点\n1. 只有一个维度`),
  });

  assert.equal(response.disposition, "pending");
  assert.equal(harness.committedNormalizationLookup()?.actorOrganizationId, ORGANIZATION_ID);
  assert.ok(harness.queueInput());
  assert.ok(harness.normalizationEncryptionInput());
});

test("keeps an active project-run normalization pending instead of creating another job", async () => {
  const existingQueueIdentity = {
    snapshotId: "10000000-0000-4000-8000-000000000021",
    jobId: "10000000-0000-4000-8000-000000000022",
  };
  const harness = successfulHarness({ existingQueueIdentity });

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: importRequest(`${ASIN}\n1. 顾客关注点\n1. 只有一个维度`),
  });

  assert.equal(response.disposition, "pending");
  assert.equal(response.record, null);
  assert.ok(harness.queueInput());
  assert.equal(response.normalization.fingerprint, harness.queueInput()?.executionFingerprint);
});

test("returns only the requested run-local Alexa normalization statuses", async () => {
  const fingerprint = "d".repeat(64);
  const harness = successfulHarness({
    normalizationStatuses: [{
      asin: ASIN,
      fingerprint,
      status: "success",
      revision: "8",
      error: null,
    }],
  });
  const response = await harness.service.getNormalizationStatus({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    query: { projectId: PROJECT_ID, runId: RUN_ID, marketplace: "US", asins: [ASIN] },
  });
  assert.deepEqual(response, { records: [{
    asin: ASIN,
    fingerprint,
    status: "success",
    revision: "8",
    error: null,
  }] });
  assert.deepEqual(harness.normalizationStatusLookup(), {
    actorOrganizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    marketplace: "US",
    asins: [ASIN],
  });
  assert.doesNotMatch(JSON.stringify(response), /rawText|ciphertext|wrappedDek|modelResponse/i);
});

test("rejects foreign, mismatched-run, and non-member status scopes without repository reads", async () => {
  for (const harness of [
    successfulHarness({ projectOrganizationId: "20000000-0000-4000-8000-000000000001" }),
    successfulHarness({ runProjectId: "10000000-0000-4000-8000-000000000099" }),
  ]) {
    await assert.rejects(
      harness.service.getNormalizationStatus({
        principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
        query: { projectId: PROJECT_ID, runId: RUN_ID, marketplace: "US", asins: [ASIN] },
      }),
      (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === "forbidden",
    );
    assert.equal(harness.normalizationStatusLookup(), null);
  }
  const nonMember = successfulHarness();
  await assert.rejects(
    nonMember.service.getNormalizationStatus({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      query: { projectId: PROJECT_ID, runId: RUN_ID, marketplace: "US", asins: ["B0NOTMEMB1"] },
    }),
    (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === "forbidden",
  );
  assert.equal(nonMember.normalizationStatusLookup(), null);
});
