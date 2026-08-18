import { resolve } from "node:path";

import type { VocPositioningRuntimeConfig } from "../config";
import type { RuntimeAgentRepository } from "../db/repository";
import { preprocessVocSnapshot } from "../domain/voc/preprocess-voc-snapshot";
import { createVocPositioningJobHandler } from "../services/voc-positioning-worker-handler";
import {
  VocPositioningExecutionService,
  VocPositioningInputUnavailableError,
} from "../services/voc-positioning-execution-service";
import { SkillRegistry } from "../skills/registry";
import { AuditedSkillRunner } from "./agent-run-service";
import {
  ModelBudgetCoordinator,
  StaticModelBudgetLimitProvider,
} from "./model-budget-coordinator";
import type { ModelProvider } from "./model-provider";
import {
  OpenAIProvider,
  type OpenAIProviderOptions,
} from "./openai-provider";
import { WorkerTaskError } from "./retry-policy";
import { SkillRunner, type ModelValidationLogger } from "./skill-runner";
import {
  JobAttemptWorkerLoop,
  type WorkerClock,
  type WorkerLogger,
} from "./worker-loop";

export interface VocPositioningRuntimeOptions {
  repository: RuntimeAgentRepository;
  config: VocPositioningRuntimeConfig;
  provider?: ModelProvider;
  providerFactory?: (options: OpenAIProviderOptions) => ModelProvider;
  providerName?: string;
  skillsRoot?: string;
  clock?: () => Date;
  workerClock?: WorkerClock;
  logger?: WorkerLogger;
  validationLogger?: ModelValidationLogger;
}

export interface VocPositioningRuntime {
  start(): void;
  stop(): Promise<void>;
}

export async function createVocPositioningRuntime(
  options: VocPositioningRuntimeOptions,
): Promise<VocPositioningRuntime> {
  const clock = options.clock ?? (() => new Date());
  const registry = await SkillRegistry.open(
    options.skillsRoot ?? resolve("skills-src"),
  );
  const providerFactory =
    options.providerFactory ??
    ((providerOptions: OpenAIProviderOptions) =>
      new OpenAIProvider(providerOptions));
  const provider = options.provider ??
    providerFactory({
      apiKey: options.config.apiKey,
      transport: options.config.transport,
      baseUrl: options.config.baseUrl,
    });
  const providerName = options.providerName ?? options.config.providerName;
  const budgetCoordinator = new ModelBudgetCoordinator({
    repository: options.repository,
    limitProvider: new StaticModelBudgetLimitProvider(
      options.config.budgetLimits,
    ),
    clock,
  });
  const skillRunner = new SkillRunner({
    registry,
    provider,
    providerName,
    budgetCoordinator,
    now: () => clock().getTime(),
    ...(options.validationLogger
      ? { validationLogger: options.validationLogger }
      : {}),
  });
  const auditedRunner = new AuditedSkillRunner({
    skillRunner,
    repository: options.repository,
    clock,
  });
  const service = new VocPositioningExecutionService({
    repository: options.repository,
    auditedRunner,
    clock,
  });
  const handler = createVocPositioningJobHandler({
    service,
    prepare: async (job) => {
      const run = await options.repository.findAnalysisRun(job.runId);
      if (!run) throw trustedSubjectError();
      const project = await options.repository.findProjectById(run.projectId);
      if (!project) throw trustedSubjectError();
      const actor = await options.repository.findUserById(run.createdBy);
      if (
        !actor ||
        actor.status !== "active" ||
        actor.organizationId !== project.organizationId
      ) {
        throw trustedSubjectError();
      }
      const snapshots = await options.repository.listDataSnapshotsByRun({
        actorOrganizationId: project.organizationId,
        runId: run.id,
      });
      if (snapshots.length === 0) {
        throw new VocPositioningInputUnavailableError();
      }
      if (snapshots.length !== 1) {
        throw new WorkerTaskError(
          "data-quality",
          "VOC positioning requires exactly one trusted immutable snapshot",
        );
      }
      const snapshot = snapshots[0]!;
      return {
        request: {
          snapshotId: snapshot.id,
          facts: preprocessVocSnapshot(snapshot),
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
    repository: options.repository,
    ownerId: options.config.worker.ownerId,
    stage: "voc-positioning",
    handler,
    leaseDurationMs: options.config.worker.leaseDurationMs,
    heartbeatIntervalMs: options.config.worker.heartbeatIntervalMs,
    pollIntervalMs: options.config.worker.pollIntervalMs,
    stopTimeoutMs: options.config.worker.stopTimeoutMs,
    retryPolicy: options.config.worker.retryPolicy,
    ...(options.workerClock ? { clock: options.workerClock } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return Object.freeze({
    start: () => worker.start(),
    stop: () => worker.stop(),
  });
}

function trustedSubjectError() {
  return new WorkerTaskError(
    "configuration",
    "VOC positioning trusted execution subject is unavailable",
  );
}
