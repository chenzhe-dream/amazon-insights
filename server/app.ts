import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {createStatisticsViewAccess} from './auth/statistics-view-access';
import {registerAdminRequestDiagnostics} from './admin-request-diagnostics';

import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import multipart from "@fastify/multipart";
import { readProjectReadonly } from "../scripts/lib/project-store.mjs";
import { createAnalysisProjectFavoriteStore } from "./services/analysis-project-favorite-store";
import { registerAnalysisProjectFavoriteRoutes } from "./routes/analysis-project-favorites";

import {
  registerCapabilitiesRoutes,
  type OpenAiRuntimeCapability,
} from "./routes/capabilities";
import {
  registerConnectorRoutes,
  type ConnectorCredentialServiceResolver,
} from "./routes/connectors";
import { registerConcurrencyAdminRoutes } from "./routes/concurrency-admin";
import { registerAnalysisRunRoutes } from "./routes/analysis-runs";
import { createSellingTranslationService, registerSellingTranslationRoutes } from "./routes/selling-point-translations";
import { registerMarketResearchRoutes } from "./routes/market-research";
import { registerMarketModuleRoutes } from './routes/market-modules';
import {registerMarketLinkedRoutes} from './routes/market-linked';
import type {MarketLinkedService} from './services/market-linked-service';
import {registerMarketThemeSelectionRoutes} from './routes/market-theme-selection';
import type { MarketModuleService } from './services/market-module-service';
import type { MarketResearchService } from "./services/market-research-service";
import { registerLegacyProjectOwnershipRoutes } from "./routes/legacy-project-ownership";
import { registerLocalVocRoute } from "./routes/local-voc";
import {
  createDefaultLocalDataBridgeDeps,
  registerLocalDataRoutes,
  type LocalDataBridgeDeps,
} from "./routes/local-data";
import {
  loadAgentAuthenticationConfig,
  loadAgentServicePolicy,
  loadManualAlexaVocFeatureFlags,
  loadSellerSpriteQuotaRefreshConfig,
  type AgentAuthenticationConfig,
} from "./config";
import { registerAuthRoutes, registerPasswordRoute } from "./routes/auth";
import {registerModuleVisibilityRoutes} from './routes/module-visibility';
import {registerMarketFavoritesRoutes} from './routes/market-favorites';
import { registerDingTalkAuthRoutes } from "./routes/dingtalk-auth";
import { registerFeedbackRoute } from "./routes/feedback";
import { registerManualAlexaVocRoutes } from "./routes/manual-alexa-voc";
import { registerAdminUserPresenceRoutes } from "./routes/admin-user-presence";
import {registerUsageAnalyticsRoutes} from "./routes/usage-analytics";
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
import type { AdminUserPresenceRepository } from "./db/admin-user-presence-repository";
import { PostgresResourceGovernor } from "./db/concurrency-control-repository";
import type { ConcurrencyControlRepository } from "./db/concurrency-control-repository";
import {
  AnalysisRunService,
  type AnalysisDependencyStateProvider,
  type AnalysisExecutionContext,
} from "./services/analysis-run-service";
import type { ConnectorProbeService } from "./services/connector-probe-service";
import {
  SellerSpriteQuotaService,
  type ConcurrencyAdminService,
} from "./services/seller-sprite-quota-service";
import type { AuthenticationService } from "./auth/authentication-service";
import {
  createUserPresenceAccess,
  type UserPresenceAccess,
} from "./auth/user-presence-access";
import type { DingTalkAuthenticationService } from "./auth/dingtalk-authentication-service";
import type { DingTalkAuthRateLimiter } from "./auth/dingtalk-rate-limiter";
import type { PostgresConcurrencyControlStore } from "./db/postgres/concurrency-control-store";
import type { ManualAlexaVocRepositoryCapability } from "./db/repository";
import { createManualAlexaVocCipher } from "./security/manual-alexa-voc-cipher";
import { createAlexaVocNormalizationInputCipher } from "./security/alexa-voc-normalization-input-cipher";
import { ManualAlexaVocService } from "./services/manual-alexa-voc-service";
import { VocAutomationService } from "./services/voc-automation-service";
import { registerVocAutomationRoutes } from "./routes/voc-automation";
import type { AlexaVocNormalizationExecutionIdentity } from "./domain/voc/alexa-voc-normalization-contracts";

