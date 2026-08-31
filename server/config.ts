import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { resolve } from "node:path";

import { z } from "zod";

import { EntityIdSchema } from "../shared/agent-contracts";
import type { ModelBudgetLimits } from "./db/model-budget-repository";
import {
  calculateModelCostMicros,
  sha256Hex,
} from "./runtime/model-request-accounting";
import type { ModelExecutionConfig } from "./runtime/skill-runner";
import { readServerConnectorSecret } from "./config/connector-secrets.mjs";

const agentConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535),
});

const agentServicePolicySchema = z.object({
  bodyLimitBytes: z.number().int().min(1).max(10_485_760),
  requestDeadlineMs: z.number().int().min(1).max(300_000),
  proxyToken: z.string().trim().min(1).nullable(),
});

const agentDatabaseConfigSchema = z.object({
  path: z.string().trim().min(1, "AGENT_SQLITE_PATH is required"),
  busyTimeoutMs: z.number().int().min(1).max(60_000),
});

const analysisExecutionContextSchema = z.strictObject({
  actorId: EntityIdSchema,
  organizationId: EntityIdSchema,
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export function readManualAlexaVocRawReportKeyring(
  env: AgentEnvironment = process.env,
): string | null {
  return env.MANUAL_VOC_RAW_REPORT_KEYRING?.trim() || null;
}

export interface ManualAlexaVocFeatureFlags {
  writeEnabled: boolean;
  dynamicReadEnabled: boolean;
  legacyFallbackEnabled: boolean;
  publicationEnabled: boolean;
  uiEnabled: boolean;
}

export interface ManualAlexaVocPublicationConfig {
  enabled: true;
  projectionRoot: string;
  projectionPathKey: string;
  ownerId: string;
  leaseDurationMs: number;
  pollIntervalMs: number;
  reconcileIntervalMs: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  retryMaxAttempts: number;
}

export interface ManualAlexaVocRetentionConfig {
  enabled: true;
  pollIntervalMs: number;
  batchSize: number;
  policyByOrganization: Readonly<Record<string, number>>;
}

const MANUAL_ALEXA_VOC_FLAG_ERROR =
  "Manual Alexa VOC feature flag configuration is invalid";
const MANUAL_ALEXA_VOC_PUBLICATION_ERROR =
  "Manual Alexa VOC publication configuration is invalid";
const MANUAL_ALEXA_VOC_RETENTION_ERROR =
  "Manual Alexa VOC retention configuration is invalid";

export function loadManualAlexaVocFeatureFlags(
  env: AgentEnvironment = process.env,
): ManualAlexaVocFeatureFlags {
  return Object.freeze({
    writeEnabled: manualAlexaVocFlag(
      env.AGENT_MANUAL_ALEXA_VOC_WRITE_ENABLED,
    ),
    dynamicReadEnabled: manualAlexaVocFlag(
      env.AGENT_MANUAL_ALEXA_VOC_DYNAMIC_READ_ENABLED,
    ),
    legacyFallbackEnabled: manualAlexaVocFlag(
      env.AGENT_MANUAL_ALEXA_VOC_LEGACY_FALLBACK_ENABLED,
    ),
    publicationEnabled: manualAlexaVocFlag(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED,
    ),
    uiEnabled: manualAlexaVocFlag(env.MANUAL_ALEXA_VOC_UI_ENABLED),
  });
}

export function loadManualAlexaVocPublicationConfig(
  env: AgentEnvironment = process.env,
): ManualAlexaVocPublicationConfig | null {
  const flags = loadManualAlexaVocFeatureFlags(env);
  if (!flags.publicationEnabled) return null;
  try {
    const configuredRoot = requiredManualAlexaVocPublicationText(
      env.AGENT_MANUAL_ALEXA_VOC_PROJECTION_ROOT,
    );
    const projectionPathKey = requiredManualAlexaVocPublicationText(
      env.AGENT_MANUAL_ALEXA_VOC_PROJECTION_PATH_KEY,
    );
    if (
      projectionPathKey.length < 32 ||
      projectionPathKey.length > 512
    ) {
      throw new Error(MANUAL_ALEXA_VOC_PUBLICATION_ERROR);
    }
    const ownerId =
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_OWNER_ID?.trim() ||
      `manual-voc-publication-${process.pid}`;
    if (ownerId.length > 200) {
      throw new Error(MANUAL_ALEXA_VOC_PUBLICATION_ERROR);
    }
    const leaseDurationMs = manualAlexaVocPublicationInteger(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_LEASE_MS ?? "120000",
    );
    const pollIntervalMs = manualAlexaVocPublicationInteger(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_POLL_MS ?? "1000",
    );
    const reconcileIntervalMs = manualAlexaVocPublicationInteger(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_RECONCILE_MS ?? "60000",
    );
    const retryInitialDelayMs = manualAlexaVocPublicationInteger(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_BACKOFF_INITIAL_MS ?? "1000",
    );
    const retryMaxDelayMs = manualAlexaVocPublicationInteger(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_BACKOFF_MAX_MS ?? "300000",
    );
    const retryMaxAttempts = manualAlexaVocPublicationInteger(
      env.AGENT_MANUAL_ALEXA_VOC_PUBLICATION_MAX_ATTEMPTS ?? "5",
    );
    if (
      pollIntervalMs >= leaseDurationMs ||
      reconcileIntervalMs < pollIntervalMs ||
      retryInitialDelayMs > retryMaxDelayMs ||
      retryMaxAttempts > 100
    ) {
      throw new Error(MANUAL_ALEXA_VOC_PUBLICATION_ERROR);
    }
    return Object.freeze({
      enabled: true as const,
      projectionRoot: resolve(configuredRoot),
      projectionPathKey,
      ownerId,
      leaseDurationMs,
      pollIntervalMs,
      reconcileIntervalMs,
      retryInitialDelayMs,
      retryMaxDelayMs,
      retryMaxAttempts,
    });
  } catch {
    throw new Error(MANUAL_ALEXA_VOC_PUBLICATION_ERROR);
  }
}

export function loadManualAlexaVocRetentionConfig(
  env: AgentEnvironment = process.env,
): ManualAlexaVocRetentionConfig | null {
  try {
    const configuredPolicies =
      env.MANUAL_VOC_RAW_REPORT_RETENTION_DAYS_BY_ORG?.trim();
    const parsed: unknown = configuredPolicies
      ? JSON.parse(configuredPolicies)
      : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(MANUAL_ALEXA_VOC_RETENTION_ERROR);
    }
    const policyByOrganization: Record<string, number> = {};
    for (const [organizationId, days] of Object.entries(parsed)) {
      if (
        EntityIdSchema.safeParse(organizationId).success === false ||
        !Number.isSafeInteger(days) ||
        Number(days) < 365
      ) {
        throw new Error(MANUAL_ALEXA_VOC_RETENTION_ERROR);
      }
      policyByOrganization[organizationId] = Number(days);
    }
    const enabled = manualAlexaVocFlag(
      env.AGENT_MANUAL_ALEXA_VOC_RETENTION_ENABLED,
    );
    if (!enabled) return null;
    const pollIntervalMs = canonicalPositiveInteger(
      env.AGENT_MANUAL_ALEXA_VOC_RETENTION_POLL_MS ?? "86400000",
      MANUAL_ALEXA_VOC_RETENTION_ERROR,
    );
    const batchSize = canonicalPositiveInteger(
      env.AGENT_MANUAL_ALEXA_VOC_RETENTION_BATCH_SIZE ?? "100",
      MANUAL_ALEXA_VOC_RETENTION_ERROR,
    );
    if (batchSize > 1_000) {
      throw new Error(MANUAL_ALEXA_VOC_RETENTION_ERROR);
    }
    return Object.freeze({
      enabled: true as const,
      pollIntervalMs,
      batchSize,
      policyByOrganization: Object.freeze(policyByOrganization),
    });
  } catch {
    throw new Error(MANUAL_ALEXA_VOC_RETENTION_ERROR);
  }
}

function manualAlexaVocFlag(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(MANUAL_ALEXA_VOC_FLAG_ERROR);
}

function requiredManualAlexaVocPublicationText(
  value: string | undefined,
): string {
  if (!value || value.trim() !== value || value.length > 4_096) {
    throw new Error(MANUAL_ALEXA_VOC_PUBLICATION_ERROR);
  }
  return value;
}

function manualAlexaVocPublicationInteger(value: string): number {
  return canonicalPositiveInteger(value, MANUAL_ALEXA_VOC_PUBLICATION_ERROR);
}

export type NetworkInterfaceReader = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface AgentServicePolicy {
  bodyLimitBytes: number;
  requestDeadlineMs: number;
  proxyToken: string | null;
  trustedOrigins: ReadonlySet<string>;
}

export interface AgentDatabaseConfig {
  path: string;
  busyTimeoutMs: number;
}

export interface ResourceGovernorRuntimeConfig {
  ownerId: string;
}

export interface SellerSpriteQuotaRefreshConfig {
  visitsUrl: string;
  secretKey: string;
  timeoutMs: number;
  intervalMs: number;
}

export type AgentStorageConfig =
  | Readonly<{
      kind: "sqlite";
      sqlite: AgentDatabaseConfig;
    }>
  | Readonly<{
      kind: "postgres";
      databaseUrl: string;
    }>;

export type AgentAuthenticationMode =
  | "authenticated"
  | "anonymous-loopback";

export interface AgentAuthenticationConfig {
  mode: AgentAuthenticationMode;
  cookie: Readonly<{
    name: "__Host-agent_session" | "agent_session";
    secure: boolean;
    maxAgeSeconds: number;
  }>;
  sessionTtlMs: number;
  loginLimiter: Readonly<{
    windowMs: number;
    maxFailures: number;
    maxEntries: number;
  }>;
}

export type AnalysisExecutionContext = z.infer<
  typeof analysisExecutionContextSchema
>;

export type VocProviderTransport = "responses-strict" | "relay-chat-json";

export interface VocPositioningRuntimeConfig {
  apiKey: string;
  providerName: string;
  transport: VocProviderTransport;
  baseUrl: string | null;
  model: ModelExecutionConfig;
  budgetLimits: ModelBudgetLimits;
  worker: {
    ownerId: string;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    pollIntervalMs: number;
    stopTimeoutMs: number;
    retryPolicy: {
      maxAttempts: number;
      initialDelayMs: number;
      maxDelayMs: number;
      jitterRatio: number;
    };
  };
}

export type VocPositioningRuntimeConfigResolution =
  | Readonly<{
      status: "configured";
      config: VocPositioningRuntimeConfig;
      reason: null;
    }>
  | Readonly<{
      status: "incomplete" | "invalid";
      reason: string;
    }>;

const REQUIRED_VOC_RUNTIME_ENV = [
  "OPENAI_API_KEY",
  "AGENT_VOC_MODEL",
  "AGENT_VOC_ESTIMATED_INPUT_TOKENS",
  "AGENT_VOC_MAX_OUTPUT_TOKENS",
  "AGENT_VOC_TIMEOUT_MS",
  "AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS",
  "AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS",
  "AGENT_VOC_CALL_MAX_TOKENS",
  "AGENT_VOC_CALL_MAX_COST_MICROS",
  "AGENT_VOC_RUN_MAX_TOKENS",
  "AGENT_VOC_RUN_MAX_COST_MICROS",
  "AGENT_VOC_DAILY_MAX_TOKENS",
  "AGENT_VOC_DAILY_MAX_COST_MICROS",
  "AGENT_VOC_WORKER_OWNER_ID",
] as const;

const VOC_RUNTIME_INCOMPLETE_REASON =
  "VOC positioning runtime configuration is incomplete";
const VOC_RUNTIME_INVALID_REASON =
  "VOC positioning runtime configuration is invalid";

const vocPositioningRuntimeConfigSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  modelName: z.string().trim().min(1).max(500),
  estimatedInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  inputPrice: z.number().nonnegative().finite(),
  outputPrice: z.number().nonnegative().finite(),
  callMaxTokens: z.number().int().positive(),
  callMaxCostMicros: z.number().int().positive(),
  runMaxTokens: z.number().int().positive(),
  runMaxCostMicros: z.number().int().positive(),
  dailyMaxTokens: z.number().int().positive(),
  dailyMaxCostMicros: z.number().int().positive(),
  ownerId: z.string().trim().min(1).max(500),
  leaseDurationMs: z.number().int().positive().max(86_400_000),
  heartbeatIntervalMs: z.number().int().positive().max(86_400_000),
  pollIntervalMs: z.number().int().positive().max(60_000),
  stopTimeoutMs: z.number().int().positive().max(300_000),
  retryMaxAttempts: z.number().int().positive().max(100),
  retryInitialDelayMs: z.number().int().positive().max(300_000),
  retryMaxDelayMs: z.number().int().positive().max(300_000),
  retryJitterRatio: z.number().finite().min(0).max(1),
});

