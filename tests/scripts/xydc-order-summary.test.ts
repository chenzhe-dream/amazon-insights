import assert from "node:assert/strict";
import test from "node:test";

import {
  XydcOrderSnapshotSchema,
  type XydcOrderSnapshot,
} from "../../shared/xydc-order-contract";
import {
  getXydcOrderWindow,
  matchesXydcOrderSnapshot,
  summarizeXydcOrders,
} from "../../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const window = getXydcOrderWindow(new Date("2026-09-08T00:00:00.000Z"));
const parentAsin = "B0PARENT01";

function child(asin: string, values: readonly number[], reasonCode: XydcOrderSnapshot["children"][number]["reasonCode"] = null) {
  return {
    asin,
    trends: values.map((orders, index) => ({ date: window.months[index], orders })),
    fetchedAt: "2026-09-08T00:00:00.000Z",
    reasonCode,
  };
}

function snapshotFixture(
  childAsins: string[],
  children = childAsins.map(asin => child(asin, Array(12).fill(1))),
): XydcOrderSnapshot {
  return {
    version: 1,
    source: "xydc",
    aggregation: "children",
    country: "US",
    parentAsin,
    childAsins,
    window,
    children,
    sourceUpdatedAt: "2026-09-07T23:00:00.000Z",
    fetchedAt: "2026-09-08T00:00:00.000Z",
    cacheState: "fresh",
    reasonCode: null,
  };
}

function familyFixture(childAsins: string[], overrides: Partial<XydcVariantFamily> = {}): XydcVariantFamily {
  return {
    inputAsin: parentAsin,
    country: "US",
    parentAsin,
    dimensions: [],
    children: childAsins.map(asin => ({
      asin,
      attributes: [],
      title: null,
      imageUrl: null,
      price: null,
      currency: null,
      stars: null,
      productPageRatings: null,
      listingDate: null,
      infoStatus: "ready",
    })),
    sourceUpdatedAt: null,
    fetchedAt: "2026-09-08T00:00:00.000Z",
    status: "ready",
    reasonCode: null,
    cacheState: "fresh",
    ...overrides,
  };
}

test("pins twelve completed UTC months, never the current month", () => {
  assert.deepEqual(window, {
    startMonth: "2025-09",
    endMonth: "2026-08",
    months: [
      "2025-09", "2025-10", "2025-11", "2025-12",
      "2026-01", "2026-02", "2026-03", "2026-04",
      "2026-05", "2026-06", "2026-07", "2026-08",
    ],
  });
});

test("handles December/January and UTC-offset boundaries", () => {
  assert.deepEqual(getXydcOrderWindow(new Date("2026-01-15T12:00:00.000Z")).months, [
    "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
    "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
  ]);
  assert.deepEqual(getXydcOrderWindow(new Date("2026-09-01T00:30:00+14:00")), {
    startMonth: "2025-08",
    endMonth: "2026-07",
    months: [
      "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01",
      "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
    ],
  });
  assert.throws(() => getXydcOrderWindow(new Date(Number.NaN)), /valid date/i);
});

test("strictly validates order snapshots and their cross-field identities", () => {
  const valid = snapshotFixture(["B07R56PTMS", "B0834KGXN1"]);
  assert.deepEqual(XydcOrderSnapshotSchema.parse(valid), valid);

  const invalidSnapshots: unknown[] = [];
  invalidSnapshots.push({ ...valid, cachePath: "../../escape.json" });
  invalidSnapshots.push({ ...valid, country: "US/../CA" });
  invalidSnapshots.push({ ...valid, parentAsin: "bad" });
  invalidSnapshots.push({ ...valid, childAsins: ["B07R56PTMS", "B07R56PTMS"] });
  invalidSnapshots.push({ ...valid, childAsins: [] });
  invalidSnapshots.push({ ...valid, children: [valid.children[0], valid.children[0]] });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], asin: "B0831DV4D9" }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [...valid.children[0].trends, valid.children[0].trends[0]] }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [{ date: "2025-08", orders: 1 }] }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [{ date: "2025-13", orders: 1 }] }, valid.children[1]],
  });
  invalidSnapshots.push({ ...valid, fetchedAt: "not-a-date" });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], fetchedAt: " 2026-09-08T00:00:00.000Z" }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [{ date: window.months[0], orders: Number.POSITIVE_INFINITY }] }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [{ date: window.months[0], orders: -1 }] }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [{ date: window.months[0], orders: 1.5 }] }, valid.children[1]],
  });
  invalidSnapshots.push({
    ...valid,
    children: [{ ...valid.children[0], trends: [{ date: window.months[0], orders: Number.MAX_SAFE_INTEGER + 1 }] }, valid.children[1]],
  });
  invalidSnapshots.push({ ...valid, window: { ...valid.window, months: valid.window.months.slice(1) } });
  invalidSnapshots.push({
    ...valid,
    window: { ...valid.window, months: [...valid.window.months.slice(0, 11), "2026-09"], endMonth: "2026-09" },
  });

  for (const candidate of invalidSnapshots) {
    assert.equal(XydcOrderSnapshotSchema.safeParse(candidate).success, false);
  }
});

