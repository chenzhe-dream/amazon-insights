import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import {
  loadAgentConfig,
  loadAgentDatabaseConfig,
  loadAgentServicePolicy,
  loadVocPositioningRuntimeConfig,
  resolveVocPositioningRuntimeConfig,
} from "../../server/config";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import type {
  ModelProvider,
  StructuredGenerationRequest,
} from "../../server/runtime/model-provider";
import { ModelProviderError } from "../../server/runtime/model-provider";
import type { WorkerClock } from "../../server/runtime/worker-loop";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";

const REQUIRED_VOC_RUNTIME_ENV = [
  "OPENAI_API_KEY",
  "AGENT_VOC_MODEL",
  "AGENT_VOC_ESTIMATED_INPUT_TOKENS",
  "AGENT_VOC_MAX_OUTPUT_TOKENS",
  "AGENT_VOC_TIMEOUT_MS",
  "AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS",
  "AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS",
  "AGENT_VOC_CALL_MAX_TOKENS",
  "AGENT_VOC_CALL_MAX_COST_MICROS",
  "AGENT_VOC_RUN_MAX_TOKENS",
  "AGENT_VOC_RUN_MAX_COST_MICROS",
  "AGENT_VOC_DAILY_MAX_TOKENS",
  "AGENT_VOC_DAILY_MAX_COST_MICROS",
  "AGENT_VOC_WORKER_OWNER_ID",
] as const;

function validRuntimeEnv(): Record<string, string> {
  return {
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

for (const name of REQUIRED_VOC_RUNTIME_ENV) {
  test(`runtime configuration rejects omitted required ${name}`, () => {
    const env = validRuntimeEnv();
    delete env[name];
    assert.throws(
      () => loadVocPositioningRuntimeConfig(env),
      /VOC positioning runtime configuration is incomplete or invalid/,
    );
  });

  test(`runtime configuration rejects blank required ${name}`, () => {
    assert.throws(
      () => loadVocPositioningRuntimeConfig({
        ...validRuntimeEnv(),
        [name]: "   ",
      }),
      /VOC positioning runtime configuration is incomplete or invalid/,
    );
  });
}

test("runtime pricing accepts only explicitly configured zero", () => {
  const configured = loadVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "0",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "0",
  });
  assert.deepEqual(configured.model.pricing, {
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
  });
});

test("runtime pricing rejects positive underflow and non-canonical fixed decimals", () => {
  for (const value of [
    `0.${"0".repeat(400)}1`,
    "0.0000001",
    "01",
    "01.5",
    "1000000000",
  ]) {
    assert.throws(
      () => loadVocPositioningRuntimeConfig({
        ...validRuntimeEnv(),
        AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: value,
      }),
      /VOC positioning runtime configuration is incomplete or invalid/,
      value,
    );
  }
});

test("runtime pricing accepts the minimum positive and lexical maximum fixed decimals", () => {
  const minimum = loadVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "1",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "1",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "0.000001",
  });
  assert.equal(minimum.model.pricing.inputUsdPerMillionTokens, 0.000001);

  const maximum = loadVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "1",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "1",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "999999999",
  });
  assert.equal(maximum.model.pricing.inputUsdPerMillionTokens, 999999999);
});

test("optional runtime resolution classifies every omitted and blank required field without values", () => {
  for (const name of REQUIRED_VOC_RUNTIME_ENV) {
    for (const value of [undefined, "   "] as const) {
      const env: Record<string, string | undefined> = validRuntimeEnv();
      env[name] = value;
      const resolved = resolveVocPositioningRuntimeConfig(env);
      assert.deepEqual(resolved, {
        status: "incomplete",
        reason: "VOC positioning runtime configuration is incomplete",
      });
      assert.doesNotMatch(JSON.stringify(resolved), /configured-key/);
    }
  }
});

test("optional runtime resolution reports complete invalid configuration without echoing values", () => {
  const secret = "secret-value-that-must-not-escape";
  const resolved = resolveVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    OPENAI_API_KEY: secret,
    AGENT_VOC_RETRY_JITTER_RATIO: "Infinity",
  });
  assert.deepEqual(resolved, {
    status: "invalid",
    reason: "VOC positioning runtime configuration is invalid",
  });
  assert.doesNotMatch(JSON.stringify(resolved), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(resolved), /Infinity/);
});

test("optional runtime resolution treats explicit zero pricing as configured", () => {
  const resolved = resolveVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "0",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "0",
  });
  assert.equal(resolved.status, "configured");
  if (resolved.status === "configured") {
    assert.deepEqual(resolved.config.model.pricing, {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    });
  }
});

