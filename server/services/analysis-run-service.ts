import { randomUUID } from "node:crypto";
import { vocQueueTimeoutError } from "../domain/voc/queue-deadline";

import type {
  AnalysisRun,
  ApiError,
  ApiErrorCode,
  CancelRunResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateRunRequest,
  CreateRunResponse,
  GetProjectResponse,
  GetRunResponse,
  GetReportResponse,
  JobAttempt,
  ListProjectsResponse,
  ListReportsResponse,
  RetryStageResponse,
  RunStage,
  StageName,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from "../../shared/agent-contracts";
import {
  ApiErrorSchema,
  CancelRunResponseSchema,
  CreateProjectResponseSchema,
  GetReportResponseSchema,
  GetProjectResponseSchema,
  GetRunResponseSchema,
  JobAttemptSchema,
  ListProjectsResponseSchema,
  ListReportsResponseSchema,
  RetryStageResponseSchema,
  UpdateProjectResponseSchema,
} from "../../shared/agent-contracts";
import type { RequestPrincipal } from "../auth/authorization";
import type { DataSnapshotRepository } from "../db/data-snapshot-repository";
import {
  IdempotencyKeyReusedError,
  createRunCreationFingerprint,
} from "../db/manual-alexa-voc-repository";
import {
  ProjectCreationIdempotencyConflictError,
  type ComparisonProjectRepository,
  type AgentRepository,
  type AnalysisRunRecord,
  type JobAttemptRecord,
  type ManualAlexaVocRepositoryCapability,
  type ProjectRecord,
  type RunStageRecord,
} from "../db/repository";
import {
  RepositoryVocSourceReader,
  type RepositoryVocReadInput,
  type RepositoryVocReadResult,
} from "../data/repository-voc-source";
import type { VocDataSnapshotRecord } from "../data/voc-data-snapshot";
import {
  AnalysisOrchestrator,
  type KeywordAnalysisArtifact,
} from "../orchestrator/analysis-orchestrator";
import { stageDefinitions } from "../orchestrator/stage-definitions";
import {
  VocDataSnapshotServiceError,
  persistVocDataSnapshot,
} from "./voc-data-snapshot-service";

export interface AnalysisExecutionContext {
  readonly actorId: string;
  readonly organizationId: string;
}

export interface AnalysisDependencyStateProvider {
  /**
   * Returns a snapshot of trusted server-side dependency state. An available
   * artifact must have a non-empty version that permanently identifies one
   * immutable persisted artifact; a version must never be reused for new
   * content. The provider is external to the lifecycle write transaction.
   */
  getKeywordAnalysisArtifact(
    runId: string,
  ): Promise<KeywordAnalysisArtifact>;
}

export interface AnalysisRunServiceOptions {
  readonly repository: AnalysisRunRepository;
  readonly executionContext: AnalysisExecutionContext;
  readonly principal?: RequestPrincipal;
  readonly sourceReader?: Readonly<{
    read(input: RepositoryVocReadInput): Promise<RepositoryVocReadResult>;
  }>;
  readonly manualAlexaVocSourcePolicy?: Readonly<{
    dynamicReadEnabled: boolean;
    legacyFallbackEnabled: boolean;
  }>;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly orchestrator?: AnalysisOrchestrator;
  readonly dependencyStateProvider?: AnalysisDependencyStateProvider;
}

type AnalysisRunRepository = AgentRepository &
  DataSnapshotRepository &
  ManualAlexaVocRepositoryCapability;

export class AnalysisLifecycleError extends Error {
  constructor(
    readonly statusCode: 403 | 404 | 409 | 503,
    message: string,
    readonly apiErrorCode?: ApiErrorCode,
  ) {
    super(message);
    this.name = "AnalysisLifecycleError";
  }
}

export class AnalysisRunService {
  readonly #repository: AnalysisRunRepository;
  readonly #context: AnalysisExecutionContext;
  readonly #principal: RequestPrincipal;
  readonly #sourceReader: NonNullable<AnalysisRunServiceOptions["sourceReader"]>;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #orchestrator: AnalysisOrchestrator;
  readonly #dependencyStateProvider: AnalysisDependencyStateProvider;

  constructor(options: AnalysisRunServiceOptions) {
    this.#repository = options.repository;
    this.#context = Object.freeze({ ...options.executionContext });
    this.#principal = options.principal ?? Object.freeze({
      kind: "user" as const,
      userId: this.#context.actorId,
      organizationId: this.#context.organizationId,
      email: "internal-analysis-execution@example.invalid",
      role: "member" as const,
      sessionId: this.#context.actorId,
    });
    this.#sourceReader = options.sourceReader ?? new RepositoryVocSourceReader({
      manualVoc: options.repository.manualAlexaVoc,
      dynamicReadEnabled: options.manualAlexaVocSourcePolicy?.dynamicReadEnabled,
      legacyFallbackEnabled: options.manualAlexaVocSourcePolicy?.legacyFallbackEnabled,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    this.#orchestrator = options.orchestrator ?? new AnalysisOrchestrator();
    this.#dependencyStateProvider =
      options.dependencyStateProvider ?? unavailableDependencyStateProvider;
  }

  createProject(input: CreateProjectRequest, idempotencyKey: string): Promise<{
    response: CreateProjectResponse;
    created: boolean;
  }> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const createProjectOnce = comparisonCapability(repository, "createProjectOnce");
      const createdAt = this.#now();
      try {
        const result = await createProjectOnce({
          idempotencyKey,
          project: {
            id: input.id ?? this.#createId(),
            organizationId: this.#context.organizationId,
            name: input.name,
            marketplace: input.marketplace,
            asins: [...input.asins],
            createdBy: this.#context.actorId,
            createdAt,
            updatedAt: createdAt,
          },
        });
        return {
          response: CreateProjectResponseSchema.parse({ project: result.project }),
          created: result.created,
        };
      } catch (error) {
        if (error instanceof ProjectCreationIdempotencyConflictError) {
          throw new AnalysisLifecycleError(
            409,
            error.message,
            "IDEMPOTENCY_KEY_REUSED",
          );
        }
        throw error;
      }
    });
  }

  async createRun(
    projectId: string,
    input: CreateRunRequest,
  ): Promise<CreateRunResponse> {
    const created = await this.createRunWithVocSnapshot({
      principal: this.#principal,
      projectId,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
    });
    return this.getRun(created.run.id);
  }

  async createRunWithVocSnapshot(input: Readonly<{
    principal: RequestPrincipal;
    projectId: string;
    mode: "existing-data" | "collect-missing";
    idempotencyKey: string;
  }>): Promise<Readonly<{
    run: AnalysisRun;
    snapshot: VocDataSnapshotRecord;
  }>> {
    this.#assertRequestPrincipal(input.principal);
    try {
      return await this.#repository.transaction(async (baseRepository) => {
        const repository = baseRepository as AnalysisRunRepository;
        await this.#assertExecutionActor(repository);
        const project = await repository.findProjectById(input.projectId);
        if (!project || project.organizationId !== this.#context.organizationId) {
          throw new AnalysisLifecycleError(404, "Project not found");
        }
        if (project.marketplace !== "US") {
          throw new AnalysisLifecycleError(409, "Project marketplace is not supported");
        }
        const fingerprint = createRunCreationFingerprint({
          organizationId: project.organizationId,
          projectId: project.id,
          marketplace: "US",
          asins: project.asins,
          mode: input.mode,
        });
        const claim = await repository.manualAlexaVoc.claimRunCreation({
          organizationId: project.organizationId,
          idempotencyKey: input.idempotencyKey,
          fingerprint,
        });
        if (claim.kind === "conflict") throw new IdempotencyKeyReusedError();
        if (claim.kind === "replay") {
          return this.#readOriginalRunAndSnapshot(
            repository,
            project,
            claim.runId,
            claim.snapshotId,
          );
        }

        await repository.manualAlexaVoc.lockScopes({
          organizationId: project.organizationId,
          marketplace: "US",
          asins: [...project.asins].sort(),
        });
        const dataCutoffAt = await repository.manualAlexaVoc.readDatabaseClock();
        const source = await this.#sourceReader.read({
          organizationId: project.organizationId,
          marketplace: "US",
          asins: project.asins,
          dataCutoffAt,
        });
        if (!source.candidate) {
          throw new AnalysisLifecycleError(
            409,
            "VOC source data is not available for this run",
          );
        }

        const runCandidate: AnalysisRunRecord = {
          id: this.#createId(),
          projectId: project.id,
          mode: input.mode,
          status: "queued",
          createdBy: this.#context.actorId,
          dataCutoffAt,
          idempotencyScope: `organization:${project.organizationId}:run-create`,
          idempotencyKey: input.idempotencyKey,
          createdAt: dataCutoffAt,
          updatedAt: dataCutoffAt,
        };
        const creation = await repository.createAnalysisRunOnce(runCandidate);
        if (!creation.created) throw new IdempotencyKeyReusedError();
        await this.#createInitialStagesAndJobs(
          repository,
          creation.run,
          dataCutoffAt,
        );
        const snapshot = await persistVocDataSnapshot({
          repository,
          actorId: this.#context.actorId,
          organizationId: project.organizationId,
          runId: creation.run.id,
          projectId: project.id,
          marketplace: "US",
          asins: project.asins,
          dataCutoffAt,
          candidateId: this.#createId(),
          createdAt: dataCutoffAt,
          candidate: source.candidate,
        });
        await repository.manualAlexaVoc.completeRunCreation({
          organizationId: project.organizationId,
          idempotencyKey: input.idempotencyKey,
          fingerprint,
          runId: creation.run.id,
          snapshotId: snapshot.id,
          completedAt: dataCutoffAt,
        });
        return Object.freeze({
          run: publicRun(creation.run),
          snapshot,
        });
      });
    } catch (error) {
      throw normalizeRunCreationError(error);
    }
  }

  async #readOriginalRunAndSnapshot(
    repository: AnalysisRunRepository,
    project: ProjectRecord,
    runId: string,
    snapshotId: string,
  ) {
    const run = await repository.findAnalysisRun(runId);
    const snapshot = await repository.findDataSnapshotById({
      actorOrganizationId: project.organizationId,
      snapshotId,
    });
    if (
      !run ||
      run.projectId !== project.id ||
      run.idempotencyKey.length === 0 ||
      !snapshot ||
      snapshot.runId !== run.id ||
      snapshot.marketplace !== project.marketplace ||
      snapshot.asins.length !== project.asins.length ||
      !snapshot.asins.every((asin, index) => asin === project.asins[index]) ||
      snapshot.dataCutoffAt !== run.dataCutoffAt
    ) {
      throw new AnalysisLifecycleError(
        409,
        "Stored run creation replay is inconsistent",
      );
    }
    return Object.freeze({ run: publicRun(run), snapshot });
  }

  async #createInitialStagesAndJobs(
    repository: AnalysisRunRepository,
    run: AnalysisRunRecord,
    createdAt: string,
  ): Promise<void> {
    const stages: RunStageRecord[] = [];
    for (const definition of stageDefinitions) {
      if (definition.creationPolicy !== "initial") continue;
      const waitingForProductDependencies = definition.name === "product-definition";
      const stage = await repository.createRunStage({
        id: this.#createId(),
        runId: run.id,
        stage: definition.name,
        status: waitingForProductDependencies ? "waiting-input" : "queued",
        progress: 0,
        attemptCount: 0,
        startedAt: null,
        completedAt: null,
        lastError: waitingForProductDependencies
          ? {
              code: "DATA_QUALITY_ERROR",
              message: "Product definition dependencies are not satisfied",
              requestId: `product-dependencies:${run.id}`,
              details: [
                { path: "dependencies.voc-positioning-report", message: "Validated VOC positioning report is required" },
                { path: "dependencies.keyword-analysis-snapshot", message: "Keyword analysis snapshot is required" },
              ],
              retryable: false,
            }
          : null,
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
  }

  #assertRequestPrincipal(principal: RequestPrincipal): void {
    if (
      principal.kind === "user" &&
      (principal.userId !== this.#context.actorId ||
        principal.organizationId !== this.#context.organizationId)
    ) {
      throw new AnalysisLifecycleError(403, "Execution context is not authorized");
    }
  }

  getProject(projectId: string): Promise<GetProjectResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const project = await repository.findProjectById(projectId);
      if (!project || project.organizationId !== this.#context.organizationId) {
        throw new AnalysisLifecycleError(404, "Project not found");
      }
      return GetProjectResponseSchema.parse({ project });
    });
  }

  listProjects(): Promise<ListProjectsResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const listProjects = comparisonCapability(repository, "listProjectsByOrganization");
      return ListProjectsResponseSchema.parse({
        projects: await listProjects(this.#context.organizationId),
      });
    });
  }

  updateProject(
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<UpdateProjectResponse> {
    if ("marketplace" in input || "asins" in input) {
      throw new AnalysisLifecycleError(
        409,
        "Project marketplace and ordered ASIN scope are immutable",
        "IMMUTABLE_SCOPE",
      );
    }
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const updateProjectMetadata = comparisonCapability(repository, "updateProjectMetadata");
      const project = await updateProjectMetadata({
        organizationId: this.#context.organizationId,
        projectId,
        name: input.name,
        updatedAt: this.#now(),
      });
      if (!project) throw new AnalysisLifecycleError(404, "Project not found", "NOT_FOUND");
      return UpdateProjectResponseSchema.parse({ project });
    });
  }

  getRun(runId: string): Promise<GetRunResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      return this.#getRun(repository, runId);
    });
  }

  listReports(runId: string): Promise<ListReportsResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      await this.#getRun(repository, runId);
      const listReports = repository.listAnalysisReports;
      if (!listReports) {
        throw new AnalysisLifecycleError(503, "Analysis reports are not configured", "CONFIGURATION_ERROR");
      }
      const reports = await Promise.all(
        (["traffic-analysis", "voc-positioning", "product-definition"] as const).map((stage) =>
          listReports.call(repository, {
            actorOrganizationId: this.#context.organizationId,
            runId,
            stage,
          }),
        ),
      );
      return ListReportsResponseSchema.parse({ reports: reports.flat() });
    });
  }

  getReport(reportId: string): Promise<GetReportResponse> {
    return this.#repository.transaction(async (repository) => {
      await this.#assertExecutionActor(repository);
      const findReport = repository.findAnalysisReportById;
      if (!findReport) {
        throw new AnalysisLifecycleError(503, "Analysis reports are not configured", "CONFIGURATION_ERROR");
      }
      const report = await findReport.call(repository, {
        actorOrganizationId: this.#context.organizationId,
        reportId,
      });
      if (!report) throw new AnalysisLifecycleError(404, "Report not found");
      return GetReportResponseSchema.parse({ report });
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

  async retryStage(
    runId: string,
    stageName: StageName,
  ): Promise<RetryStageResponse> {
    const preflight = await this.#loadAuthorizedRetryState(
      this.#repository,
      runId,
      stageName,
    );
    const keywordAnalysis = await this.#loadKeywordAnalysisArtifact(
      runId,
      stageName,
      preflight.stages,
    );

    return this.#repository.transaction(async (repository) => {
      const current = await this.#loadAuthorizedRetryState(
        repository,
        runId,
        stageName,
      );

      const plan = current.stages.map((stage) => ({
        name: stage.stage,
        status: stage.status,
        resultVersion: null,
      }));
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
      const staleStageIds = current.stages
        .filter((stage) => {
          const planned = stalePlan.find(({ name }) => name === stage.stage);
          return stage.status === "succeeded" && planned?.status === "stale";
        })
        .map((stage) => stage.id);
      const retried = await repository.retryFailedRunStage({
        runId,
        stageId: current.target.id,
        staleStageIds,
        jobId: this.#createId(),
        retriedAt: this.#now(),
        maxAutomaticAttempts: 3,
      });
      if (!retried) {
        throw new AnalysisLifecycleError(
          409,
          "Stage is no longer eligible for retry or rerun",
        );
      }
      return RetryStageResponseSchema.parse({
        stage: publicStage(retried.stage),
        attempt: publicAttempt(retried.attempt),
      });
    });
  }

  async #loadAuthorizedRetryState(
    repository: AgentRepository,
    runId: string,
    stageName: StageName,
  ): Promise<Readonly<{
    stages: readonly RunStageRecord[];
    target: RunStageRecord;
  }>> {
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
    if (target.status !== "failed" && target.status !== "succeeded") {
      throw new AnalysisLifecycleError(
        409,
        "Only failed or succeeded stages can be retried or rerun",
      );
    }
    return Object.freeze({ stages: Object.freeze(stages), target });
  }

  async #loadKeywordAnalysisArtifact(
    runId: string,
    stageName: StageName,
    stages: readonly RunStageRecord[],
  ): Promise<KeywordAnalysisArtifact> {
    const unavailable = unavailableKeywordAnalysisArtifact();
    const runnableWithoutArtifact = this.#orchestrator.findRunnableStages({
      stages: stages.map((stage) => ({
        name: stage.stage,
        status: stage.status,
        resultVersion: null,
      })),
      artifacts: { keywordAnalysis: unavailable },
      selection: { kind: "stage-rerun", stage: stageName },
    });
    if (runnableWithoutArtifact.includes(stageName)) return unavailable;

    try {
      return normalizeKeywordAnalysisArtifact(
        await this.#dependencyStateProvider.getKeywordAnalysisArtifact(runId),
      );
    } catch {
      throw new AnalysisLifecycleError(
        503,
        "Dependency state is unavailable",
        "CONFIGURATION_ERROR",
      );
    }
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

