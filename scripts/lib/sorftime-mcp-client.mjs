import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import { normalizeMcpResult, parseMcpResponse } from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";
import { runWithProviderDiagnostics } from "./provider-diagnostics.mjs";
import { providerEndpoint } from "./provider-network.mjs";

export function readSorftimeKey(env = process.env) {
  return readServerConnectorSecret("sorftime", env);
}

export async function requestSorftimeMcp(
  key,
  method,
  params,
  {
    fetchImpl = fetch,
    signal,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    attemptKind = "initial",
    env = process.env,
  } = {},
) {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Sorftime server credential is not configured");
  }

  return await runWithProviderDiagnostics({
    connector: "sorftime",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(params),
    env,
  }, async () => {
    const response = await governExternalRequest({
    resourceGovernor,
    requireResourceGovernor,
    env,
    organizationId,
    jobId,
    resource: "sorftime",
    attemptKind,
    operation: () => {
      const endpoint = new URL(providerEndpoint("sorftime", env));
      endpoint.searchParams.set("key", key);
      return fetchImpl(endpoint, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
      });
    },
    });
    return parseMcpResponse(response);
  });
}

export async function callSorftimeTool(key, toolName, args, options = {}) {
  const env = options.env ?? process.env;
  return await runWithProviderDiagnostics({
    connector: "sorftime",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    env,
  }, async () => normalizeMcpResult(
    await requestSorftimeMcp(key, "tools/call", { name: toolName, arguments: args }, options),
  ));
}

function providerAsin(value) {
  const candidate = value?.asin ?? value?.arguments?.asin;
  return typeof candidate === "string" ? candidate.trim().toUpperCase() : "UNKNOWNASIN";
}
