import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
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
import type { AnalysisRunService } from "../services/analysis-run-service";

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
  service: AnalysisRunService | null,
): AnalysisRunService {
  if (service) return service;
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "Analysis lifecycle is not configured",
  );
}

export function registerAnalysisRunRoutes(
  app: FastifyInstance,
  service: AnalysisRunService | null,
) {
  app.post("/v1/projects/:projectId/runs", async (request) => {
    const params = parseContract(ProjectIdParamsSchema, request.params);
    const body = parseContract(CreateRunRequestSchema, request.body);
    return CreateRunResponseSchema.parse(
      await requireService(service).createRun(params.projectId, body),
    );
  });

  app.get("/v1/runs/:runId", async (request) => {
    const params = parseContract(RunIdParamsSchema, request.params);
    return GetRunResponseSchema.parse(
      await requireService(service).getRun(params.runId),
    );
  });

  app.get("/v1/runs/:runId/reports", async (request) => {
    const params = parseContract(RunIdParamsSchema, request.params);
    return ListReportsResponseSchema.parse(
      await requireService(service).listReports(params.runId),
    );
  });

  app.get("/v1/reports/:reportId", async (request) => {
    const params = parseContract(ReportIdParamsSchema, request.params);
    return GetReportResponseSchema.parse(
      await requireService(service).getReport(params.reportId),
    );
  });

  app.post("/v1/runs/:runId/cancel", async (request) => {
    const params = parseContract(RunIdParamsSchema, request.params);
    parseContract(CancelRunRequestSchema, request.body ?? {});
    return CancelRunResponseSchema.parse(
      await requireService(service).cancelRun(params.runId, request.id),
    );
  });

  app.post("/v1/runs/:runId/stages/:stage/retry", async (request) => {
    const params = parseContract(RetryStageParamsSchema, request.params);
    parseContract(RetryStageRequestSchema, request.body ?? {});
    return RetryStageResponseSchema.parse(
      await requireService(service).retryStage(params.runId, params.stage),
    );
  });
}
