import assert from "node:assert/strict";
import test from "node:test";
import type {
  ShapePriceAnalysisInput,
  ShapePriceProduct,
} from "../../server/domain/market-research/shape-price";

const months = ["2026-08"];
const bands = [
  { id: "low", minInclusive: 0, maxExclusive: 10 },
  { id: "high", minInclusive: 10, maxExclusive: null },
];
const asin = (index: number) => `B${String(index).padStart(9, "0")}`;
const product = (index: number, patch: Partial<ShapePriceProduct> = {}): ShapePriceProduct => ({
  asin: asin(index), shape: "desk", price: 5, brand: "Example",
  monthlySales: [{ month: "2026-08", units: 10 }], ...patch,
});
const input = (products: ShapePriceProduct[] = [product(1)]): ShapePriceAnalysisInput => ({
  months: [...months], bands: bands.map((band) => ({ ...band })), products,
});
async function api() {
  try { return await import("../../server/domain/market-research/shape-price"); }
  catch (error) { assert.fail(`Shape/price implementation is required: ${(error as NodeJS.ErrnoException).code}`); }
}

test("100 links with one selling 100 and 99 selling 10 have monthly units per link of 10.9", async () => {
  const { analyzeShapePriceBands } = await api();
  const products = Array.from({ length: 100 }, (_, index) => product(index, {
    monthlySales: [{ month: "2026-08", units: index === 0 ? 100 : 10 }],
  }));
  const result = analyzeShapePriceBands(input(products));
  assert.deepEqual(result.totals, {
    totalUnits: 1090, eligibleLinkCount: 100, linkMonthCount: 100, monthlyUnitsPerLink: 10.9,
  });
  assert.deepEqual(result.shapes[0].totals, result.totals);
  assert.deepEqual(result.shapes[0].bands[0].metrics, result.totals);
  assert.deepEqual(result.coverage.eligibleProductRatio, {
    unit: "ratio", numerator: 100, denominator: 100, value: 1,
  });
});

test("shape totals recompute from original members across unequal price bands", async () => {
  const { analyzeShapePriceBands } = await api();
  const products = Array.from({ length: 100 }, (_, index) => product(index, {
    price: index === 0 ? 5 : 15,
    monthlySales: [{ month: "2026-08", units: index === 0 ? 100 : 10 }],
  }));
  const result = analyzeShapePriceBands(input(products));
  const shape = result.shapes[0];
  assert.equal(shape.bands[0].metrics.monthlyUnitsPerLink, 100);
  assert.equal(shape.bands[1].metrics.monthlyUnitsPerLink, 10);
  assert.equal(shape.totals.monthlyUnitsPerLink, 10.9);
  assert.deepEqual(shape.bands[0].salesShareWithinShape, {
    unit: "ratio", numerator: 100, denominator: 1090, value: 100 / 1090,
  });
  assert.deepEqual(shape.bands[0].linkShareWithinShape, {
    unit: "ratio", numerator: 1, denominator: 100, value: 0.01,
  });
});

test("complete consecutive months across a year divide total units by both months and links", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands({ ...input([
    product(1, { monthlySales: [{ month: "2025-12", units: 100 }, { month: "2026-01", units: 200 }] }),
    product(2, { monthlySales: [{ month: "2026-01", units: 60 }, { month: "2025-12", units: 40 }] }),
  ]), months: ["2025-12", "2026-01"] });
  assert.deepEqual(result.months, ["2025-12", "2026-01"]);
  assert.deepEqual(result.totals, {
    totalUnits: 400, eligibleLinkCount: 2, linkMonthCount: 4, monthlyUnitsPerLink: 100,
  });
});

test("price bands are left-closed and right-open including a zero price", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input([0, 9.99, 10, 20].map((price, index) => product(index, { price }))));
  const groups = result.shapes[0].bands;
  assert.deepEqual(groups.map((group) => group.eligibleAsins), [[asin(0), asin(1)], [asin(2), asin(3)]]);
  assert.deepEqual(groups.map((group) => group.metrics.totalUnits), [20, 20]);
});

test("zero sales remain observed zero with unknown sales shares but measured link shares", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input([product(1, { monthlySales: [{ month: "2026-08", units: 0 }] })]));
  assert.equal(result.totals.totalUnits, 0);
  assert.equal(result.totals.monthlyUnitsPerLink, 0);
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(result.shapes[0].bands[0].salesShareWithinShape, {
    unit: "ratio", numerator: 0, denominator: 0, value: null,
  });
  assert.equal(result.shapes[0].bands[0].linkShareWithinShape.value, 1);
});

