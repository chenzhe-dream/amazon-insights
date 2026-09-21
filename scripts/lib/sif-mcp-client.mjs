import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import { McpTransportError, normalizeMcpResult, parseMcpResponse } from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";
import { runWithProviderDiagnostics } from "./provider-diagnostics.mjs";
import { providerEndpoint } from "./provider-network.mjs";

/** @param {Readonly<Record<string, string | undefined>>} [env] */
export function readSifHeaders(env = process.env) {
  const secret = readServerConnectorSecret("sif", env);
  return secret ? { "secret-key": secret, Authorization: secret } : null;
}

/**
 * @typedef {object} SifMcpOptions
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 * @property {import('../../server/db/concurrency-control-repository').ResourceGovernor} [resourceGovernor]
 * @property {boolean} [requireResourceGovernor]
 * @property {string | null} [organizationId]
 * @property {string | null} [jobId]
 * @property {import('../../server/db/concurrency-control-repository').GovernedAttemptKind} [attemptKind]
 */

/** @param {SifMcpOptions} [options] */
export async function requestSifMcp(
  method,
  params,
  options = {},
) {
  const {
    env = process.env,
    fetchImpl = fetch,
    signal,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    attemptKind = "initial",
  } = options;
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

/** @param {SifMcpOptions} [options] */
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
