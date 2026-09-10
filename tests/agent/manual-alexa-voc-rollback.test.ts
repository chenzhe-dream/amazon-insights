import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { RequestPrincipal } from "../../server/auth/authorization";
import type { AgentAuthenticationConfig } from "../../server/config";
import { ManualAlexaVocRepositoryError } from "../../server/db/manual-alexa-voc-repository";
import type { AgentRepository, ManualAlexaVocRepositoryCapability } from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import { createManualAlexaVocCipher, type ManualAlexaVocCipher } from "../../server/security/manual-alexa-voc-cipher";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import { ManualAlexaVocService, ManualAlexaVocServiceError } from "../../server/services/manual-alexa-voc-service";
import {
  createManualVocOverlayState,
  hydrationStarted,
  hydrationSucceeded,
  identityChanged,
  importSucceeded,
  reduceManualVoc,
  selectEffectiveVocByAsin,
} from "../../app/features/voc/manual-alexa-voc-store";
import type { ManualAlexaVocRecord } from "../../shared/agent-contracts";

const ORIGIN = "http://127.0.0.1:31900";
const PROXY_TOKEN = "task-12-manual-voc-proxy";
const SESSION_TOKEN = "S".repeat(43);
const ORGANIZATION_ID = "12000000-0000-4000-8000-000000000001";
const ACTOR_ID = "12000000-0000-4000-8000-000000000002";
const ASIN = "B0ALEXA001";
const PROJECT_ASINS = [ASIN, "B0TASK1202", "B0TASK1203"] as const;
// Rollback of the synchronous import path needs a complete, directly parseable report.
// Free-form reports exercise the separate asynchronous normalization suite.
const REPORT = `示例品牌 (${ASIN}) — 顾客评价深度分析
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

const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "__Host-agent_session", secure: true, maxAgeSeconds: 28_800 },
  sessionTtlMs: 28_800_000,
  loginLimiter: { windowMs: 900_000, maxFailures: 5, maxEntries: 10_000 },
};

class Task12AuthService {
  async authenticate(token: string | null) {
    return token === SESSION_TOKEN
      ? {
          kind: "user" as const,
          userId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          email: "task12@example.test",
          role: "member" as const,
          sessionId: "12000000-0000-4000-8000-000000000003",
        }
      : null;
  }
}

function headers() {
  return {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    cookie: `__Host-agent_session=${SESSION_TOKEN}`,
  };
}

function appFor(service: ManualAlexaVocService | null) {
  return buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
      AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN,
    },
    authConfig,
    authService: new Task12AuthService() as unknown as AuthenticationService,
    manualAlexaVocService: service,
  });
}

function keyring() {
  return {
    MANUAL_VOC_RAW_REPORT_KEYRING: JSON.stringify({
      activeKeyId: "task12",
      keys: { task12: Buffer.alloc(32, 0x54).toString("base64url") },
    }),
  };
}

function principal(): RequestPrincipal {
  return {
    kind: "user",
    userId: ACTOR_ID,
    organizationId: ORGANIZATION_ID,
    email: "task12@example.test",
    role: "member",
    sessionId: randomUUID(),
  };
}

function emptyReviewSources() {
  return {
    sorftime: { meta: { marketplace: "US" }, data: {} },
    sellerSprite: { meta: { marketplace: "US" }, data: {} },
  };
}

function provenanceRevision(snapshot: Readonly<{ sources: readonly unknown[] }>) {
  const alexa = snapshot.sources[0] as { recordProvenance?: readonly { revision: string }[] } | undefined;
  return alexa?.recordProvenance?.[0]?.revision ?? null;
}

async function seedImportRun(repository: AgentRepository, projectId: string) {
  const runId = randomUUID();
  const createdAt = "2026-08-31T08:00:00.000Z";
  await repository.createAnalysisRun({
    id: runId, projectId, mode: "existing-data", status: "queued", createdBy: ACTOR_ID,
    dataCutoffAt: createdAt, idempotencyScope: `rollback-test:${runId}`, idempotencyKey: "create",
    createdAt, updatedAt: createdAt,
  });
  return runId;
}

test("disabled authoritative writes and database outages return 503 without a static write", async (t) => {
  let transactions = 0;
  let staticWrites = 0;
  const repository = {
    manualAlexaVoc: {},
    async findProjectById() { throw new ManualAlexaVocRepositoryError("connection"); },
    async transaction() {
      transactions += 1;
      throw new ManualAlexaVocRepositoryError("connection");
    },
  } as unknown as AgentRepository & ManualAlexaVocRepositoryCapability;
  const cipher = {
    encrypt() {
      staticWrites += 1;
      throw new Error("must not encrypt while writes are disabled");
    },
  } as unknown as ManualAlexaVocCipher;
  const disabledService = new ManualAlexaVocService({
    repository,
    cipher,
    writeEnabled: false,
    publicationEnabled: false,
  });
  const disabled = appFor(disabledService);
  t.after(() => disabled.close());

  const response = await disabled.inject({
    method: "POST",
    url: "/v1/manual-alexa-voc/import",
    headers: headers(),
    payload: { projectId: randomUUID(), runId: randomUUID(), asin: ASIN, marketplace: "US", rawText: REPORT },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(transactions, 0);
  assert.equal(staticWrites, 0);

  const unavailableService = new ManualAlexaVocService({
    repository,
    cipher: createManualAlexaVocCipher(keyring()),
    writeEnabled: true,
    publicationEnabled: true,
  });
  const unavailable = appFor(unavailableService);
  t.after(() => unavailable.close());
  const failed = await unavailable.inject({
    method: "POST",
    url: "/v1/manual-alexa-voc/import",
    headers: headers(),
    payload: { projectId: randomUUID(), runId: randomUUID(), asin: ASIN, marketplace: "US", rawText: REPORT },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(staticWrites, 0);
});

test("dynamic rollback is empty when owner legacy is denied and never masks a repository failure", async () => {
  let dynamicReads = 0;
  let legacyReads = 0;
  const deniedLegacy = {
    async readIfEligible() {
      legacyReads += 1;
      return { status: "ineligible" as const, reason: "owner_mismatch" as const };
    },
  };
  const disabled = new RepositoryVocSourceReader({
    manualVoc: {
      async listAtCutoff() {
        dynamicReads += 1;
        return [];
      },
    },
    legacySource: deniedLegacy,
    reviewSources: emptyReviewSources(),
    dynamicReadEnabled: false,
    legacyFallbackEnabled: true,
  });
  const empty = await disabled.read({
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asins: [ASIN],
    dataCutoffAt: "2026-08-31T09:10:11.123Z",
  });
  assert.equal(empty.recordCount, 0);
  assert.equal(empty.candidate, null);
  assert.equal(dynamicReads, 0);
  assert.equal(legacyReads, 1);

  const failing = new RepositoryVocSourceReader({
    manualVoc: {
      async listAtCutoff() {
        throw new ManualAlexaVocRepositoryError("connection");
      },
    },
    legacySource: deniedLegacy,
    reviewSources: emptyReviewSources(),
    dynamicReadEnabled: true,
    legacyFallbackEnabled: true,
  });
  const beforeFailureLegacyReads = legacyReads;
  await assert.rejects(
    failing.read({
      organizationId: ORGANIZATION_ID,
      marketplace: "US",
      asins: [ASIN],
      dataCutoffAt: "2026-08-31T09:10:11.123Z",
    }),
    ManualAlexaVocRepositoryError,
  );
  assert.equal(legacyReads, beforeFailureLegacyReads);
});

test("owner-approved stale rollback is explicitly labeled", async () => {
  const normalizedRecord = {
    asin: ASIN,
    attention: ["stale-attention"], positives: [], negatives: [], unmet: [],
    audiences: [], scenarios: [], motives: [], captureStatus: "dialog" as const,
    alexaReport: {
      title: "Stale owner-approved report", asin: ASIN, rating: 4.5, reviewCount: 10,
      prompt: "fixture prompt", overallConclusion: "stale conclusion", captureStatus: "dialog" as const,
    },
  };
  const reader = new RepositoryVocSourceReader({
    manualVoc: { async listAtCutoff() { return []; } },
    legacySource: {
      async readIfEligible() {
        return {
          status: "ready" as const,
          source: "legacy-static-stale" as const,
          contentHash: "a".repeat(64),
          record: {
            asin: ASIN, marketplace: "US" as const, revision: "1",
            contentHash: "a".repeat(64), normalizedRecord,
            source: "legacy-static-stale" as const, generation: "7",
            capturedAt: "2026-08-30T09:10:11.123Z",
          },
        };
      },
    },
    reviewSources: emptyReviewSources(),
    dynamicReadEnabled: false,
    legacyFallbackEnabled: true,
  });
  const result = await reader.read({
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asins: [ASIN],
    dataCutoffAt: "2026-08-31T09:10:11.123Z",
  });
  const alexa = result.candidate?.sources[0];
  assert.equal(alexa?.recordProvenance?.[0]?.source, "legacy-static-stale");
  assert.equal(alexa?.recordProvenance?.[0]?.generation, "7");
});

test("in-process import is immediate, refreshable, scope isolated, and run snapshots stay pinned", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-task12-e2e-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const projectId = randomUUID();
  const createdAt = "2026-08-31T08:00:00.000Z";
  await repository.createUser({
    id: ACTOR_ID, organizationId: ORGANIZATION_ID, email: "task12@example.test",
    displayName: "Task 12 actor", role: "member", status: "active", createdAt, updatedAt: createdAt,
  });
  await repository.createProject({
    id: projectId, organizationId: ORGANIZATION_ID, name: "Task 12 E2E",
    marketplace: "US", asins: [...PROJECT_ASINS], createdBy: ACTOR_ID, createdAt, updatedAt: createdAt,
  });
  const runId = await seedImportRun(repository, projectId);
  const service = new ManualAlexaVocService({
    repository,
    cipher: createManualAlexaVocCipher(keyring()),
    writeEnabled: true,
    publicationEnabled: true,
  });
  const app = appFor(service);
  t.after(() => app.close());

  const imported = await app.inject({
    method: "POST", url: "/v1/manual-alexa-voc/import", headers: headers(),
    payload: { projectId, runId, asin: ASIN, marketplace: "US", rawText: REPORT },
  });
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.json().disposition, "success");
  assert.equal(imported.json().normalization.status, "success");
  const firstRecord = imported.json().record as ManualAlexaVocRecord;

  let page = createManualVocOverlayState("session-a", ORGANIZATION_ID, 1, "US");
  page = reduceManualVoc(page, importSucceeded({
    sessionOrgEpoch: 1, requestGeneration: 1,
    scope: { organizationId: ORGANIZATION_ID, marketplace: "US" }, record: firstRecord,
  }));
  assert.equal(selectEffectiveVocByAsin(page, ORGANIZATION_ID, "US", ASIN)?.revision, "1");

  const listed = await app.inject({
    method: "GET", url: `/v1/manual-alexa-voc?projectId=${projectId}&marketplace=US&asins=${ASIN}`, headers: headers(),
  });
  assert.equal(listed.statusCode, 200);
  let refreshed = createManualVocOverlayState("session-a", ORGANIZATION_ID, 1, "US");
  refreshed = reduceManualVoc(refreshed, hydrationStarted({
    sessionOrgEpoch: 1, requestGeneration: 1,
    scope: { organizationId: ORGANIZATION_ID, marketplace: "US" }, asins: [ASIN],
  }));
  refreshed = reduceManualVoc(refreshed, hydrationSucceeded({
    sessionOrgEpoch: 1, requestGeneration: 1,
    scope: { organizationId: ORGANIZATION_ID, marketplace: "US" },
    requestedAsins: [ASIN], records: listed.json().records,
  }));
  assert.equal(selectEffectiveVocByAsin(refreshed, ORGANIZATION_ID, "US", ASIN)?.revision, "1");

  const staleEpoch = hydrationSucceeded({
    sessionOrgEpoch: 1, requestGeneration: 2,
    scope: { organizationId: ORGANIZATION_ID, marketplace: "US" },
    requestedAsins: [ASIN], records: [firstRecord],
  });
  const switchedSession = reduceManualVoc(refreshed, identityChanged("session-b", ORGANIZATION_ID, "US"));
  assert.equal(reduceManualVoc(switchedSession, staleEpoch), switchedSession);
  assert.equal(switchedSession.overlay.size, 0);
  const switchedOrg = reduceManualVoc(refreshed, identityChanged("session-a", randomUUID(), "US"));
  assert.equal(switchedOrg.overlay.size, 0);
  const switchedMarket = reduceManualVoc(refreshed, identityChanged("session-a", ORGANIZATION_ID, "CA"));
  assert.equal(switchedMarket.overlay.size, 0);

  const sourceReader = new RepositoryVocSourceReader({
    manualVoc: repository.manualAlexaVoc,
    legacySource: { async readIfEligible() { return { status: "missing" as const, reason: "not-found" as const }; } },
    reviewSources: emptyReviewSources(),
    dynamicReadEnabled: true,
    legacyFallbackEnabled: false,
  });
  const lifecycle = new AnalysisRunService({
    repository,
    executionContext: { actorId: ACTOR_ID, organizationId: ORGANIZATION_ID },
    sourceReader,
  });
  const firstRun = await lifecycle.createRunWithVocSnapshot({
    principal: principal(), projectId, mode: "existing-data", idempotencyKey: "task12-run-one",
  });
  assert.equal(provenanceRevision(firstRun.snapshot), "1");

  const secondImport = await app.inject({
    method: "POST", url: "/v1/manual-alexa-voc/import", headers: headers(),
    payload: { projectId, runId, asin: ASIN, marketplace: "US", rawText: `${REPORT.trimEnd()}\n补充说明：Task 12 revision two` },
  });
  assert.equal(secondImport.statusCode, 200);
  assert.equal(secondImport.json().record.revision, "2");
  const firstSnapshotBefore = await repository.findDataSnapshotById({
    actorOrganizationId: ORGANIZATION_ID, snapshotId: firstRun.snapshot.id,
  });
  const secondRun = await lifecycle.createRunWithVocSnapshot({
    principal: principal(), projectId, mode: "existing-data", idempotencyKey: "task12-run-two",
  });
  const firstSnapshotAfter = await repository.findDataSnapshotById({
    actorOrganizationId: ORGANIZATION_ID, snapshotId: firstRun.snapshot.id,
  });
  assert.equal(provenanceRevision(secondRun.snapshot), "2");
  assert.deepEqual(firstSnapshotAfter, firstSnapshotBefore);
});

test("disabled publication exposes no generation without undoing committed revisions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-task12-publication-off-"));
  const repository = openSqliteAgentRepository({ path: join(directory, "agent.sqlite"), busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const createdAt = "2026-08-31T08:00:00.000Z";
  await repository.createUser({
    id: ACTOR_ID, organizationId: ORGANIZATION_ID, email: "task12@example.test",
    displayName: "Task 12 actor", role: "member", status: "active", createdAt, updatedAt: createdAt,
  });
  const projectId = randomUUID();
  await repository.createProject({
    id: projectId, organizationId: ORGANIZATION_ID, name: "Publication disabled",
    marketplace: "US", asins: [...PROJECT_ASINS], createdBy: ACTOR_ID, createdAt, updatedAt: createdAt,
  });
  const runId = await seedImportRun(repository, projectId);
  const service = new ManualAlexaVocService({
    repository, cipher: createManualAlexaVocCipher(keyring()),
    writeEnabled: true, publicationEnabled: false,
  });
  const response = await service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: ACTOR_ID },
    request: { projectId, runId, asin: ASIN, marketplace: "US", rawText: REPORT },
  });
  assert.equal(response.disposition, "success");
  assert.equal(response.record?.generation, null);
  assert.equal((await repository.manualAlexaVoc.listCurrent({
    organizationId: ORGANIZATION_ID, marketplace: "US", asins: [ASIN],
  }))[0]?.revision, "1");
});

test("dynamic repository failure refuses a new realtime-dependent run", async () => {
  const repository = {
    manualAlexaVoc: {
      async listAtCutoff() { throw new ManualAlexaVocRepositoryError("connection"); },
    },
  } as unknown as AgentRepository & ManualAlexaVocRepositoryCapability;
  const reader = new RepositoryVocSourceReader({
    manualVoc: repository.manualAlexaVoc,
    legacySource: { async readIfEligible() { assert.fail("legacy must not mask a dynamic failure"); } },
    reviewSources: emptyReviewSources(),
    dynamicReadEnabled: true,
    legacyFallbackEnabled: true,
  });
  await assert.rejects(
    reader.read({
      organizationId: ORGANIZATION_ID, marketplace: "US", asins: [ASIN],
      dataCutoffAt: "2026-08-31T09:10:11.123Z",
    }),
    ManualAlexaVocRepositoryError,
  );
  await assert.rejects(
    Promise.reject(new ManualAlexaVocServiceError("unavailable", "dynamic source unavailable")),
    (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === "unavailable",
  );
});
