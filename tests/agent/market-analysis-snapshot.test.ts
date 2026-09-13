import assert from "node:assert/strict";
import test from "node:test";

const now = new Date("2026-09-12T00:00:00.000Z");
const scope = {
  organizationId: "org-a", researchId: "20000000-0000-4000-8000-000000000001",
  marketplace: "US", nodeIdPath: "1055398:1063294",
  fromMonth: "2026-07", toMonth: "2026-08", currency: "USD",
};
const record = (id = "B000000001", data: unknown = { price: 10, units: null }) => ({ id, scope: { ...scope }, data });
const input = () => ({
  scope: { ...scope }, kind: "products", sourceVersion: "seller-snapshot/1",
  ruleVersion: "market-rules/1.0.0", collectedAt: "2026-09-11T00:00:00.000Z",
  records: [record()], expectedRecordIds: ["B000000001", "B000000002"],
});
async function api() {
  try { return await import("../../server/domain/market-research/snapshot"); }
  catch (error) { assert.fail(`Snapshot implementation is required: ${(error as NodeJS.ErrnoException).code}`); }
}

test("snapshots preserve unknown values and identify missing members without claiming completion", async () => {
  const { createMarketInputSnapshot } = await api();
  const snapshot = createMarketInputSnapshot(input(), now);
  assert.equal(snapshot.coverage.status, "partial");
  assert.equal(snapshot.coverage.expectedCount, 2);
  assert.equal(snapshot.coverage.availableCount, 1);
  assert.deepEqual(snapshot.coverage.missingRecordIds, ["B000000002"]);
  assert.equal((snapshot.records[0].data as { units: null }).units, null);
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/);
});

test("canonical input identity does not depend on object keys or member ordering", async () => {
  const { createMarketInputSnapshot } = await api();
  const first = { ...input(), records: [record(), record("B000000002", { units: 5, price: 20 })] };
  const second = { ...first, expectedRecordIds: [...first.expectedRecordIds].reverse(), records: [
    record("B000000002", { price: 20, units: 5 }), record("B000000001", { units: null, price: 10 }),
  ] };
  assert.equal(createMarketInputSnapshot(first, now).contentHash, createMarketInputSnapshot(second, now).contentHash);
  assert.equal(createMarketInputSnapshot(first, now).snapshotId, createMarketInputSnapshot(second, now).snapshotId);
});

test("identity changes with organization, period, source, rules or record contents", async () => {
  const { createMarketInputSnapshot } = await api();
  const first = createMarketInputSnapshot(input(), now);
  const movedScope = { ...scope, organizationId: "org-b" };
  const movedPeriod = { ...scope, fromMonth: "2026-06" };
  const changed = [
    { ...input(), scope: movedScope, records: [{ ...record(), scope: movedScope }] },
    { ...input(), scope: movedPeriod, records: [{ ...record(), scope: movedPeriod }] },
    { ...input(), sourceVersion: "seller-snapshot/2" },
    { ...input(), ruleVersion: "market-rules/1.1.0" },
    { ...input(), records: [record("B000000001", { price: 11, units: null })] },
    { ...input(), expectedRecordIds: ["B000000001"] },
  ];
  for (const value of changed) assert.notEqual(createMarketInputSnapshot(value, now).contentHash, first.contentHash);
});

test("immutable snapshots cannot be altered by caller mutation or nested writes", async () => {
  const { createMarketInputSnapshot } = await api();
  const original = input();
  const snapshot = createMarketInputSnapshot(original, now);
  original.scope.organizationId = "mutated";
  original.records[0].data = { price: 999 };
  assert.equal(snapshot.scope.organizationId, "org-a");
  assert.equal((snapshot.records[0].data as { price: number }).price, 10);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.records[0].data));
  assert.throws(() => { (snapshot.records[0].data as { price: number }).price = 999; }, TypeError);
});

test("wrong record scope, undeclared members and duplicate IDs are rejected", async () => {
  const { createMarketInputSnapshot } = await api();
  for (const value of [
    { ...input(), records: [{ ...record(), scope: { ...scope, organizationId: "org-b" } }] },
    { ...input(), records: [record("B000000003")] },
    { ...input(), records: [record(), record()] },
    { ...input(), expectedRecordIds: ["B000000001", "B000000001"] },
  ]) assert.throws(() => createMarketInputSnapshot(value, now));
});

test("future, current, invalid and reversed research months are rejected", async () => {
  const { createMarketInputSnapshot } = await api();
  for (const patch of [
    { toMonth: "2026-09" }, { toMonth: "2027-01" }, { fromMonth: "2026-13" },
    { fromMonth: "2026-08", toMonth: "2026-07" },
  ]) {
    const nextScope = { ...scope, ...patch };
    assert.throws(() => createMarketInputSnapshot({ ...input(), scope: nextScope, records: [{ ...record(), scope: nextScope }] }, now));
  }
});

