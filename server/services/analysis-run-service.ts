import type {
  AnalysisRun,
  ApiError,
  CancelRunResponse,
  CreateRunRequest,
  CreateRunResponse,
  GetRunResponse,
  JobAttempt,
  RetryStageResponse,
  RunStage,
  StageName,
} from "../../shared/agent-contracts";
import {
  ApiErrorSchema,
  CancelRunResponseSchema,
  GetRunResponseSchema,
  JobAttemptSchema,
  RetryStageResponseSchema,
} from "../../shared/agent-contracts";
import type {
  AgentRepository,
  AnalysisRunRecord,
  JobAttemptRecord,
  RunStageRecord,
} from "../db/repository";
import {
  AnalysisOrchestrator,
  type KeywordAnalysisArtifact,
} from "../orchestrator/analysis-orchestrator";
import { stageDefinitions } from "../orchestrator/stage-definitions";

export interface AnalysisExecutionContext {
  readonly actorId: string;
  readonly organizationId: string;
}

export interface AnalysisDependencyStateProvider {
  getKeywordAnalysisArtifact(
    runId: string,
  ): Promise<KeywordAnalysisArtifact>;
}

export interface AnalysisRunServiceOptions {
  readonly repository: AgentRepository;
  readonly executionContext: AnalysisExecutionContext;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly orchestrator?: AnalysisOrchestrator;
  readonly dependencyStateProvider?: AnalysisDependencyStateProvider;
}

export class AnalysisLifecycleError extends Error {
  constructor(
    readonly statusCode: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisLifecycleError";
  }
}

export class AnalysisRunService {
  readonly #repository: AgentRepository;
  readonly #context: AnalysisExecutionContext;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #orchestrator: AnalysisOrchestrator;
  readonly #dependencyStateProvider: AnalysisDependencyStateProvider;

  constructor(options: AnalysisRunServiceOptions) {
    this.#repository = options.repository;
    this.#context = Object.freeze({ ...options.executionContext });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    this.#orchestrator = options.orchestrator ?? new AnalysisOrchestrator();
    this.#dependencyStateProvider =
      options.dependencyStateProvider ?? unavailableDependencyStateProvider;
  }

  createRun(
    projectId: string,
    input: CreateRunRequest,
  ): Promise<CreateRunResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const project = await repository.findProjectById(projectId);
      if (!project || project.organizationId !== this.#context.organizationId) {
        throw new AnalysisLifecycleError(404, "Project not found");
      }

      const createdAt = this.#now();
      const candidate: AnalysisRunRecord = {
        id: this.#createId(),
        projectId,
        mode: input.mode,
        status: "queued",
        createdBy: this.#context.actorId,
        dataCutoffAt: input.dataCutoffAt ?? createdAt,
        idempotencyScope: [
          "organization",
          this.#context.organizationId,
          "actor",
          this.#context.actorId,
          "project",
          projectId,
        ].join(":"),
        idempotencyKey: input.idempotencyKey,
        createdAt,
        updatedAt: createdAt,
      };
      const creation = await repository.createAnalysisRunOnce(candidate);
      if (!creation.created) {
        return this.#getRun(repository, creation.run.id);
      }

      const stages: RunStageRecord[] = [];
      for (const definition of stageDefinitions) {
        const stage = await repository.createRunStage({
          id: this.#createId(),
          runId: creation.run.id,
          stage: definition.name,
          status: "queued",
          progress: 0,
          attemptCount: 0,
          startedAt: null,
          completedAt: null,
          lastError: null,
          createdAt,
          updatedAt: createdAt,
        });
        stages.push(stage);
      }