const VOC_RUNTIME_CONFIGURATION_ERROR =
  "VOC positioning runtime configuration is incomplete or invalid; configure OPENAI_API_KEY, AGENT_VOC_MODEL, AGENT_VOC_ESTIMATED_INPUT_TOKENS, AGENT_VOC_MAX_OUTPUT_TOKENS, AGENT_VOC_TIMEOUT_MS, pricing, call/run/daily budgets, and AGENT_VOC_WORKER_OWNER_ID";

function parseTrustedOrigins(value: string | undefined) {
  const origins = new Set<string>();

  for (const item of value?.split(",") ?? []) {
    const candidate = item.trim();
    if (!candidate) continue;

    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new Error("Agent Service trusted origin is invalid");
    }
    origins.add(url.origin);
  }

  return origins;
}

export function loadAgentConfig(
  env: AgentEnvironment = process.env,
): AgentConfig {
  return agentConfigSchema.parse({
    host: env.AGENT_SERVICE_HOST ?? "127.0.0.1",
    port: canonicalPositiveInteger(
      env.AGENT_SERVICE_PORT ?? "3100",
      "Agent Service listen configuration is invalid",
    ),
  });
}

export function loadAgentServicePolicy(
  env: AgentEnvironment = process.env,
): AgentServicePolicy {
  const policy = agentServicePolicySchema.parse({
    bodyLimitBytes: canonicalPositiveInteger(
      env.AGENT_SERVICE_BODY_LIMIT_BYTES ?? "1048576",
      "Agent Service policy configuration is invalid",
    ),
    requestDeadlineMs: canonicalPositiveInteger(
      env.AGENT_SERVICE_REQUEST_DEADLINE_MS ?? "10000",
      "Agent Service policy configuration is invalid",
    ),
    proxyToken: env.AGENT_SERVICE_PROXY_TOKEN?.trim() || null,
  });

  return {
    ...policy,
    trustedOrigins: parseTrustedOrigins(env.AGENT_SERVICE_TRUSTED_ORIGINS),
  };
}

