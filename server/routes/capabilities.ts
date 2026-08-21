import type { FastifyInstance } from "fastify";

import {
  CapabilitiesResponseSchema,
  type CapabilitiesResponse,
} from "../../shared/agent-contracts";
import type { RequestPrincipal } from "../auth/authorization";
import { getServerConnectorSecretState } from "../config/connector-secrets.mjs";
import type { ConnectorCapabilities } from "../services/connector-probe-service";

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
  connectors?: ConnectorCapabilities;
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

function passiveConnectorState(
  configured: boolean,
  displayName: string,
): CapabilitiesResponse["capabilities"]["sif"] {
  return {
    configured,
    available: false,
    reason: configured
      ? "Connector health has not been checked"
      : `${displayName} credential is not configured`,
    checkedAt: null,
  };
}

export function getAgentCapabilities(
  env: AgentEnvironment = process.env,
  runtime: AgentRuntimeCapabilities = { storageAvailable: false },
): CapabilitiesResponse {
  const connectorSecrets = getServerConnectorSecretState(env);
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
      sif:
        runtime.connectors?.sif ??
        passiveConnectorState(connectorSecrets.sif, "SIF"),
      sorftime:
        runtime.connectors?.sorftime ??
        passiveConnectorState(connectorSecrets.sorftime, "Sorftime"),
      sellerSprite:
        runtime.connectors?.sellerSprite ??
        passiveConnectorState(connectorSecrets.sellerSprite, "SellerSprite"),
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
  connectorCapabilities?: (
    principal: Extract<RequestPrincipal, { kind: "user" }>,
  ) => Promise<ConnectorCapabilities>,
) {
  app.get("/v1/capabilities", async (request) => {
    const principal = request.authPrincipal;
    if (!connectorCapabilities || principal?.kind !== "user") {
      return getAgentCapabilities(env, runtime);
    }
    try {
      return getAgentCapabilities(env, {
        ...runtime,
        connectors: await connectorCapabilities(principal),
      });
    } catch {
      return getAgentCapabilities(env, runtime);
    }
  });
}
