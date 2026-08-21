import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import { normalizeMcpResult, parseMcpResponse } from "../../server/connectors/mcp-transport.mjs";

export function readSifHeaders(env = process.env) {
  const secret = readServerConnectorSecret("sif", env);
  return secret ? { "secret-key": secret, Authorization: secret } : null;
}

export async function requestSifMcp(
  method,
  params,
  { env = process.env, fetchImpl = fetch, signal } = {},
) {
  const headers = readSifHeaders(env);
  if (!headers) throw new Error("SIF server credential is not configured");

  const response = await fetchImpl("https://mcp.sif.com/mcp", {
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
  });

  return parseMcpResponse(response);
}

export async function callSifTool(toolName, args, options = {}) {
  return normalizeMcpResult(
    await requestSifMcp(
      "tools/call",
      { name: toolName, arguments: args },
      options,
    ),
  );
}
