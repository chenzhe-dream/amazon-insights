import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const now = new Date("2026-09-12T00:00:00.000Z");
const scope = { organizationId: "org-a", researchId: "20000000-0000-4000-8000-000000000001", marketplace: "US", nodeIdPath: "123:456", fromMonth: "2026-07", toMonth: "2026-08", currency: "USD" };
const identity = { marketplace: "US", nodeIdPath: "123:456", nodeId: "456", month: "2026-08", asin: "B000000001", keyword: "floor lamp", page: 1, currency: "USD" };
function input() {
  return {
    scope: { ...scope }, provider: "sellerSprite", operation: "market_product_concentration",
    requestIdentity: { ...identity },
    responseIdentityPaths: Object.fromEntries(Object.keys(identity).map(key => [key, [["data", key]]])),
    payload: { data: { ...identity, units: 0, unknown: null } },
    fetchedAt: "2026-09-11T00:00:00.000Z",
    observationPeriod: { kind: "calendar-months", fromMonth: "2026-08", toMonth: "2026-08" },
    units: { sales: { status: "known", unit: "count", rawUnit: "units" }, cpc: { status: "unknown", rawUnit: null, reason: "Currency not supplied" } },
    coverage: { receivedCount: 1, expectedCount: 2, truncation: { status: "unknown", reason: "No completion marker" } },
  };
}
async function api() {
  try { return await import("../../server/domain/market-research/source-evidence"); }
  catch (error) { assert.fail(`Source evidence implementation is required: ${(error as NodeJS.ErrnoException).code}`); }
}

test("each response identity is verified from its actual payload location", async () => {
  const { createMarketSourceEvidence } = await api();
  const result = createMarketSourceEvidence(input(), now);
  assert.equal(result.schemaVersion, "market-source-evidence/v1");
  for (const [field, value] of Object.entries(identity)) {
    const check = result.responseIdentity[field as keyof typeof result.responseIdentity];
    assert.equal(check.status, "verified"); assert.equal(check.expected, value); assert.equal(check.reason, null);
    assert.deepEqual(check.echoes, [{ path: ["data", field], value }]);
  }
  assert.equal(Object.hasOwn(result, "verified"), false);
});

test("all supplied response identity conflicts are rejected", async () => {
  const { createMarketSourceEvidence } = await api();
  const conflicts = { marketplace: "GB", nodeIdPath: "123:999", nodeId: "999", month: "2026-07", asin: "B000000009", keyword: "desk lamp", page: 2, currency: "EUR" };
  for (const [field, value] of Object.entries(conflicts)) {
    const candidate = input();
    Object.assign(candidate.payload.data, { [field]: value });
    assert.throws(() => createMarketSourceEvidence(candidate, now), new RegExp(field, "i"));
  }
});

test("absent paths and absent echoes stay explicitly unverified", async () => {
  const { createMarketSourceEvidence } = await api();
  const unmapped = createMarketSourceEvidence({ ...input(), responseIdentityPaths: {} }, now);
  assert.equal(unmapped.responseIdentity.month.status, "unverified");
  assert.equal(unmapped.responseIdentity.month.reason, "not-echoed");
  const missing = createMarketSourceEvidence({ ...input(), payload: { data: {} } }, now);
  assert.equal(missing.responseIdentity.month.reason, "missing-echo-path");
  assert.deepEqual(missing.responseIdentity.month.echoes, []);
});

test("multiple echo locations must all match and missing mapped locations cannot verify", async () => {
  const { createMarketSourceEvidence } = await api();
  const paths = { ...input().responseIdentityPaths, nodeId: [["data", "nodeId"], ["items", 0, "node_id"]] };
  assert.throws(() => createMarketSourceEvidence({ ...input(), responseIdentityPaths: paths, payload: { ...input().payload, items: [{ node_id: "999" }] } }, now), /nodeId/i);
  const result = createMarketSourceEvidence({ ...input(), responseIdentityPaths: paths }, now);
  assert.equal(result.responseIdentity.nodeId.status, "unverified");
  assert.equal(result.responseIdentity.nodeId.reason, "missing-echo-path");
});

test("response without an explicit request identity is not verified and still checks research conflicts", async () => {
  const { createMarketSourceEvidence } = await api();
  const result = createMarketSourceEvidence({ ...input(), requestIdentity: {} }, now);
  assert.equal(result.responseIdentity.asin.status, "unverified");
  assert.equal(result.responseIdentity.asin.reason, "no-request-identity");
  assert.equal(result.responseIdentity.marketplace.status, "unverified");
  assert.throws(() => createMarketSourceEvidence({ ...input(), requestIdentity: {}, payload: { data: { ...identity, currency: "EUR" } } }, now), /currency/i);
});

