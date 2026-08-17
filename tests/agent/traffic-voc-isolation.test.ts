import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadVocPositioningRuntimeConfig } from "../../server/config";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { TrafficAnalysisInput } from "../../server/domain/traffic/traffic-analysis-contracts";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import { createTrafficAnalysisRuntime } from "../../server/runtime/traffic-analysis-runtime";
import type {
  ModelProvider,
  StructuredGenerationRequest,
} from "../../server/runtime/model-provider";
import { createVocPositioningRuntime } from "../../server/runtime/voc-positioning-runtime";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import type { StageName } from "../../shared/agent-contracts";
import {
  realVocSnapshot,
  SCOOTER_ASINS,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";

for (const failedStage of ["voc-positioning", "traffic-analysis"] as const) {
  const successfulStage: StageName = failedStage === "voc-positioning"
    ? "traffic-analysis"
    : "voc-positioning";

  test(`${failedStage} validation failure preserves the successful ${successfulStage} report across restart`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "amazon-traffic-voc-isolation-"));
    const path = join(directory, "agent.sqlite");
    let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    let repositoryOpen = true;
    t.after(() => {
      if (repositoryOpen) repository.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const subject = await seedRun(repository, failedStage);
    const provider = new StageSelectiveProvider(
      failedStage,
      validVocPositioningOutput(preprocessVocSnapshot(subject.snapshot)),
    );
    const config = runtimeConfig(`${failedStage}-worker`);
    const vocRuntime = await createVocPositioningRuntime({
      repository,
      config,
      provider,
      providerName: "isolation-fixture",
    });
    const trafficRuntime = await createTrafficAnalysisRuntime({
      repository,
      config: {
        providerName: "isolation-fixture",
        model: config.model,
        budgetLimits: config.budgetLimits,
        worker: { ...config.worker, ownerId: `${failedStage}-traffic-worker` },
      },
      provider,
    });
    t.after(async () => {
      await Promise.allSettled([vocRuntime.stop(), trafficRuntime.stop()]);
    });

    vocRuntime.start();
    trafficRuntime.start();
    await waitForTerminalStages(repository, subject.runId);
    await Promise.all([vocRuntime.stop(), trafficRuntime.stop()]);

    const lifecycle = lifecycleFor(repository, subject);
    const beforeRestart = await lifecycle.getRun(subject.runId);
    assert.equal(beforeRestart.run.status, "partial");
    assert.equal(stageStatus(beforeRestart.stages, failedStage), "failed");
    assert.equal(stageStatus(beforeRestart.stages, successfulStage), "succeeded");
    assert.ok(provider.callCount(failedStage) >= 1);
    assert.equal(provider.callCount(successfulStage), 1);
    const beforeReports = await lifecycle.listReports(subject.runId);
    assert.equal(beforeReports.reports.length, 1);
    assert.equal(beforeReports.reports[0]?.stage, successfulStage);
    assert.equal(beforeReports.reports[0]?.version, 1);
    assert.notEqual(beforeReports.reports[0]?.status, "stale");

    repository.close();
    repositoryOpen = false;
    repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    repositoryOpen = true;
    const afterRestart = await lifecycleFor(repository, subject).getRun(subject.runId);
    const afterReports = await lifecycleFor(repository, subject).listReports(subject.runId);
    assert.equal(afterRestart.run.status, "partial");
    assert.equal(stageStatus(afterRestart.stages, successfulStage), "succeeded");
    assert.deepEqual(afterReports.reports, beforeReports.reports);
  });
}

class StageSelectiveProvider implements ModelProvider {
  readonly #calls = new Map<"voc-positioning" | "traffic-analysis", number>();

