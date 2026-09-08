import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { XydcOrderReason } from "../../shared/xydc-order-contract";
import type { XydcVariantReasonCode } from "../../shared/xydc-variant-contract";

const ALLOWED_TOOLS = new Set(["get_asin_variations", "get_asin_info", "get_asin_order_trends"]);
type AllowedTool = "get_asin_variations" | "get_asin_info" | "get_asin_order_trends";
type ProviderReasonCode = XydcVariantReasonCode | XydcOrderReason;
type SafeProviderReason = "APICredentialUnavailable" | "CreditBalanceInsufficient" |
  "CreditAccountUnavailable" | "APICredentialNotFound" | "CreditAccountNotFound" |
  "RateLimitExceeded" | "InternalError";

type XydcProviderErrorMetadata = Readonly<{
  statusCode?: number;
  retryAfterMs?: number;
  providerReason?: SafeProviderReason;
}>;

const MAX_SAFE_RETRY_AFTER_MS = 30_000;

export class XydcProviderError extends Error {
  readonly reasonCode: ProviderReasonCode;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly providerReason?: SafeProviderReason;

  constructor(reasonCode: ProviderReasonCode, metadata: XydcProviderErrorMetadata = {}) {
    super(reasonCode);
    this.name = "XydcProviderError";
    this.reasonCode = reasonCode;
    this.statusCode = Number.isInteger(metadata.statusCode) && metadata.statusCode! >= 100 && metadata.statusCode! <= 599
      ? metadata.statusCode
      : undefined;
    this.retryAfterMs = Number.isInteger(metadata.retryAfterMs) && metadata.retryAfterMs! >= 0
      && metadata.retryAfterMs! <= MAX_SAFE_RETRY_AFTER_MS
      ? metadata.retryAfterMs
      : undefined;
    this.providerReason = metadata.providerReason;
  }

  toJSON() {
    return {
      name: this.name,
      reasonCode: this.reasonCode,
      ...(this.statusCode === undefined ? {} : { statusCode: this.statusCode }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.providerReason === undefined ? {} : { providerReason: this.providerReason }),
    };
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
  const envelope = result as { isError?: unknown; structuredContent?: unknown; content?: unknown };
  if (envelope.isError === true) throw new XydcProviderError("RPC_ERROR");
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
    if (toolName === "get_asin_order_trends") throwForStructuredOrderError(raw);
    return unwrapXydcToolResult(raw);
  } catch (error) {
    if (error instanceof XydcProviderError) throw error;
    throw providerErrorFor(error, signal, toolName === "get_asin_order_trends");
  }
}

function structuralFields(error: unknown) {
  const record = typeof error === "object" && error !== null && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const rawCode = record.code ?? record.status ?? record.statusCode;
  const statusCode = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode : undefined;
  const safeReasons = new Set<SafeProviderReason>([
    "APICredentialUnavailable", "CreditBalanceInsufficient", "CreditAccountUnavailable",
    "APICredentialNotFound", "CreditAccountNotFound", "RateLimitExceeded", "InternalError",
  ]);
  const providerReason = typeof record.reason === "string" && safeReasons.has(record.reason as SafeProviderReason)
    ? record.reason as SafeProviderReason
    : undefined;
  const headers = record.headers;
  const headerValue = headers && typeof headers === "object" && "get" in headers && typeof headers.get === "function"
    ? headers.get.call(headers, "retry-after")
    : undefined;
  const rawRetry = record.retryAfter ?? record.retryAfterSeconds ?? headerValue;
  const retrySeconds = typeof rawRetry === "number" ? rawRetry
    : typeof rawRetry === "string" && /^\d+(?:\.\d+)?$/.test(rawRetry.trim()) ? Number(rawRetry) : Number.NaN;
  const retryAfterMs = Number.isFinite(retrySeconds) && retrySeconds >= 0 && retrySeconds * 1_000 <= MAX_SAFE_RETRY_AFTER_MS
    ? Math.floor(retrySeconds * 1_000)
    : typeof record.retryAfterMs === "number" && Number.isInteger(record.retryAfterMs)
      && record.retryAfterMs >= 0 && record.retryAfterMs <= MAX_SAFE_RETRY_AFTER_MS
      ? Math.floor(record.retryAfterMs)
      : undefined;
  return { statusCode, providerReason, retryAfterMs };
}

function orderReason(statusCode: number | undefined, providerReason: SafeProviderReason | undefined): XydcOrderReason {
  if (["APICredentialUnavailable", "APICredentialNotFound"].includes(providerReason ?? "")) return "AUTH_FAILED";
  if (["CreditBalanceInsufficient", "CreditAccountUnavailable", "CreditAccountNotFound"].includes(providerReason ?? "")) return "QUOTA_EXCEEDED";
  if (providerReason === "RateLimitExceeded" || statusCode === 429) return "RATE_LIMITED";
  if (statusCode === 401 || statusCode === 403) return "AUTH_FAILED";
  if (statusCode === 404) return "NOT_FOUND";
  return "RPC_ERROR";
}

function providerErrorFor(error: unknown, signal: AbortSignal, orderTool: boolean) {
  if (signal.aborted || (error instanceof Error && /abort|timeout/i.test(error.name))) {
    return new XydcProviderError("TIMEOUT");
  }
  const fields = structuralFields(error);
  if (orderTool) return new XydcProviderError(orderReason(fields.statusCode, fields.providerReason), fields);
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  if (code === "AUTH_FAILED" || code === 401 || code === 403) return new XydcProviderError("AUTH_FAILED");
  if (code === "SCHEMA_INVALID") return new XydcProviderError("SCHEMA_INVALID");
  if (code === "NOT_FOUND" || code === 404) return new XydcProviderError("NOT_FOUND");
  return new XydcProviderError("RPC_ERROR");
}

function throwForStructuredOrderError(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const envelope = result as { isError?: unknown; structuredContent?: unknown };
  if (envelope.isError !== true || !envelope.structuredContent || typeof envelope.structuredContent !== "object" || Array.isArray(envelope.structuredContent)) return;
  const fields = structuralFields(envelope.structuredContent);
  throw new XydcProviderError(orderReason(fields.statusCode, fields.providerReason), fields);
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
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (response.ok) return response;
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      throw Object.assign(new Error("XYDC_HTTP_ERROR"), {
        code: response.status,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    },
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