test("runtime numeric configuration rejects non-canonical and unsafe values", () => {
  for (const [name, value] of [
    ["AGENT_VOC_ESTIMATED_INPUT_TOKENS", "1e3"],
    ["AGENT_VOC_MAX_OUTPUT_TOKENS", "9007199254740992"],
    ["AGENT_VOC_TIMEOUT_MS", "Infinity"],
    ["AGENT_VOC_CALL_MAX_COST_MICROS", "-1"],
    ["AGENT_VOC_RETRY_JITTER_RATIO", "NaN"],
    ["AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS", "1e308"],
    [
      "AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS",
      "999999999999999999999999999999999999",
    ],
  ] as const) {
    assert.throws(
      () => loadVocPositioningRuntimeConfig({
        ...validRuntimeEnv(),
        [name]: value,
      }),
      /VOC positioning runtime configuration is incomplete or invalid/,
      `${name}=${value}`,
    );
  }
});

test("all service numeric configuration rejects blank, scientific, non-finite, negative, and unsafe units", () => {
  for (const [label, load, name] of [
    ["listen port", loadAgentConfig, "AGENT_SERVICE_PORT"],
    ["body bytes", loadAgentServicePolicy, "AGENT_SERVICE_BODY_LIMIT_BYTES"],
    ["request deadline", loadAgentServicePolicy, "AGENT_SERVICE_REQUEST_DEADLINE_MS"],
    ["SQLite busy timeout", loadAgentDatabaseConfig, "AGENT_SQLITE_BUSY_TIMEOUT_MS"],
  ] as const) {
    for (const value of ["", "1e3", "Infinity", "-1", "9007199254740992"]) {
      const env = {
        AGENT_SQLITE_PATH: "agent.sqlite",
        [name]: value,
      };
      assert.throws(() => load(env), `${label}=${value}`);
    }
  }
});