  constructor(
    private readonly failedStage: "voc-positioning" | "traffic-analysis",
    private readonly vocOutput: unknown,
  ) {}

  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    const kind = (request.input as { kind?: string }).kind;
    const stage = kind === "competitor-traffic-analysis-input"
      ? "traffic-analysis"
      : "voc-positioning";
    this.#calls.set(stage, (this.#calls.get(stage) ?? 0) + 1);
    if (stage === this.failedStage) {
      return {
        value: { invalid: true } as T,
        responseId: `invalid-${stage}`,
        inputTokens: 100,
        outputTokens: 50,
      };
    }
    if (stage === "voc-positioning") {
      return {
        value: this.vocOutput as T,
        responseId: "valid-voc",
        inputTokens: 100,
        outputTokens: 50,
      };
    }
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
        summary: "流量、份额和趋势仅用于判断流量获取与运营结构。",
        competitors: input.competitors,
        decisionBoundaries: {
          profitability: "not-assessed",
          advertisingEfficiency: "requires-validation",
          roi: "not-assessed",
          projectApproval: "not-assessed",
        },
        dataBoundary: "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。",
      } as T,
      responseId: "valid-traffic",
      inputTokens: 100,
      outputTokens: 50,
    };
  }

  callCount(stage: "voc-positioning" | "traffic-analysis") {
    return this.#calls.get(stage) ?? 0;
  }
}

async function seedRun(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  suffix: string,
) {
  const now = new Date().toISOString();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Isolation actor",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Traffic VOC isolation",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  const lifecycle = new AnalysisRunService({
    repository,
    executionContext: { actorId, organizationId },
  });
  const created = await lifecycle.createRun(projectId, {
    mode: "existing-data",
    dataCutoffAt: CUTOFF,
    idempotencyKey: `isolation-${suffix}-${randomUUID()}`,
  });
  const snapshotId = randomUUID();
  const record = realVocSnapshot(SCOOTER_ASINS, snapshotId, created.run.id);
  const { id: _id, runId: _runId, createdAt: _createdAt, ...candidate } = record;
  void _id;
  void _runId;
  void _createdAt;
  const snapshot = await repository.createDataSnapshotForRun({
    actorId,
    actorOrganizationId: organizationId,
    runId: created.run.id,
    expectedProjectId: projectId,
    expectedMarketplace: "US",
    expectedAsins: SCOOTER_ASINS,
    expectedRunCutoffAt: CUTOFF,
    candidateId: snapshotId,
    createdAt: now,
    candidate,
  });
  return {
    actorId,
    organizationId,
    projectId,
    runId: created.run.id,
    snapshot: snapshot.snapshot,
  };
}

function lifecycleFor(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  subject: { actorId: string; organizationId: string },
) {
  return new AnalysisRunService({
    repository,
    executionContext: {
      actorId: subject.actorId,
      organizationId: subject.organizationId,
    },
  });
}

function stageStatus(
  stages: readonly { stage: StageName; status: string }[],
  stage: StageName,
) {
  return stages.find((candidate) => candidate.stage === stage)?.status;
}

async function waitForTerminalStages(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  runId: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stages = await repository.listRunStages(runId);
    const selected = stages.filter(({ stage }) =>
      stage === "traffic-analysis" || stage === "voc-positioning",
    );
    if (
      selected.length === 2 &&
      selected.every(({ status }) => status === "succeeded" || status === "failed")
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Traffic/VOC stages did not reach terminal state");
}

function runtimeConfig(ownerId: string) {
  return loadVocPositioningRuntimeConfig({
    OPENAI_API_KEY: "fixture-key",
    AGENT_VOC_MODEL: "fixture-model",
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "4000",
    AGENT_VOC_TIMEOUT_MS: "5000",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_CALL_MAX_TOKENS: "100000",
    AGENT_VOC_CALL_MAX_COST_MICROS: "1000000",
    AGENT_VOC_RUN_MAX_TOKENS: "100000",
    AGENT_VOC_RUN_MAX_COST_MICROS: "1000000",
    AGENT_VOC_DAILY_MAX_TOKENS: "1000000",
    AGENT_VOC_DAILY_MAX_COST_MICROS: "10000000",
    AGENT_VOC_WORKER_OWNER_ID: ownerId,
    AGENT_VOC_WORKER_LEASE_MS: "120000",
    AGENT_VOC_WORKER_HEARTBEAT_MS: "60000",
    AGENT_VOC_WORKER_POLL_MS: "10",
    AGENT_VOC_WORKER_STOP_TIMEOUT_MS: "1000",
    AGENT_VOC_RETRY_MAX_ATTEMPTS: "1",
    AGENT_VOC_RETRY_INITIAL_DELAY_MS: "10",
    AGENT_VOC_RETRY_MAX_DELAY_MS: "10",
    AGENT_VOC_RETRY_JITTER_RATIO: "0",
  });
}
