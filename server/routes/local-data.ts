import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createAnalysisProject,
  deleteAnalysisProject,
  fetchProject,
  fetchProjects,
  updateAnalysisProject,
  type AnalysisProject,
  type ProjectKind,
} from "../../app/lib/project-server";
import {
  fetchAsinDataStatus,
  normalizeAsins,
  type AsinModuleStatus,
  type DynamicTrafficSnapshotAdapter,
  type SyncJob,
  type SyncJobScope,
} from "../../app/lib/sync-server";
import {
  LocalDataCreateProjectRequestSchema,
  LocalDataDeleteProjectResponseSchema,
  LocalDataProjectIdParamsSchema,
  LocalDataProjectListQuerySchema,
  LocalDataProjectResponseSchema,
  LocalDataProjectsResponseSchema,
  LocalDataStageOutputParamsSchema,
  LocalDataStageOutputResponseSchema,
  LocalDataSyncJobIdParamsSchema,
  LocalDataSyncJobSchema,
  LocalDataSyncReadinessQuerySchema,
  LocalDataSyncReadinessResponseSchema,
  LocalDataSyncResumeResponseSchema,
  LocalDataSyncStartRequestSchema,
  LocalDataSyncStartResponseSchema,
  SyncLegacyRepairApplyRequestSchema,
  SyncLegacyRepairResponseSchema,
  LocalDataUpdateProjectRequestSchema,
  TrafficSnapshotReadParamsSchema,
  TrafficSnapshotReadResponseSchema,
  type ApiErrorCode,
  type TrafficSnapshotReadResponse,
  type SyncLegacyRepairResponse,
} from "../../shared/agent-contracts";
import { ContractRouteError } from "./analysis-runs";
import type { RequestPrincipal } from "../auth/authorization";
import type { AuthenticationService } from "../auth/authentication-service";
import type { RuntimeAgentRepository } from "../db/repository";
import { SyncJobRunConflictError } from "../db/sync-job-repository";
import {
  isSyncJobAdmissionLimitError,
  SyncJobService,
} from "../services/sync-job-service";
import { ConnectorCredentialService } from "../services/connector-credential-service";
import {
  SyncProviderReadinessError,
  SyncProviderReadinessService,
} from "../services/sync-provider-readiness-service";
import {
  SyncLegacyRepairConflictError,
  SyncLegacyStatusRepairService,
  type SyncLegacyRepairRepository,
} from "../services/sync-legacy-status-repair-service";
import {
  SyncPublicationStatusService,
  type SyncPublication,
} from "../services/sync-publication-status-service";

export type StartAsinSyncResult = Awaited<ReturnType<SyncJobService["start"]>>;
export type ResumeAsinSyncResult = Awaited<ReturnType<SyncJobService["resume"]>>;

export type LocalDataBridgeDeps = {
  fetchProjects(options?: { kind?: ProjectKind }): Promise<AnalysisProject[]>;
  fetchProject(id: string): Promise<AnalysisProject | null>;
  createAnalysisProject(input: Record<string, unknown>): Promise<AnalysisProject>;
  updateAnalysisProject(id: string, patch: Record<string, unknown>): Promise<AnalysisProject | null>;
  deleteAnalysisProject(id: string): Promise<boolean>;
  normalizeAsins(values: unknown): Promise<string[] | null>;
  fetchAsinDataStatus(asins: string[]): Promise<AsinModuleStatus[]>;
  startAsinSyncJob(input: SyncJobScope & { asins: string[]; marketplace: string }): Promise<StartAsinSyncResult>;
  readJob(jobId: string): Promise<SyncJob | null>;
  readStageOutput?(input: {
    organizationId: string;
    projectId: string;
    runId: string;
    jobId: string;
    stage: "keywords" | "reviews" | "sales_trend" | "fba" | "listing" | "category" | "traffic";
  }): Promise<unknown | null>;
  readPublication?(jobId: string): Promise<SyncPublication>;
  resumeAsinSyncJob(jobId: string, principal: Extract<RequestPrincipal, { kind: "user" }>): Promise<ResumeAsinSyncResult>;
  previewLegacyStatusRepair?(input: {
    jobId: string;
    organizationId: string;
  }): Promise<SyncLegacyRepairResponse | null>;
  applyLegacyStatusRepair?(input: {
    jobId: string;
    organizationId: string;
    version: string;
  }): Promise<SyncLegacyRepairResponse | null>;
  readTrafficSnapshot?(input: {
    organizationId: string;
    runId: string;
  }): Promise<Omit<TrafficSnapshotReadResponse, "version" | "state"> | null>;
  authorizeSyncScope?(
    principal: RequestPrincipal,
    input: { projectId?: string; runId?: string },
  ): Promise<SyncJobScope | null>;
};

