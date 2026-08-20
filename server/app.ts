import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyServerOptions } from "fastify";

import {
  registerCapabilitiesRoutes,
  type OpenAiRuntimeCapability,
} from "./routes/capabilities";
import {
  registerConnectorRoutes,
  type ConnectorCredentialServiceResolver,
} from "./routes/connectors";
import { registerAnalysisRunRoutes } from "./routes/analysis-runs";
import { registerLocalVocRoute } from "./routes/local-voc";
import { registerLocalDataRoutes, type LocalDataBridgeDeps } from "./routes/local-data";
import {
  loadAgentAuthenticationConfig,
  loadAgentServicePolicy,
  type AgentAuthenticationConfig,
} from "./config";
import { registerAuthRoutes, registerPasswordRoute } from "./routes/auth";
import {
  classifyRoute,
  requestPathname,
  requireRole,
  type RequestPrincipal,
} from "./auth/authorization";
import { parseSessionCookie } from "./auth/session";
import {
  ApiErrorCodeSchema,
  ApiErrorResponseSchema,
  normalizeRequestId,
  type ApiError,
  type ApiErrorCode,
  type ApiErrorResponse,
} from "../shared/agent-contracts";
import type { RuntimeAgentRepository } from "./db/repository";
import {
  AnalysisRunService,
  type AnalysisDependencyStateProvider,
  type AnalysisExecutionContext,
} from "./services/analysis-run-service";
import type { ConnectorProbeService } from "./services/connector-probe-service";
import type { AuthenticationService } from "./auth/authentication-service";

type BuildAgentAppOptions = Pick<FastifyServerOptions, "logger"> & {
  env?: Readonly<Record<string, string | undefined>>;
  storageAvailable?: boolean; openaiAvailable?: boolean; openaiCapability?: OpenAiRuntimeCapability;
  repository?: RuntimeAgentRepository;
  executionContext?: AnalysisExecutionContext;
  dependencyStateProvider?: AnalysisDependencyStateProvider;
  localDataBridgeDeps?: LocalDataBridgeDeps;
  connectorProbeService?: ConnectorProbeService | null;
  connectorCredentialServiceResolver?: ConnectorCredentialServiceResolver | null;
  authService?: AuthenticationService | null;
  authConfig?: AgentAuthenticationConfig;
};

const LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-agent-proxy-token"]',
  "headers.authorization",
  "headers.cookie",
  'headers["x-agent-proxy-token"]',
  "body.password",
  "body.secret",
  "req.body.password",
  "body.currentPassword",
  "body.newPassword",
  "body.confirmation",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.confirmation",
  "req.body.secret",
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
  const authConfig = options.authConfig ?? loadAgentAuthenticationConfig(env);
  const authService = options.authService ?? null;
  const localBrowserOrigin =
    env.AGENT_VOC_LOCAL_ORIGIN ??
    (env.AGENT_VOC_LOCAL_FAKE === "1" ? "http://127.0.0.1:31900" : null);
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

    if (localBrowserOrigin && request.headers.origin === localBrowserOrigin) {
      reply.header("access-control-allow-origin", localBrowserOrigin);
      reply.header("access-control-allow-headers", "content-type, x-agent-proxy-token, x-request-id");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      if (request.method === "OPTIONS") return reply.status(204).send();
    }

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
      details: structuredError.details ? [...structuredError.details] : undefined,
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

  registerAuthRoutes(
    app,
    authService,
    authConfig,
  );

  app.addHook("preHandler", async (request, reply) => {
    request.authPrincipal = null;
    const pathname = requestPathname(request);
    if (pathname !== "/health" && !pathname.startsWith("/v1/")) return;
    const access = classifyRoute(request.method, pathname);
    if (access.kind === "public" || access.kind === "proxy-only") return;

    const rawToken = parseSessionCookie(
      typeof request.headers.cookie === "string" ? request.headers.cookie : null,
      authConfig.cookie,
    );
    const principal = authService
      ? await authService.authenticate(rawToken)
      : null;
    if (principal) {
      try {
        requireRole(principal, access.roles);
      } catch {
        return reply.status(403).send(
          contractError({
            code: "FORBIDDEN",
            message: "Request is not authorized",
            requestId: request.id,
          }),
        );
      }
      request.authPrincipal = principal;
      return;
    }

    if (
      access.kind === "session-or-anonymous-loopback" &&
      authConfig.mode === "anonymous-loopback"
    ) {
      request.authPrincipal = { kind: "anonymous-loopback" };
      return;
    }

    if (
      authConfig.mode === "anonymous-loopback" &&
      access.kind === "session" &&
      access.roles.length === 1 &&
      access.roles[0] === "admin"
    ) {
      return reply.status(403).send(
        contractError({
          code: "FORBIDDEN",
          message: "Request is not authorized",
          requestId: request.id,
        }),
      );
    }

    return reply.status(401).send(
      contractError({
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required",
        requestId: request.id,
      }),
    );
  });

  registerPasswordRoute(app, authService);

  app.get("/health", async () => ({
    status: "ok",
    service: "agent-service",
  }));

  registerCapabilitiesRoutes(app, env, {
    storageAvailable: options.storageAvailable ?? false,
    openaiAvailable: options.openaiAvailable ?? false,
    ...(options.openaiCapability
      ? { openai: options.openaiCapability }
      : {}),
  }, options.connectorProbeService
    ? () => options.connectorProbeService!.getCapabilities()
    : undefined);
  registerConnectorRoutes(
    app,
    options.connectorProbeService ?? null,
    options.connectorCredentialServiceResolver ?? null,
  );
  const resolveExecutionContext = (principal: RequestPrincipal) => {
    if (principal.kind === "user") {
      return {
        actorId: principal.userId,
        organizationId: principal.organizationId,
      };
    }
    return options.executionContext ?? null;
  };
  const analysisRunServiceResolver =
    options.repository
      ? (principal: RequestPrincipal) => {
          const executionContext = resolveExecutionContext(principal);
          return executionContext
            ? new AnalysisRunService({
                repository: options.repository!,
                executionContext,
                dependencyStateProvider:
                  options.dependencyStateProvider ?? options.repository!,
              })
            : null;
        }
      : null;
  registerAnalysisRunRoutes(app, analysisRunServiceResolver);
  registerLocalVocRoute(
    app,
    options.repository ?? null,
    options.repository ? (principal) => resolveExecutionContext(principal) : null,
    options.openaiCapability ?? null,
  );
  if (env.AGENT_VOC_LOCAL_FAKE === "1") {
    registerLocalDataRoutes(app, options.localDataBridgeDeps);
  }

  return app;
}