test("partial coverage lists every missing cause and keeps unknown shape and brand eligible", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands({
    months: ["2026-07", "2026-08"], bands: [{ id: "bounded", minInclusive: 0, maxExclusive: 10 }],
    products: [
      product(1, { shape: null, brand: null, monthlySales: [{ month: "2026-07", units: 0 }, { month: "2026-08", units: 8 }] }),
      product(2, { price: null, monthlySales: [{ month: "2026-07", units: null }] }),
      product(3, { price: 10, monthlySales: [{ month: "2026-07", units: 100 }, { month: "2026-08", units: 100 }] }),
    ],
  });
  assert.deepEqual(result.scope, { requestedAsins: [asin(1), asin(2), asin(3)], eligibleAsins: [asin(1)] });
  assert.deepEqual(result.coverage, {
    status: "partial", requestedProductCount: 3, eligibleProductCount: 1, excludedProductCount: 2,
    eligibleProductRatio: { unit: "ratio", numerator: 1, denominator: 3, value: 1 / 3 },
  });
  assert.deepEqual(result.excludedProducts, [
    { asin: asin(2), reasons: [{ code: "unknown_price" }, { code: "unknown_sales", month: "2026-07" }, { code: "missing_month", month: "2026-08" }] },
    { asin: asin(3), reasons: [{ code: "unmapped_price" }] },
  ]);
  assert.deepEqual(result.unknownProducts, [
    { asin: asin(1), reasons: [{ code: "unknown_shape" }, { code: "unknown_brand" }] },
    { asin: asin(2), reasons: [{ code: "unknown_price" }, { code: "unknown_sales", month: "2026-07" }, { code: "missing_month", month: "2026-08" }] },
  ]);
  assert.equal(result.shapes[0].shape, null);
  assert.equal(result.shapes[0].totals.totalUnits, 8);
  assert.equal(result.shapes[0].totals.monthlyUnitsPerLink, 4);
  assert.equal(result.shapes[1].shape, "desk");
  assert.equal(result.shapes[1].totals.totalUnits, null);
});

test("no eligible samples keep totals, efficiency, and shares unknown", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input([product(1, { price: null })]));
  assert.equal(result.coverage.status, "none");
  assert.equal(result.coverage.eligibleProductRatio.value, 0);
  assert.deepEqual(result.totals, {
    totalUnits: null, eligibleLinkCount: 0, linkMonthCount: 0, monthlyUnitsPerLink: null,
  });
  assert.equal(result.shapes[0].bands[0].salesShareWithinShape.value, null);
  assert.equal(result.shapes[0].bands[0].salesShareWithinShape.numerator, null);
  assert.equal(result.shapes[0].bands[0].salesShareWithinShape.denominator, null);
  assert.equal(result.shapes[0].bands[0].linkShareWithinShape.value, null);
});

test("an empty requested pool is not complete coverage", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input([]));
  assert.equal(result.coverage.status, "none");
  assert.equal(result.coverage.eligibleProductRatio.value, null);
  assert.equal(result.totals.totalUnits, null);
  assert.deepEqual(result.shapes, []);
});

test("an empty price band does not manufacture observed units or sales share", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input());
  assert.equal(result.shapes[0].bands[1].metrics.totalUnits, null);
  assert.equal(result.shapes[0].bands[1].salesShareWithinShape.value, null);
  assert.equal(result.shapes[0].bands[1].linkShareWithinShape.value, 0);
});

test("scope excludes sales outside the specified months without borrowing them for missing months", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input([
    product(1, { monthlySales: [{ month: "2026-08", units: 10 }, { month: "2026-07", units: 9000 }] }),
    product(2, { monthlySales: [{ month: "2026-07", units: 9000 }] }),
  ]));
  assert.equal(result.totals.totalUnits, 10);
  assert.deepEqual(result.excludedProducts[0].reasons, [{ code: "missing_month", month: "2026-08" }]);
});

test("ASIN identity normalizes whitespace and case before checking duplicates", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands(input([product(1, { asin: " b000000001 " })]));
  assert.deepEqual(result.scope.eligibleAsins, [asin(1)]);
  assert.throws(() => analyzeShapePriceBands(input([product(1), product(2, { asin: " b000000001 " })])), /duplicate.*ASIN/i);
});

test("duplicate sales months are rejected even outside the requested range", async () => {
  const { analyzeShapePriceBands } = await api();
  for (const month of ["2026-08", "2026-07"]) {
    assert.throws(() => analyzeShapePriceBands(input([product(1, {
      monthlySales: [{ month, units: 10 }, { month, units: 20 }],
    })])), /duplicate.*month/i);
  }
});

test("requested months must be valid nonempty chronological consecutive calendar months", async () => {
  const { analyzeShapePriceBands } = await api();
  for (const invalidMonths of [[], ["2026-8"], ["2026-00"], ["2026-13"], ["0000-01"],
    ["2026-06", "2026-08"], ["2026-08", "2026-07"], ["2026-08", "2026-08"]]) {
    assert.throws(() => analyzeShapePriceBands({ ...input(), months: invalidMonths }), /month/i);
  }
  assert.throws(() => analyzeShapePriceBands(input([product(1, { monthlySales: [{ month: "2026-13", units: 1 }] })])), /month/i);
});