export function loadAgentAuthenticationConfig(
  env: AgentEnvironment = process.env,
  readNetworkInterfaces: NetworkInterfaceReader = networkInterfaces,
): AgentAuthenticationConfig {
  const anonymousLoopback = canonicalFlag(
    env.AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK,
  );
  const insecureCookie = canonicalFlag(
    env.AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE,
  );
  const insecurePrivateNetworkCookie = canonicalFlag(
    env.AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE,
  );

  if (
    insecurePrivateNetworkCookie &&
    (anonymousLoopback || insecureCookie)
  ) {
    throw new Error("Agent authentication configuration is invalid");
  }
  if (anonymousLoopback || insecureCookie) {
    assertLoopbackCompatibilityAllowed(env);
  }
  if (insecurePrivateNetworkCookie) {
    assertPrivateNetworkCompatibilityAllowed(env, readNetworkInterfaces);
  }
  const allowInsecureCookie = insecureCookie || insecurePrivateNetworkCookie;

  return Object.freeze({
    mode: anonymousLoopback ? "anonymous-loopback" : "authenticated",
    cookie: Object.freeze({
      name: allowInsecureCookie ? "agent_session" : "__Host-agent_session",
      secure: !allowInsecureCookie,
      maxAgeSeconds: 28_800,
    }),
    sessionTtlMs: 28_800_000,
    loginLimiter: Object.freeze({
      windowMs: 900_000,
      maxFailures: 5,
      maxEntries: 10_000,
    }),
  });
}

