import { resolve } from "node:path";

import { z } from "zod";

import { EntityIdSchema } from "../shared/agent-contracts";
import type { ModelBudgetLimits } from "./db/model-budget-repository";
import { calculateModelCostMicros } from "./runtime/model-request-accounting";
import type { ModelExecutionConfig } from "./runtime/skill-runner";

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

export type AnalysisExecutionContext = z.infer<
  typeof analysisExecutionContextSchema
>;

export interface VocPositioningRuntimeConfig {
  apiKey: string;
  providerName: "openai";
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
  } catch {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  return Object.freeze({
    apiKey: parsed.apiKey,
    providerName: "openai" as const,
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
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  return parsed;
}
