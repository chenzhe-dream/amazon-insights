import { z } from "zod";

const agentConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65_535),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export function loadAgentConfig(
  env: AgentEnvironment = process.env,
): AgentConfig {
  return agentConfigSchema.parse({
    host: env.AGENT_SERVICE_HOST ?? "127.0.0.1",
    port: env.AGENT_SERVICE_PORT ?? "3100",
  });
}