type BuildAgentAppOptions = Pick<FastifyServerOptions, "logger"> & {
  env?: Readonly<Record<string, string | undefined>>;
  storageAvailable?: boolean; openaiAvailable?: boolean; openaiCapability?: OpenAiRuntimeCapability;
  repository?: RuntimeAgentRepository;
  vocAutomationService?: VocAutomationService;
  marketResearchService?: MarketResearchService | null;
  marketModuleService?: MarketModuleService | null;
  marketLinkedService?: MarketLinkedService | null;
  executionContext?: AnalysisExecutionContext;
  dependencyStateProvider?: AnalysisDependencyStateProvider;
  localDataBridgeDeps?: LocalDataBridgeDeps;
  connectorProbeService?: ConnectorProbeService | null;
  connectorCredentialServiceResolver?: ConnectorCredentialServiceResolver | null;
  concurrencyAdminService?: ConcurrencyAdminService | null;
  authService?: AuthenticationService | null;
  dingTalkService?: DingTalkAuthenticationService | null;
  dingTalkRateLimiter?: DingTalkAuthRateLimiter;
  authConfig?: AgentAuthenticationConfig;
  manualAlexaVocService?: ManualAlexaVocService | null;
  normalizationExecutionIdentity?: AlexaVocNormalizationExecutionIdentity | null;
  readLegacyProject?: (legacyProjectId: string) => unknown;
  adminUserPresenceRepository?: AdminUserPresenceRepository | null;
  userPresenceAccess?: UserPresenceAccess | null;
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
  "body.code",
  "body.state",
  "req.body.password",
  "req.body.code",
  "req.body.state",
  "body.currentPassword",
  "body.newPassword",
  "body.confirmation",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.confirmation",
  "req.body.secret",
  "body.accessToken",
  "body.refreshToken",
  "req.body.accessToken",
  "req.body.refreshToken",
  "body.rawText",
  "body.text",
  "req.body.rawText",
  "req.body.text",
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
  const userPresenceAccess = options.userPresenceAccess === undefined
    ? authService
      ? createUserPresenceAccess({
          env,
          authService,
          repository: options.repository ?? null,
          isSystemOwner: options.repository?.moduleVisibility
            ? (organizationId,userId)=>options.repository!.moduleVisibility!.isOwner(organizationId,userId)
            : undefined,
        })
      : null
    : options.userPresenceAccess;
  const statisticsViewAccess = createStatisticsViewAccess({legacyAccess:userPresenceAccess,authService,visibility:options.repository?.moduleVisibility??null});
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
  registerAdminRequestDiagnostics(app);
  void app.register(multipart, {
    limits: {
      files: 3,
      fileSize: 5 * 1024 * 1024,
      fields: 8,
      parts: 11,
      fieldNameSize: 100,
      fieldSize: 16 * 1024,
    },
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

    const feedbackTransfer = request.headers["x-agent-feedback-transfer"];
    if (
      feedbackTransfer !== undefined &&
      (feedbackTransfer !== "1" ||
        request.method !== "POST" ||
        requestPathname(request) !== "/v1/feedback")
    ) {
      return reply.status(400).send(
        contractError({
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
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
    const isInvalidJson =
      structuredError.code === "FST_ERR_CTP_INVALID_JSON_BODY";
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
          : isInvalidJson
            ? "Request validation failed"
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
    statisticsViewAccess,
    options.repository?.moduleVisibility??null,
    userPresenceAccess,
  );
  registerModuleVisibilityRoutes(app,options.repository?.moduleVisibility??null,userPresenceAccess);
  registerMarketFavoritesRoutes(app,options.repository?.marketFavorites??null,options.repository?.moduleVisibility??null);
  registerUsageAnalyticsRoutes(app,env.AGENT_USAGE_ANALYTICS_ENABLED==="false"?null:options.repository?.usageAnalytics??null,statisticsViewAccess);
  registerDingTalkAuthRoutes(
    app,
    options.dingTalkService ?? null,
    authConfig,
    options.dingTalkRateLimiter,
  );

  const authenticateSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
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
  };

  const isManualAlexaVocPath = (pathname: string) =>
    pathname === "/v1/manual-alexa-voc" ||
    pathname === "/v1/manual-alexa-voc/import";
  const requiresEarlySessionAuth = (pathname: string) =>
    isManualAlexaVocPath(pathname) || pathname === "/v1/auth/activity";

  app.addHook("onRequest", async (request, reply) => {
    if (!requiresEarlySessionAuth(requestPathname(request))) return;
    return authenticateSession(request, reply);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (requiresEarlySessionAuth(requestPathname(request))) return;
    return authenticateSession(request, reply);
  });

  const manualAlexaVocFlags = loadManualAlexaVocFeatureFlags(env);
  registerPasswordRoute(app, authService);
  registerAdminUserPresenceRoutes(
    app,
    options.adminUserPresenceRepository === undefined
      ? options.repository?.adminUserPresence ?? null
      : options.adminUserPresenceRepository,
    undefined,
    statisticsViewAccess,
    env.AGENT_USAGE_ANALYTICS_ENABLED==="false"?null:options.repository?.usageAnalytics??null,
  );
  registerFeedbackRoute(app, options.repository ?? null, env);
  const vocAutomationService = options.vocAutomationService ?? (options.repository?.vocAutomations ? new VocAutomationService({repository:options.repository, disabled: true}) : null);
  registerVocAutomationRoutes(app,vocAutomationService);
  registerManualAlexaVocRoutes(
    app,
    options.manualAlexaVocService === undefined
      ? createDefaultManualAlexaVocService(
          options.repository ?? null,
          env,
          options.normalizationExecutionIdentity ?? null,
        )
      : options.manualAlexaVocService,
    vocAutomationService ? input => vocAutomationService.afterImport(input,input.runId) : undefined,
  );

  app.get("/health", async () => ({
    status: "ok",
    service: "agent-service",
    ...(boundedCodeSource(env.AGENT_CODE_SOURCE_COMMIT, env.AGENT_CODE_SOURCE_HASH)
      ? { codeSource: boundedCodeSource(env.AGENT_CODE_SOURCE_COMMIT, env.AGENT_CODE_SOURCE_HASH) } : {}),
  }));

  registerCapabilitiesRoutes(app, env, {
    storageAvailable: options.storageAvailable ?? false,
    openaiAvailable: options.openaiAvailable ?? false,
    ...(options.openaiCapability
      ? { openai: options.openaiCapability }
      : {}),
  }, options.connectorProbeService
    ? (principal) => options.connectorProbeService!.getCapabilities({
        organizationId: principal.organizationId,
        actorId: principal.userId,
      })
    : undefined);
  registerConnectorRoutes(
    app,
    options.connectorProbeService ?? null,
    options.connectorCredentialServiceResolver ?? null,
    authService,
  );
  const concurrencyAdminService = options.concurrencyAdminService === undefined
    ? createConcurrencyAdminService(options.repository ?? null, env)
    : options.concurrencyAdminService;
  registerConcurrencyAdminRoutes(
    app,
    concurrencyAdminService ?? null,
    authService,
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
                manualAlexaVocSourcePolicy: {
                  dynamicReadEnabled: manualAlexaVocFlags.dynamicReadEnabled,
                  legacyFallbackEnabled: manualAlexaVocFlags.legacyFallbackEnabled,
                },
              })
            : null;
        }
      : null;
  registerAnalysisRunRoutes(app, analysisRunServiceResolver);
  registerSellingTranslationRoutes(app, createSellingTranslationService(options.repository ?? null, env));
  registerMarketResearchRoutes(app, options.marketResearchService ?? null);
  registerMarketModuleRoutes(app, options.marketModuleService ?? null, options.repository?.marketFavorites?.projects?.resolveReadActor.bind(options.repository.marketFavorites.projects));
  registerMarketLinkedRoutes(app,options.marketLinkedService??null);
  registerMarketThemeSelectionRoutes(app, options.repository?.marketExecutionContext ?? null, options.repository?.marketFavorites?.projects?.resolveReadActor.bind(options.repository.marketFavorites.projects));
  registerLegacyProjectOwnershipRoutes(
    app,
    options.repository ?? null,
    options.readLegacyProject ?? readProjectReadonly,
  );
  registerLocalVocRoute(
    app,
    options.repository ?? null,
    options.repository ? (principal) => resolveExecutionContext(principal) : null,
    options.openaiCapability ?? null,
  );
  registerAnalysisProjectFavoriteRoutes(app, createAnalysisProjectFavoriteStore({ env }));
  registerLocalDataRoutes(
    app,
    options.localDataBridgeDeps ?? createDefaultLocalDataBridgeDeps(options.repository ?? null, {
      env,
      bypassProviderReadiness: env.AGENT_VOC_LOCAL_FAKE === "1",
    }),
    authService,
  );

  return app;
}

function createDefaultManualAlexaVocService(
  repository: RuntimeAgentRepository | null,
  env: Readonly<Record<string, string | undefined>>,
  normalizationExecutionIdentity: AlexaVocNormalizationExecutionIdentity | null,
): ManualAlexaVocService | null {
  if (!repository || !("manualAlexaVoc" in repository)) return null;
  try {
    return new ManualAlexaVocService({
      positioningMode: "local-rules",
      repository: repository as RuntimeAgentRepository & ManualAlexaVocRepositoryCapability,
      cipher: createManualAlexaVocCipher(env),
      normalizationInputCipher: createAlexaVocNormalizationInputCipher(env),
      writeEnabled: loadManualAlexaVocFeatureFlags(env).writeEnabled,
      publicationEnabled: loadManualAlexaVocFeatureFlags(env).publicationEnabled,
      normalizationExecutionIdentity,
    });
  } catch {
    return null;
  }
}

export function createConcurrencyAdminService(
  repository: RuntimeAgentRepository | null,
  env: Readonly<Record<string, string | undefined>>,
): ConcurrencyAdminService | null {
  if (!repository?.concurrencyControl || !hasConcurrencyAdminStore(repository.concurrencyControl)) return null;
  const config = loadSellerSpriteQuotaRefreshConfig(env);
  return new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(
      repository.concurrencyControl,
      "agent-service:quota-admin",
    ),
    visitsUrl: config?.visitsUrl ?? null,
    secretKey: config?.secretKey ?? null,
    timeoutMs: config?.timeoutMs,
  });
}

type ConcurrencyAdminStore = ConcurrencyControlRepository & Pick<
  PostgresConcurrencyControlStore,
  | "readConcurrencyAdminState"
  | "setConcurrencyProfile"
  | "setSellerSpriteManualTotal"
  | "recordSellerSpriteQuotaSnapshot"
  | "setSellerSpriteManualPause"
  | "resetConnectorCircuit"
>;

function hasConcurrencyAdminStore(
  store: ConcurrencyControlRepository,
): store is ConcurrencyAdminStore {
  const candidate = store as Partial<Record<keyof ConcurrencyAdminStore, unknown>>;
  return (
    typeof candidate.readConcurrencyAdminState === "function" &&
    typeof candidate.setConcurrencyProfile === "function" &&
    typeof candidate.setSellerSpriteManualTotal === "function" &&
    typeof candidate.recordSellerSpriteQuotaSnapshot === "function" &&
    typeof candidate.setSellerSpriteManualPause === "function" &&
    typeof candidate.resetConnectorCircuit === "function"
  );
}
import { boundedCodeSource } from "../scripts/lib/code-publication-identity.mjs";