test("rejects snapshots whose derived sums cannot remain safe integers", () => {
  const unsafe = snapshotFixture([
    "B07R56PTMS",
    "B0834KGXN1",
  ], [
    child("B07R56PTMS", [Number.MAX_SAFE_INTEGER, ...Array(11).fill(0)]),
    child("B0834KGXN1", [1, ...Array(11).fill(0)]),
  ]);
  assert.equal(XydcOrderSnapshotSchema.safeParse(unsafe).success, false);
});

test("matches country, parent, child set and window without depending on child order", () => {
  const childAsins = ["B07R56PTMS", "B0834KGXN1"];
  const snapshot = snapshotFixture(childAsins);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture([...childAsins].reverse()), window), true);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture(childAsins, { parentAsin: "B0831DV4D9" }), window), false);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture(childAsins, { country: "CA" }), window), false);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture([childAsins[0]]), window), false);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture([]), window), false);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture([childAsins[0], childAsins[0]]), window), false);
  assert.equal(matchesXydcOrderSnapshot(snapshot, familyFixture(childAsins), getXydcOrderWindow(new Date("2026-10-01T00:00:00Z"))), false);
});

test("aggregates the labelled historical fixture without averaging monthly shares", () => {
  const historicalValues = {
    B07R56PTMS: [400, 400, 400, 500, 400, 300, 300, 200, 100, 400, 300, 300],
    B0834KGXN1: [100, 100, 100, 100, 100, 100, 100, 100, 50, 100, 100, 100],
    B0831DV4D9: [50, 50, 100, 50, 100, 50, 50, 0, 0, 0, 100, 100],
    B0831FMFVW: [50, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  } as const;
  const childAsins = Object.keys(historicalValues);
  const children = Object.entries(historicalValues).map(([asin, values]) => {
    const row = child(asin, values);
    row.trends.reverse();
    return row;
  });
  const summary = summarizeXydcOrders(XydcOrderSnapshotSchema.parse(snapshotFixture(childAsins, children)));

  assert.equal(summary.complete, true);
  assert.equal(summary.total, 5900);
  assert.equal(summary.expectedChildren, 4);
  assert.equal(summary.returnedChildren, 4);
  assert.equal(summary.undisclosedChildMonths, 13);
  assert.deepEqual(summary.rows.map(row => [row.asin, row.total]), [
    ["B07R56PTMS", 4000],
    ["B0834KGXN1", 1150],
    ["B0831DV4D9", 650],
    ["B0831FMFVW", 100],
  ]);
  assert.equal(summary.rows[0].share, 4000 / 5900 * 100);
  assert.deepEqual(summary.months.map(month => month.date), window.months);
  assert.equal(summary.months[0].total, 600);
  assert.deepEqual(summary.months[0].values, [
    { asin: "B07R56PTMS", orders: 400 },
    { asin: "B0834KGXN1", orders: 100 },
    { asin: "B0831DV4D9", orders: 50 },
    { asin: "B0831FMFVW", orders: 50 },
  ]);
});

test("uses every child in the denominator even when only three rows are previewed", () => {
  const snapshot = snapshotFixture(
    ["B07R56PTMS", "B0834KGXN1", "B0831DV4D9", "B0831FMFVW"],
    [
      child("B07R56PTMS", [60, ...Array(11).fill(0)]),
      child("B0834KGXN1", [30, ...Array(11).fill(0)]),
      child("B0831DV4D9", [10, ...Array(11).fill(0)]),
      child("B0831FMFVW", [100, ...Array(11).fill(0)]),
    ],
  );
  const summary = summarizeXydcOrders(snapshot);
  assert.equal(summary.total, 200);
  assert.deepEqual(summary.rows.map(row => [row.asin, row.total, row.share]), [
    ["B0831FMFVW", 100, 50],
    ["B07R56PTMS", 60, 30],
    ["B0834KGXN1", 30, 15],
    ["B0831DV4D9", 10, 5],
  ]);
});

test("marks failed, absent and missing-month children incomplete without inventing zero", () => {
  const failed = child("B0834KGXN1", [2, 2], "TIMEOUT");
  const incomplete = summarizeXydcOrders(snapshotFixture(
    ["B07R56PTMS", "B0834KGXN1"],
    [child("B07R56PTMS", Array(12).fill(3)), failed],
  ));
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.total, null);
  assert.deepEqual(incomplete.rows.map(row => [row.asin, row.complete, row.total, row.share]), [
    ["B07R56PTMS", true, 36, null],
    ["B0834KGXN1", false, null, null],
  ]);
  assert.deepEqual(incomplete.rows[1].missingMonths, window.months.slice(2));
  assert.equal(incomplete.months[0].total, 5);
  assert.equal(incomplete.months[2].total, null);
  assert.deepEqual(incomplete.months[2].values, [
    { asin: "B07R56PTMS", orders: 3 },
    { asin: "B0834KGXN1", orders: null },
  ]);

  const absent = summarizeXydcOrders(snapshotFixture(
    ["B07R56PTMS", "B0834KGXN1"],
    [child("B07R56PTMS", Array(12).fill(3))],
  ));
  assert.equal(absent.complete, false);
  assert.equal(absent.total, null);
  assert.equal(absent.returnedChildren, 1);
  assert.equal(absent.expectedChildren, 2);
  assert.deepEqual(absent.rows.map(row => [row.asin, row.complete, row.total, row.share]), [
    ["B07R56PTMS", true, 36, null],
    ["B0834KGXN1", false, null, null],
  ]);
  assert.deepEqual(absent.rows[1].missingMonths, window.months);
  assert.deepEqual(absent.months[0].values, [
    { asin: "B07R56PTMS", orders: 3 },
    { asin: "B0834KGXN1", orders: null },
  ]);

  const missingMonthChild = child("B07R56PTMS", Array(12).fill(1));
  missingMonthChild.trends.splice(5, 1);
  const missingMonth = summarizeXydcOrders(snapshotFixture(["B07R56PTMS"], [missingMonthChild]));
  assert.equal(missingMonth.rows[0].complete, false);
  assert.equal(missingMonth.rows[0].total, null);
  assert.deepEqual(missingMonth.rows[0].missingMonths, [window.months[5]]);
});

