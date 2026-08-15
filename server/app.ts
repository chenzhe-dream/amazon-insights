import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyServerOptions } from "fastify";

import { registerCapabilitiesRoutes } from "./routes/capabilities";
import { registerAnalysisRunRoutes } from "./routes/analysis-runs";
import { loadAgentServicePolicy } from "./config";
import {
  ApiErrorCodeSchema,
  ApiErrorResponseSchema,
  normalizeRequestId,
  type ApiError,
  type ApiErrorCode,
  type ApiErrorResponse,
} from "../shared/agent-contracts";
import type { AgentRepository } from "./db/repository";
import {
  AnalysisRunService,
  type AnalysisDependencyStateProvider,
  type AnalysisExecutionContext,
} from "./services/analysis-run-service";

type BuildAgentAppOptions = Pick<FastifyServerOptions, "logger"> & {
  env?: Readonly<Record<string, string | undefined>>;
  storageAvailable?: boolean; openaiAvailable?: boolean;
  repository?: AgentRepository;
  executionContext?: AnalysisExecutionContext;
  dependencyStateProvider?: AnalysisDependencyStateProvider;
};

const LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-agent-proxy-token"]',
  "headers.authorization",
  "headers.cookie",
  'headers["x-agent-proxy-token"]',
  "body.password",
] as const;

function loggerWithRedaction(logger: FastifyServerOptions["logger"]) {
  if (!logger) return false;
  const redact = { paths: [...LOG_REDACTION_PATHS], censor: "[Redacted]" };
  return logger === true ? { redact } : { ...logger, redact };
}

function tokensMatch(expected: string, supplied: string) {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function errorCodeForStatus(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 401:
      return "AUTHENTICATION_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "VALIDATION_ERROR";
  }
}

function contractError(error: ApiError): ApiErrorResponse {
  return ApiErrorResponseSchema.parse({ error });
}

export function buildAgentApp(options: BuildAgentAppOptions = {}) {
  const env = options.env ?? process.env;
  const policy = loadAgentServicePolicy(env);
  const app = Fastify({
    logger: loggerWithRedaction(options.logger),
    bodyLimit: policy.bodyLimitBytes,
    requestTimeout: policy.requestDeadlineMs,
    handlerTimeout: policy.requestDeadlineMs,
    forceCloseConnections: "idle",
    requestIdHeader: false,
    genReqId: (request) =>
      normalizeRequestId(request.headers["x-request-id"], randomUUID),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);

    if (!request.url.startsWith("/v1/")) return;
    if (!policy.proxyToken || policy.trustedOrigins.size === 0) {
      return reply.status(503).send(
        contractError({
          code: "CONFIGURATION_ERROR",
          message: "Agent Service security is not configured",
          requestId: request.id,
        }),
      );
    }

    const suppliedToken = request.headers["x-agent-proxy-token"];
    if (
      typeof suppliedToken !== "string" ||
      !tokensMatch(policy.proxyToken, suppliedToken)
    ) {
      return reply.status(401).send(
        contractError({
          code: "AUTHENTICATION_REQUIRED",
          message: "Internal proxy authentication is required",
          requestId: request.id,
        }),
      );
    }

    const origin = request.headers.origin;
    if (typeof origin !== "string" || !policy.trustedOrigins.has(origin)) {
      return reply.status(403).send(
        contractError({
          code: "FORBIDDEN",
          message: "Request origin is not trusted",
          requestId: request.id,
        }),
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const structuredError = error as {
      apiErrorCode?: unknown;
      code?: string;
      details?: readonly { path: string; message: string }[];
      message?: string;
      statusCode?: number;
    };
    const isDeadline = structuredError.code === "FST_ERR_HANDLER_TIMEOUT";
    const statusCode = isDeadline
      ? 504
      : typeof structuredError.statusCode === "number" &&
          structuredError.statusCode >= 400
        ? structuredError.statusCode
        : 500;

    const declaredCode = ApiErrorCodeSchema.safeParse(
      structuredError.apiErrorCode,
    );
    const payload = contractError({
      code: declaredCode.success
        ? declaredCode.data
        : isDeadline
          ? "AGENT_SERVICE_TIMEOUT"
          : errorCodeForStatus(statusCode),
      message:
        isDeadline
          ? "Agent Service request timed out"
          : statusCode >= 500 && !declaredCode.success
            ? "Internal server error"
            : (structuredError.message ?? "Request failed"),
      requestId: request.id,
      details: structuredError.details,
    });
    reply.status(statusCode).send(payload);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(
      contractError({
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: request.id,
      }),
    );
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "agent-service",
  }));

  registerCapabilitiesRoutes(app, env, {
    storageAvailable: options.storageAvailable ?? false,
    openaiAvailable: options.openaiAvailable ?? false,
  });
  const analysisRunService =
    options.repository && options.executionContext
      ? new AnalysisRunService({
          repository: options.repository,
          executionContext: options.executionContext,
          ...(options.dependencyStateProvider
            ? { dependencyStateProvider: options.dependencyStateProvider }
            : {}),
        })
      : null;
  registerAnalysisRunRoutes(app, analysisRunService);

  return app;
}