export function createDefaultLocalDataBridgeDeps(
  repository: RuntimeAgentRepository | null = null,
  options: {
    dynamicTrafficSnapshotAdapter?: DynamicTrafficSnapshotAdapter;
    providerReadiness?: SyncProviderReadinessService | null;
    bypassProviderReadiness?: boolean;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): LocalDataBridgeDeps {
  const providerReadiness = repository
    ? options.providerReadiness ?? new SyncProviderReadinessService({
        credentialServiceResolver: (organizationId) => new ConnectorCredentialService({
          repository,
          organizationId,
          env: options.env ?? {},
        }),
        connectorStatuses: repository,
      })
    : null;
  const syncJobService = repository
    ? new SyncJobService(repository.syncJobs, {
        providerReadiness,
        bypassProviderReadiness: options.bypassProviderReadiness ?? false,
      })
    : null;
  const legacyRepairService = repository?.syncJobs && isLegacyRepairRepository(repository.syncJobs)
    ? new SyncLegacyStatusRepairService({ repository: repository.syncJobs })
    : null;
  const publicationStatusService = new SyncPublicationStatusService();
  return {
    fetchProjects,
    fetchProject,
    createAnalysisProject,
    updateAnalysisProject,
    deleteAnalysisProject,
    normalizeAsins: async (values) => normalizeAsins(values),
    fetchAsinDataStatus,
    startAsinSyncJob: syncJobService
      ? (input) => syncJobService.start(input)
      : async () => unavailableSyncQueue(),
    readJob: syncJobService
      ? (jobId) => syncJobService.read(jobId)
      : async () => null,
    readStageOutput: syncJobService
      ? (input) => syncJobService.readStageOutput(input)
      : async () => null,
    readPublication: (jobId) => publicationStatusService.read(jobId),
    resumeAsinSyncJob: syncJobService
      ? (jobId, principal) => syncJobService.resume({
          jobId,
          organizationId: principal.organizationId,
          actorId: principal.userId,
        })
      : async () => unavailableSyncQueue(),
    ...(legacyRepairService ? {
      previewLegacyStatusRepair: (input: { jobId: string; organizationId: string }) =>
        legacyRepairService.preview(input),
      applyLegacyStatusRepair: (input: { jobId: string; organizationId: string; version: string }) =>
        legacyRepairService.apply(input),
    } : {}),
    async readTrafficSnapshot(input) {
      if (!repository) return null;
      const run = await repository.findAnalysisRun(input.runId);
      if (!run) return null;
      const project = await repository.findProjectById(run.projectId);
      if (!project || project.organizationId !== input.organizationId) return null;
      const snapshot = (await repository.listTrafficDataSnapshotsByRun({
        actorOrganizationId: input.organizationId,
        runId: run.id,
      }))
        .filter((item) => item.sources.every((source) => "connectorId" in source && source.connectorId === "sif"))
        .at(-1);
      if (!snapshot) return null;
      return {
        marketplace: snapshot.marketplace,
        asins: snapshot.asins,
        source: "sif",
        collectedAt: snapshot.sources.map((source) => source.capturedAt).sort().at(-1) ?? snapshot.createdAt,
        traffic: { competitors: snapshot.payload.input.competitors },
      };
    },
    async authorizeSyncScope(principal, input) {
      if (principal.kind !== "user") return null;
      if (!input.projectId && !input.runId) {
        return { organizationId: principal.organizationId, projectId: null, runId: null, actorId: principal.userId };
      }
      if (!repository) return null;
      const run = input.runId ? await repository.findAnalysisRun(input.runId) : null;
      if (input.runId && !run) return null;
      const projectId = input.projectId ?? run?.projectId;
      const project = projectId ? await repository.findProjectById(projectId) : null;
      if (!project || project.organizationId !== principal.organizationId) return null;
      if (run && run.projectId !== project.id) return null;
      return {
        organizationId: principal.organizationId,
        projectId: project.id,
        runId: run?.id ?? null,
        actorId: principal.userId,
      };
    },
  };
}

function isLegacyRepairRepository(
  repository: RuntimeAgentRepository["syncJobs"],
): repository is RuntimeAgentRepository["syncJobs"] & SyncLegacyRepairRepository {
  return typeof (repository as Partial<SyncLegacyRepairRepository>).applyLegacyStatusRepair === "function";
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ContractRouteError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "request",
      message: issue.message,
    })),
  );
}

