import fs from "node:fs";
import path from "node:path";

function readMcpConfig() {
  const mcpPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cursor", "mcp.json");
  if (!fs.existsSync(mcpPath)) return null;
  return JSON.parse(fs.readFileSync(mcpPath, "utf8"));
}

export function readSifHeaders() {
  const fromEnv = process.env.SIF_MCP_SECRET;
  if (fromEnv) {
    return { "secret-key": fromEnv, Authorization: fromEnv };
  }
  const config = readMcpConfig();
  const headers = config?.mcpServers?.["sif-mcp"]?.headers ?? {};
  if (headers["secret-key"] || headers.Authorization) return headers;
  return null;
}

export async function callSifTool(toolName, args) {
  const headers = readSifHeaders();
  if (!headers) throw new Error("未找到 SIF MCP 密钥，请配置 ~/.cursor/mcp.json 或 SIF_MCP_SECRET");

  const response = await fetch("https://mcp.sif.com/mcp", {
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
