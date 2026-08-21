import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { RuntimeAgentRepository } from "../db/repository";
import type { ModelBudgetLimits } from "../db/model-budget-repository";
import type { RemoteMcpConnector } from "../connectors/connector-contract";
import { buildDeterministicTrafficInput } from "../domain/traffic/traffic-analysis-contracts";
import { buildTrafficSnapshotCandidate } from "../data/traffic-data-snapshot";
import { TrafficAnalysisExecutionService } from "../services/traffic-analysis-execution-service";
import { createTrafficAnalysisJobHandler } from "../services/traffic-analysis-worker-handler";
import { SifTrafficSnapshotTask } from "../services/sif-traffic-snapshot-task";
import { SkillRegistry } from "../skills/registry";
import { AuditedSkillRunner } from "./agent-run-service";
import { ModelBudgetCoordinator, StaticModelBudgetLimitProvider } from "./model-budget-coordinator";
import type { ModelProvider } from "./model-provider";
import { SkillRunner, type ModelExecutionConfig } from "./skill-runner";
import { JobAttemptWorkerLoop, type WorkerClock, type WorkerLogger } from "./worker-loop";
import { WorkerTaskError, type RetryPolicy } from "./retry-policy";

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
  repository: RuntimeAgentRepository;
  config: TrafficAnalysisRuntimeConfig;
  provider: ModelProvider;
  skillsRoot?: string;
  clock?: () => Date;
  workerClock?: WorkerClock;
  logger?: WorkerLogger;
  sifConnector?: RemoteMcpConnector;
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
  const snapshotTask = options.sifConnector
    ? new SifTrafficSnapshotTask({
        repository: options.repository,
        connector: options.sifConnector,
        clock,
      })
    : null;
  const handler = createTrafficAnalysisJobHandler({
    service,
    prepare: async (job, signal) => {
      const run = await options.repository.findAnalysisRun(job.runId);
      if (!run) throw unavailableSubject();
      const project = await options.repository.findProjectById(run.projectId);
      const actor = await options.repository.findUserById(run.createdBy);
      if (!project || !actor || actor.status !== "active" || actor.organizationId !== project.organizationId) throw unavailableSubject();
      if (project.marketplace !== "US") throw unavailableSubject();
      const trustedRun = run;
      const trustedProject = project;
      const trustedActor = actor;
      const snapshot = trustedRun.mode === "collect-missing"
        ? await collectSnapshot()
        : await createExistingDataSnapshot();
      const input = snapshot.snapshot.payload.input;
      return {
        request: { snapshotId: snapshot.snapshot.id, input, model: options.config.model },
        context: { actorId: trustedActor.id, organizationId: trustedActor.organizationId, projectId: trustedProject.id, dataCutoffAt: trustedRun.dataCutoffAt },
      };

      async function collectSnapshot() {
        if (!snapshotTask) {
          throw new WorkerTaskError(
            "configuration",
            "SIF traffic connector is unavailable for collect-missing runs",
          );
        }
        const collected = await snapshotTask.createForRun({
          actorId: trustedActor.id,
          organizationId: trustedActor.organizationId,
          projectId: trustedProject.id,
          runId: trustedRun.id,
          marketplace: "US",
          asins: trustedProject.asins,
          dataCutoffAt: trustedRun.dataCutoffAt,
        }, signal);
        return { snapshot: collected, created: true } as const;
      }

      async function createExistingDataSnapshot() {
        const input = buildDeterministicTrafficInput({
          marketplace: "US",
          asins: trustedProject.asins,
          dataCutoffAt: trustedRun.dataCutoffAt,
        });
        return options.repository.createTrafficDataSnapshotForRun({
          actorId: trustedActor.id,
          actorOrganizationId: trustedActor.organizationId,
          runId: trustedRun.id,
          expectedProjectId: trustedProject.id,
          expectedMarketplace: trustedProject.marketplace,
          expectedAsins: trustedProject.asins,
          expectedRunCutoffAt: trustedRun.dataCutoffAt,
          candidateId: randomUUID(),
          createdAt: clock().toISOString(),
          candidate: buildTrafficSnapshotCandidate({
            asins: trustedProject.asins,
            trafficInput: input,
          }),
        });
      }
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