test("formal Agent Service entry starts from a queued job, publishes a report, and stops boundedly", async (t) => {
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
  const agentService = await createAgentService({
    repository,
    env: {
      ...validRuntimeEnv(),
      AGENT_SQLITE_PATH: databasePath,
      AGENT_SERVICE_PROXY_TOKEN: "runtime-proxy-token",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:3001",
    },
    provider,
    providerName: "fake",
  });

  await agentService.start({ host: "127.0.0.1", port: 0 });
  await waitFor(async () =>
    (await repository.findRunStage(stageId))?.status === "succeeded",
  );
  const capabilities = await agentService.app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: {
      origin: "http://127.0.0.1:3001",
      "x-agent-proxy-token": "runtime-proxy-token",
    },
  });
  assert.deepEqual(capabilities.json().capabilities.openai, {
    configured: true,
    available: true,
    reason: null,
  });
  await Promise.race([
    agentService.stop(),
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

test("formal Agent Service entry stays healthy and leaves VOC queued when runtime config is absent or invalid", async (t) => {
  for (const [label, runtimeEnv] of [
    ["absent", {}],
    [
      "invalid",
      {
        ...validRuntimeEnv(),
        OPENAI_API_KEY: "secret-not-for-capabilities",
        AGENT_VOC_RETRY_JITTER_RATIO: "Infinity",
      },
    ],
  ] as const) {
    const directory = mkdtempSync(join(tmpdir(), `amazon-agent-entry-${label}-`));
    const databasePath = join(directory, "agent.sqlite");
    const repository = openSqliteAgentRepository({
      path: databasePath,
      busyTimeoutMs: 5_000,
    });
    const now = new Date().toISOString();
    const organizationId = randomUUID();
    const actorId = randomUUID();
    const projectId = randomUUID();
    const runId = randomUUID();
    const stageId = randomUUID();
    await repository.createUser({
      id: actorId,
      organizationId,
      email: `${actorId}@example.com`,
      displayName: "Optional runtime actor",
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await repository.createProject({
      id: projectId,
      organizationId,
      name: "Optional runtime project",
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
      status: "queued",
      createdBy: actorId,
      dataCutoffAt: CUTOFF,
      idempotencyScope: `optional-runtime:${runId}`,
      idempotencyKey: "create",
      createdAt: now,
      updatedAt: now,
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
    const env = {
      ...runtimeEnv,
      AGENT_SQLITE_PATH: databasePath,
      AGENT_SERVICE_PROXY_TOKEN: "runtime-proxy-token",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:3001",
    };
    const agentService = await createAgentService({ repository, env });
    t.after(async () => {
      await agentService.stop();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await agentService.start({ host: "127.0.0.1", port: 0 });
    const health = await agentService.app.inject({ method: "GET", url: "/health" });
    const capabilities = await agentService.app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: {
        origin: "http://127.0.0.1:3001",
        "x-agent-proxy-token": "runtime-proxy-token",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(health.statusCode, 200, label);
    assert.equal(capabilities.statusCode, 200, label);
    assert.deepEqual(capabilities.json().capabilities.openai, {
      configured: label === "invalid",
      available: false,
      reason:
        label === "invalid"
          ? "VOC positioning runtime configuration is invalid"
          : "VOC positioning runtime configuration is incomplete",
    });
    assert.doesNotMatch(capabilities.payload, /secret-not-for-capabilities/);
    assert.equal((await repository.findRunStage(stageId))?.status, "queued");
  }
});

for (const interruption of ["stop", "heartbeat-failure"] as const) {
  test(`formal composition root recovers live provider ${interruption} after SQLite reopen`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `amazon-voc-runtime-${interruption}-`));
    const databasePath = join(directory, "agent.sqlite");
    let repository = openSqliteAgentRepository({
      path: databasePath,
      busyTimeoutMs: 5_000,
    });
    const subject = await seedCompositionVocJob(repository);
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let providerAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      providerAborted = resolve;
    });
    let interruptedCalls = 0;
    const interruptedProvider: ModelProvider = {
      async generateStructured<T>(request: StructuredGenerationRequest<T>) {
        interruptedCalls += 1;
        providerStarted();
        return await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              providerAborted();
              reject(new ModelProviderError("aborted", "private worker abort"));
            },
            { once: true },
          );
        });
      },
    };
    const env = {
      ...validRuntimeEnv(),
      AGENT_SQLITE_PATH: databasePath,
      AGENT_VOC_WORKER_LEASE_MS: "120000",
      AGENT_VOC_WORKER_HEARTBEAT_MS: "50",
      AGENT_VOC_WORKER_POLL_MS: "10",
      AGENT_VOC_WORKER_STOP_TIMEOUT_MS: "100",
    };
    let failHeartbeat!: () => void;
    const heartbeatFailureClock: WorkerClock = {
      now: () => new Date().toISOString(),
      sleep: (durationMs, signal) => {
        if (durationMs === 50) {
          return new Promise<void>((_resolve, reject) => {
            failHeartbeat = () => reject(new Error("private heartbeat failure"));
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, durationMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    };
    const firstService = await createAgentService({
      repository,
      env,
      provider: interruptedProvider,
      providerName: "fake",
      ...(interruption === "heartbeat-failure"
        ? { workerClock: heartbeatFailureClock }
        : {}),
    });
    await firstService.start({ host: "127.0.0.1", port: 0 });
    await started;
    if (interruption === "stop") {
      await firstService.stop();
      await aborted;
    } else {
      failHeartbeat();
      await aborted;
      await firstService.stop();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inspector = new DatabaseSync(databasePath, { readOnly: true });
    const terminalRows = inspector
      .prepare("SELECT terminal_status FROM agent_runs WHERE run_id = ?")
      .all(subject.runId) as Array<{ terminal_status: string | null }>;
    inspector.close();
    assert.ok(terminalRows.length >= 1);
    assert.ok(terminalRows.every((row) => row.terminal_status !== "cancelled"));

    repository.close();
    repository = openSqliteAgentRepository({
      path: databasePath,
      busyTimeoutMs: 5_000,
    });
    const recoveryNow = new Date(Date.now() + 180_000);
    let recoveryCalls = 0;
    const recoveryProvider: ModelProvider = {
      async generateStructured<T>() {
        recoveryCalls += 1;
        return {
          value: subject.output as T,
          responseId: "composition-recovery-response",
          inputTokens: 500,
          outputTokens: 250,
        };
      },
    };
    const recoveryService = await createAgentService({
      repository,
      env: {
        ...env,
        AGENT_VOC_WORKER_OWNER_ID: `recovery-${interruption}`,
      },
      provider: recoveryProvider,
      providerName: "fake",
      clock: () => recoveryNow,
      workerClock: {
        now: () => recoveryNow.toISOString(),
        sleep: async (_durationMs, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      },
    });
    try {
      await recoveryService.start({ host: "127.0.0.1", port: 0 });
      await waitFor(async () =>
        (await repository.findRunStage(subject.stageId))?.status === "succeeded",
      );
      assert.equal(interruptedCalls, 1);
      assert.equal(recoveryCalls, 1);
      assert.equal((await repository.listAnalysisReports({
        actorOrganizationId: subject.organizationId,
        runId: subject.runId,
        stage: "voc-positioning",
      })).length, 1);
    } finally {
      await recoveryService.stop();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

async function seedCompositionVocJob(
  repository: ReturnType<typeof openSqliteAgentRepository>,
) {
  const now = new Date().toISOString();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Composition interruption actor",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Composition interruption project",
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
    idempotencyScope: `composition-interruption:${runId}`,
    idempotencyKey: "create",
    createdAt: now,
    updatedAt: now,
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
  const record = realVocSnapshot(SCOOTER_ASINS, snapshotId, runId);
  const { id: _id, runId: _runId, createdAt: _createdAt, ...candidate } = record;
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
  return {
    organizationId,
    runId,
    stageId,
    output: validVocPositioningOutput(preprocessVocSnapshot(snapshot.snapshot)),
  };
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for formal VOC runtime");
}
