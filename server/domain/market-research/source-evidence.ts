import { createHash } from "node:crypto";
import { MarketInputRecordSchema, type MarketAnalysisScope, type MarketJsonValue } from "../../../shared/market-analysis-contracts";
import {
  MARKET_SOURCE_IDENTITY_FIELDS, MarketSourceEvidenceInputSchema, MarketSourceIdentityValueSchemas,
  type MarketSourceEvidence, type MarketSourceIdentityCheck, type MarketSourceIdentityField, type MarketSourcePayloadPath,
} from "../../../shared/market-source-contracts";

function canonical(value: MarketJsonValue): MarketJsonValue {
  if (Array.isArray(value)) {
    const result: MarketJsonValue[] = [];
    for (let index = 0; index < value.length; index++) result.push(canonical(value[index]));
    return result;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function readOwnPath(payload: MarketJsonValue, path: MarketSourcePayloadPath): { found: true; value: MarketJsonValue } | { found: false } {
  let value = payload;
  for (const key of path) {
    if (value === null || typeof value !== "object") return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return { found: false };
    value = descriptor.value as MarketJsonValue;
  }
  return { found: true, value };
}

function assertResearchIdentity(field: MarketSourceIdentityField, value: string | number, scope: MarketAnalysisScope): void {
  const expected = field === "marketplace" ? scope.marketplace
    : field === "currency" ? scope.currency
      : field === "nodeIdPath" ? scope.nodeIdPath
        : field === "nodeId" ? scope.nodeIdPath.split(":").at(-1) : undefined;
  if (expected !== undefined && value !== expected) throw new TypeError(`${field} conflicts with research scope`);
  if (field === "month" && (String(value) < scope.fromMonth || String(value) > scope.toMonth)) throw new TypeError("month falls outside research scope");
}

/**
 * Creates immutable evidence from plain JSON, after service authorization.
 * Typed collectors must declare every identity echo location; this factory never
 * guesses that a returned keyword item is the request keyword or infers periods.
 */
export function createMarketSourceEvidence(value: unknown, now: Date = new Date()): MarketSourceEvidence {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("A valid current time is required");
  // Reuse T1's repaired guard before reading envelope fields or any input methods.
  const json = MarketInputRecordSchema.shape.data.safeParse(value);
  if (!json.success) throw new TypeError("Source evidence input must be bounded plain JSON with finite numbers");
  const parsed = MarketSourceEvidenceInputSchema.parse(json.data);
  if (parsed.scope.toMonth >= now.toISOString().slice(0, 7)) throw new TypeError("Research requires completed calendar months");
  if (Date.parse(parsed.fetchedAt) > now.getTime()) throw new TypeError("fetchedAt cannot be in the future");
  const period = parsed.observationPeriod;
  if (period.kind === "calendar-months" && period.toMonth >= parsed.fetchedAt.slice(0, 7)) {
    throw new TypeError("Observation calendar months must be complete at fetchedAt");
  }
  if ((period.kind === "current" || period.kind === "trailing-days") && Date.parse(period.asOf) > Date.parse(parsed.fetchedAt)) {
    throw new TypeError("Observation asOf cannot be after fetchedAt");
  }
  for (const field of MARKET_SOURCE_IDENTITY_FIELDS) {
    const requested = parsed.requestIdentity[field];
    if (requested !== undefined) assertResearchIdentity(field, requested, parsed.scope);
  }
  for (const [metric, unit] of Object.entries(parsed.units)) {
    if (unit.status === "known" && unit.currency !== undefined && unit.currency !== parsed.scope.currency) {
      throw new TypeError(`${metric} currency conflicts with research scope`);
    }
  }

  const responseIdentity = {} as Record<MarketSourceIdentityField, MarketSourceIdentityCheck>;
  for (const field of MARKET_SOURCE_IDENTITY_FIELDS) {
    const requested = parsed.requestIdentity[field];
    const echoes: { path: MarketSourcePayloadPath; value: string | number }[] = [];
    const missingPaths: MarketSourcePayloadPath[] = [];
    for (const path of parsed.responseIdentityPaths[field] ?? []) {
      const raw = readOwnPath(parsed.payload, path);
      if (!raw.found) { missingPaths.push([...path]); continue; }
      const checked = MarketSourceIdentityValueSchemas[field].safeParse(raw.value);
      if (!checked.success) throw new TypeError(`Invalid response ${field} identity`);
      const actual = checked.data;
      assertResearchIdentity(field, actual, parsed.scope);
      if (requested !== undefined && actual !== requested) throw new TypeError(`Response ${field} conflicts with request identity`);
      if (echoes.length > 0 && echoes[0].value !== actual) throw new TypeError(`Response ${field} echoes conflict with each other`);
      echoes.push({ path: [...path], value: actual });
    }
    const checkReason = missingPaths.length > 0 ? "missing-echo-path" as const
      : echoes.length === 0 ? "not-echoed" as const
        : requested === undefined ? "no-request-identity" as const : null;
    responseIdentity[field] = {
      expected: requested ?? null, echoes, missingPaths,
      status: checkReason === null ? "verified" : "unverified", reason: checkReason,
    };
  }

  const payloadText = JSON.stringify(canonical(parsed.payload));
  if (Buffer.byteLength(payloadText, "utf8") > 8_000_000) throw new TypeError("Source payload exceeds the supported byte budget");
  const payloadHash = createHash("sha256").update(payloadText).digest("hex");
  // JSON was validated before serialization; detach every metadata reference too.
  return freezeDeep(JSON.parse(JSON.stringify({
    schemaVersion: "market-source-evidence/v1",
    scope: parsed.scope, provider: parsed.provider, operation: parsed.operation,
    requestIdentity: parsed.requestIdentity, fetchedAt: parsed.fetchedAt,
    observationPeriod: parsed.observationPeriod, units: parsed.units, coverage: parsed.coverage,
    responseIdentity,
    payload: JSON.parse(payloadText), payloadHash,
  })) as MarketSourceEvidence);
}