function missing(message: string): never {
  throw new ContractRouteError(404, "NOT_FOUND", message);
}

function validation(message: string): never {
  throw new ContractRouteError(400, "VALIDATION_ERROR", message);
}

function unavailableSyncQueue(): never {
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "Sync job queue requires PostgreSQL storage",
  );
}

function syncScopeFor(
  deps: LocalDataBridgeDeps,
  principal: RequestPrincipal | null,
  input: { projectId?: string; runId?: string },
) {
  if (!principal || principal.kind !== "user") return Promise.resolve(null);
  if (deps.authorizeSyncScope) return deps.authorizeSyncScope(principal, input);
  if (input.projectId || input.runId) return Promise.resolve(null);
  return Promise.resolve({
    organizationId: principal.organizationId,
    projectId: null,
    runId: null,
  });
}

function publicSyncJob(job: SyncJob, publication?: SyncPublication) {
  const scope = job.scope
    ? {
        projectId: job.scope.projectId === "unscoped" ? null : job.scope.projectId,
        runId: job.scope.runId,
      }
    : undefined;
  return {
    jobId: job.jobId,
    asins: job.asins,
    marketplace: job.marketplace,
    status: job.status,
    message: job.message,
    currentStageId: job.currentStageId,
    stages: job.stages,
    asinProgress: job.asinProgress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.dynamicSnapshot ? { dynamicSnapshot: job.dynamicSnapshot } : {}),
    resumableStages: job.resumableStages ?? [],
    ...(job.alexaVoc ? { alexaVoc: job.alexaVoc } : {}),
    ...(publication && publication.status !== "not-required" ? { publication } : {}),
    ...(typeof job.needsReload === "boolean" ? { needsReload: job.needsReload } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(typeof job.queuePosition === "number" ? { queuePosition: job.queuePosition } : {}),
    ...(scope ? { scope } : {}),
  };
}

function rethrowLegacyError(error: unknown): never {
  if (error instanceof SyncJobRunConflictError) {
    throw new ContractRouteError(
      409,
      "CONFLICT",
      "Sync scope is not available for the requested run",
    );
  }
  if (error instanceof SyncProviderReadinessError) {
    throw new ContractRouteError(
      503,
      "CONFIGURATION_ERROR",
      "Required connectors are not ready",
      error.details.map((detail) => ({
        path: `connectors.${detail.connectorId}`,
        message: detail.causeCode,
      })),
    );
  }
  if (isSyncJobAdmissionLimitError(error)) {
    throw new ContractRouteError(
      429,
      "RATE_LIMITED",
      error instanceof Error ? error.message : "Sync job admission limit reached",
    );
  }
  const message = error instanceof Error ? error.message : "Local data operation failed";
  const apiErrorCode: ApiErrorCode = /required|empty|asins/i.test(message)
    ? "VALIDATION_ERROR"
    : "INFRASTRUCTURE_ERROR";
  const statusCode = apiErrorCode === "VALIDATION_ERROR" ? 400 : 500;
  throw new ContractRouteError(statusCode, apiErrorCode, message);
}

