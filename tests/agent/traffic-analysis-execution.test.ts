import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  TrafficAnalysisOutputSchema,
  assertTrafficCapabilityLanguage,
  buildDeterministicTrafficInput,
  canonicalizeTrafficAnalysisOutput,
} from "../../server/domain/traffic/traffic-analysis-contracts";
import { TrafficAnalysisExecutionService } from "../../server/services/traffic-analysis-execution-service";
import { AuditedSkillRunner } from "../../server/runtime/agent-run-service";
import { ModelBudgetCoordinator, StaticModelBudgetLimitProvider } from "../../server/runtime/model-budget-coordinator";
import type { ModelProvider, StructuredGenerationRequest } from "../../server/runtime/model-provider";
import { SkillRunner } from "../../server/runtime/skill-runner";
import { JobAttemptWorkerLoop } from "../../server/runtime/worker-loop";
import { createTrafficAnalysisJobHandler } from "../../server/services/traffic-analysis-worker-handler";
import { SkillRegistry } from "../../server/skills/registry";
import { realVocSnapshot, SCOOTER_ASINS } from "./helpers/voc-positioning-fixture";

test("traffic output keeps volume, share, rank, concentration, and trend outside profit claims", () => {
  const input = buildDeterministicTrafficInput({
    marketplace: "US",
    asins: SCOOTER_ASINS,
    dataCutoffAt: "2026-08-15T23:59:59.999Z",
  });
  assert.equal(input.competitors.length, 3);
  assert.deepEqual(
    input.competitors.map((competitor) => competitor.trafficRank),
    [1, 2, 3],
  );
  for (const competitor of input.competitors) {
    assert.equal(typeof competitor.top1Share, "number");
    assert.equal(typeof competitor.top3Share, "number");
    assert.equal(typeof competitor.hhi, "number");
    assert.equal(typeof competitor.effectiveChildren, "number");
    assert.equal(typeof competitor.childCount, "number");
    assert.equal("concentration" in competitor, false);
  }
  const output = TrafficAnalysisOutputSchema.parse({
    schemaVersion: "1.0.0",
    kind: "competitor-traffic-analysis",
    status: "complete",
    identity: {
      dataCutoffAt: input.dataCutoffAt,
      inputDigest: input.inputDigest,
    },
    summary: "流量规模、自然与广告占比、排名、集中度和月度趋势只用于判断流量获取与运营结构。",
    competitors: input.competitors,
    decisionBoundaries: {
      profitability: "not-assessed",
      advertisingEfficiency: "requires-validation",
      roi: "not-assessed",
      projectApproval: "not-assessed",
    },
    dataBoundary:
      "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。",
  });

  assert.doesNotThrow(() => assertTrafficCapabilityLanguage(output));
  const canonical = canonicalizeTrafficAnalysisOutput({
    ...output,
    competitors: output.competitors.map((competitor, index) => ({
      ...competitor,
      trafficRank: index + 7,
      top3Share: 0,
      hhi: 0,
    })),
  }, input);
  assert.deepEqual(canonical.competitors, input.competitors);
  assert.throws(
    () =>
      assertTrafficCapabilityLanguage({
        ...output,
        summary: "流量占比证明 profit efficiency 很高。",
      }),
    /profit efficiency/i,
  );
});