test("future timestamps, unsupported market and unknown envelope fields are rejected", async () => {
  const { createMarketInputSnapshot } = await api();
  for (const value of [
    { ...input(), collectedAt: "2026-09-13T00:00:00.000Z" },
    { ...input(), collectedAt: "not-a-date" },
    { ...input(), scope: { ...scope, marketplace: "UK" } },
    { ...input(), overwriteOtherOrganization: true },
  ]) assert.throws(() => createMarketInputSnapshot(value, now));
  assert.throws(() => createMarketInputSnapshot(input(), new Date("invalid")));
});

test("only finite plain JSON data is admitted to persisted snapshots", async () => {
  const { createMarketInputSnapshot } = await api();
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const values: unknown[] = [NaN, Infinity, undefined, BigInt(1), new Date(), { bad: undefined }, { f() {} }, circular, new Array(2)];
  for (const value of values) {
    assert.throws(() => createMarketInputSnapshot({ ...input(), records: [{ ...record(), data: value }] }, now));
  }
});

test("hidden array method getters are rejected without executing source code", async () => {
  const { createMarketInputSnapshot } = await api();
  let getterCalls = 0;
  const data = [1];
  Object.defineProperty(data, "map", {
    get() { getterCalls++; return () => [999]; },
  });
  let failure: unknown;
  try { createMarketInputSnapshot({ ...input(), records: [record("B000000001", data)] }, now); }
  catch (error) { failure = error; }
  assert.equal(getterCalls, 0, "source array getters must never execute");
  assert.ok(failure instanceof Error, "hidden array properties must be rejected");
  assert.match(failure.message, /bounded plain JSON/);
  assert.equal(JSON.stringify(data), "[1]");
});

test("arrays reject hidden extra own keys including noncanonical numeric properties", async () => {
  const { createMarketInputSnapshot } = await api();
  for (const key of ["map", "constructor", "toJSON", "00", "-1", "1.0", "4294967295", Symbol("metadata")]) {
    const data = [1];
    Object.defineProperty(data, key, { value: "hidden" });
    assert.throws(
      () => createMarketInputSnapshot({ ...input(), records: [record("B000000001", data)] }, now),
      /bounded plain JSON/,
      `unexpected own key ${String(key)} must be rejected`,
    );
  }
});

test("array index accessors are rejected without execution and hidden indices are not plain JSON", async () => {
  const { createMarketInputSnapshot } = await api();
  let getterCalls = 0;
  const accessor = [1];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { getterCalls++; return 2; } });
  const hiddenIndex = [1];
  Object.defineProperty(hiddenIndex, "0", { enumerable: false, value: 1 });
  for (const data of [accessor, hiddenIndex]) {
    assert.throws(() => createMarketInputSnapshot({ ...input(), records: [record("B000000001", data)] }, now), /bounded plain JSON/);
  }
  assert.equal(getterCalls, 0);
});

test("normal nested and frozen arrays preserve value and order with detached frozen snapshots", async () => {
  const { createMarketInputSnapshot } = await api();
  const data = Object.freeze([1, null, Object.freeze(["second", "first"]), { z: 2, a: 1 }, []]);
  const snapshot = createMarketInputSnapshot({ ...input(), records: [record("B000000001", data)] }, now);
  assert.deepEqual(snapshot.records[0].data, data);
  assert.notEqual(snapshot.records[0].data, data);
  assert.ok(Object.isFrozen(snapshot.records[0].data));
  assert.equal(JSON.stringify(data), '[1,null,["second","first"],{"z":2,"a":1},[]]');
});

test("an empty input is explicitly empty and a full declared pool is complete", async () => {
  const { createMarketInputSnapshot } = await api();
  assert.equal(createMarketInputSnapshot({ ...input(), records: [] }, now).coverage.status, "empty");
  assert.equal(createMarketInputSnapshot({ ...input(), expectedRecordIds: ["B000000001"] }, now).coverage.status, "complete");
});

test("product identities are ASINs, while keyword snapshots have source record IDs", async () => {
  const { createMarketInputSnapshot } = await api();
  const value = { ...input(), records: [record("keyword-1")], expectedRecordIds: ["keyword-1"] };
  assert.throws(() => createMarketInputSnapshot(value, now));
  assert.equal(createMarketInputSnapshot({ ...value, kind: "keywords" }, now).coverage.status, "complete");
});
