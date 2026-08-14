import { resolve } from "node:path";

import { z } from "zod";

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