function normalizeRunCreationError(error: unknown): Error {
  if (
    error instanceof AnalysisLifecycleError ||
    error instanceof IdempotencyKeyReusedError
  ) {
    return error;
  }

  if (error instanceof VocDataSnapshotServiceError) {
    return new AnalysisLifecycleError(
      409,
      "Trusted analysis run changed while creating its data snapshot",
    );
  }
  return new AnalysisLifecycleError(
    503,
    "Analysis run storage is unavailable",
    "INFRASTRUCTURE_ERROR",
  );
}

const unavailableDependencyStateProvider: AnalysisDependencyStateProvider =
  Object.freeze({
    async getKeywordAnalysisArtifact() {
      return unavailableKeywordAnalysisArtifact();
    },
  });

function unavailableKeywordAnalysisArtifact(): KeywordAnalysisArtifact {
  return Object.freeze({ available: false, version: null });
}

function normalizeKeywordAnalysisArtifact(
  artifact: KeywordAnalysisArtifact,
): KeywordAnalysisArtifact {
  if (!artifact.available && artifact.version === null) {
    return unavailableKeywordAnalysisArtifact();
  }
  if (
    artifact.available &&
    typeof artifact.version === "string" &&
    artifact.version.trim().length > 0
  ) {
    return Object.freeze({
      available: true,
      version: artifact.version.trim(),
    });
  }
  throw new TypeError("Invalid keyword analysis artifact state");
}

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
  if (error.code === "QUEUE_TIMEOUT") {
    return ApiErrorSchema.parse({ ...vocQueueTimeoutError(), requestId });
  }
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

function comparisonCapability<Key extends keyof ComparisonProjectRepository>(
  repository: AgentRepository,
  key: Key,
): ComparisonProjectRepository[Key] {
  const capability = repository[key];
  if (typeof capability !== "function") {
    throw new AnalysisLifecycleError(
      503,
      "Comparison project repository is not configured",
      "CONFIGURATION_ERROR",
    );
  }
  return capability.bind(repository) as ComparisonProjectRepository[Key];
}
