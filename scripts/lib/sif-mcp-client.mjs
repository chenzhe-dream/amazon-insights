import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import { McpTransportError, normalizeMcpResult, parseMcpResponse } from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";
import { runWithProviderDiagnostics } from "./provider-diagnostics.mjs";
import { providerEndpoint } from "./provider-network.mjs";

export function readSifHeaders(env = process.env) {
  const secret = readServerConnectorSecret("sif", env);
  return secret ? { "secret-key": secret, Authorization: secret } : null;
}

export async function requestSifMcp(
  method,
  params,
  {
    env = process.env,
    fetchImpl = fetch,
    signal,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    attemptKind = "initial",
  } = {},
) {
  const headers = readSifHeaders(env);
  if (!headers) throw new Error("SIF server credential is not configured");

  return await runWithProviderDiagnostics({
    connector: "sif",
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
    resource: "sif",
    attemptKind,
    operation: () => fetchImpl(providerEndpoint("sif", env), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    }),
    });
    return parseMcpResponse(response);
  });
}

export async function callSifTool(toolName, args, options = {}) {
  const env = options.env ?? process.env;
  return await runWithProviderDiagnostics({
    connector: "sif",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    env,
  }, async () => {
    const result = await requestSifMcp("tools/call", { name: toolName, arguments: args }, options);
    if (result?.isError === true) throw new McpTransportError("rpc", null, { boundary: "tool-content" });
    return normalizeMcpResult(result);
  });
}

function providerAsin(value) {
  const candidate = value?.asin ?? value?.arguments?.asin;
  return typeof candidate === "string" ? candidate.trim().toUpperCase() : "UNKNOWNASIN";
}
