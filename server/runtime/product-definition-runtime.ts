import { resolve } from "node:path";
import { DEFAULT_VOC_QUEUE_TIMEOUT_MS } from "../domain/voc/queue-deadline";

import type { VocPositioningRuntimeConfig } from "../config";
import type { RuntimeAgentRepository } from "../db/repository";
import { buildProductDefinitionInput } from "../domain/product/product-definition-contracts";
import { ProductDefinitionExecutionService } from "../services/product-definition-execution-service";
import { createProductDefinitionJobHandler } from "../services/product-definition-worker-handler";
import { SkillRegistry } from "../skills/registry";
import { AuditedSkillRunner } from "./agent-run-service";
import { ModelBudgetCoordinator, StaticModelBudgetLimitProvider } from "./model-budget-coordinator";
import type { ModelProvider } from "./model-provider";
import { WorkerTaskError } from "./retry-policy";
import { SkillRunner } from "./skill-runner";
import { JobAttemptWorkerLoop, type WorkerClock, type WorkerLogger } from "./worker-loop";

export async function createProductDefinitionRuntime(options: {
  queueTimeoutMs?: number;
  repository: RuntimeAgentRepository;
  config: VocPositioningRuntimeConfig;
  provider: ModelProvider;
  providerName: string;
  skillsRoot?: string;
  clock?: () => Date;
  workerClock?: WorkerClock;
  logger?: WorkerLogger;
}) {
  const clock = options.clock ?? (() => new Date());
  const registry = await SkillRegistry.open(options.skillsRoot ?? resolve("skills-src"));
  const runner = new SkillRunner({
    registry,
    provider: options.provider,
    providerName: options.providerName,
    budgetCoordinator: new ModelBudgetCoordinator({
      repository: options.repository,
      limitProvider: new StaticModelBudgetLimitProvider(options.config.budgetLimits),
      clock,
    }),
    now: () => clock().getTime(),
  });
  const service = new ProductDefinitionExecutionService({
    repository: options.repository,
    auditedRunner: new AuditedSkillRunner({ skillRunner: runner, repository: options.repository, clock }),
    clock,
  });
  const handler = createProductDefinitionJobHandler({
    service,
    prepare: async (job) => {
      const run = await options.repository.findAnalysisRun(job.runId);
      if (!run) throw unavailableDependencies();
      const project = await options.repository.findProjectById(run.projectId);
      const actor = await options.repository.findUserById(run.createdBy);
      if (!project || !actor || actor.status !== "active" || actor.organizationId !== project.organizationId || project.marketplace !== "US") {
        throw unavailableDependencies();
      }
      const vocReports = await options.repository.listAnalysisReports({
        actorOrganizationId: project.organizationId,
        runId: run.id,
        stage: "voc-positioning",
      });
      const keywordSnapshots = await options.repository.listKeywordAnalysisSnapshotsByRun({
        actorOrganizationId: project.organizationId,
        runId: run.id,
      });
      const vocReport = [...vocReports].reverse().find(({ status }) => status === "complete" || status === "partial");
      const keywordSnapshot = keywordSnapshots.at(-1);
      if (!vocReport || !keywordSnapshot) throw unavailableDependencies();
      const vocSnapshotId = vocReport.snapshotIds[0];
      const vocSnapshot = vocSnapshotId ? await options.repository.findDataSnapshotById({
        actorOrganizationId: project.organizationId,
        snapshotId: vocSnapshotId,
      }) : null;
      if (!vocSnapshot || vocSnapshot.runId !== run.id) throw unavailableDependencies();
      return {
        request: {
          vocReportId: vocReport.id,
          keywordSnapshotId: keywordSnapshot.id,
          input: buildProductDefinitionInput({
            marketplace: "US",
            asins: keywordSnapshot.asins,
            dataCutoffAt: run.dataCutoffAt,
            vocReport,
            keywordSnapshot,
            ...(vocSnapshot.payload.evidenceSelection ? { evidenceSelection: vocSnapshot.payload.evidenceSelection } : {}),
          }),
          model: options.config.model,
        },
        context: {
          actorId: actor.id,
          organizationId: actor.organizationId,
          projectId: project.id,
          dataCutoffAt: run.dataCutoffAt,
        },
      };
    },
  });
  const worker = new JobAttemptWorkerLoop({
    ...options.config.worker,
    repository: options.repository,
    stage: "product-definition",
    queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_VOC_QUEUE_TIMEOUT_MS,
    handler,
    ...(options.workerClock ? { clock: options.workerClock } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return Object.freeze({ start: () => worker.start(), stop: () => worker.stop() });
}

function unavailableDependencies() {
  return new WorkerTaskError("data-quality", "Product definition dependencies are unavailable");
}
