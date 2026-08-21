export class McpTransportError extends Error {
  constructor(kind, status = null) {
    super("MCP transport failed");
    this.name = "McpTransportError";
    this.kind = kind;
    this.status = status;
  }
}

export async function parseMcpResponse(response) {
  if (!response.ok) {
    throw new McpTransportError("http", response.status);
  }

  const text = await response.text();
  const dataLine = text
    .split("\n")
    .map(line => line.trim())
    .find(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]");

  let payload;
  try {
    payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  } catch {
    throw new McpTransportError("malformed");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new McpTransportError("malformed");
  }
  if (payload.error) {
    throw new McpTransportError("rpc");
  }
  if (!("result" in payload)) {
    throw new McpTransportError("malformed");
  }
  return payload.result;
}

export function normalizeMcpResult(result) {
  const content = result?.content?.[0]?.text;
  if (typeof content !== "string") return result;
  try {
    return JSON.parse(content);
  } catch {
    throw new McpTransportError("malformed");
  }
}
