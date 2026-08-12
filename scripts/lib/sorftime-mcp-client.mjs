import fs from "node:fs";
import path from "node:path";

export function readSorftimeKey() {
  if (process.env.SORFTIME_MCP_KEY) return process.env.SORFTIME_MCP_KEY;
  const mcpPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cursor", "mcp.json");
  if (!fs.existsSync(mcpPath)) return null;
  const config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  const url = config?.mcpServers?.["sorftime-mcp"]?.url ?? "";
  const match = url.match(/[?&]key=([^&]+)/);
  return match?.[1] ?? config?.mcpServers?.["sorftime-mcp"]?.headers?.Authorization ?? null;
}

export async function callSorftimeTool(key, toolName, args) {
  const response = await fetch(`https://mcp.sorftime.com?key=${encodeURIComponent(key)}`, {
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