test("request identity cannot cross research scope or request a month outside its bounds", async () => {
  const { createMarketSourceEvidence } = await api();
  for (const patch of [{ marketplace: "GB" }, { currency: "EUR" }, { nodeId: "999" }, { nodeIdPath: "123:999" }, { month: "2026-06" }]) {
    assert.throws(() => createMarketSourceEvidence({ ...input(), requestIdentity: { ...identity, ...patch } }, now));
  }
});

test("canonical month and identity normalization preserve a real equivalent echo", async () => {
  const { createMarketSourceEvidence } = await api();
  const result = createMarketSourceEvidence({ ...input(), payload: { data: { ...identity, month: "202608", asin: " b000000001 ", keyword: " floor   lamp ", marketplace: "us" } } }, now);
  assert.equal(result.responseIdentity.month.echoes[0].value, "2026-08");
  assert.equal(result.responseIdentity.keyword.status, "verified");
});

test("payload hash is recomputable and canonical but cannot be supplied by a caller", async () => {
  const { createMarketSourceEvidence } = await api();
  const simple = { ...input(), requestIdentity: {}, responseIdentityPaths: {}, payload: { z: [null, 0], a: "source" } };
  const first = createMarketSourceEvidence(simple, now);
  assert.equal(first.payloadHash, createHash("sha256").update('{"a":"source","z":[null,0]}').digest("hex"));
  const reordered = createMarketSourceEvidence({ ...simple, payload: { a: "source", z: [null, 0] } }, now);
  assert.equal(first.payloadHash, reordered.payloadHash);
  assert.notEqual(first.payloadHash, createMarketSourceEvidence({ ...simple, payload: { a: "changed", z: [null, 0] } }, now).payloadHash);
  assert.throws(() => createMarketSourceEvidence({ ...simple, payloadHash: "a".repeat(64) }, now));
  assert.throws(() => createMarketSourceEvidence({ ...simple, responseIdentity: { verified: true } }, now));
});

test("research scope never supplies a missing observation period", async () => {
  const { createMarketSourceEvidence } = await api();
  const period = { kind: "unknown", reason: "Upstream does not expose its observation window" };
  const result = createMarketSourceEvidence({ ...input(), provider: "sorftime", operation: "category_report", requestIdentity: { marketplace: "US", nodeId: "456" }, responseIdentityPaths: {}, observationPeriod: period }, now);
  assert.deepEqual(result.observationPeriod, period);
  assert.equal(Object.hasOwn(result.requestIdentity, "month"), false);
  assert.equal(result.responseIdentity.month.status, "unverified");
});

test("current and trailing periods remain distinct from requested historical months", async () => {
  const { createMarketSourceEvidence } = await api();
  for (const observationPeriod of [{ kind: "current", asOf: "2026-09-10T00:00:00.000Z" }, { kind: "trailing-days", days: 30, asOf: "2026-09-10T00:00:00.000Z" }]) {
    const result = createMarketSourceEvidence({ ...input(), observationPeriod }, now);
    assert.deepEqual(result.observationPeriod, observationPeriod);
    assert.equal(result.scope.toMonth, "2026-08");
  }
  const differentCalendar = { kind: "calendar-months", fromMonth: "2026-06", toMonth: "2026-06" };
  assert.deepEqual(createMarketSourceEvidence({ ...input(), observationPeriod: differentCalendar }, now).observationPeriod, differentCalendar);
});

test("invalid research and observation months or reversed periods are rejected", async () => {
  const { createMarketSourceEvidence } = await api();
  for (const observationPeriod of [
    { kind: "calendar-months", fromMonth: "2026-13", toMonth: "2026-13" },
    { kind: "calendar-months", fromMonth: "2026-08", toMonth: "2026-07" },
    { kind: "calendar-months", fromMonth: "2026-09", toMonth: "2026-09" },
    { kind: "unknown", reason: " " },
  ]) assert.throws(() => createMarketSourceEvidence({ ...input(), observationPeriod }, now));
  assert.throws(() => createMarketSourceEvidence({ ...input(), scope: { ...scope, toMonth: "2026-09" } }, now));
});

