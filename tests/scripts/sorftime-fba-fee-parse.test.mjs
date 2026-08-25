import assert from "node:assert/strict";
import test from "node:test";

import { buildSorftimeFbaRecord } from "../../scripts/lib/sorftime-fba-fee-parse.mjs";

test("Sorftime FBA record becomes ready from the product-detail fee when no Keepa result is available", () => {
  const record = buildSorftimeFbaRecord({
    asin: "B0TEST0001",
    marketplace: "US",
    fetchedAt: "2026-08-25",
    response: {
      data: {
        fba_fee: "4.25",
        package_size_cm: "10 x 10 x 10",
      },
    },
  });

  assert.deepEqual(record, {
    asin: "B0TEST0001",
    marketplace: "US",
    fetchedAt: "2026-08-25",
    status: "ready",
    source: "sorftime",
    fbaFee: 4.25,
    packageSize: "10 x 10 x 10",
  });
});

test("Sorftime FBA record is verified empty when the product-detail fee is absent", () => {
  const record = buildSorftimeFbaRecord({
    asin: "B0TEST0002",
    marketplace: "US",
    fetchedAt: "2026-08-25",
    response: { data: { package_size_cm: "10 x 10 x 10" } },
  });

  assert.equal(record.status, "empty");
  assert.equal(record.source, "sorftime");
  assert.equal(record.fbaFee, null);
});
