import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class McpTransportError extends Error {
  constructor(kind, status = null, diagnostic = {}) {
    super("MCP transport failed");
    this.name = "McpTransportError";
    this.kind = kind;
    this.status = status;
    this.providerDiagnostic = Object.freeze({
      boundary: diagnostic.boundary,
      shape: diagnostic.shape ?? describeMcpCandidateShape(diagnostic.candidate, {
        unknown: diagnostic.candidate === undefined,
      }),
    });
  }
}

export function safeSellerSpriteTransportError(error, signal, diagnostic = {}) {
  if (signal.aborted) return new McpTransportError("timeout", null, diagnostic);
  if (
    error instanceof StreamableHTTPError &&
    Number.isInteger(error.code) &&
    error.code >= 100 &&
    error.code <= 599
  ) {
    return new McpTransportError("http", error.code, diagnostic);
  }
  return new McpTransportError("malformed", null, diagnostic);
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
    throw new McpTransportError("malformed", null, { boundary: "response-body" });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new McpTransportError("malformed", null, { boundary: "rpc-envelope", candidate: payload });
  }
  if (payload.error) {
    throw new McpTransportError("rpc");
  }
  if (!("result" in payload)) {
    throw new McpTransportError("malformed", null, { boundary: "rpc-envelope", candidate: payload });
  }
  return payload.result;
}

export function normalizeMcpResult(result) {
  const content = result?.content?.[0]?.text;
  if (typeof content !== "string") return result;
  try {
    return JSON.parse(content);
  } catch {
    throw new McpTransportError("malformed", null, { boundary: "tool-content" });
  }
}

export function createMcpConsumerShapeError(candidate) {
  return new McpTransportError("schema", null, {
    boundary: "consumer-shape",
    candidate,
  });
}

function describeMcpCandidateShape(candidate, { unknown = false } = {}) {
  if (unknown) return unknownShape();
  const topLevelType = jsonType(candidate);
  const data = fieldShape(candidate, "data");
  const projected = data.presence === "present" && candidate?.data != null
    ? candidate.data
    : candidate;
  return Object.freeze({
    topLevelType,
    data,
    details: fieldShape(projected, "details"),
    items: fieldShape(projected, "items"),
  });
}

function unknownShape() {
  const field = () => Object.freeze({ presence: "unknown", type: "unknown" });
  return Object.freeze({
    topLevelType: "unknown",
    data: field(),
    details: field(),
    items: field(),
  });
}

function fieldShape(candidate, field) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return Object.freeze({ presence: "missing", type: "unknown" });
  }
  if (!Object.hasOwn(candidate, field)) {
    return Object.freeze({ presence: "missing", type: "unknown" });
  }
  return Object.freeze({ presence: "present", type: jsonType(candidate[field]) });
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (["object", "string", "number", "boolean"].includes(typeof value)) return typeof value;
  return "unknown";
}
