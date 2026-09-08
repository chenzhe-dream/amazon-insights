import type { XydcOrderReason } from "../../shared/xydc-order-contract";
import type { XydcVariantReasonCode } from "../../shared/xydc-variant-contract";

type ProviderReasonCode = XydcVariantReasonCode | XydcOrderReason;
type SafeProviderReason = "APICredentialUnavailable" | "CreditBalanceInsufficient" |
  "CreditAccountUnavailable" | "APICredentialNotFound" | "CreditAccountNotFound" |
  "RateLimitExceeded" | "InternalError";

type XydcProviderErrorMetadata = Readonly<{
  statusCode?: number;
  retryAfterMs?: number;
  retryAfterUnbounded?: boolean;
  providerReason?: SafeProviderReason;
}>;

const MAX_SAFE_RETRY_AFTER_MS = Number.MAX_SAFE_INTEGER;

export class XydcProviderError extends Error {
  readonly reasonCode: ProviderReasonCode;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly retryAfterUnbounded?: boolean;
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
    this.retryAfterUnbounded = metadata.retryAfterUnbounded || (typeof metadata.retryAfterMs === "number" && metadata.retryAfterMs > MAX_SAFE_RETRY_AFTER_MS) || undefined;
  }

  toJSON() {
    return {
      name: this.name,
      reasonCode: this.reasonCode,
      ...(this.statusCode === undefined ? {} : { statusCode: this.statusCode }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.retryAfterUnbounded ? { retryAfterUnbounded: true } : {}),
      ...(this.providerReason === undefined ? {} : { providerReason: this.providerReason }),
    };
  }
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

export function decodeXydcResult(raw: unknown) { throwForStructuredOrderError(raw); return unwrapXydcToolResult(raw); }
export function structuralFields(error: unknown) {
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
  const retryDate = typeof rawRetry === "string" && !/^\d+(?:\.\d+)?$/.test(rawRetry.trim()) ? Date.parse(rawRetry) : NaN;
  const retryAfterUnbounded = (typeof rawRetry === "string" && /^\d+(?:\.\d+)?$/.test(rawRetry.trim()) || typeof rawRetry === "number")
    && retrySeconds >= 0 && (!Number.isFinite(retrySeconds) || retrySeconds * 1_000 > Number.MAX_SAFE_INTEGER);
  const retryAfterMs = Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now())
    : Number.isFinite(retrySeconds) && retrySeconds >= 0 && retrySeconds * 1_000 <= Number.MAX_SAFE_INTEGER
    ? Math.floor(retrySeconds * 1_000)
    : typeof record.retryAfterMs === "number" && Number.isInteger(record.retryAfterMs)
      && record.retryAfterMs >= 0 && record.retryAfterMs <= MAX_SAFE_RETRY_AFTER_MS
      ? Math.floor(record.retryAfterMs)
      : undefined;
  return { statusCode, providerReason, retryAfterMs, retryAfterUnbounded };
}

function orderReason(statusCode: number | undefined, providerReason: SafeProviderReason | undefined): XydcOrderReason {
  if (["APICredentialUnavailable", "APICredentialNotFound"].includes(providerReason ?? "")) return "AUTH_FAILED";
  if (["CreditBalanceInsufficient", "CreditAccountUnavailable", "CreditAccountNotFound"].includes(providerReason ?? "")) return "QUOTA_EXCEEDED";
  if (providerReason === "RateLimitExceeded" || statusCode === 429) return "RATE_LIMITED";
  if (statusCode === 401 || statusCode === 403) return "AUTH_FAILED";
  if (statusCode === 404) return "NOT_FOUND";
  return "RPC_ERROR";
}

export function providerErrorFor(error: unknown, signal: AbortSignal, orderTool: boolean) {
  if (signal.aborted || (error instanceof Error && /abort|timeout/i.test(error.name))) {
    return new XydcProviderError("TIMEOUT");
  }
  const fields = structuralFields(error);
  const known = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  if (known === "SCHEMA_INVALID") return new XydcProviderError("SCHEMA_INVALID");
  if (known === "AUTH_FAILED") return new XydcProviderError("AUTH_FAILED");
  if (known === "NOT_FOUND") return new XydcProviderError("NOT_FOUND");
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
  if (!envelope.structuredContent || typeof envelope.structuredContent !== "object" || Array.isArray(envelope.structuredContent)) return;
  const fields = structuralFields(envelope.structuredContent);
  if (envelope.isError !== true && fields.statusCode !== 429 && fields.providerReason !== "RateLimitExceeded") return;
  throw new XydcProviderError(orderReason(fields.statusCode, fields.providerReason), fields);
}
