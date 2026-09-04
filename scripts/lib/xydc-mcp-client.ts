import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { XydcVariantReasonCode } from "../../shared/xydc-variant-contract";

const ALLOWED_TOOLS = new Set(["get_asin_variations", "get_asin_info"]);
type AllowedTool = "get_asin_variations" | "get_asin_info";

export class XydcProviderError extends Error {
  readonly reasonCode: XydcVariantReasonCode;

  constructor(reasonCode: XydcVariantReasonCode) {
    super(reasonCode);
    this.name = "XydcProviderError";
    this.reasonCode = reasonCode;
  }

  toJSON() {
    return { name: this.name, reasonCode: this.reasonCode };
  }
}

export interface XydcClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  callTool?: (input: {
    toolName: AllowedTool;
    args: Readonly<Record<string, unknown>>;
    headers: Readonly<{ Authorization: string }>;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

function isBoundedToolPayload(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (typeof value === "object" && value !== null);
}

/** Projects an SDK CallToolResult into the only payload shape consumers may inspect. */
export function unwrapXydcToolResult(result: unknown): Record<string, unknown> | unknown[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new XydcProviderError("SCHEMA_INVALID");
  const envelope = result as { structuredContent?: unknown; content?: unknown };
  if (envelope.structuredContent !== undefined) {
    if (!isBoundedToolPayload(envelope.structuredContent)) throw new XydcProviderError("SCHEMA_INVALID");
    return envelope.structuredContent;
  }
  if (!Array.isArray(envelope.content) || envelope.content.length !== 1) throw new XydcProviderError("SCHEMA_INVALID");
  const [block] = envelope.content;
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new XydcProviderError("SCHEMA_INVALID");
  const text = block as { type?: unknown; text?: unknown };
  if (text.type !== "text" || typeof text.text !== "string") throw new XydcProviderError("SCHEMA_INVALID");
  try {
    const parsed: unknown = JSON.parse(text.text);
    if (!isBoundedToolPayload(parsed)) throw new XydcProviderError("SCHEMA_INVALID");
    return parsed;
  } catch (error) {
    if (error instanceof XydcProviderError) throw error;
    throw new XydcProviderError("SCHEMA_INVALID");
  }
}

export function xydcRequestHeaders(token: string) {
  if (!token.trim()) throw new XydcProviderError("NOT_CONFIGURED");
  return Object.freeze({ Authorization: `Bearer ${token.trim()}` });
}

export async function callXydcTool(
  token: string,
  toolName: AllowedTool,
  args: Readonly<Record<string, unknown>>,
  options: XydcClientOptions = {},
) {
  if (!ALLOWED_TOOLS.has(toolName)) throw new XydcProviderError("RPC_ERROR");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 15_000);
  try {
    const headers = xydcRequestHeaders(token);
    const raw = options.callTool
      ? await options.callTool({ toolName, args, headers, signal })
      : await callWithSdkTransport({ token, toolName, args, signal, env: options.env });
    return unwrapXydcToolResult(raw);
  } catch (error) {
    if (error instanceof XydcProviderError) throw error;
    throw new XydcProviderError(reasonForProviderError(error, signal));
  }
}

function reasonForProviderError(error: unknown, signal: AbortSignal): XydcVariantReasonCode {
  if (signal.aborted || (error instanceof Error && /abort|timeout/i.test(error.name))) return "TIMEOUT";
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  if (code === "AUTH_FAILED" || code === 401 || code === 403) return "AUTH_FAILED";
  if (code === "SCHEMA_INVALID") return "SCHEMA_INVALID";
  if (code === "NOT_FOUND" || code === 404) return "NOT_FOUND";
  return "RPC_ERROR";
}

async function callWithSdkTransport({
  token,
  toolName,
  args,
  signal,
  env = process.env,
}: {
  token: string;
  toolName: AllowedTool;
  args: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}) {
  const client = new Client({ name: "amazon-opportunity-insights", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(env.XYDC_MCP_URL?.trim() || "https://mcp.xydc.com/mcp"), {
    requestInit: { headers: xydcRequestHeaders(token), redirect: "error", signal },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
  });
  let connected = false;
  try {
    await client.connect(transport, { signal });
    connected = true;
    return await client.callTool({ name: toolName, arguments: args }, undefined, { signal });
  } finally {
    if (connected) await client.close().catch(() => undefined);
  }
}