export function loadAgentDatabaseConfig(
  env: AgentEnvironment = process.env,
): AgentDatabaseConfig {
  const config = agentDatabaseConfigSchema.parse({
    path: env.AGENT_SQLITE_PATH ?? "",
    busyTimeoutMs: canonicalPositiveInteger(
      env.AGENT_SQLITE_BUSY_TIMEOUT_MS ?? "5000",
      "Agent database configuration is invalid",
    ),
  });

  return {
    path: resolve(config.path),
    busyTimeoutMs: config.busyTimeoutMs,
  };
}

export function loadAgentStorageConfig(
  env: AgentEnvironment = process.env,
): AgentStorageConfig {
  const databaseUrl = env.AGENT_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    return Object.freeze({
      kind: "sqlite" as const,
      sqlite: loadAgentDatabaseConfig(env),
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Agent storage configuration is invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Agent storage configuration is invalid");
  }
  return Object.freeze({
    kind: "postgres" as const,
    databaseUrl,
  });
}

export function loadResourceGovernorRuntimeConfig(
  env: AgentEnvironment = process.env,
): ResourceGovernorRuntimeConfig {
  const ownerId =
    env.AGENT_RESOURCE_GOVERNOR_OWNER_ID?.trim() ||
    `agent-service-${process.pid}`;
  if (ownerId.length > 200) {
    throw new Error("Agent resource governor configuration is invalid");
  }
  return Object.freeze({ ownerId });
}

export function loadSellerSpriteQuotaRefreshConfig(
  env: AgentEnvironment = process.env,
): SellerSpriteQuotaRefreshConfig | null {
  const visitsUrl = env.SELLERSPRITE_VISITS_URL?.trim() || null;
  const secretKey = readServerConnectorSecret("sellerSprite", env);
  if (!visitsUrl || !secretKey) return null;
  const url = new URL(visitsUrl);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/v1/visits" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("SellerSprite quota refresh configuration is invalid");
  }
  const timeoutMs = canonicalPositiveInteger(
    env.SELLERSPRITE_VISITS_TIMEOUT_MS ?? "10000",
    "SellerSprite quota refresh configuration is invalid",
  );
  const intervalMs = canonicalPositiveInteger(
    env.SELLERSPRITE_QUOTA_REFRESH_INTERVAL_MS ?? String(45 * 60 * 1000),
    "SellerSprite quota refresh configuration is invalid",
  );
  if (intervalMs < 30 * 60 * 1000 || intervalMs > 60 * 60 * 1000) {
    throw new Error("SellerSprite quota refresh configuration is invalid");
  }
  return Object.freeze({
    visitsUrl: url.toString(),
    secretKey,
    timeoutMs,
    intervalMs,
  });
}

