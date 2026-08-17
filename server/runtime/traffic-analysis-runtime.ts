import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { SqliteAgentRepository } from "../db/sqlite-repository";
import type { ModelBudgetLimits } from "../db/model-budget-repository";
import { buildDeterministicTrafficInput } from "../domain/traffic/traffic-analysis-contracts";
import { buildTrafficSnapshotCandidate } from "../data/traffic-data-snapshot";
import { TrafficAnalysisExecutionService } from "../services/traffic-analysis-execution-service";
import { createTrafficAnalysisJobHandler } from "../services/traffic-analysis-worker-handler";
import { SkillRegistry } from "../skills/registry";
import { AuditedSkillRunner } from "./agent-run-service";
import { ModelBudgetCoordinator, StaticModelBudgetLimitProvider } from "./model-budget-coordinator";
import type { ModelProvider } from "./model-provider";
import { SkillRunner, type ModelExecutionConfig } from "./skill-runner";
import { JobAttemptWorkerLoop, type WorkerClock, type WorkerLogger } from "./worker-loop";
import type { RetryPolicy } from "./retry-policy";

export interface TrafficAnalysisRuntimeConfig {
  providerName: string;
  model: ModelExecutionConfig;
  budgetLimits: ModelBudgetLimits;
  worker: {
    ownerId: string;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    pollIntervalMs: number;
    stopTimeoutMs: number;
    retryPolicy: RetryPolicy;
  };
}

export async function createTrafficAnalysisRuntime(options: {
  repository: SqliteAgentRepository;
  config: TrafficAnalysisRuntimeConfig;
  provider: ModelProvider;
  skillsRoot?: string;
  clock?: () => Date;
  workerClock?: WorkerClock;
  logger?: WorkerLogger;
}) {
  const clock = options.clock ?? (() => new Date());
  const registry = await SkillRegistry.open(options.skillsRoot ?? resolve("skills-src"));
  const runner = new SkillRunner({
    registry, provider: options.provider, providerName: options.config.providerName,
    budgetCoordinator: new ModelBudgetCoordinator({ repository: options.repository, limitProvider: new StaticModelBudgetLimitProvider(options.config.budgetLimits), clock }),
    now: () => clock().getTime(),
  });
  const service = new TrafficAnalysisExecutionService({
    repository: options.repository,
    auditedRunner: new AuditedSkillRunner({ skillRunner: runner, repository: options.repository, clock }),
    clock,
  });
  const handler = createTrafficAnalysisJobHandler({
    service,
    prepare: async (job) => {
      const run = await options.repository.findAnalysisRun(job.runId);
      if (!run) throw unavailableSubject();
      const project = await options.repository.findProjectById(run.projectId);
      const actor = await options.repository.findUserById(run.createdBy);
      if (!project || !actor || actor.status !== "active" || actor.organizationId !== project.organizationId) throw unavailableSubject();
      if (project.marketplace !== "US") throw unavailableSubject();
      const input = buildDeterministicTrafficInput({
        marketplace: "US",
        asins: project.asins,
        dataCutoffAt: run.dataCutoffAt,
      });
      const snapshot = await options.repository.createTrafficDataSnapshotForRun({
        actorId: actor.id,
        actorOrganizationId: actor.organizationId,
        runId: run.id,
        expectedProjectId: project.id,
        expectedMarketplace: project.marketplace,
        expectedAsins: project.asins,
        expectedRunCutoffAt: run.dataCutoffAt,
        candidateId: randomUUID(),
        createdAt: clock().toISOString(),
        candidate: buildTrafficSnapshotCandidate({
          asins: project.asins,
          trafficInput: input,
        }),
      });
      return {
        request: { snapshotId: snapshot.snapshot.id, input, model: options.config.model },
        context: { actorId: actor.id, organizationId: actor.organizationId, projectId: project.id, dataCutoffAt: run.dataCutoffAt },
      };
    },
  });
  const worker = new JobAttemptWorkerLoop({
    ...options.config.worker,
    repository: options.repository,
    stage: "traffic-analysis",
    handler,
    ...(options.workerClock ? { clock: options.workerClock } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return Object.freeze({ start: () => worker.start(), stop: () => worker.stop() });
}

function unavailableSubject() {
  return new Error("Traffic analysis trusted execution subject is unavailable");
}