test("treats raw zero as undisclosed and keeps zero-only shares unknown", () => {
  const summary = summarizeXydcOrders(snapshotFixture(
    ["B07R56PTMS", "B0834KGXN1"],
    [child("B07R56PTMS", Array(12).fill(0)), child("B0834KGXN1", Array(12).fill(0))],
  ));
  assert.equal(summary.complete, true);
  assert.equal(summary.total, 0);
  assert.equal(summary.undisclosedChildMonths, 24);
  assert.deepEqual(summary.rows.map(row => row.share), [null, null]);
  assert.deepEqual(summary.months.map(month => month.total), Array(12).fill(0));
});

test("does not turn an empty family into a complete zero-total family", () => {
  const summary = summarizeXydcOrders(snapshotFixture([], []));
  assert.equal(summary.complete, false);
  assert.equal(summary.total, null);
  assert.equal(summary.expectedChildren, 0);
  assert.equal(summary.returnedChildren, 0);
  assert.deepEqual(summary.rows, []);
});

test("sorts equal positive totals by ASIN and unknown rows last", () => {
  const incompleteChild = child("B0831DV4D9", Array(11).fill(1));
  const summary = summarizeXydcOrders(snapshotFixture(
    ["B0834KGXN1", "B07R56PTMS", "B0831DV4D9"],
    [child("B0834KGXN1", Array(12).fill(1)), child("B07R56PTMS", Array(12).fill(1)), incompleteChild],
  ));
  assert.deepEqual(summary.rows.map(row => row.asin), ["B07R56PTMS", "B0834KGXN1", "B0831DV4D9"]);
  assert.deepEqual(summary.rows.map(row => row.share), [null, null, null]);
});