test("future fetchedAt and periods after fetchedAt or invalid clocks are rejected", async () => {
  const { createMarketSourceEvidence } = await api();
  assert.throws(() => createMarketSourceEvidence({ ...input(), fetchedAt: "2026-09-13T00:00:00.000Z" }, now));
  assert.throws(() => createMarketSourceEvidence({ ...input(), observationPeriod: { kind: "current", asOf: "2026-09-11T01:00:00.000Z" } }, now));
  assert.throws(() => createMarketSourceEvidence({ ...input(), fetchedAt: "2026-08-31T00:00:00.000Z" }, now));
  assert.throws(() => createMarketSourceEvidence(input(), new Date("invalid")));
});

test("unknown raw units are preserved and known money cannot claim a conflicting currency", async () => {
  const { createMarketSourceEvidence } = await api();
  const result = createMarketSourceEvidence(input(), now);
  assert.deepEqual(result.units.cpc, { status: "unknown", rawUnit: null, reason: "Currency not supplied" });
  const unit = { status: "known", unit: "currency", rawUnit: "$", currency: "USD" };
  assert.deepEqual(createMarketSourceEvidence({ ...input(), units: { price: unit } }, now).units.price, unit);
  for (const invalid of [{ ...unit, currency: "EUR" }, { ...unit, currency: null }, { status: "known", unit: "count", rawUnit: "units", currency: "USD" }, { status: "unknown", rawUnit: null, reason: " " }]) {
    assert.throws(() => createMarketSourceEvidence({ ...input(), units: { price: invalid } }, now));
  }
});

test("coverage and trailing days require bounded integer counts with nonblank uncertainty reasons", async () => {
  const { createMarketSourceEvidence } = await api();
  for (const count of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.throws(() => createMarketSourceEvidence({ ...input(), coverage: { ...input().coverage, receivedCount: count } }, now));
    assert.throws(() => createMarketSourceEvidence({ ...input(), observationPeriod: { kind: "trailing-days", days: count, asOf: "2026-09-10T00:00:00.000Z" } }, now));
  }
  assert.throws(() => createMarketSourceEvidence({ ...input(), coverage: { ...input().coverage, expectedCount: 0 } }, now));
  assert.throws(() => createMarketSourceEvidence({ ...input(), coverage: { ...input().coverage, truncation: { status: "truncated", reason: " " } } }, now));
  const zero = { receivedCount: 0, expectedCount: null, truncation: { status: "not-truncated" } };
  assert.deepEqual(createMarketSourceEvidence({ ...input(), coverage: zero }, now).coverage, zero);
});

test("malformed identity values and unsafe property paths are rejected", async () => {
  const { createMarketSourceEvidence } = await api();
  for (const patch of [{ page: Infinity }, { page: "1" }, { page: 0 }, { month: "202613" }, { asin: "B123" }, { nodeId: "not-node" }]) {
    assert.throws(() => createMarketSourceEvidence({ ...input(), payload: { data: { ...identity, ...patch } } }, now));
  }
  assert.throws(() => createMarketSourceEvidence({ ...input(), responseIdentityPaths: { page: [[-1]] } }, now));
  const ownOnly = createMarketSourceEvidence({ ...input(), responseIdentityPaths: { keyword: [["toString"]] } }, now);
  assert.equal(ownOnly.responseIdentity.keyword.status, "unverified");
});

test("T1 JSON boundary rejects hooks and preserves source null and zero without execution", async () => {
  const { createMarketSourceEvidence } = await api();
  let calls = 0;
  const hooked = [1]; Object.defineProperty(hooked, "map", { get() { calls++; return () => [999]; } });
  for (const payload of [hooked, NaN, undefined, new Date(), { count: Infinity }, { count: undefined }, { run() {} }]) {
    assert.throws(() => createMarketSourceEvidence({ ...input(), payload }, now));
  }
  assert.equal(calls, 0);
  const result = createMarketSourceEvidence(input(), now);
  assert.equal((result.payload as { data: { units: number; unknown: null } }).data.units, 0);
  assert.equal((result.payload as { data: { unknown: null } }).data.unknown, null);
});

test("source evidence is detached and deeply frozen across metadata and payload", async () => {
  const { createMarketSourceEvidence } = await api();
  const original = input(); const result = createMarketSourceEvidence(original, now);
  original.payload.data.units = 999; original.scope.organizationId = "changed";
  assert.equal(result.scope.organizationId, "org-a");
  assert.equal((result.payload as { data: { units: number } }).data.units, 0);
  function frozen(value: unknown): boolean { return value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(frozen)); }
  assert.ok(frozen(result));
});
