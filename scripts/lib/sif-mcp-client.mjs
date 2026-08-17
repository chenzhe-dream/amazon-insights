import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";

export function readSifHeaders(env = process.env) {
  const secret = readServerConnectorSecret("sif", env);
  return secret ? { "secret-key": secret, Authorization: secret } : null;
}

export async function callSifTool(toolName, args, { env = process.env, fetchImpl = fetch } = {}) {
  const headers = readSifHeaders(env);
  if (!headers) throw new Error("SIF server credential is not configured");

  const response = await fetchImpl("https://mcp.sif.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const text = await response.text();
  const line = text
    .split("\n")
    .map(item => item.trim())
    .find(item => item.startsWith("data:"));
  const payload = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));

  const content = payload.result?.content?.[0]?.text;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  return payload.result ?? payload;
}
