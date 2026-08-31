import type { FastifyInstance, FastifyRequest } from "fastify";

import {
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
      : error.kind === "too-large"
        ? 413
        : error.kind === "unavailable"
          ? 503
          : 422;
    throw new ContractRouteError(
      status,
      error.kind === "unavailable" ? "CONFIGURATION_ERROR" : "VALIDATION_ERROR",
      error.kind === "too-large"
        ? "Alexa report is too large"
        : error.kind === "unavailable"
          ? "Manual Alexa VOC writes are unavailable"
        : error.kind === "incomplete"
          ? "Alexa report is incomplete or invalid"
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
      return reply.status(
        response.idempotent || response.record.revision !== "1" ? 200 : 201,
      ).send(response);
    } catch (error) {
      mapServiceError(error);
    }
  });

  app.get("/v1/manual-alexa-voc", async (request) => {
    const raw = request.query as { marketplace?: unknown; asins?: unknown };
    const parsed = ManualAlexaVocListQuerySchema.safeParse({
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
}
