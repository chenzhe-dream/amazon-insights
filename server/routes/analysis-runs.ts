import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetProjectResponseSchema,
  GetReportResponseSchema,
  GetRunResponseSchema,
  ProjectIdParamsSchema,
  ReportIdParamsSchema,
  RetryStageParamsSchema,
  RetryStageRequestSchema,
  RetryStageResponseSchema,
  RunIdParamsSchema,
  ListReportsResponseSchema,
  type ApiErrorCode,
} from "../../shared/agent-contracts";
import type { AnalysisRunServiceResolver } from "../auth/authorization";

export class ContractRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly apiErrorCode: ApiErrorCode,
    message: string,
    readonly details?: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ContractRouteError";
  }
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

function requireService(
  service: AnalysisRunServiceResolver | null,
  principal: Parameters<AnalysisRunServiceResolver>[0] | null,
) {
  if (service && principal) {
    const resolved = service(principal);
    if (resolved) return resolved;
  }
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "Analysis lifecycle is not configured",
  );
}

export function registerAnalysisRunRoutes(
  app: FastifyInstance,
  service: AnalysisRunServiceResolver | null,
) {
  app.post("/v1/projects", async (request, reply) => {
    const body = parseContract(CreateProjectRequestSchema, request.body);
    const creation = await requireService(service, request.authPrincipal).createProject(body);
    reply.status(creation.created ? 201 : 200);
    return CreateProjectResponseSchema.parse(creation.response);
  });

  app.get("/v1/projects/:projectId", async (request) => {
    const params = parseContract(ProjectIdParamsSchema, request.params);
    return GetProjectResponseSchema.parse(
      await requireService(service, request.authPrincipal).getProject(params.projectId),
    );
  });

  app.post("/v1/projects/:projectId/runs", async (request) => {
    const params = parseContract(ProjectIdParamsSchema, request.params);
    const body = parseContract(CreateRunRequestSchema, request.body);
    const lifecycle = requireService(service, request.authPrincipal);
    const created = await lifecycle.createRunWithVocSnapshot({
      principal: request.authPrincipal!,
      projectId: params.projectId,
      mode: body.mode,
      idempotencyKey: body.idempotencyKey,
    });
    return CreateRunResponseSchema.parse(
      await lifecycle.getRun(created.run.id),
    );
  });

  app.get("/v1/runs/:runId", async (request) => {
    const params = parseContract(RunIdParamsSchema, request.params);
    return GetRunResponseSchema.parse(
      await requireService(service, request.authPrincipal).getRun(params.runId),
    );
  });

  app.get("/v1/runs/:runId/reports", async (request) => {
    const params = parseContract(RunIdParamsSchema, request.params);
    return ListReportsResponseSchema.parse(
      await requireService(service, request.authPrincipal).listReports(params.runId),
    );
  });

  app.get("/v1/reports/:reportId", async (request) => {
    const params = parseContract(ReportIdParamsSchema, request.params);
    return GetReportResponseSchema.parse(
      await requireService(service, request.authPrincipal).getReport(params.reportId),
    );
  });

  app.post("/v1/runs/:runId/cancel", async (request) => {
    const params = parseContract(RunIdParamsSchema, request.params);
    parseContract(CancelRunRequestSchema, request.body ?? {});
    return CancelRunResponseSchema.parse(
      await requireService(service, request.authPrincipal).cancelRun(params.runId, request.id),
    );
  });

  app.post("/v1/runs/:runId/stages/:stage/retry", async (request) => {
    const params = parseContract(RetryStageParamsSchema, request.params);
    parseContract(RetryStageRequestSchema, request.body ?? {});
    return RetryStageResponseSchema.parse(
      await requireService(service, request.authPrincipal).retryStage(params.runId, params.stage),
    );
  });
}