export function loadAnalysisExecutionContext(
  env: AgentEnvironment = process.env,
): AnalysisExecutionContext | null {
  const actorId = env.AGENT_EXECUTION_ACTOR_ID?.trim();
  const organizationId = env.AGENT_EXECUTION_ORGANIZATION_ID?.trim();
  if (!actorId && !organizationId) return null;
  if (!actorId || !organizationId) {
    throw new Error(
      "AGENT_EXECUTION_ACTOR_ID and AGENT_EXECUTION_ORGANIZATION_ID must both be configured",
    );
  }
  return analysisExecutionContextSchema.parse({ actorId, organizationId });
}

export function loadVocPositioningRuntimeConfig(
  env: AgentEnvironment = process.env,
): VocPositioningRuntimeConfig {
  let parsed: z.infer<typeof vocPositioningRuntimeConfigSchema>;
  let provider: ReturnType<typeof resolveVocProviderTransport>;
  try {
    parsed = vocPositioningRuntimeConfigSchema.parse({
      apiKey: requiredRuntimeText(env.OPENAI_API_KEY),
      modelName: requiredRuntimeText(env.AGENT_VOC_MODEL),
      estimatedInputTokens: positiveRuntimeInteger(
        env.AGENT_VOC_ESTIMATED_INPUT_TOKENS,
      ),
      maxOutputTokens: positiveRuntimeInteger(env.AGENT_VOC_MAX_OUTPUT_TOKENS),
      timeoutMs: positiveRuntimeInteger(env.AGENT_VOC_TIMEOUT_MS),
      inputPrice: nonNegativeRuntimeDecimal(
        env.AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS,
      ),
      outputPrice: nonNegativeRuntimeDecimal(
        env.AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS,
      ),
      callMaxTokens: positiveRuntimeInteger(env.AGENT_VOC_CALL_MAX_TOKENS),
      callMaxCostMicros: positiveRuntimeInteger(
        env.AGENT_VOC_CALL_MAX_COST_MICROS,
      ),
      runMaxTokens: positiveRuntimeInteger(env.AGENT_VOC_RUN_MAX_TOKENS),
      runMaxCostMicros: positiveRuntimeInteger(
        env.AGENT_VOC_RUN_MAX_COST_MICROS,
      ),
      dailyMaxTokens: positiveRuntimeInteger(env.AGENT_VOC_DAILY_MAX_TOKENS),
      dailyMaxCostMicros: positiveRuntimeInteger(
        env.AGENT_VOC_DAILY_MAX_COST_MICROS,
      ),
      ownerId: requiredRuntimeText(env.AGENT_VOC_WORKER_OWNER_ID),
      leaseDurationMs: positiveRuntimeInteger(
        env.AGENT_VOC_WORKER_LEASE_MS ?? "120000",
      ),
      heartbeatIntervalMs: positiveRuntimeInteger(
        env.AGENT_VOC_WORKER_HEARTBEAT_MS ?? "30000",
      ),
      pollIntervalMs: positiveRuntimeInteger(
        env.AGENT_VOC_WORKER_POLL_MS ?? "250",
      ),
      stopTimeoutMs: positiveRuntimeInteger(
        env.AGENT_VOC_WORKER_STOP_TIMEOUT_MS ?? "5000",
      ),
      retryMaxAttempts: positiveRuntimeInteger(
        env.AGENT_VOC_RETRY_MAX_ATTEMPTS ?? "3",
      ),
      retryInitialDelayMs: positiveRuntimeInteger(
        env.AGENT_VOC_RETRY_INITIAL_DELAY_MS ?? "250",
      ),
      retryMaxDelayMs: positiveRuntimeInteger(
        env.AGENT_VOC_RETRY_MAX_DELAY_MS ?? "5000",
      ),
      retryJitterRatio: nonNegativeRuntimeDecimal(
        env.AGENT_VOC_RETRY_JITTER_RATIO ?? "0.2",
      ),
    });
    if (
      parsed.heartbeatIntervalMs >= parsed.leaseDurationMs ||
      parsed.retryInitialDelayMs > parsed.retryMaxDelayMs ||
      !Number.isSafeInteger(
        parsed.estimatedInputTokens + parsed.maxOutputTokens,
      )
    ) {
      throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
    }
    calculateModelCostMicros(
      parsed.estimatedInputTokens,
      parsed.maxOutputTokens,
      {
        inputUsdPerMillionTokens: parsed.inputPrice,
        outputUsdPerMillionTokens: parsed.outputPrice,
      },
    );
    provider = resolveVocProviderTransport(env);
  } catch {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  return Object.freeze({
    apiKey: parsed.apiKey,
    ...provider,
    model: Object.freeze({
      name: parsed.modelName,
      estimatedInputTokens: parsed.estimatedInputTokens,
      maxOutputTokens: parsed.maxOutputTokens,
      timeoutMs: parsed.timeoutMs,
      pricing: Object.freeze({
        inputUsdPerMillionTokens: parsed.inputPrice,
        outputUsdPerMillionTokens: parsed.outputPrice,
      }),
    }),
    budgetLimits: Object.freeze({
      call: Object.freeze({
        maxTokens: parsed.callMaxTokens,
        maxCostMicros: parsed.callMaxCostMicros,
      }),
      run: Object.freeze({
        maxTokens: parsed.runMaxTokens,
        maxCostMicros: parsed.runMaxCostMicros,
      }),
      organizationUtcDay: Object.freeze({
        maxTokens: parsed.dailyMaxTokens,
        maxCostMicros: parsed.dailyMaxCostMicros,
      }),
    }),
    worker: Object.freeze({
      ownerId: parsed.ownerId,
      leaseDurationMs: parsed.leaseDurationMs,
      heartbeatIntervalMs: parsed.heartbeatIntervalMs,
      pollIntervalMs: parsed.pollIntervalMs,
      stopTimeoutMs: parsed.stopTimeoutMs,
      retryPolicy: Object.freeze({
        maxAttempts: parsed.retryMaxAttempts,
        initialDelayMs: parsed.retryInitialDelayMs,
        maxDelayMs: parsed.retryMaxDelayMs,
        jitterRatio: parsed.retryJitterRatio,
      }),
    }),
  });
}

function resolveVocProviderTransport(env: AgentEnvironment): {
  transport: VocProviderTransport;
  baseUrl: string | null;
  providerName: string;
} {
  const transport =
    env.AGENT_VOC_TRANSPORT === undefined
      ? "responses-strict"
      : requiredRuntimeText(env.AGENT_VOC_TRANSPORT);
  if (transport === "responses-strict") {
    return {
      transport,
      baseUrl: null,
      providerName: "openai:responses-strict",
    };
  }
  if (transport !== "relay-chat-json") {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const url = new URL(requiredRuntimeText(env.OPENAI_BASE_URL));
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const baseUrl = url.toString().replace(/\/$/, "");
  return {
    transport,
    baseUrl,
    providerName: `openai:relay-chat-json:${sha256Hex(baseUrl)}`,
  };
}

export function resolveVocPositioningRuntimeConfig(
  env: AgentEnvironment = process.env,
): VocPositioningRuntimeConfigResolution {
  if (
    REQUIRED_VOC_RUNTIME_ENV.some(
      (name) =>
        env[name] === undefined || env[name]!.trim().length === 0,
    )
  ) {
    return Object.freeze({
      status: "incomplete" as const,
      reason: VOC_RUNTIME_INCOMPLETE_REASON,
    });
  }
  try {
    return Object.freeze({
      status: "configured" as const,
      config: loadVocPositioningRuntimeConfig(env),
      reason: null,
    });
  } catch {
    return Object.freeze({
      status: "invalid" as const,
      reason: VOC_RUNTIME_INVALID_REASON,
    });
  }
}

function requiredRuntimeText(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  return value.trim();
}

function canonicalFlag(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("Agent authentication configuration is invalid");
}

function assertLoopbackCompatibilityAllowed(env: AgentEnvironment): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Agent authentication configuration is invalid");
  }
  if (!isLoopbackHost(env.AGENT_SERVICE_HOST ?? "127.0.0.1")) {
    throw new Error("Agent authentication configuration is invalid");
  }

  let origins: Set<string>;
  try {
    origins = parseTrustedOrigins(env.AGENT_SERVICE_TRUSTED_ORIGINS);
  } catch {
    throw new Error("Agent authentication configuration is invalid");
  }
  if (origins.size === 0) {
    throw new Error("Agent authentication configuration is invalid");
  }
  for (const origin of origins) {
    if (!isLoopbackHost(new URL(origin).hostname)) {
      throw new Error("Agent authentication configuration is invalid");
    }
  }
}

