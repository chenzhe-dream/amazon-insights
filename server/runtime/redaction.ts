import { createHash } from "node:crypto";

const SENSITIVE_KEY =
  /(?:api.?key|authorization|cookie|credential|password|passwd|secret|session|token)/i;

export interface ContentSummary {
  contentHash: string;
  recordCount: number;
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const canonical = Array.isArray(value)
    ? value.map((item) => canonicalize(item, seen))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            canonicalize((value as Record<string, unknown>)[key], seen),
          ]),
      );
  seen.delete(value);
  return canonical;
}

function countRecords(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length + value.reduce((sum, item) => sum + countRecords(item), 0);
  }
  if (value && typeof value === "object") return 1;
  return 0;
}

export function summarizeContent(value: unknown): ContentSummary {
  const serialized = JSON.stringify(canonicalize(value));
  return Object.freeze({
    contentHash: createHash("sha256").update(serialized).digest("hex"),
    recordCount: countRecords(value),
  });
}

export function redactForLog(
  value: unknown,
  seen = new Set<object>(),
): unknown {
  if (typeof value === "string") {
    return redactStringForLog(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactForLog(item, seen));
    seen.delete(value);
    return redacted;
  }

  const redacted: Record<string, unknown> = {};
  let removedSensitiveField = false;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      removedSensitiveField = true;
      continue;
    }
    redacted[key] = redactForLog(child, seen);
  }
  if (removedSensitiveField) redacted.redacted = "[REDACTED]";
  seen.delete(value);
  return redacted;
}

export function redactStringForLog(value: string) {
  return value
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
