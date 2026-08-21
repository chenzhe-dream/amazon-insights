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
  readJob,
  startAsinSyncJob,
  type AsinModuleStatus,
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
  LocalDataSyncJobIdParamsSchema,
  LocalDataSyncJobSchema,
  LocalDataSyncReadinessQuerySchema,
  LocalDataSyncReadinessResponseSchema,
  LocalDataSyncStartRequestSchema,
  LocalDataSyncStartResponseSchema,
  LocalDataUpdateProjectRequestSchema,
  type ApiErrorCode,
} from "../../shared/agent-contracts";
import { ContractRouteError } from "./analysis-runs";
import type { RequestPrincipal } from "../auth/authorization";
import type { RuntimeAgentRepository } from "../db/repository";

export type StartAsinSyncResult = Awaited<ReturnType<typeof startAsinSyncJob>>;

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
  authorizeSyncScope?(
    principal: RequestPrincipal,
    input: { projectId?: string; runId?: string },
  ): Promise<SyncJobScope | null>;
};

export function createDefaultLocalDataBridgeDeps(
  repository: RuntimeAgentRepository | null = null,
): LocalDataBridgeDeps {
  return {
    fetchProjects,
    fetchProject,
    createAnalysisProject,
    updateAnalysisProject,
    deleteAnalysisProject,
    normalizeAsins: async (values) => normalizeAsins(values),
    fetchAsinDataStatus,
    startAsinSyncJob,
    readJob,
    async authorizeSyncScope(principal, input) {
      if (principal.kind !== "user") return null;
      if (!input.projectId && !input.runId) {
        return { organizationId: principal.organizationId, projectId: null, runId: null };
      }
      if (!repository) return null;
      const run = input.runId ? await repository.findAnalysisRun(input.runId) : null;
      const projectId = input.projectId ?? run?.projectId;
      const project = projectId ? await repository.findProjectById(projectId) : null;
      if (!project || project.organizationId !== principal.organizationId) return null;
      if (run && run.projectId !== project.id) return null;
      return {
        organizationId: principal.organizationId,
        projectId: project.id,
        runId: run?.id ?? null,
      };
    },
  };
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

function syncScopeFor(
  deps: LocalDataBridgeDeps,
  principal: RequestPrincipal | null,
  input: { projectId?: string; runId?: string },
) {
  if (!principal || principal.kind !== "user") return Promise.resolve(null);
  if (deps.authorizeSyncScope) return deps.authorizeSyncScope(principal, input);
  return Promise.resolve({
    organizationId: principal.organizationId,
    projectId: input.projectId ?? null,
    runId: input.runId ?? null,
  });
}

function publicSyncJob(job: SyncJob) {
  const scope = job.scope
    ? {
        projectId: job.scope.projectId === "unscoped" ? null : job.scope.projectId,
        runId: job.scope.runId,
      }
    : undefined;
  return { ...job, ...(scope ? { scope } : {}) };
}

function rethrowLegacyError(error: unknown): never {
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
      });
    } catch (error) {
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
      return LocalDataSyncJobSchema.parse(publicSyncJob(job));
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      rethrowLegacyError(error);
    }
  });
}
