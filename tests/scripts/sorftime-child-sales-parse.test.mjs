import assert from "node:assert/strict";
import test from "node:test";

import { parseVariationRows } from "../../scripts/build-sorftime-child-sales.mjs";

test("recognized empty variation container is the only verified-empty parser shape", () => {
  assert.deepEqual(parseVariationRows({ data: [] }), {
    containerRecognized: true,
    rawRowCount: 0,
    validSalesRowCount: 0,
    rows: [],
  });
  assert.deepEqual(parseVariationRows(null), {
    containerRecognized: false,
    rawRowCount: 0,
    validSalesRowCount: 0,
    rows: [],
  });
});

test("nonempty variation rows with invalid sales stay observable as a schema gap", () => {
  const parsed = parseVariationRows({ data: [
    { Asin: "B000000001", SalesAmount: "not-a-number" },
  ] });

  assert.equal(parsed.containerRecognized, true);
  assert.equal(parsed.rawRowCount, 1);
  assert.equal(parsed.validSalesRowCount, 0);
  assert.deepEqual(parsed.rows, []);
});

test("valid variation rows retain only normalized business fields", () => {
  const parsed = parseVariationRows({ data: [
    { Asin: "B000000001", Property: "Color: Black", SalesAmount: 12 },
  ] });

  assert.equal(parsed.containerRecognized, true);
  assert.equal(parsed.rawRowCount, 1);
  assert.equal(parsed.validSalesRowCount, 1);
  assert.deepEqual(parsed.rows, [{
    asin: "B000000001",
    variant: "Black",
    sales: 12,
    itemIndex: null,
  }]);
});