type ParsedPrivateOrigin = Readonly<{
  origin: string;
  hostname: string;
  port: number;
}>;

function ipv4Octets(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  return octets.every((value) =>
    Number.isInteger(value) && value >= 0 && value <= 255,
  ) ? octets : null;
}

function isRfc1918Host(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function parsePrivateOrigins(value: string | undefined): ParsedPrivateOrigin[] {
  const parsed: ParsedPrivateOrigin[] = [];
  for (const item of value?.split(",") ?? []) {
    const candidate = item.trim();
    if (!candidate) continue;
    const authority = candidate.match(
      /^http:\/\/(\[[^\]]+\]|[^:/?#]+):([1-9]\d*)\/?$/i,
    );
    if (!authority) {
      throw new Error("Agent authentication configuration is invalid");
    }
    const port = Number(authority[2]);
    if (!Number.isInteger(port) || port > 65_535) {
      throw new Error("Agent authentication configuration is invalid");
    }
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      (!isLoopbackHost(hostname) && !isRfc1918Host(hostname))
    ) {
      throw new Error("Agent authentication configuration is invalid");
    }
    parsed.push({ origin: url.origin, hostname, port });
  }
  if (parsed.length === 0) {
    throw new Error("Agent authentication configuration is invalid");
  }
  return parsed;
}

function assignedPrivateIpv4(
  readNetworkInterfaces: NetworkInterfaceReader,
): ReadonlySet<string> {
  const assigned = new Set<string>();
  for (const entries of Object.values(readNetworkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        !entry.internal &&
        entry.family === "IPv4" &&
        isRfc1918Host(entry.address)
      ) {
        assigned.add(entry.address);
      }
    }
  }
  return assigned;
}

