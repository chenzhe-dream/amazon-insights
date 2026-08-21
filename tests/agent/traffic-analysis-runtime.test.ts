import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { TrafficAnalysisInput } from "../../server/domain/traffic/traffic-analysis-contracts";
import type {
  ModelProvider,
  StructuredGenerationRequest,
} from "../../server/runtime/model-provider";
import {
  realVocSnapshot,
  SCOOTER_ASINS,
} from "./helpers/voc-positioning-fixture";

const NOW = "2026-08-16T00:00:00.000Z";
const CUTOFF = "2026-08-15T23:59:59.999Z";

test("Agent Service starts traffic runtime and executes a queued traffic job", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-traffic-runtime-"));
  const databasePath = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
  });
  const subject = await seedTrafficJob(repository);
  const provider = new RuntimeTrafficProvider();
  const service = await createAgentService({
    repository,
    provider,
    providerName: "traffic-runtime-fixture",
    env: runtimeEnv(databasePath),
  });
  t.after(async () => {
    await service.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await service.start({ host: "127.0.0.1", port: 0 });
  const stage = await waitForTrafficStage(repository, subject.stageId);

  assert.equal(repository.listAppliedMigrations().at(-1)?.version, 9);
  assert.equal(stage.status, "succeeded");
  assert.equal(provider.requests.length, 1);
  const reports = await repository.listAnalysisReports({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
    stage: "traffic-analysis",
  });
  assert.equal(reports.length, 1);
  const trafficSnapshots = await repository.listTrafficDataSnapshotsByRun({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(trafficSnapshots.length, 1);
  assert.notEqual(trafficSnapshots[0]?.id, subject.vocSnapshotId);
  assert.deepEqual(reports[0]?.snapshotIds, [trafficSnapshots[0]?.id]);
  assert.deepEqual(reports[0]?.evidence, [{
    id: trafficSnapshots[0]?.id,
    type: "snapshot",
    sourceId: "traffic-data-snapshot",
    capturedAt: trafficSnapshots[0]?.createdAt,
  }]);
  assert.deepEqual(
    trafficSnapshots[0]?.payload.input,
    provider.requests[0]?.input,
  );
  assert.equal(
    await repository.findTrafficDataSnapshotById({
      actorOrganizationId: subject.organizationId,
      snapshotId: subject.vocSnapshotId,
    }),
    null,
  );
});

class RuntimeTrafficProvider implements ModelProvider {
  readonly requests: StructuredGenerationRequest<unknown>[] = [];

  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    this.requests.push(request as StructuredGenerationRequest<unknown>);
    const input = request.input as TrafficAnalysisInput;
    return {
      value: {
        schemaVersion: "1.0.0",
        kind: "competitor-traffic-analysis",
        status: "complete",
        identity: {
          dataCutoffAt: input.dataCutoffAt,
          inputDigest: input.inputDigest,
        },
        summary: "流量规模、份额与结构只用于判断流量获取和运营能力。",
        competitors: input.competitors,
        decisionBoundaries: {
          profitability: "not-assessed",
          advertisingEfficiency: "requires-validation",
          roi: "not-assessed",
          projectApproval: "not-assessed",
        },
        dataBoundary:
          "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。",
      } as T,
      responseId: "traffic-runtime-response",
      inputTokens: 100,
      outputTokens: 50,
    };
  }
}

async function seedTrafficJob(
  repository: ReturnType<typeof openSqliteAgentRepository>,
) {
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
    displayName: "Traffic runtime actor",
    role: "admin",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Traffic runtime project",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actorId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "running",
    createdBy: actorId,
    dataCutoffAt: CUTOFF,
    idempotencyScope: `traffic-runtime:${runId}`,
    idempotencyKey: "create",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.createRunStage({
    id: stageId,
    runId,
    stage: "traffic-analysis",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.enqueueJob({
    id: randomUUID(),
    stageId,
    attemptNumber: 1,
    maxAttempts: 1,
    availableAt: new Date().toISOString(),
    createdAt: NOW,
  });
  const snapshotRecord = realVocSnapshot(SCOOTER_ASINS, snapshotId, runId);
  const { id: _id, runId: _runId, createdAt: _createdAt, ...candidate } =
    snapshotRecord;
  void _id;
  void _runId;
  void _createdAt;
  await repository.createDataSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: snapshotId,
    createdAt: NOW,
    candidate,
  });
  return { organizationId, runId, stageId, vocSnapshotId: snapshotId };
}

async function waitForTrafficStage(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  stageId: string,
) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const stage = await repository.findRunStage(stageId);
    if (stage && stage.status !== "queued" && stage.status !== "running") {
      return stage;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stage = await repository.findRunStage(stageId);
  assert.ok(stage);
  return stage;
}

function runtimeEnv(databasePath: string) {
  return {
    OPENAI_API_KEY: "fixture-key",
    AGENT_VOC_MODEL: "fixture-model",
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "2000",
    AGENT_VOC_TIMEOUT_MS: "5000",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_CALL_MAX_TOKENS: "100000",
    AGENT_VOC_CALL_MAX_COST_MICROS: "1000000",
    AGENT_VOC_RUN_MAX_TOKENS: "100000",
    AGENT_VOC_RUN_MAX_COST_MICROS: "1000000",
    AGENT_VOC_DAILY_MAX_TOKENS: "100000",
    AGENT_VOC_DAILY_MAX_COST_MICROS: "1000000",
    AGENT_VOC_WORKER_OWNER_ID: "agent-service-traffic-worker",
    AGENT_VOC_WORKER_LEASE_MS: "120000",
    AGENT_VOC_WORKER_HEARTBEAT_MS: "60000",
    AGENT_VOC_WORKER_POLL_MS: "10",
    AGENT_VOC_WORKER_STOP_TIMEOUT_MS: "1000",
    AGENT_VOC_RETRY_MAX_ATTEMPTS: "1",
    AGENT_VOC_RETRY_INITIAL_DELAY_MS: "10",
    AGENT_VOC_RETRY_MAX_DELAY_MS: "10",
    AGENT_VOC_RETRY_JITTER_RATIO: "0",
    AGENT_SQLITE_PATH: databasePath,
  };
}