test("overlapping bands including an unbounded band and duplicate normalized IDs are rejected", async () => {
  const { analyzeShapePriceBands } = await api();
  for (const invalidBands of [
    [{ id: "a", minInclusive: 0, maxExclusive: 11 }, { id: "b", minInclusive: 10, maxExclusive: null }],
    [{ id: "a", minInclusive: 0, maxExclusive: null }, { id: "b", minInclusive: 10, maxExclusive: 20 }],
    [{ id: "a", minInclusive: 0, maxExclusive: 10 }, { id: " a ", minInclusive: 10, maxExclusive: 20 }],
  ]) assert.throws(() => analyzeShapePriceBands({ ...input(), bands: invalidBands }), /band/i);
});

test("invalid band bounds, missing bands, and blank band IDs are rejected", async () => {
  const { analyzeShapePriceBands } = await api();
  for (const invalidBand of [
    { id: "a", minInclusive: -1, maxExclusive: 10 },
    { id: "a", minInclusive: NaN, maxExclusive: 10 },
    { id: "a", minInclusive: Infinity, maxExclusive: null },
    { id: "a", minInclusive: 0, maxExclusive: Infinity },
    { id: "a", minInclusive: 0, maxExclusive: NaN },
    { id: "a", minInclusive: 10, maxExclusive: 10 },
    { id: "a", minInclusive: 10, maxExclusive: 5 },
    { id: " ", minInclusive: 0, maxExclusive: 10 },
  ]) assert.throws(() => analyzeShapePriceBands({ ...input(), bands: [invalidBand] }), /band/i);
  assert.throws(() => analyzeShapePriceBands({ ...input(), bands: [] }), /band/i);
});

test("finite nonnegative price and sales are required without coercing strings", async () => {
  const { analyzeShapePriceBands } = await api();
  for (const value of [-1, NaN, Infinity, -Infinity, "10"]) {
    assert.throws(() => analyzeShapePriceBands(input([product(1, { price: value as number })])), /price/i);
    assert.throws(() => analyzeShapePriceBands(input([product(1, {
      monthlySales: [{ month: "2026-08", units: value as number }],
    })])), /units/i);
  }
  assert.throws(() => analyzeShapePriceBands(input([product(1, {
    price: null, monthlySales: [{ month: "2026-07", units: -1 }],
  })])), /units/i);
});

test("malformed ASIN identities and empty or non-string shape and brand labels are rejected", async () => {
  const { analyzeShapePriceBands } = await api();
  for (const invalidAsin of ["", "B123", "B00000000!", "B0000000000"]) {
    assert.throws(() => analyzeShapePriceBands(input([product(1, { asin: invalidAsin })])), /ASIN/i);
  }
  for (const field of ["shape", "brand"] as const) {
    for (const value of [" ", 4, undefined]) {
      assert.throws(() => analyzeShapePriceBands(input([product(1, { [field]: value })])), new RegExp(field, "i"));
    }
  }
});

test("aggregation rejects finite inputs whose product or pool sum overflows", async () => {
  const { analyzeShapePriceBands } = await api();
  const huge = product(1, { monthlySales: [{ month: "2026-08", units: Number.MAX_VALUE }] });
  assert.throws(() => analyzeShapePriceBands(input([huge, { ...huge, asin: asin(2) }])), /finite|overflow/i);
  assert.throws(() => analyzeShapePriceBands({ ...input([product(1, {
    monthlySales: [{ month: "2026-07", units: Number.MAX_VALUE }, { month: "2026-08", units: Number.MAX_VALUE }],
  })]), months: ["2026-07", "2026-08"] }), /finite|overflow/i);
});

test("input remains untouched, output is detached, and special shape names group safely", async () => {
  const { analyzeShapePriceBands } = await api();
  const original = input([product(1, { shape: "__proto__" })]);
  const before = structuredClone(original);
  const result = analyzeShapePriceBands(original);
  assert.deepEqual(original, before);
  assert.equal(result.shapes[0].shape, "__proto__");
  result.months[0] = "1999-01";
  result.shapes[0].bands[0].band.minInclusive = 999;
  assert.deepEqual(original, before);
});

test("non-overlapping bands may be supplied out of price order while preserving declared display order", async () => {
  const { analyzeShapePriceBands } = await api();
  const result = analyzeShapePriceBands({ ...input(), bands: [...bands].reverse() });
  assert.deepEqual(result.shapes[0].bands.map((group) => group.band.id), ["high", "low"]);
  assert.equal(result.shapes[0].bands[1].metrics.totalUnits, 10);
});
