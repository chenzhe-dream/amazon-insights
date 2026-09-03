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
  repositoryVocCandidateFixture,
  SCOOTER_ASINS,
  validAmazonVocInsightOutput,
} from "./helpers/voc-positioning-fixture";

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
      validAmazonVocInsightOutput(preprocessVocSnapshot(subject.snapshot)),
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
      provider.releaseFailure();
      await Promise.allSettled([vocRuntime.stop(), trafficRuntime.stop()]);
    });

    vocRuntime.start();
    trafficRuntime.start();
    const lifecycle = lifecycleFor(repository, subject);
    await provider.waitUntilFailureBlocked();
    const capturedReport = await captureSuccessfulReportBeforeFailureRelease({
      lifecycle,
      provider,
      runId: subject.runId,
      successfulStage,
    });
    assert.equal(capturedReport.status, "complete");
    assert.equal(capturedReport.stage, successfulStage);
    assert.equal(capturedReport.version, 1);
    assert.equal(provider.callCount(successfulStage), 1);
    assert.equal(provider.failureReleased, false);
    const beforeFailureRelease = await lifecycle.getRun(subject.runId);
    assert.equal(stageStatus(beforeFailureRelease.stages, successfulStage), "succeeded");
    assert.equal(stageStatus(beforeFailureRelease.stages, failedStage), "running");
    assert.deepEqual(
      (await lifecycle.listReports(subject.runId)).reports,
      [capturedReport],
    );

    provider.releaseFailure();
    await waitForFailedStage(repository, subject.runId, failedStage);
    await Promise.all([vocRuntime.stop(), trafficRuntime.stop()]);

    const afterFailure = await lifecycle.getRun(subject.runId);
    assert.equal(afterFailure.run.status, "partial");
    assert.equal(stageStatus(afterFailure.stages, failedStage), "failed");
    assert.equal(stageStatus(afterFailure.stages, successfulStage), "succeeded");
    assert.ok(provider.callCount(failedStage) >= 1);
    const afterFailureReports = await lifecycle.listReports(subject.runId);
    assert.deepEqual(afterFailureReports.reports, [capturedReport]);

    repository.close();
    repositoryOpen = false;
    repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    repositoryOpen = true;
    const afterRestart = await lifecycleFor(repository, subject).getRun(subject.runId);
    const afterReports = await lifecycleFor(repository, subject).listReports(subject.runId);
    assert.equal(afterRestart.run.status, "partial");
    assert.equal(stageStatus(afterRestart.stages, successfulStage), "succeeded");
    assert.deepEqual(afterReports.reports, [capturedReport]);
  });
}

class StageSelectiveProvider implements ModelProvider {
  readonly #calls = new Map<"voc-positioning" | "traffic-analysis", number>();
  readonly #failureBlocked = deferred();
  readonly #failureGate = deferred();
  #failureReleased = false;

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
      this.#failureBlocked.resolve();
      await this.#failureGate.promise;
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

  waitUntilFailureBlocked() {
    return this.#failureBlocked.promise;
  }

  releaseFailure() {
    this.#failureReleased = true;
    this.#failureGate.resolve();
  }

  get failureReleased() {
    return this.#failureReleased;
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
    sourceReader: {
      async read(input) {
        return {
          candidate: repositoryVocCandidateFixture(input.asins, input.dataCutoffAt),
          missingSources: [],
          recordCount: input.asins.length,
        };
      },
    },
  });
  const created = await lifecycle.createRunWithVocSnapshot({
    principal: {
      kind: "user",
      userId: actorId,
      organizationId,
      email: `${actorId}@example.com`,
      role: "admin",
      sessionId: randomUUID(),
    },
    projectId,
    mode: "existing-data",
    idempotencyKey: `isolation-${suffix}-${randomUUID()}`,
  });
  return {
    actorId,
    organizationId,
    projectId,
    runId: created.run.id,
    snapshot: created.snapshot,
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

async function captureSuccessfulReportBeforeFailureRelease(input: {
  lifecycle: AnalysisRunService;
  provider: StageSelectiveProvider;
  runId: string;
  successfulStage: StageName;
}) {
  assert.equal(
    input.provider.failureReleased,
    false,
    "failure barrier must remain closed until the successful report is captured",
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const aggregate = await input.lifecycle.getRun(input.runId);
    const reports = await input.lifecycle.listReports(input.runId);
    if (
      stageStatus(aggregate.stages, input.successfulStage) === "succeeded" &&
      reports.reports.length === 1 &&
      reports.reports[0]?.stage === input.successfulStage
    ) {
      return structuredClone(reports.reports[0]);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Successful report was not published before failure release");
}

async function waitForFailedStage(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  runId: string,
  failedStage: StageName,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stages = await repository.listRunStages(runId);
    if (stageStatus(stages, failedStage) === "failed") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Selected failure stage did not reach terminal state");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
