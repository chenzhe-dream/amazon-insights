import { createHash } from "node:crypto";
import {
  MarketInputSnapshotInputSchema,
  type MarketInputSnapshot,
  type MarketJsonValue,
} from "../../../shared/market-analysis-contracts";

const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function canonicalize(value: MarketJsonValue): MarketJsonValue {
  if (Array.isArray(value)) {
    const items: MarketJsonValue[] = [];
    for (let index = 0; index < value.length; index++) items[index] = canonicalize(value[index]);
    return items;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareIds).map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

/** Create a content-addressed input snapshot after the collector verifies source scope. */
export function createMarketInputSnapshot(value: unknown, now: Date = new Date()): MarketInputSnapshot {
  if (!Number.isFinite(now.getTime())) throw new TypeError("A valid current time is required");
  const parsed = MarketInputSnapshotInputSchema.parse(value);
  if (parsed.scope.toMonth >= now.toISOString().slice(0, 7)) {
    throw new TypeError("Research requires a completed calendar month");
  }
  if (Date.parse(parsed.collectedAt) > now.getTime()) throw new TypeError("Collection time cannot be in the future");
  const expected = [...parsed.expectedRecordIds].sort(compareIds);
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length) throw new TypeError("Duplicate expected record ID");
  const scopeIdentity = JSON.stringify(canonicalize(parsed.scope));
  const actual = new Set<string>();
  for (const record of parsed.records) {
    if (JSON.stringify(canonicalize(record.scope)) !== scopeIdentity) throw new TypeError("Record scope differs from research scope");
    if (!expectedSet.has(record.id)) throw new TypeError("Record is outside the declared input pool");
    if (actual.has(record.id)) throw new TypeError("Duplicate source record ID");
    actual.add(record.id);
  }
  if (parsed.kind === "products" && expected.some(id => !/^[A-Z0-9]{10}$/.test(id))) {
    throw new TypeError("Product pool identities must be ASINs");
  }
  const normalized = {
    ...parsed,
    collectedAt: new Date(parsed.collectedAt).toISOString(),
    expectedRecordIds: expected,
    records: [...parsed.records].sort((a, b) => compareIds(a.id, b.id)),
  };
  const serialized = JSON.stringify(canonicalize(normalized));
  if (Buffer.byteLength(serialized, "utf8") > 8_000_000) throw new TypeError("Input snapshot exceeds the supported byte budget");
  // Round-trip ensures even mutable caller payloads are detached before deep freezing.
  const detached = MarketInputSnapshotInputSchema.parse(JSON.parse(serialized));
  const contentHash = createHash("sha256").update(serialized).digest("hex");
  return freezeDeep({
    schemaVersion: "market-input/v1" as const,
    ...detached,
    snapshotId: `market-input:${contentHash}`,
    contentHash,
    coverage: {
      status: actual.size === 0 ? "empty" as const : actual.size === expected.length ? "complete" as const : "partial" as const,
      expectedCount: expected.length,
      availableCount: actual.size,
      missingRecordIds: expected.filter(id => !actual.has(id)),
    },
  });
}