      const runnable = this.#orchestrator.findRunnableStages({
        stages: stages.map((stage) => ({
          name: stage.stage,
          status: stage.status,
          resultVersion: null,
        })),
        artifacts: {
          keywordAnalysis: { available: false, version: null },
        },
        selection: { kind: "all" },
      });
      for (const stage of stages) {
        if (!runnable.includes(stage.stage)) continue;
        await repository.enqueueJob({
          id: this.#createId(),
          stageId: stage.id,
          attemptNumber: 1,
          maxAttempts: 3,
          availableAt: createdAt,
          createdAt,
        });
      }

      return this.#getRun(repository, creation.run.id);
    });
  }

  getRun(runId: string): Promise<GetRunResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      return this.#getRun(repository, runId);
    });
  }

  cancelRun(
    runId: string,
    requestId = "server-execution",
  ): Promise<CancelRunResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const aggregate = await this.#getRun(repository, runId);
      if (aggregate.run.status === "succeeded") {
        throw new AnalysisLifecycleError(409, "Succeeded runs cannot be cancelled");
      }
      if (aggregate.run.status === "cancelled") {
        return CancelRunResponseSchema.parse({ run: aggregate.run });
      }

      const cancelledAt = this.#now();
      const run = await repository.cancelAnalysisRun({
        runId,
        cancelledAt,
        error: ApiErrorSchema.parse({
          code: "CANCELLED",
          message: "Run was cancelled",
          requestId,
        }),
      });
      if (!run) throw new AnalysisLifecycleError(404, "Run not found");
      return CancelRunResponseSchema.parse({ run: publicRun(run) });
    });
  }

  retryStage(
    runId: string,
    stageName: StageName,
  ): Promise<RetryStageResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const run = await repository.findAnalysisRun(runId);
      if (!run) throw new AnalysisLifecycleError(404, "Run not found");
      const project = await repository.findProjectById(run.projectId);
      if (!project || project.organizationId !== this.#context.organizationId) {
        throw new AnalysisLifecycleError(404, "Run not found");
      }
      if (run.status === "cancelled") {
        throw new AnalysisLifecycleError(409, "Cancelled runs cannot be retried");
      }
      const stages = await repository.listRunStages(runId);
      const target = stages.find((stage) => stage.stage === stageName);
      if (!target) throw new AnalysisLifecycleError(404, "Stage not found");
      if (target.status !== "failed") {
        throw new AnalysisLifecycleError(409, "Only failed stages can be retried");
      }

      const plan = stages.map((stage) => ({
        name: stage.stage,
        status: stage.status,
        resultVersion: null,
      }));
      const keywordAnalysis =
        await this.#dependencyStateProvider.getKeywordAnalysisArtifact(runId);
      const runnable = this.#orchestrator.findRunnableStages({
        stages: plan,
        artifacts: { keywordAnalysis },
        selection: { kind: "stage-rerun", stage: stageName },
      });
      if (!runnable.includes(stageName)) {
        throw new AnalysisLifecycleError(
          409,
          "Stage dependencies are not satisfied",
        );
      }
      const stalePlan = this.#orchestrator.markDownstreamStale(plan, [
        { kind: "stage", stage: stageName },
      ]);
      const staleStageIds = stages
        .filter((stage) => {
          const planned = stalePlan.find(({ name }) => name === stage.stage);
          return stage.status === "succeeded" && planned?.status === "stale";
        })
        .map((stage) => stage.id);
      const retried = await repository.retryFailedRunStage({
        runId,
        stageId: target.id,
        staleStageIds,
        jobId: this.#createId(),
        retriedAt: this.#now(),
        maxAutomaticAttempts: 3,
      });
      if (!retried) {
        throw new AnalysisLifecycleError(409, "Stage is no longer failed");
      }
      return RetryStageResponseSchema.parse({
        stage: publicStage(retried.stage),
        attempt: publicAttempt(retried.attempt),
      });
    });
  }

  async #assertExecutionActor(repository: AgentRepository): Promise<void> {
    const actor = await repository.findUserById(this.#context.actorId);
    if (
      !actor ||
      actor.status !== "active" ||
      actor.organizationId !== this.#context.organizationId
    ) {
      throw new AnalysisLifecycleError(
        403,
        "Execution context is not authorized",
      );
    }
  }

  async #getRun(
    repository: AgentRepository,
    runId: string,
  ): Promise<GetRunResponse> {
    const run = await repository.findAnalysisRun(runId);
    if (!run) throw new AnalysisLifecycleError(404, "Run not found");
    const project = await repository.findProjectById(run.projectId);
    if (!project || project.organizationId !== this.#context.organizationId) {
      throw new AnalysisLifecycleError(404, "Run not found");
    }
    const stages = await repository.listRunStages(run.id);
    return GetRunResponseSchema.parse({
      run: publicRun(run),
      stages: stages.map(publicStage),
    });
  }
}

const unavailableDependencyStateProvider: AnalysisDependencyStateProvider =
  Object.freeze({
    async getKeywordAnalysisArtifact() {
      return Object.freeze({ available: false, version: null });
    },
  });

function publicRun(run: AnalysisRunRecord): AnalysisRun {
  return {
    id: run.id,
    projectId: run.projectId,
    mode: run.mode,
    status: run.status,
    createdBy: run.createdBy,
    dataCutoffAt: run.dataCutoffAt,
    idempotencyKey: run.idempotencyKey,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function publicStage(stage: RunStageRecord): RunStage {
  return {
    id: stage.id,
    runId: stage.runId,
    stage: stage.stage,
    status: stage.status,
    progress: stage.progress,
    attemptCount: stage.attemptCount,
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
    lastError:
      stage.lastError === null
        ? null
        : publicPersistedError(stage.lastError, `worker-stage:${stage.id}`),
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
  };
}

function publicAttempt(attempt: JobAttemptRecord): JobAttempt {
  return JobAttemptSchema.parse({
    id: attempt.id,
    stageId: attempt.stageId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    leasedBy: attempt.leasedBy,
    leaseExpiresAt: attempt.leaseExpiresAt,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    error:
      attempt.error === null
        ? null
        : publicPersistedError(
            attempt.error,
            `worker-attempt:${attempt.id}`,
          ),
    createdAt: attempt.createdAt,
  });
}

const workerErrorCodes = {
  validation: "VALIDATION_ERROR",
  configuration: "CONFIGURATION_ERROR",
  authentication: "AUTHENTICATION_REQUIRED",
  "rate-limit": "RATE_LIMITED",
  "upstream-temporary": "UPSTREAM_TEMPORARY",
  "upstream-permanent": "UPSTREAM_PERMANENT",
  "data-quality": "DATA_QUALITY_ERROR",
  "model-output": "MODEL_OUTPUT_ERROR",
  infrastructure: "INFRASTRUCTURE_ERROR",
  cancelled: "CANCELLED",
} as const;

function publicPersistedError(
  error: Record<string, unknown>,
  requestId: string,
): ApiError {
  const alreadyPublic = ApiErrorSchema.safeParse(error);
  if (alreadyPublic.success) return alreadyPublic.data;

  const classification =
    typeof error.classification === "string" ? error.classification : "";
  const code =
    workerErrorCodes[classification as keyof typeof workerErrorCodes] ??
    "INFRASTRUCTURE_ERROR";
  const message =
    typeof error.message === "string" && error.message.trim().length > 0
      ? error.message
      : "Stage execution failed";
  return ApiErrorSchema.parse({
    code,
    message,
    requestId,
    retryable:
      classification === "rate-limit" ||
      classification === "upstream-temporary",
  });
}
import { randomUUID } from "node:crypto";
