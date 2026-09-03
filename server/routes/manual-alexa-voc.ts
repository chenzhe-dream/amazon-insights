import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  AlexaVocNormalizationStatusQuerySchema,
  AlexaVocNormalizationStatusResponseSchema,
  ManualAlexaVocImportRequestSchema,
  ManualAlexaVocListQuerySchema,
  ManualAlexaVocListResponseSchema,
  ManualAlexaVocWriteResponseSchema,
} from "../../shared/agent-contracts";
import { ManualAlexaVocRepositoryError } from "../db/manual-alexa-voc-repository";
import {
  ManualAlexaVocCipherUnavailableError,
} from "../security/manual-alexa-voc-cipher";
import {
  ManualAlexaVocServiceError,
  type ManualAlexaVocService,
} from "../services/manual-alexa-voc-service";
import { ContractRouteError } from "./analysis-runs";

function principal(request: FastifyRequest) {
  if (request.authPrincipal?.kind !== "user") {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return {
    organizationId: request.authPrincipal.organizationId,
    userId: request.authPrincipal.userId,
  };
}

function requireService(service: ManualAlexaVocService | null) {
  if (!service) {
    throw new ContractRouteError(
      503,
      "CONFIGURATION_ERROR",
      "Manual Alexa VOC storage is not configured",
    );
  }
  return service;
}

function validationDetails(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map(issue => ({
    path: issue.path.length ? issue.path.join(".") : "request",
    message: issue.message,
  }));
}

function mapServiceError(error: unknown): never {
  if (error instanceof ManualAlexaVocServiceError) {
    const status = error.kind === "validation"
      ? 400
      : error.kind === "asin-mismatch"
        ? 422
      : error.kind === "too-large"
        ? 413
        : error.kind === "forbidden"
          ? 403
          : error.kind === "not-found"
            ? 404
            : error.kind === "conflict"
              ? 409
        : error.kind === "unavailable"
          ? 503
          : 422;
    const code = error.kind === "forbidden"
      ? "FORBIDDEN"
      : error.kind === "asin-mismatch"
        ? "ALEXA_VOC_ASIN_MISMATCH"
      : error.kind === "not-found"
        ? "NOT_FOUND"
        : error.kind === "conflict"
          ? "CONFLICT"
          : error.kind === "unavailable"
            ? "CONFIGURATION_ERROR"
            : "VALIDATION_ERROR";
    throw new ContractRouteError(
      status,
      code,
      error.kind === "too-large"
        ? "Alexa report is too large"
        : error.kind === "asin-mismatch"
          ? "Alexa report ASIN conflicts with trusted scope"
        : error.kind === "unavailable"
          ? "Manual Alexa VOC writes are unavailable"
          : error.kind === "forbidden"
            ? "Project scope is not authorized"
            : error.kind === "not-found"
              ? "Project or analysis run was not found"
              : error.kind === "conflict"
                ? "Analysis run cannot accept Alexa VOC input"
                : "Request validation failed",
    );
  }
  if (error instanceof ManualAlexaVocRepositoryError) {
    throw new ContractRouteError(
      503,
      "INFRASTRUCTURE_ERROR",
      "Manual Alexa VOC storage is unavailable",
    );
  }
  if (error instanceof ManualAlexaVocCipherUnavailableError) {
    throw new ContractRouteError(
      503,
      "CONFIGURATION_ERROR",
      "Manual Alexa VOC encryption is unavailable",
    );
  }
  throw error;
}

export function registerManualAlexaVocRoutes(
  app: FastifyInstance,
  service: ManualAlexaVocService | null,
) {
  app.post("/v1/manual-alexa-voc/import", async (request, reply) => {
    const parsed = ManualAlexaVocImportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        validationDetails(parsed.error),
      );
    }
    try {
      const response = ManualAlexaVocWriteResponseSchema.parse(
        await requireService(service).importReport({
          principal: principal(request),
          request: parsed.data,
        }),
      );
      const status = response.disposition === "pending"
        ? 202
        : response.record?.revision === "1"
          ? 201
          : 200;
      return reply.status(status).send(response);
    } catch (error) {
      mapServiceError(error);
    }
  });

  app.get("/v1/manual-alexa-voc", async (request) => {
    const raw = request.query as { projectId?: unknown; marketplace?: unknown; asins?: unknown };
    const parsed = ManualAlexaVocListQuerySchema.safeParse({
      projectId: raw.projectId,
      marketplace: raw.marketplace,
      asins: Array.isArray(raw.asins)
        ? raw.asins
        : raw.asins === undefined
          ? undefined
          : [raw.asins],
    });
    if (!parsed.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        validationDetails(parsed.error),
      );
    }
    try {
      return ManualAlexaVocListResponseSchema.parse(
        await requireService(service).listReports({
          principal: principal(request),
          query: parsed.data,
        }),
      );
    } catch (error) {
      mapServiceError(error);
    }
  });

  app.get("/v1/manual-alexa-voc/normalization-status", async (request) => {
    const raw = request.query as {
      projectId?: unknown;
      runId?: unknown;
      marketplace?: unknown;
      asins?: unknown;
    };
    const parsed = AlexaVocNormalizationStatusQuerySchema.safeParse({
      projectId: raw.projectId,
      runId: raw.runId,
      marketplace: raw.marketplace,
      asins: Array.isArray(raw.asins)
        ? raw.asins
        : raw.asins === undefined
          ? undefined
          : [raw.asins],
    });
    if (!parsed.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        validationDetails(parsed.error),
      );
    }
    try {
      return AlexaVocNormalizationStatusResponseSchema.parse(
        await requireService(service).getNormalizationStatus({
          principal: principal(request),
          query: parsed.data,
        }),
      );
    } catch (error) {
      mapServiceError(error);
    }
  });
}