export function registerLocalDataRoutes(
  app: FastifyInstance,
  deps: LocalDataBridgeDeps = createDefaultLocalDataBridgeDeps(),
  authService: AuthenticationService | null = null,
) {
  app.get("/v1/local-data/projects", async (request) => {
    const query = parseContract(LocalDataProjectListQuerySchema, request.query);
    try {
      return LocalDataProjectsResponseSchema.parse({
        projects: await deps.fetchProjects(query.kind ? { kind: query.kind } : undefined),
      });
    } catch (error) {
      rethrowLegacyError(error);
    }
  });

  app.post("/v1/local-data/projects", async (request, reply) => {
    const body = parseContract(LocalDataCreateProjectRequestSchema, request.body);
    try {
      reply.status(201);
      return LocalDataProjectResponseSchema.parse({
        project: await deps.createAnalysisProject(body),
      });
    } catch (error) {
      rethrowLegacyError(error);
    }
  });

  app.get("/v1/local-data/projects/:id", async (request) => {
    const { id } = parseContract(LocalDataProjectIdParamsSchema, request.params);
    try {
      const project = await deps.fetchProject(id);
      if (!project) return missing("Project not found");
      return LocalDataProjectResponseSchema.parse({ project });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.patch("/v1/local-data/projects/:id", async (request) => {
    const { id } = parseContract(LocalDataProjectIdParamsSchema, request.params);
    const body = parseContract(LocalDataUpdateProjectRequestSchema, request.body);
    try {
      const project = await deps.updateAnalysisProject(id, body);
      if (!project) return missing("Project not found");
      return LocalDataProjectResponseSchema.parse({ project });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.delete("/v1/local-data/projects/:id", async (request) => {
    const { id } = parseContract(LocalDataProjectIdParamsSchema, request.params);
    try {
      if (!(await deps.deleteAnalysisProject(id))) return missing("Project not found");
      return LocalDataDeleteProjectResponseSchema.parse({ ok: true });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.get("/v1/local-data/sync-asins", async (request) => {
    const { asins: raw } = parseContract(LocalDataSyncReadinessQuerySchema, request.query);
    const asins = await deps.normalizeAsins(raw.split(","));
    if (!asins) return validation("Invalid ASINs");
    try {
      const items = await deps.fetchAsinDataStatus(asins);
      const needsSync = items.some((item) =>
        !item.inCatalog || item.keywords === "missing" || item.reviews === "missing" ||
        item.sales === "missing" || item.childSales === "missing" || item.priceStrategy === "missing" ||
        item.fba === "missing" || item.listing === "missing" || item.imageRemarks === "missing" ||
        item.category === "missing" ||
        item.traffic === "missing" || item.voc === "missing",
      );
      return LocalDataSyncReadinessResponseSchema.parse({
        asins,
        items,
        needsSync,
        vocPending: items.filter((item) => item.voc === "missing").map((item) => item.asin),
        catalogPending: items.filter((item) => !item.inCatalog).map((item) => item.asin),
      });
    } catch (error) {
      rethrowLegacyError(error);
    }
  });

  app.post("/v1/local-data/sync-asins", async (request, reply) => {
    const body = parseContract(LocalDataSyncStartRequestSchema, request.body);
    const asins = await deps.normalizeAsins(body.asins);
    if (!asins) return validation("Invalid ASINs");
    try {
      const scope = await syncScopeFor(deps, request.authPrincipal, body);
      if (!scope) return missing("Sync scope not found");
      const result = await deps.startAsinSyncJob({
        ...scope,
        asins,
        marketplace: body.marketplace ?? "US",
      });
      reply.status(202);
      return LocalDataSyncStartResponseSchema.parse({
        jobId: result.job.jobId,
        status: result.job.status,
        message: result.job.message,
        mcpAsinsPending: result.mcpAsinsPending,
        estimatedAutoSeconds: result.estimatedAutoSeconds,
        estimatedAlexaSeconds: result.estimatedAlexaSeconds,
        stages: result.job.stages,
        reused: result.reused,
        scope: {
          projectId: result.job.scope?.projectId ?? null,
          runId: result.job.scope?.runId ?? null,
        },
      });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.get("/v1/local-data/sync-asins/:jobId", async (request) => {
    const { jobId } = parseContract(LocalDataSyncJobIdParamsSchema, request.params);
    try {
      const job = await deps.readJob(jobId);
      if (!job) return missing("Sync job not found");
      if (
        job.scope?.organizationId &&
        (request.authPrincipal?.kind !== "user" || job.scope.organizationId !== request.authPrincipal.organizationId)
      ) return missing("Sync job not found");
      const publication = deps.readPublication ? await deps.readPublication(jobId) : undefined;
      return LocalDataSyncJobSchema.parse(publicSyncJob(job, publication));
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.get("/v1/projects/:projectId/runs/:runId/sync-jobs/:jobId/stages/:stage/output", async (request) => {
    const { projectId, runId, jobId, stage } = parseContract(
      LocalDataStageOutputParamsSchema,
      request.params,
    );
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== "user" || !deps.readStageOutput) {
      return missing("Stage output not found");
    }
    try {
      const output = await deps.readStageOutput({
        organizationId: principal.organizationId,
        projectId,
        runId,
        jobId,
        stage,
      });
      if (!output) return missing("Stage output not found");
      return LocalDataStageOutputResponseSchema.parse(output);
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.post("/v1/admin/sync-asins/:jobId/resume", async (request, reply) => {
    const { jobId } = parseContract(LocalDataSyncJobIdParamsSchema, request.params);
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== "user" || principal.role !== "admin") {
      throw new ContractRouteError(403, "FORBIDDEN", "Administrator role required");
    }
    try {
      const resumed = await deps.resumeAsinSyncJob(jobId, principal);
      if (!resumed) return missing("Sync job not found");
      reply.status(202);
      return LocalDataSyncResumeResponseSchema.parse({
        job: publicSyncJob(resumed.job),
        resumedStages: resumed.resumedStages,
        reused: resumed.reused,
      });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });

  app.post("/v1/admin/sync-asins/:jobId/legacy-repair/preview", async (request) => {
    const principal = await requirePrimaryAdmin(request.authPrincipal, authService);
    const { jobId } = parseContract(LocalDataSyncJobIdParamsSchema, request.params);
    if (!deps.previewLegacyStatusRepair) return unavailableLegacyRepair();
    const preview = await deps.previewLegacyStatusRepair({
      jobId,
      organizationId: principal.organizationId,
    });
    if (!preview) return missing("Sync job not found");
    return SyncLegacyRepairResponseSchema.parse(preview);
  });

  app.post("/v1/admin/sync-asins/:jobId/legacy-repair/apply", async (request) => {
    const principal = await requirePrimaryAdmin(request.authPrincipal, authService);
    const { jobId } = parseContract(LocalDataSyncJobIdParamsSchema, request.params);
    const body = parseContract(SyncLegacyRepairApplyRequestSchema, request.body);
    if (!deps.applyLegacyStatusRepair) return unavailableLegacyRepair();
    try {
      const applied = await deps.applyLegacyStatusRepair({
        jobId,
        organizationId: principal.organizationId,
        version: body.version,
      });
      if (!applied) return missing("Sync job not found");
      return SyncLegacyRepairResponseSchema.parse(applied);
    } catch (error) {
      if (error instanceof SyncLegacyRepairConflictError) {
        throw new ContractRouteError(409, "CONFLICT", "Legacy repair preview is stale");
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/traffic-snapshot", async (request) => {
    const { runId } = parseContract(TrafficSnapshotReadParamsSchema, request.params);
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== "user" || !deps.readTrafficSnapshot) {
      return missing("Traffic snapshot is pending");
    }
    try {
      const snapshot = await deps.readTrafficSnapshot({
        organizationId: principal.organizationId,
        runId,
      });
      if (!snapshot) return missing("Traffic snapshot is pending");
      return TrafficSnapshotReadResponseSchema.parse({
        version: "1",
        state: "ready",
        ...snapshot,
      });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });
}

async function requirePrimaryAdmin(
  principal: RequestPrincipal | null,
  authService: AuthenticationService | null,
) {
  if (!principal || principal.kind !== "user" || principal.role !== "admin") {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  const user = authService ? await authService.findPublicUser(principal.userId) : null;
  if (
    !user ||
    user.organizationId !== principal.organizationId ||
    user.role !== "admin" ||
    user.status !== "active" ||
    user.email.trim().toLowerCase() !== "admin@example.com"
  ) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return principal;
}

function unavailableLegacyRepair(): never {
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "Legacy sync repair is not configured",
  );
}