test("traffic execution rejects an unrelated VOC snapshot before calling the provider", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-traffic-execution-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date("2026-08-16T00:00:00.000Z"),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = "2026-08-16T00:00:00.000Z";
  const cutoff = "2026-08-15T23:59:59.999Z";
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();
  const snapshotId = randomUUID();
  await repository.createUser({ id: actorId, organizationId, email: `${actorId}@example.com`, displayName: "Traffic actor", role: "admin", status: "active", createdAt: now, updatedAt: now });
  await repository.createProject({ id: projectId, organizationId, name: "Traffic project", marketplace: "US", asins: [...SCOOTER_ASINS], createdBy: actorId, createdAt: now, updatedAt: now });
  await repository.createAnalysisRun({ id: runId, projectId, mode: "existing-data", status: "running", createdBy: actorId, dataCutoffAt: cutoff, idempotencyScope: `traffic:${runId}`, idempotencyKey: "create", createdAt: now, updatedAt: now });
  await repository.createRunStage({ id: stageId, runId, stage: "traffic-analysis", status: "queued", progress: 0, attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: now, updatedAt: now });
  await repository.enqueueJob({ id: jobId, stageId, attemptNumber: 1, maxAttempts: 3, availableAt: now, createdAt: now });
  const snapshotRecord = realVocSnapshot(SCOOTER_ASINS, snapshotId, runId);
  const { id: _id, runId: _runId, createdAt: _createdAt, ...candidate } = snapshotRecord;
  void _id; void _runId; void _createdAt;
  await repository.createDataSnapshotForRun({ actorId, actorOrganizationId: organizationId, runId, expectedProjectId: projectId, expectedMarketplace: "US", expectedAsins: SCOOTER_ASINS, expectedRunCutoffAt: cutoff, candidateId: snapshotId, createdAt: now, candidate });

  const input = buildDeterministicTrafficInput({ marketplace: "US", asins: SCOOTER_ASINS, dataCutoffAt: cutoff });
  const provider = new FakeTrafficProvider({
    schemaVersion: "1.0.0",
    kind: "competitor-traffic-analysis",
    status: "complete",
    identity: { dataCutoffAt: cutoff, inputDigest: input.inputDigest },
    summary: "流量规模、自然与广告占比、排名、集中度和趋势用于判断流量获取与运营结构。",
    competitors: input.competitors,
    decisionBoundaries: {
      profitability: "not-assessed",
      advertisingEfficiency: "requires-validation",
      roi: "not-assessed",
      projectApproval: "not-assessed",
    },
    dataBoundary: "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。",
  });
  const registry = await SkillRegistry.open(resolve("skills-src"));
  const runner = new SkillRunner({ registry, provider, providerName: "fake", budgetCoordinator: new ModelBudgetCoordinator({ repository, limitProvider: new StaticModelBudgetLimitProvider({ call: { maxTokens: 100_000, maxCostMicros: 1_000_000 }, run: { maxTokens: 100_000, maxCostMicros: 1_000_000 }, organizationUtcDay: { maxTokens: 100_000, maxCostMicros: 1_000_000 } }), clock: () => new Date(now) }), sleep: async () => {}, now: () => Date.parse(now) });
  const service = new TrafficAnalysisExecutionService({ repository, auditedRunner: new AuditedSkillRunner({ skillRunner: runner, repository, clock: () => new Date(now) }), clock: () => new Date(now) });
  const worker = new JobAttemptWorkerLoop({
    repository,
    ownerId: "traffic-worker",
    stage: "traffic-analysis",
    handler: createTrafficAnalysisJobHandler({
      service,
      prepare: () => ({
        request: { snapshotId, input, model: modelConfig() },
        context: { actorId, organizationId, projectId, dataCutoffAt: cutoff },
      }),
    }),
    leaseDurationMs: 120_000,
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 1_000,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
  });
  assert.equal(await worker.runOnce(), true);

  assert.equal(provider.requests.length, 0);
  const reports = await repository.listAnalysisReports({ actorOrganizationId: organizationId, runId, stage: "traffic-analysis" });
  assert.equal(reports.length, 0);
  const stage = await repository.findRunStage(stageId);
  assert.equal(stage?.status, "failed");
});

class FakeTrafficProvider implements ModelProvider {
  readonly requests: StructuredGenerationRequest<unknown>[] = [];
  constructor(private readonly output: unknown) {}
  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    this.requests.push(request as StructuredGenerationRequest<unknown>);
    return { value: this.output as T, responseId: "traffic-response", inputTokens: 100, outputTokens: 50 };
  }
}

function modelConfig() {
  return { name: "traffic-test-model", estimatedInputTokens: 4_000, maxOutputTokens: 2_000, timeoutMs: 5_000, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } };
}