function assertPrivateNetworkCompatibilityAllowed(
  env: AgentEnvironment,
  readNetworkInterfaces: NetworkInterfaceReader,
): void {
  const fail = () => {
    throw new Error("Agent authentication configuration is invalid");
  };
  if (env.NODE_ENV === "production" || !env.AGENT_SERVICE_PROXY_TOKEN?.trim()) {
    fail();
  }

  const agentHost = env.AGENT_SERVICE_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(agentHost)) fail();
  if (
    env.WEB_PORT !== "31900" ||
    env.AGENT_SERVICE_PORT !== "31901"
  ) {
    fail();
  }

  let agentPort: number;
  let webPort: number;
  let internalUrl: URL;
  let origins: ParsedPrivateOrigin[];
  let assigned: ReadonlySet<string>;
  try {
    agentPort = canonicalPositiveInteger(
      env.AGENT_SERVICE_PORT ?? "",
      "Agent authentication configuration is invalid",
    );
    webPort = canonicalPositiveInteger(
      env.WEB_PORT ?? "",
      "Agent authentication configuration is invalid",
    );
    internalUrl = new URL(
      env.AGENT_SERVICE_INTERNAL_URL ?? `http://${agentHost}:${agentPort}`,
    );
    origins = parsePrivateOrigins(env.AGENT_SERVICE_TRUSTED_ORIGINS);
    assigned = assignedPrivateIpv4(readNetworkInterfaces);
  } catch {
    fail();
  }

  if (
    internalUrl!.protocol !== "http:" ||
    internalUrl!.username ||
    internalUrl!.password ||
    internalUrl!.search ||
    internalUrl!.hash ||
    (internalUrl!.pathname !== "/" && internalUrl!.pathname !== "") ||
    !isLoopbackHost(internalUrl!.hostname) ||
    Number(internalUrl!.port || "80") !== agentPort!
  ) {
    fail();
  }

  const webHost = (env.WEB_HOST ?? env.HOST ?? "127.0.0.1").trim();
  if (
    webHost !== "0.0.0.0" &&
    (!isRfc1918Host(webHost) || !assigned!.has(webHost))
  ) {
    fail();
  }

  const expectedHost = webHost === "0.0.0.0" ? null : webHost;
  const hasExactLanOrigin = origins!.some((origin) =>
    isRfc1918Host(origin.hostname) &&
    assigned!.has(origin.hostname) &&
    origin.port === webPort! &&
    (expectedHost === null || origin.hostname === expectedHost),
  );
  if (!hasExactLanOrigin) fail();
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const unbracketed =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;

  if (unbracketed === "localhost" || unbracketed === "::1") {
    return true;
  }

  const octets = unbracketed.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const parsed = Number(octet);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
  });
}

function canonicalPositiveInteger(value: string, message: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(message);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(message);
  return parsed;
}

function positiveRuntimeInteger(value: string | undefined): number {
  const text = requiredRuntimeText(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  return parsed;
}

function nonNegativeRuntimeDecimal(value: string | undefined): number {
  const text = requiredRuntimeText(value);
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(text)) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const parsed = Number(text);
  const semanticallyNonZero = /[1-9]/.test(text);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (semanticallyNonZero && parsed === 0)
  ) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  return parsed;
}
