import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import { loadAnalysisExecutionContext } from "../../server/config";
import type { DataSnapshotRepository } from "../../server/db/data-snapshot-repository";
import type {
  AgentRepository,
  ManualAlexaVocRepositoryCapability,
  RuntimeAgentRepository,
} from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import { AnalysisLifecycleError } from "../../server/services/analysis-run-service";
import { JobAttemptWorkerLoop } from "../../server/runtime/worker-loop";
import { createDefaultLocalDataBridgeDeps } from "../../server/routes/local-data";
import {
  ApiErrorResponseSchema,
  CancelRunResponseSchema,
  CreateProjectResponseSchema,
  CreateRunResponseSchema,
  GetProjectResponseSchema,
  GetRunResponseSchema,
  RetryStageResponseSchema,
} from "../../shared/agent-contracts";

const now = "2026-08-14T08:00:00.000Z";
const actorId = "30000000-0000-4000-8000-000000000001";
const organizationId = "30000000-0000-4000-8000-000000000002";
const projectId = "30000000-0000-4000-8000-000000000003";
const proxyToken = "lifecycle-internal-proxy-token";
const trustedOrigin = "http://127.0.0.1:3001";
const securityEnv = {
  AGENT_SERVICE_PROXY_TOKEN: proxyToken,
  AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
};
const proxyHeaders = {
  origin: trustedOrigin,
  "x-agent-proxy-token": proxyToken,
};
const rawToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: {
    name: "__Host-agent_session",
    secure: true,
    maxAgeSeconds: 28_800,
  },
  sessionTtlMs: 28_800_000,
  loginLimiter: {
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 10_000,
  },
};

class FakeAuthService {
  constructor(
    readonly principal: Awaited<ReturnType<AuthenticationService["authenticate"]>>,
  ) {}

  async authenticate(token: string | null) {
    return token === rawToken ? this.principal : null;
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

function sessionHeaders(overrides: Record<string, string> = {}) {
  return {
    ...proxyHeaders,
    cookie: `__Host-agent_session=${rawToken}`,
    ...overrides,
  };
}

function memberPrincipal(userId = actorId, orgId = organizationId) {
  return {
    kind: "user" as const,
    userId,
    organizationId: orgId,
    email: "member@example.com",
    role: "member" as const,
    sessionId: "30000000-0000-4000-8000-000000000099",
  };
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-run-lifecycle-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<
    | Readonly<{ status: "fulfilled"; value: T }>
    | Readonly<{ status: "rejected"; reason: unknown }>
    | Readonly<{ status: "timed-out" }>
  >((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: "fulfilled", value });
      },
      (reason: unknown) => {
        clearTimeout(timer);
        resolve({ status: "rejected", reason });
      },
    );
  });
}

async function seedProject(repository: AgentRepository) {
  await repository.createUser({
    id: actorId,
    organizationId,
    email: "lifecycle@example.com",
    displayName: "Lifecycle test",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Durable analysis",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await repository.transaction(async (transactionRepository) => {
    const scoped = transactionRepository as AgentRepository &
      ManualAlexaVocRepositoryCapability;
    const asin = "B0ABC12345";
    const normalizedRecord = {
      asin,
      attention: ["durable build quality"],
      positives: ["easy to use"],
      negatives: ["limited fixture coverage"],
      unmet: ["more durable controls"],
      audiences: ["home users"],
      scenarios: ["daily use"],
      motives: ["replace an older product"],
      captureStatus: "dialog" as const,
      alexaReport: {
        title: "Lifecycle fixture report",
        asin,
        rating: 4.4,
        reviewCount: 25,
        prompt: "fixture prompt",
        overallConclusion: "Fixture conclusion",
      },
    };
    await scoped.manualAlexaVoc.lockScopes({
      organizationId,
      marketplace: "US",
      asins: [asin],
    });
    const expectedRevision = await scoped.manualAlexaVoc.peekNextRevision({
      organizationId,
      marketplace: "US",
      asin,
    });
    await scoped.manualAlexaVoc.put({
      organizationId,
      marketplace: "US",
      asin,
      createdBy: actorId,
      expectedRevision,
      normalizedRecord,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
      contentHash: canonicalJsonSha256(normalizedRecord),
      raw: {
        algVersion: "AES-256-GCM/v1",
        keyId: "analysis-run-lifecycle-test-key",
        wrappedDek: new Uint8Array(60).fill(1),
        nonce: new Uint8Array(12).fill(2),
        ciphertext: new Uint8Array(48).fill(3),
        tag: new Uint8Array(16).fill(4),
        aadSha256: canonicalJsonSha256({ organizationId, asin }),
        plaintextBytes: 48,
        plaintextSha256: canonicalJsonSha256("lifecycle fixture"),
      },
    });
  });
}

function idFactory(start = 100) {
  let next = start;
  return () =>
    `30000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function offsetIso(reference: string, milliseconds: number) {
  return new Date(Date.parse(reference) + milliseconds).toISOString();
}

function service(
  repository: AgentRepository &
    DataSnapshotRepository &
    ManualAlexaVocRepositoryCapability,
  idStart = 100,
) {
  return new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
    now: () => now,
    createId: idFactory(idStart),
  });
}

async function seedRetryableVocRun(
  repository: AgentRepository,
  suffix: string,
) {
  const runId = `31000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const trafficId = `32000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const vocId = `33000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const productId = `34000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const jobId = `35000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "partial",
    createdBy: actorId,
    dataCutoffAt: now,
    idempotencyScope: `retry-seed:${suffix}`,
    idempotencyKey: "seed",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: trafficId,
    runId,
    stage: "traffic-analysis",
    status: "succeeded",
    progress: 100,
    attemptCount: 1,
    startedAt: now,
    completedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: vocId,
    runId,
    stage: "voc-positioning",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: productId,
    runId,
    stage: "product-definition",
    status: "succeeded",
    progress: 100,
    attemptCount: 1,
    startedAt: now,
    completedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.enqueueJob({
    id: jobId,
    stageId: vocId,
    attemptNumber: 1,
    maxAttempts: 1,
    availableAt: now,
    createdAt: now,
  });
  const claimed = await repository.claimNextJob({
    ownerId: `failing-worker-${suffix}`,
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 30_000,
  });
  await repository.failJob({
    jobId: claimed!.id,
    ownerId: claimed!.leasedBy!,
    leaseGeneration: claimed!.leaseGeneration,
    failedAt: "2026-08-14T08:00:02.000Z",
    retryable: false,
    retryAt: null,
    error: {
      code: "UPSTREAM_PERMANENT",
      message: "Upstream data remained unavailable",
      requestId: `worker-${suffix}`,
    },
  });
  return { runId, trafficId, vocId, productId };
}

