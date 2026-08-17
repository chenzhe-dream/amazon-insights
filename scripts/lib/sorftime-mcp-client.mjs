import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";

export function readSorftimeKey(env = process.env) {
  return readServerConnectorSecret("sorftime", env);
}

export async function callSorftimeTool(key, toolName, args, { fetchImpl = fetch } = {}) {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Sorftime server credential is not configured");
  }

  const response = await fetchImpl(`https://mcp.sorftime.com?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
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
