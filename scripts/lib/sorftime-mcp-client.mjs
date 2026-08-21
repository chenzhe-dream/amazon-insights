import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import { normalizeMcpResult, parseMcpResponse } from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";

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

  const response = await governExternalRequest({
    resourceGovernor,
    requireResourceGovernor,
    env,
    organizationId,
    jobId,
    resource: "sorftime",
    attemptKind,
    operation: () => fetchImpl(`https://mcp.sorftime.com?key=${encodeURIComponent(key)}`, {
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
    }),
  });

  return parseMcpResponse(response);
}

export async function callSorftimeTool(key, toolName, args, options = {}) {
  return normalizeMcpResult(
    await requestSorftimeMcp(
      key,
      "tools/call",
      { name: toolName, arguments: args },
      options,
    ),
  );
}
