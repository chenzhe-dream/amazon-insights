import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadVocPositioningRuntimeConfig,
  type VocPositioningRuntimeConfig,
} from "../../server/config";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import type { ModelProvider } from "../../server/runtime/model-provider";
import { createVocPositioningRuntime } from "../../server/runtime/voc-positioning-runtime";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";

function runtimeConfig(): VocPositioningRuntimeConfig {
  return {
    apiKey: "fake-test-key",
    providerName: "openai",
    model: {
      name: "configured-test-model",
      estimatedInputTokens: 4_000,
      maxOutputTokens: 4_000,
      timeoutMs: 5_000,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
      },
    },
    budgetLimits: {
      call: { maxTokens: 50_000, maxCostMicros: 50_000 },
      run: { maxTokens: 50_000, maxCostMicros: 50_000 },
      organizationUtcDay: { maxTokens: 50_000, maxCostMicros: 50_000 },
    },
    worker: {
      ownerId: "formal-voc-runtime",
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
      pollIntervalMs: 10,
      stopTimeoutMs: 1_000,
      retryPolicy: {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
    },
  };
}

test("runtime configuration fails closed unless provider, model, pricing, budget and owner are complete", () => {
  assert.throws(
    () => loadVocPositioningRuntimeConfig({}),
    /OPENAI_API_KEY.*AGENT_VOC_MODEL/,
  );
  assert.throws(
    () => loadVocPositioningRuntimeConfig({ OPENAI_API_KEY: "secret-only" }),
    /VOC positioning runtime configuration is incomplete or invalid/,
  );
  const configured = loadVocPositioningRuntimeConfig({
    OPENAI_API_KEY: "configured-key",
    AGENT_VOC_MODEL: "configured-model",
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "4000",
    AGENT_VOC_TIMEOUT_MS: "5000",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "2",
    AGENT_VOC_CALL_MAX_TOKENS: "50000",
    AGENT_VOC_CALL_MAX_COST_MICROS: "50000",
    AGENT_VOC_RUN_MAX_TOKENS: "50000",
    AGENT_VOC_RUN_MAX_COST_MICROS: "50000",
    AGENT_VOC_DAILY_MAX_TOKENS: "50000",
    AGENT_VOC_DAILY_MAX_COST_MICROS: "50000",
    AGENT_VOC_WORKER_OWNER_ID: "configured-worker",
  });
  assert.equal(configured.model.name, "configured-model");
  assert.equal(configured.worker.ownerId, "configured-worker");
});

test("formal composition root starts from a queued job, publishes a report, and stops boundedly", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-runtime-"));
  const databasePath = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const trafficStageId = randomUUID();
  const stageId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Runtime actor",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Runtime project",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "running",
    createdBy: actorId,
    dataCutoffAt: CUTOFF,
    idempotencyScope: `runtime:${runId}`,
    idempotencyKey: "create",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: trafficStageId,
    runId,
    stage: "traffic-analysis",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  await repository.enqueueJob({
    id: randomUUID(),
    stageId: trafficStageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: "2026-08-15T00:00:00.000Z",
    createdAt: "2026-08-15T00:00:00.000Z",
  });
  await repository.createRunStage({
    id: stageId,
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
  await repository.enqueueJob({
    id: randomUUID(),
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
  });
  const snapshotRecord = realVocSnapshot(SCOOTER_ASINS, snapshotId, runId);
  const { id: _id, runId: _runId, createdAt: _createdAt, ...candidate } = snapshotRecord;
  const snapshot = await repository.createDataSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: snapshotId,
    createdAt: now,
    candidate,
  });
  void _id;
  void _runId;
  void _createdAt;
  const output = validVocPositioningOutput(preprocessVocSnapshot(snapshot.snapshot));
  let calls = 0;
  const provider: ModelProvider = {
    async generateStructured<T>() {
      calls += 1;
      return {
        value: output as T,
        responseId: "formal-runtime-response",
        inputTokens: 500,
        outputTokens: 250,
      };
    },
  };
  const runtime = await createVocPositioningRuntime({
    repository,
    config: runtimeConfig(),
    provider,
    providerName: "fake",
  });

  runtime.start();
  await waitFor(async () =>
    (await repository.findRunStage(stageId))?.status === "succeeded",
  );
  await Promise.race([
    runtime.stop(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("runtime stop exceeded bound")), 2_000),
    ),
  ]);

  assert.equal(calls, 1);
  assert.equal((await repository.findRunStage(trafficStageId))?.status, "queued");
  assert.equal((await repository.listAnalysisReports({
    actorOrganizationId: organizationId,
    runId,
    stage: "voc-positioning",
  })).length, 1);
});

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for formal VOC runtime");
}