async function seedRetryableProductRun(
  repository: AgentRepository,
  suffix: string,
  vocStatus: "queued" | "succeeded",
) {
  const runId = `36000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const trafficId = `36100000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const vocId = `36200000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const productId = `36300000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const jobId = `36400000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "failed",
    createdBy: actorId,
    dataCutoffAt: now,
    idempotencyScope: `product-retry-seed:${suffix}`,
    idempotencyKey: "seed",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: trafficId,
    runId,
    stage: "traffic-analysis",
    status: "succeeded",
    progress: 100,
    attemptCount: 1,
    startedAt: now,
    completedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: vocId,
    runId,
    stage: "voc-positioning",
    status: vocStatus,
    progress: vocStatus === "succeeded" ? 100 : 0,
    attemptCount: vocStatus === "succeeded" ? 1 : 0,
    startedAt: vocStatus === "succeeded" ? now : null,
    completedAt: vocStatus === "succeeded" ? now : null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: productId,
    runId,
    stage: "product-definition",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.enqueueJob({
    id: jobId,
    stageId: productId,
    attemptNumber: 1,
    maxAttempts: 1,
    availableAt: now,
    createdAt: now,
  });
  const claimed = await repository.claimNextJob({
    ownerId: `product-worker-${suffix}`,
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed?.stageId, productId);
  await repository.failJob({
    jobId: claimed!.id,
    ownerId: claimed!.leasedBy!,
    leaseGeneration: claimed!.leaseGeneration,
    failedAt: "2026-08-14T08:00:02.000Z",
    retryable: false,
    retryAt: null,
    error: { classification: "upstream-permanent", message: "Failed product" },
  });
  return { productId, runId };
}

test("create run is atomic, idempotent, and enqueues only initially runnable stages", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const lifecycle = service(repository);

  const first = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "create-browser-request",
  });
  const repeated = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "create-browser-request",
  });

  assert.equal(repeated.run.id, first.run.id);
  assert.deepEqual(repeated.stages, first.stages);
  assert.equal(
    first.stages.some(({ stage }) => stage === "alexa-voc-normalization"),
    false,
  );
  assert.deepEqual(
    first.stages.map(({ stage, status }) => ({ stage, status })),
    [
      { stage: "traffic-analysis", status: "queued" },
      { stage: "voc-positioning", status: "queued" },
      { stage: "product-definition", status: "waiting-input" },
    ],
  );
  assert.deepEqual(
    await Promise.all(
      first.stages.map(async ({ id, stage }) => ({
        stage,
        attempts: (await repository.listJobAttempts(id)).length,
      })),
    ),
    [
      { stage: "traffic-analysis", attempts: 1 },
      { stage: "voc-positioning", attempts: 1 },
      { stage: "product-definition", attempts: 0 },
    ],
  );
});

test("concurrent create requests return one durable aggregate", async (t) => {
  const { directory, path } = temporaryDatabase();
  const firstRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  const secondRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    firstRepository.close();
    secondRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(firstRepository);

  const input = {
    mode: "existing-data" as const,
    idempotencyKey: "concurrent-create",
  };
  const [left, right] = await Promise.all([
    service(firstRepository, 100).createRun(projectId, input),
    service(secondRepository, 1_000).createRun(projectId, input),
  ]);

  assert.equal(left.run.id, right.run.id);
  assert.deepEqual(left.stages, right.stages);
  assert.equal((await firstRepository.listAnalysisRuns(projectId)).length, 1);
  assert.equal(
    (
      await Promise.all(
        left.stages.map(({ id }) => firstRepository.listJobAttempts(id)),
      )
    ).flat().length,
    2,
  );
});

test("get run restores the aggregate after SQLite closes and reopens", async (t) => {
  const { directory, path } = temporaryDatabase();
  const beforeRestart = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  await seedProject(beforeRestart);
  const created = await service(beforeRestart).createRun(projectId, {
    mode: "collect-missing",
    idempotencyKey: "refresh-recovery",
  });
  beforeRestart.close();

  const afterRestart = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    afterRestart.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(await service(afterRestart).getRun(created.run.id), created);
});

test("cancel is idempotent and preserves succeeded stages and attempts", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const lifecycle = service(repository);
  const created = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "cancel-idempotently",
  });
  const traffic = created.stages.find(
    ({ stage }) => stage === "traffic-analysis",
  )!;
  const trafficJob = await repository.claimNextJob({
    ownerId: "successful-worker",
    claimedAt: offsetIso(created.run.dataCutoffAt, 1_000),
    leaseDurationMs: 30_000,
  });
  assert.equal(trafficJob?.stageId, traffic.id);
  await repository.completeJob({
    jobId: trafficJob!.id,
    ownerId: "successful-worker",
    leaseGeneration: trafficJob!.leaseGeneration,
    completedAt: offsetIso(created.run.dataCutoffAt, 2_000),
  });

  const firstCancel = await lifecycle.cancelRun(created.run.id, "cancel-request");
  const repeatedCancel = await lifecycle.cancelRun(
    created.run.id,
    "repeated-cancel-request",
  );
  const restored = await lifecycle.getRun(created.run.id);

  assert.equal(firstCancel.run.status, "cancelled");
  assert.deepEqual(repeatedCancel, firstCancel);
  assert.deepEqual(
    restored.stages.map(({ stage, status }) => ({ stage, status })),
    [
      { stage: "traffic-analysis", status: "succeeded" },
      { stage: "voc-positioning", status: "cancelled" },
      { stage: "product-definition", status: "cancelled" },
    ],
  );
  assert.equal((await repository.listJobAttempts(traffic.id))[0]?.status, "succeeded");
  const voc = restored.stages.find(({ stage }) => stage === "voc-positioning")!;
  assert.equal((await repository.listJobAttempts(voc.id))[0]?.status, "cancelled");
});

test("cancel fences an in-flight worker from restoring succeeded state", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const lifecycle = service(repository);
  const created = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "cancel-worker-race",
  });

  let releaseHandler!: () => void;
  const handlerRelease = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const worker = new JobAttemptWorkerLoop({
    repository,
    ownerId: "racing-worker",
    handler: async () => {
      handlerStarted();
      await handlerRelease;
      return { status: "succeeded" };
    },
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10,
    stopTimeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
      jitterRatio: 0,
    },
  });

  const running = worker.runOnce();
  await started;
  await lifecycle.cancelRun(created.run.id, "cancel-race-request");
  releaseHandler();
  assert.equal(await running, true);

  const restored = await lifecycle.getRun(created.run.id);
  assert.equal(restored.run.status, "cancelled");
  assert.equal(
    restored.stages.find(({ stage }) => stage === "traffic-analysis")?.status,
    "cancelled",
  );
});

test("retry preserves the failed attempt and marks only successful downstream stale", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const seeded = await seedRetryableVocRun(repository, "1");

  const retried = await service(repository).retryStage(
    seeded.runId,
    "voc-positioning",
  );
  const restored = await service(repository).getRun(seeded.runId);
  const attempts = await repository.listJobAttempts(seeded.vocId);

  assert.equal(retried.stage.status, "queued");
  assert.equal(retried.attempt.attemptNumber, 2);
  assert.deepEqual(
    attempts.map(({ attemptNumber, status }) => ({ attemptNumber, status })),
    [
      { attemptNumber: 1, status: "failed" },
      { attemptNumber: 2, status: "queued" },
    ],
  );
  assert.deepEqual(
    restored.stages.map(({ stage, status, progress }) => ({
      stage,
      status,
      progress,
    })),
    [
      { stage: "traffic-analysis", status: "succeeded", progress: 100 },
      { stage: "voc-positioning", status: "queued", progress: 0 },
      { stage: "product-definition", status: "stale", progress: 100 },
    ],
  );
});

test("concurrent retry requests create one non-competing attempt", async (t) => {
  const { directory, path } = temporaryDatabase();
  const firstRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  const secondRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    firstRepository.close();
    secondRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(firstRepository);
  const seeded = await seedRetryableVocRun(firstRepository, "2");

  const results = await Promise.allSettled([
    service(firstRepository, 100).retryStage(seeded.runId, "voc-positioning"),
    service(secondRepository, 1_000).retryStage(
      seeded.runId,
      "voc-positioning",
    ),
  ]);

  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") {
    assert.ok(rejected.reason instanceof AnalysisLifecycleError);
    assert.equal(rejected.reason.statusCode, 409);
  }
  assert.deepEqual(
    (await firstRepository.listJobAttempts(seeded.vocId)).map(
      ({ attemptNumber }) => attemptNumber,
    ),
    [1, 2],
  );
});

test("product retry creates no attempt when VOC or keyword dependency is unavailable", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const missingVoc = await seedRetryableProductRun(repository, "10", "queued");
  const missingKeyword = await seedRetryableProductRun(
    repository,
    "11",
    "succeeded",
  );

  const withKeyword = new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async () => ({
        available: true,
        version: "keyword-v1",
      }),
    },
  });
  await assert.rejects(
    withKeyword.retryStage(missingVoc.runId, "product-definition"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );
  await assert.rejects(
    service(repository).retryStage(
      missingKeyword.runId,
      "product-definition",
    ),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );
  assert.equal(
    (await repository.listJobAttempts(missingVoc.productId)).length,
    1,
  );
  assert.equal(
    (await repository.listJobAttempts(missingKeyword.productId)).length,
    1,
  );
});

test("product retry is runnable when VOC and keyword dependencies are satisfied", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const seeded = await seedRetryableProductRun(repository, "12", "succeeded");
  const lifecycle = new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
    createId: idFactory(900),
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async (runId) =>
        runId === seeded.runId
          ? { available: true, version: "keyword-v1" }
          : { available: false, version: null },
    },
  });

  const retried = await lifecycle.retryStage(
    seeded.runId,
    "product-definition",
  );

  assert.equal(retried.attempt.attemptNumber, 2);
  assert.equal(retried.attempt.status, "queued");
  assert.deepEqual(
    (await repository.listJobAttempts(seeded.productId)).map(
      ({ attemptNumber }) => attemptNumber,
    ),
    [1, 2],
  );
});

test("pending product dependency lookup does not block a worker lease renewal", async (t) => {
  const { directory, path } = temporaryDatabase();
  const retryRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  const workerRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    retryRepository.close();
    workerRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(retryRepository);
  const seeded = await seedRetryableProductRun(
    retryRepository,
    "14",
    "succeeded",
  );
  const activeRun = await service(retryRepository, 1_300).createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "heartbeat-during-dependency-lookup",
  });
  const claimed = await workerRepository.claimNextJob({
    ownerId: "dependency-heartbeat-worker",
    claimedAt: offsetIso(activeRun.run.dataCutoffAt, 3_000),
    leaseDurationMs: 30_000,
  });
  assert.ok(claimed);

  const providerStarted = deferred<void>();
  const artifact = deferred<{
    readonly available: true;
    readonly version: string;
  }>();
  const lifecycle = new AnalysisRunService({
    repository: retryRepository,
    executionContext: { actorId, organizationId },
    createId: idFactory(1_400),
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async () => {
        providerStarted.resolve();
        return artifact.promise;
      },
    },
  });

  const retry = lifecycle.retryStage(seeded.runId, "product-definition");
  await providerStarted.promise;
  const renewal = workerRepository.renewJobLease({
    jobId: claimed.id,
    ownerId: "dependency-heartbeat-worker",
    leaseGeneration: claimed.leaseGeneration,
    renewedAt: offsetIso(activeRun.run.dataCutoffAt, 4_000),
    leaseDurationMs: 30_000,
  });
  let renewalResult:
    | Awaited<ReturnType<typeof settleWithin>>
    | undefined;
  try {
    renewalResult = await settleWithin(renewal, 250);
    assert.equal(renewalResult.status, "fulfilled");
  } finally {
    artifact.resolve({ available: true, version: "keyword-v1" });
    await Promise.allSettled([renewal, retry]);
  }

  assert.equal(renewalResult?.status, "fulfilled");
  assert.equal((await retry).attempt.attemptNumber, 2);
  assert.equal(
    (await retryRepository.listJobAttempts(seeded.productId)).length,
    2,
  );
  assert.equal(activeRun.run.status, "queued");
});

test("product retry revalidates cancellation after dependency lookup", async (t) => {
  const { directory, path } = temporaryDatabase();
  const retryRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  const cancelRepository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    retryRepository.close();
    cancelRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(retryRepository);
  const seeded = await seedRetryableProductRun(
    retryRepository,
    "15",
    "succeeded",
  );
  const providerStarted = deferred<void>();
  const artifact = deferred<{
    readonly available: true;
    readonly version: string;
  }>();
  const retry = new AnalysisRunService({
    repository: retryRepository,
    executionContext: { actorId, organizationId },
    createId: idFactory(1_500),
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async () => {
        providerStarted.resolve();
        return artifact.promise;
      },
    },
  }).retryStage(seeded.runId, "product-definition");
  await providerStarted.promise;

  const cancel = service(cancelRepository, 1_600).cancelRun(
    seeded.runId,
    "cancel-during-dependency-lookup",
  );
  let cancelResult:
    | Awaited<ReturnType<typeof settleWithin>>
    | undefined;
  try {
    cancelResult = await settleWithin(cancel, 250);
    assert.equal(cancelResult.status, "fulfilled");
  } finally {
    artifact.resolve({ available: true, version: "keyword-v1" });
    await Promise.allSettled([cancel, retry]);
  }

  await assert.rejects(
    retry,
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );
  assert.equal(cancelResult?.status, "fulfilled");
  assert.equal(
    (await retryRepository.listJobAttempts(seeded.productId)).length,
    1,
  );
  assert.equal(
    (await retryRepository.findAnalysisRun(seeded.runId))?.status,
    "cancelled",
  );
});

test("available keyword dependency requires a non-empty immutable version", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const seeded = await seedRetryableProductRun(repository, "16", "succeeded");
  const lifecycle = new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async () => ({ available: true, version: "" }),
    },
  });

  await assert.rejects(
    lifecycle.retryStage(seeded.runId, "product-definition"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 503 &&
      error.message === "Dependency state is unavailable",
  );
  assert.equal(
    (await repository.listJobAttempts(seeded.productId)).length,
    1,
  );
});

test("dependency provider failures are normalized without exposing provider text", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const seeded = await seedRetryableProductRun(repository, "17", "succeeded");
  const lifecycle = new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async () => {
        throw new Error("secret-provider-endpoint-and-token");
      },
    },
  });

  await assert.rejects(
    lifecycle.retryStage(seeded.runId, "product-definition"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 503 &&
      error.message === "Dependency state is unavailable" &&
      !String(error).includes("secret-provider-endpoint-and-token"),
  );
  assert.equal(
    (await repository.listJobAttempts(seeded.productId)).length,
    1,
  );
});

test("retry preflight does not call dependency provider for unauthorized or missing runs", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const seeded = await seedRetryableProductRun(repository, "18", "succeeded");
  let providerCalls = 0;
  const provider = {
    getKeywordAnalysisArtifact: async () => {
      providerCalls += 1;
      return { available: true as const, version: "keyword-v1" };
    },
  };
  const unauthorized = new AnalysisRunService({
    repository,
    executionContext: {
      actorId: "30000000-0000-4000-8000-000000000418",
      organizationId,
    },
    dependencyStateProvider: provider,
  });
  const authorized = new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
    dependencyStateProvider: provider,
  });

  await assert.rejects(
    unauthorized.retryStage(seeded.runId, "product-definition"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 403,
  );
  await assert.rejects(
    authorized.retryStage(
      "39999999-9999-4999-8999-999999999999",
      "product-definition",
    ),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 404,
  );
  assert.equal(providerCalls, 0);
});

test("lifecycle routes validate shared contracts and use only server execution context", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedProject(repository);
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    executionContext: { actorId, organizationId },
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal())),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const project = await app.inject({
    method: "GET",
    url: `/v1/projects/${projectId}`,
    headers: sessionHeaders(),
  });
  assert.equal(project.statusCode, 200);
  assert.equal(GetProjectResponseSchema.safeParse(project.json()).success, true);

  const rejectedIdentity = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/runs`,
    headers: {
      ...sessionHeaders(),
      "x-request-id": "identity-validation-request",
    },
    payload: {
      mode: "existing-data",
      idempotencyKey: "must-not-create",
      actorId: "39000000-0000-4000-8000-000000000001",
    },
  });
  assert.equal(rejectedIdentity.statusCode, 400);
  assert.equal(
    ApiErrorResponseSchema.safeParse(rejectedIdentity.json()).success,
    true,
  );
  assert.equal(rejectedIdentity.json().error.requestId, "identity-validation-request");

  const rejectedCutoff = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/runs`,
    headers: {
      ...sessionHeaders(),
      "x-request-id": "cutoff-validation-request",
    },
    payload: {
      mode: "existing-data",
      idempotencyKey: "must-not-own-cutoff",
      dataCutoffAt: "2026-08-14T07:00:00.000Z",
    },
  });
  assert.equal(rejectedCutoff.statusCode, 400);
  assert.equal(
    ApiErrorResponseSchema.safeParse(rejectedCutoff.json()).success,
    true,
  );
  assert.equal(rejectedCutoff.json().error.requestId, "cutoff-validation-request");
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 0);

  const create = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/runs`,
    headers: { ...sessionHeaders(), "x-request-id": "create-route-request" },
    payload: {
      mode: "existing-data",
      idempotencyKey: "route-create",
    },
  });
  assert.equal(create.statusCode, 200);
  assert.equal(CreateRunResponseSchema.safeParse(create.json()).success, true);
  assert.equal(create.json().run.createdBy, actorId);
  const runId = create.json().run.id as string;

  const conflictingProjectId = "30000000-0000-4000-8000-000000000088";
  await repository.createProject({
    id: conflictingProjectId,
    organizationId,
    name: "Conflicting idempotency scope",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  const conflict = await app.inject({
    method: "POST",
    url: `/v1/projects/${conflictingProjectId}/runs`,
    headers: { ...sessionHeaders(), "x-request-id": "run-key-conflict" },
    payload: {
      mode: "existing-data",
      idempotencyKey: "route-create",
    },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(conflict.json().error.requestId, "run-key-conflict");

  const get = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}`,
    headers: sessionHeaders(),
  });
  assert.equal(get.statusCode, 200);
  assert.equal(GetRunResponseSchema.safeParse(get.json()).success, true);

  const cancel = await app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/cancel`,
    headers: { ...sessionHeaders(), "x-request-id": "cancel-route-request" },
    payload: {},
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(CancelRunResponseSchema.safeParse(cancel.json()).success, true);
  assert.equal(cancel.json().run.status, "cancelled");

  const seeded = await seedRetryableVocRun(repository, "3");
  const retry = await app.inject({
    method: "POST",
    url: `/v1/runs/${seeded.runId}/stages/voc-positioning/retry`,
    headers: sessionHeaders(),
    payload: {},
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(RetryStageResponseSchema.safeParse(retry.json()).success, true);
});

test("run creation route maps transaction storage failures to a stable typed 503", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const transactionError = new Error(
    "secret database host, role, schema, and transaction detail",
  );
  transactionError.name = "RunCreationTransactionStoreError";
  const failingRepository = new Proxy(
    repository as unknown as RuntimeAgentRepository,
    {
      get(target, property, receiver) {
        if (property === "transaction") {
          return () => Promise.reject(transactionError);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    },
  );
  const app = buildAgentApp({
    env: securityEnv,
    repository: failingRepository,
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal())),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/runs`,
    headers: { ...sessionHeaders(), "x-request-id": "storage-failure-route" },
    payload: {
      mode: "existing-data",
      idempotencyKey: "storage-failure",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: {
      code: "INFRASTRUCTURE_ERROR",
      message: "Analysis run storage is unavailable",
      requestId: "storage-failure-route",
    },
  });
  assert.doesNotMatch(response.body, /secret database host|role|schema|transaction/);
});

test("an authenticated local workspace registration makes the same project identity eligible for scoped sync", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await repository.createUser({
    id: actorId,
    organizationId,
    email: "lifecycle@example.com",
    displayName: "Lifecycle test",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const workspaceId = "a081d838-ffcb-4e36-b4ad-e38937f7336a";
  const workspaceAsins = ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"];
  const capturedScopes: Array<Record<string, unknown>> = [];
  const localDataBridgeDeps = createDefaultLocalDataBridgeDeps(repository);
  localDataBridgeDeps.startAsinSyncJob = async (input) => {
    capturedScopes.push(input);
    return {
      job: {
        jobId: "registered-project-sync",
        jobVersion: 1,
        asins: workspaceAsins,
        marketplace: "US",
        status: "queued",
        message: "Queued",
        currentStageId: "catalog",
        stages: [],
        asinProgress: {},
        createdAt: now,
        updatedAt: now,
        scope: {
          organizationId,
          projectId: workspaceId,
          runId: null,
          marketplace: "US",
          asins: workspaceAsins,
          actorId,
        },
      },
      reused: false,
      mcpAsinsPending: [],
      estimatedAutoSeconds: 0,
      estimatedAlexaSeconds: 0,
    };
  };
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal())),
    localDataBridgeDeps,
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const registered = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders(),
    payload: {
      id: workspaceId,
      name: "Kick Scooters 3ASIN 真实验收",
      marketplace: "US",
      asins: workspaceAsins,
    },
  });
  assert.equal(registered.statusCode, 201);
  assert.equal(CreateProjectResponseSchema.safeParse(registered.json()).success, true);
  assert.equal(registered.json().project.id, workspaceId);
  assert.equal(registered.json().project.organizationId, organizationId);
  assert.equal(registered.json().project.createdBy, actorId);

  const repeated = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders(),
    payload: {
      id: workspaceId,
      name: "Kick Scooters 3ASIN 真实验收",
      marketplace: "US",
      asins: workspaceAsins,
    },
  });
  assert.equal(repeated.statusCode, 200);
  assert.deepEqual(repeated.json(), registered.json());

  const spoofedOwnership = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders(),
    payload: {
      id: workspaceId,
      name: "Kick Scooters 3ASIN 真实验收",
      marketplace: "US",
      asins: workspaceAsins,
      organizationId: "30000000-0000-4000-8000-000000000777",
      createdBy: "30000000-0000-4000-8000-000000000778",
    },
  });
  assert.equal(spoofedOwnership.statusCode, 400);
  assert.equal((await repository.findProjectById(workspaceId))?.createdBy, actorId);

  const otherActorId = "30000000-0000-4000-8000-000000000779";
  const otherOrganizationId = "30000000-0000-4000-8000-000000000780";
  await repository.createUser({
    id: otherActorId,
    organizationId: otherOrganizationId,
    email: "other-lifecycle@example.com",
    displayName: "Other lifecycle test",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const otherApp = buildAgentApp({
    env: securityEnv,
    repository,
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal(otherActorId, otherOrganizationId))),
  });
  t.after(() => otherApp.close());
  const crossTenant = await otherApp.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders(),
    payload: {
      id: workspaceId,
      name: "Kick Scooters 3ASIN 真实验收",
      marketplace: "US",
      asins: workspaceAsins,
    },
  });
  assert.equal(crossTenant.statusCode, 404);
  assert.equal((await repository.findProjectById(workspaceId))?.organizationId, organizationId);
  assert.equal((await repository.findProjectById(workspaceId))?.createdBy, actorId);

  const conflicting = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders(),
    payload: {
      id: workspaceId,
      name: "Conflicting replacement",
      marketplace: "US",
      asins: workspaceAsins,
    },
  });
  assert.equal(conflicting.statusCode, 409);
  assert.equal((await repository.findProjectById(workspaceId))?.name, "Kick Scooters 3ASIN 真实验收");
  assert.equal((await repository.findProjectById(workspaceId))?.createdBy, actorId);

  const sync = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: sessionHeaders(),
    payload: {
      asins: workspaceAsins,
      marketplace: "US",
      projectId: workspaceId,
    },
  });
  assert.equal(sync.statusCode, 202);
  assert.equal(capturedScopes.length, 1);
  assert.equal(capturedScopes[0]?.projectId, workspaceId);
  assert.equal(capturedScopes[0]?.organizationId, organizationId);
});

test("lifecycle routes require an active session before domain work", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedProject(repository);
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    executionContext: { actorId, organizationId },
    authConfig,
    authService: asAuthService(new FakeAuthService(null)),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/runs`,
    headers: proxyHeaders,
    payload: {
      mode: "existing-data",
      idempotencyKey: "missing-session-must-not-create",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 0);
});

test("authenticated lifecycle routes derive actor and organization from the session principal", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedProject(repository);
  const staticActorId = "30000000-0000-4000-8000-000000000501";
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    executionContext: { actorId: staticActorId, organizationId },
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal())),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/runs`,
    headers: sessionHeaders(),
    payload: {
      mode: "existing-data",
      idempotencyKey: "principal-derived-context",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().run.createdBy, actorId);
  assert.notEqual(response.json().run.createdBy, staticActorId);
});

test("lifecycle routes return contract-safe auth, 404, and 409 errors with request IDs", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedProject(repository);
  const seeded = await seedRetryableVocRun(repository, "4");
  const dependencyBlocked = await seedRetryableProductRun(
    repository,
    "13",
    "succeeded",
  );
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    executionContext: { actorId, organizationId },
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal())),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const firstRetry = await app.inject({
    method: "POST",
    url: `/v1/runs/${seeded.runId}/stages/voc-positioning/retry`,
    headers: sessionHeaders(),
    payload: {},
  });
  assert.equal(firstRetry.statusCode, 200);

  const cases = [
    {
      response: await app.inject({
        method: "GET",
        url: `/v1/runs/${seeded.runId}`,
        headers: { origin: trustedOrigin, "x-request-id": "auth-request" },
      }),
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      requestId: "auth-request",
    },
    {
      response: await app.inject({
        method: "GET",
        url: "/v1/runs/39999999-9999-4999-8999-999999999999",
        headers: { ...sessionHeaders(), "x-request-id": "missing-request" },
      }),
      status: 404,
      code: "NOT_FOUND",
      requestId: "missing-request",
    },
    {
      response: await app.inject({
        method: "POST",
        url: `/v1/runs/${seeded.runId}/stages/voc-positioning/retry`,
        headers: { ...sessionHeaders(), "x-request-id": "conflict-request" },
        payload: {},
      }),
      status: 409,
      code: "CONFLICT",
      requestId: "conflict-request",
    },
    {
      response: await app.inject({
        method: "POST",
        url: `/v1/runs/${dependencyBlocked.runId}/stages/product-definition/retry`,
        headers: { ...sessionHeaders(), "x-request-id": "dependency-request" },
        payload: {},
      }),
      status: 409,
      code: "CONFLICT",
      requestId: "dependency-request",
    },
  ];

  for (const item of cases) {
    assert.equal(item.response.statusCode, item.status);
    assert.equal(ApiErrorResponseSchema.safeParse(item.response.json()).success, true);
    assert.equal(item.response.json().error.code, item.code);
    assert.equal(item.response.json().error.requestId, item.requestId);
  }
  assert.equal(
    (await repository.listJobAttempts(dependencyBlocked.productId)).length,
    1,
  );
});

test("invalid execution context returns a contract-safe 403 with request ID", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedProject(repository);
  const created = await service(repository).createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "invalid-context-route",
  });
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    executionContext: {
      actorId,
      organizationId,
    },
    authConfig,
    authService: asAuthService(new FakeAuthService(
      memberPrincipal("30000000-0000-4000-8000-000000000408"),
    )),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: `/v1/runs/${created.run.id}`,
    headers: { ...sessionHeaders(), "x-request-id": "invalid-context-request" },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(ApiErrorResponseSchema.safeParse(response.json()).success, true);
  assert.deepEqual(response.json(), {
    error: {
      code: "FORBIDDEN",
      message: "Execution context is not authorized",
      requestId: "invalid-context-request",
    },
  });
});

test("dependency provider failures return a safe shared-contract error", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedProject(repository);
  const seeded = await seedRetryableProductRun(repository, "19", "succeeded");
  const app = buildAgentApp({
    env: securityEnv,
    repository,
    executionContext: { actorId, organizationId },
    authConfig,
    authService: asAuthService(new FakeAuthService(memberPrincipal())),
    dependencyStateProvider: {
      getKeywordAnalysisArtifact: async () => {
        throw new Error("secret-provider-host-and-token");
      },
    },
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: `/v1/runs/${seeded.runId}/stages/product-definition/retry`,
    headers: { ...sessionHeaders(), "x-request-id": "provider-failure-request" },
    payload: {},
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: {
      code: "CONFIGURATION_ERROR",
      message: "Dependency state is unavailable",
      requestId: "provider-failure-request",
    },
  });
  assert.doesNotMatch(response.body, /secret-provider-host-and-token/);
  assert.equal(
    (await repository.listJobAttempts(seeded.productId)).length,
    1,
  );
});

test("run aggregation and safe stage errors survive repository reopen", async (t) => {
  const { directory, path } = temporaryDatabase();
  const beforeRestart = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  await seedProject(beforeRestart);
  const lifecycle = service(beforeRestart);
  const created = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "aggregate-partial",
  });

  const traffic = await beforeRestart.claimNextJob({
    ownerId: "traffic-worker",
    claimedAt: offsetIso(created.run.dataCutoffAt, 1_000),
    leaseDurationMs: 30_000,
  });
  await beforeRestart.failJob({
    jobId: traffic!.id,
    ownerId: "traffic-worker",
    leaseGeneration: traffic!.leaseGeneration,
    failedAt: offsetIso(created.run.dataCutoffAt, 2_000),
    retryable: false,
    retryAt: null,
    error: {
      classification: "upstream-permanent",
      message: "Configured source could not provide data",
    },
  });
  const voc = await beforeRestart.claimNextJob({
    ownerId: "voc-worker",
    claimedAt: offsetIso(created.run.dataCutoffAt, 3_000),
    leaseDurationMs: 30_000,
  });
  await beforeRestart.completeJob({
    jobId: voc!.id,
    ownerId: "voc-worker",
    leaseGeneration: voc!.leaseGeneration,
    completedAt: offsetIso(created.run.dataCutoffAt, 4_000),
  });
  beforeRestart.close();

  const afterRestart = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    afterRestart.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const restored = await service(afterRestart).getRun(created.run.id);

  assert.equal(restored.run.status, "partial");
  const failedTraffic = restored.stages.find(
    ({ stage }) => stage === "traffic-analysis",
  )!;
  assert.equal(failedTraffic.status, "failed");
  assert.equal(failedTraffic.lastError?.code, "UPSTREAM_PERMANENT");
  assert.match(failedTraffic.lastError?.requestId ?? "", /^worker-stage:/);
  assert.equal(GetRunResponseSchema.safeParse(restored).success, true);
});

test("retry rejects non-rerunnable waiting, budget, and running stages", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const lifecycle = service(repository);
  const created = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "non-failed-retry",
  });
  const traffic = await repository.claimNextJob({
    ownerId: "waiting-worker",
    claimedAt: offsetIso(created.run.dataCutoffAt, 1_000),
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    lifecycle.retryStage(created.run.id, "traffic-analysis"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );
  await repository.failJob({
    jobId: traffic!.id,
    ownerId: "waiting-worker",
    leaseGeneration: traffic!.leaseGeneration,
    failedAt: offsetIso(created.run.dataCutoffAt, 2_000),
    retryable: false,
    retryAt: null,
    stageStatus: "waiting-input",
    error: { classification: "authentication", message: "Input required" },
  });
  await assert.rejects(
    lifecycle.retryStage(created.run.id, "traffic-analysis"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );

  const voc = await repository.claimNextJob({
    ownerId: "budget-worker",
    claimedAt: offsetIso(created.run.dataCutoffAt, 3_000),
    leaseDurationMs: 30_000,
  });
  await repository.failJob({
    jobId: voc!.id,
    ownerId: "budget-worker",
    leaseGeneration: voc!.leaseGeneration,
    failedAt: offsetIso(created.run.dataCutoffAt, 4_000),
    retryable: false,
    retryAt: null,
    stageStatus: "budget-exceeded",
    error: { classification: "configuration", message: "Budget exhausted" },
  });
  await assert.rejects(
    lifecycle.retryStage(created.run.id, "voc-positioning"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );
  await assert.rejects(
    lifecycle.retryStage(created.run.id, "product-definition"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 409,
  );
});

test("server execution context is explicit, validated, and absent by default", () => {
  assert.equal(loadAnalysisExecutionContext({}), null);
  assert.deepEqual(
    loadAnalysisExecutionContext({
      AGENT_EXECUTION_ACTOR_ID: actorId,
      AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
    }),
    { actorId, organizationId },
  );
  assert.throws(
    () =>
      loadAnalysisExecutionContext({
        AGENT_EXECUTION_ACTOR_ID: "browser-member",
        AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
      }),
    /uuid/i,
  );
  assert.throws(
    () =>
      loadAnalysisExecutionContext({
        AGENT_EXECUTION_ACTOR_ID: actorId,
      }),
    /both be configured/i,
  );
});

test("a missing execution actor cannot create or read lifecycle data", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const legitimate = await service(repository).createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "legitimate-missing-actor-check",
  });
  const unauthorized = new AnalysisRunService({
    repository,
    executionContext: {
      actorId: "30000000-0000-4000-8000-000000000404",
      organizationId,
    },
    createId: idFactory(1_100),
  });

  for (const operation of [
    () =>
      unauthorized.createRun(projectId, {
        mode: "existing-data",
        idempotencyKey: "missing-actor-must-not-create",
      }),
    () => unauthorized.getRun(legitimate.run.id),
  ]) {
    await assert.rejects(
      operation(),
      (error: unknown) =>
        error instanceof AnalysisLifecycleError &&
        error.statusCode === 403 &&
        error.message === "Execution context is not authorized",
    );
  }
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 1);
});

test("a disabled execution actor cannot cancel or read lifecycle data", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const legitimate = await service(repository).createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "legitimate-disabled-actor-check",
  });
  const disabledActorId = "30000000-0000-4000-8000-000000000405";
  await repository.createUser({
    id: disabledActorId,
    organizationId,
    email: "disabled-lifecycle@example.com",
    displayName: "Disabled lifecycle actor",
    role: "member",
    status: "disabled",
    createdAt: now,
    updatedAt: now,
  });
  const unauthorized = new AnalysisRunService({
    repository,
    executionContext: { actorId: disabledActorId, organizationId },
  });

  await assert.rejects(
    unauthorized.cancelRun(legitimate.run.id),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 403 &&
      error.message === "Execution context is not authorized",
  );
  await assert.rejects(
    unauthorized.getRun(legitimate.run.id),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 403 &&
      error.message === "Execution context is not authorized",
  );
  assert.notEqual(
    (await repository.findAnalysisRun(legitimate.run.id))?.status,
    "cancelled",
  );
});

test("a cross-organization execution actor cannot retry or read lifecycle data", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const seeded = await seedRetryableVocRun(repository, "20");
  const foreignActorId = "30000000-0000-4000-8000-000000000406";
  await repository.createUser({
    id: foreignActorId,
    organizationId: "30000000-0000-4000-8000-000000000407",
    email: "foreign-lifecycle@example.com",
    displayName: "Foreign lifecycle actor",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const unauthorized = new AnalysisRunService({
    repository,
    executionContext: { actorId: foreignActorId, organizationId },
    createId: idFactory(1_200),
  });

  await assert.rejects(
    unauthorized.retryStage(seeded.runId, "voc-positioning"),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 403 &&
      error.message === "Execution context is not authorized",
  );
  await assert.rejects(
    unauthorized.getRun(seeded.runId),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 403 &&
      error.message === "Execution context is not authorized",
  );
  assert.equal((await repository.listJobAttempts(seeded.vocId)).length, 1);
});

test("organization-wide idempotency replays the original actor's run", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const secondActorId = "30000000-0000-4000-8000-000000000099";
  await repository.createUser({
    id: secondActorId,
    organizationId,
    email: "second-actor@example.com",
    displayName: "Second actor",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const first = await service(repository).createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "actor-scoped-key",
  });
  const second = await new AnalysisRunService({
    repository,
    executionContext: { actorId: secondActorId, organizationId },
    now: () => now,
    createId: idFactory(500),
  }).createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "actor-scoped-key",
  });

  assert.equal(first.run.id, second.run.id);
  assert.equal(second.run.createdBy, actorId);
  assert.equal(second.run.dataCutoffAt, first.run.dataCutoffAt);
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 1);
});

test("releasing a lease restores a persisted queued run aggregate", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedProject(repository);
  const lifecycle = service(repository);
  const created = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    idempotencyKey: "lease-release-aggregate",
  });
  const claimed = await repository.claimNextJob({
    ownerId: "stopping-worker",
    claimedAt: offsetIso(created.run.dataCutoffAt, 1_000),
    leaseDurationMs: 30_000,
  });
  assert.equal((await lifecycle.getRun(created.run.id)).run.status, "running");

  await repository.releaseJobLease({
    jobId: claimed!.id,
    ownerId: "stopping-worker",
    leaseGeneration: claimed!.leaseGeneration,
    releasedAt: offsetIso(created.run.dataCutoffAt, 2_000),
  });

  assert.equal((await lifecycle.getRun(created.run.id)).run.status, "queued");
});

test("VOC inventory GET is authorized, read-only and validates selected scope", async t => {
 const repository=openSqliteAgentRepository({path:":memory:",busyTimeoutMs:5000});await seedProject(repository);
 const baseRunId="80000000-0000-4000-8000-000000000001";
 const project=(await repository.findProjectById(projectId))!;
 await repository.createAnalysisRun({id:baseRunId,projectId,createdBy:actorId,mode:"existing-data",status:"succeeded",dataCutoffAt:now,idempotencyScope:`sync:${organizationId}:${projectId}`,idempotencyKey:"inventory-job",createdAt:now,updatedAt:now});
 let reads=0,writes=0;
 const wrap=(target: typeof repository): typeof repository=>new Proxy(target,{get(target,key){
  if(key==="syncJobs")return {findById:async()=>({jobId:"inventory-job",organizationId,projectId,runId:baseRunId,marketplace:"US",asins:project.asins}),readStageOutput:async()=>{reads++;return null;}};
  if(key==="transaction")return (fn:(repo:typeof repository)=>Promise<unknown>)=>target.transaction(transaction=>fn(wrap(transaction as typeof repository)));
  if(typeof key==="string" && /^(create|update|enqueue|publish|complete|delete)/.test(key))return ()=>{writes++;throw new Error("GET attempted mutation");};
  const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
 }});
 const app=buildAgentApp({env:securityEnv,repository:wrap(repository) as never,executionContext:{actorId,organizationId},authConfig,authService:asAuthService(new FakeAuthService(memberPrincipal()))});
 t.after(async()=>{await app.close();repository.close();});
 const url=`/v1/projects/${projectId}/voc-inputs?baseSyncRunId=${baseRunId}&asins=${project.asins[0]}`;
 assert.equal((await app.inject({method:"GET",url,headers:proxyHeaders})).statusCode,401);
 for(let i=0;i<2;i++){const response=await app.inject({method:"GET",url,headers:sessionHeaders()});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().manual.keywords.state,"missing");}
 assert.equal(writes,0);assert.equal(reads,4);
 assert.equal((await app.inject({method:"GET",url:url+","+project.asins[0],headers:sessionHeaders()})).statusCode,400);
 assert.equal((await app.inject({method:"GET",url:url.replace(projectId,"80000000-0000-4000-8000-000000000002"),headers:sessionHeaders()})).statusCode,404);
});
