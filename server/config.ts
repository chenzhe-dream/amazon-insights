import { resolve } from "node:path";

import { z } from "zod";

import { EntityIdSchema } from "../shared/agent-contracts";
import type { ModelBudgetLimits } from "./db/model-budget-repository";
import type { ModelExecutionConfig } from "./runtime/skill-runner";

const agentConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65_535),
});

const agentServicePolicySchema = z.object({
  bodyLimitBytes: z.coerce.number().int().min(1).max(10_485_760),
  requestDeadlineMs: z.coerce.number().int().min(1).max(300_000),
  proxyToken: z.string().trim().min(1).nullable(),
});

const agentDatabaseConfigSchema = z.object({
  path: z.string().trim().min(1, "AGENT_SQLITE_PATH is required"),
  busyTimeoutMs: z.coerce.number().int().min(1).max(60_000),
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

const vocPositioningRuntimeConfigSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  modelName: z.string().trim().min(1).max(500),
  estimatedInputTokens: z.coerce.number().int().positive(),
  maxOutputTokens: z.coerce.number().int().positive(),
  timeoutMs: z.coerce.number().int().min(1_000).max(300_000),
  inputPrice: z.coerce.number().nonnegative().finite(),
  outputPrice: z.coerce.number().nonnegative().finite(),
  callMaxTokens: z.coerce.number().int().positive(),
  callMaxCostMicros: z.coerce.number().int().positive(),
  runMaxTokens: z.coerce.number().int().positive(),
  runMaxCostMicros: z.coerce.number().int().positive(),
  dailyMaxTokens: z.coerce.number().int().positive(),
  dailyMaxCostMicros: z.coerce.number().int().positive(),
  ownerId: z.string().trim().min(1).max(500),
  leaseDurationMs: z.coerce.number().int().positive(),
  heartbeatIntervalMs: z.coerce.number().int().positive(),
  pollIntervalMs: z.coerce.number().int().positive(),
  stopTimeoutMs: z.coerce.number().int().positive(),
  retryMaxAttempts: z.coerce.number().int().positive(),
  retryInitialDelayMs: z.coerce.number().int().positive(),
  retryMaxDelayMs: z.coerce.number().int().positive(),
  retryJitterRatio: z.coerce.number().min(0).max(1),
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
    port: env.AGENT_SERVICE_PORT ?? "3100",
  });
}

export function loadAgentServicePolicy(
  env: AgentEnvironment = process.env,
): AgentServicePolicy {
  const policy = agentServicePolicySchema.parse({
    bodyLimitBytes: env.AGENT_SERVICE_BODY_LIMIT_BYTES ?? "1048576",
    requestDeadlineMs: env.AGENT_SERVICE_REQUEST_DEADLINE_MS ?? "10000",
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
    busyTimeoutMs: env.AGENT_SQLITE_BUSY_TIMEOUT_MS ?? "5000",
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
      apiKey: env.OPENAI_API_KEY ?? "",
      modelName: env.AGENT_VOC_MODEL ?? "",
      estimatedInputTokens: env.AGENT_VOC_ESTIMATED_INPUT_TOKENS ?? "",
      maxOutputTokens: env.AGENT_VOC_MAX_OUTPUT_TOKENS ?? "",
      timeoutMs: env.AGENT_VOC_TIMEOUT_MS ?? "",
      inputPrice: env.AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS ?? "",
      outputPrice: env.AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS ?? "",
      callMaxTokens: env.AGENT_VOC_CALL_MAX_TOKENS ?? "",
      callMaxCostMicros: env.AGENT_VOC_CALL_MAX_COST_MICROS ?? "",
      runMaxTokens: env.AGENT_VOC_RUN_MAX_TOKENS ?? "",
      runMaxCostMicros: env.AGENT_VOC_RUN_MAX_COST_MICROS ?? "",
      dailyMaxTokens: env.AGENT_VOC_DAILY_MAX_TOKENS ?? "",
      dailyMaxCostMicros: env.AGENT_VOC_DAILY_MAX_COST_MICROS ?? "",
      ownerId: env.AGENT_VOC_WORKER_OWNER_ID ?? "",
      leaseDurationMs: env.AGENT_VOC_WORKER_LEASE_MS ?? "120000",
      heartbeatIntervalMs: env.AGENT_VOC_WORKER_HEARTBEAT_MS ?? "30000",
      pollIntervalMs: env.AGENT_VOC_WORKER_POLL_MS ?? "250",
      stopTimeoutMs: env.AGENT_VOC_WORKER_STOP_TIMEOUT_MS ?? "5000",
      retryMaxAttempts: env.AGENT_VOC_RETRY_MAX_ATTEMPTS ?? "3",
      retryInitialDelayMs: env.AGENT_VOC_RETRY_INITIAL_DELAY_MS ?? "250",
      retryMaxDelayMs: env.AGENT_VOC_RETRY_MAX_DELAY_MS ?? "5000",
      retryJitterRatio: env.AGENT_VOC_RETRY_JITTER_RATIO ?? "0.2",
    });
  } catch {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  if (parsed.heartbeatIntervalMs >= parsed.leaseDurationMs) {
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
