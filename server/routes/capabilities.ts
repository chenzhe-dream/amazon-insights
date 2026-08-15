import type { FastifyInstance } from "fastify";

import {
  CapabilitiesResponseSchema,
  type CapabilitiesResponse,
} from "../../shared/agent-contracts";

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface OpenAiRuntimeCapability {
  configured: boolean;
  available: boolean;
  reason: string | null;
}

interface AgentRuntimeCapabilities {
  storageAvailable: boolean;
  openaiAvailable?: boolean;
  openai?: OpenAiRuntimeCapability;
}

function unavailableState(
  configured: boolean,
  missingReason: string,
  unavailableReason: string,
): CapabilitiesResponse["capabilities"]["storage"] {
  return {
    configured,
    available: false,
    reason: configured ? unavailableReason : missingReason,
  };
}

function hasValue(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function getAgentCapabilities(
  env: AgentEnvironment = process.env,
  runtime: AgentRuntimeCapabilities = { storageAvailable: false },
): CapabilitiesResponse {
  const storageConfigured =
    hasValue(env.AGENT_DATABASE_URL) || hasValue(env.AGENT_SQLITE_PATH);
  const payload = {
    schemaVersion: "1.0.0",
    capabilities: {
      storage:
        storageConfigured && runtime.storageAvailable
          ? { configured: true, available: true, reason: null }
          : unavailableState(
              storageConfigured,
              "Storage is not configured",
              "Storage runtime is not available in this build",
            ),
      openai: runtime.openai ??
        (hasValue(env.OPENAI_API_KEY) && runtime.openaiAvailable
          ? { configured: true, available: true, reason: null }
          : unavailableState(
              hasValue(env.OPENAI_API_KEY),
              "OpenAI credential is not configured",
              "OpenAI runtime is not active",
            )),
      sif: unavailableState(
        hasValue(env.SIF_MCP_SECRET),
        "SIF credential is not configured",
        "SIF connector is not available in this build",
      ),
      sorftime: unavailableState(
        hasValue(env.SORFTIME_MCP_KEY),
        "Sorftime credential is not configured",
        "Sorftime connector is not available in this build",
      ),
      sellerSprite: unavailableState(
        hasValue(env.SELLERSPRITE_SECRET_KEY),
        "SellerSprite credential is not configured",
        "SellerSprite connector is not available in this build",
      ),
      manualVoc: {
        configured: true,
        available: false,
        reason: "Manual VOC import is not available in this build",
      },
    },
  };

  return CapabilitiesResponseSchema.parse(payload);
}

export function registerCapabilitiesRoutes(
  app: FastifyInstance,
  env: AgentEnvironment = process.env,
  runtime: AgentRuntimeCapabilities = { storageAvailable: false },
) {
  app.get("/v1/capabilities", async () => getAgentCapabilities(env, runtime));
}
