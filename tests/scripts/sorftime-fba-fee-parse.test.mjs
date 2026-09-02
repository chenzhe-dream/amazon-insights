import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildSorftimeFbaRecord,
  requiresSorftimeFbaCredential,
  SORFTIME_FBA_PACING_MS,
  shouldUseCachedSorftimeFbaRecord,
} from "../../scripts/lib/sorftime-fba-fee-parse.mjs";

test("Sorftime FBA record becomes ready from the product-detail fee when no Keepa result is available", () => {
  const record = buildSorftimeFbaRecord({
    asin: "B0TEST0001",
    marketplace: "US",
    fetchedAt: "2026-08-25",
    response: {
      data: {
        fba_fee: 4.25,
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

test("Sorftime FBA projection rejects incompatible and tool-error shapes instead of coercing them", () => {
  const inputs = [
    null,
    [],
    { data: null },
    { data: [] },
    { isError: true, data: { fba_fee: 4.25 } },
    { error: { code: "tool-error" }, data: { fba_fee: 4.25 } },
    { data: { fba_fee: "4.25" } },
    { data: { fba_fee: " " } },
    { data: { fba_fee: false } },
    { code: "MCP_TOOL_ERROR", message: "tool failed" },
  ];

  for (const response of inputs) {
    assert.throws(
      () => buildSorftimeFbaRecord({
        asin: "B0TEST0003",
        marketplace: "US",
        fetchedAt: "2026-08-25",
        response,
      }),
      TypeError,
    );
  }
});

test("Sorftime FBA projection keeps ordinary product message fields outside the narrow tool-error shape", () => {
  const record = buildSorftimeFbaRecord({
    asin: "B0TEST0004",
    marketplace: "US",
    fetchedAt: "2026-08-25",
    response: {
      code: "PRODUCT_METADATA",
      message: "ordinary product detail text",
      fba_fee: 4.25,
    },
  });

  assert.equal(record.status, "ready");
  assert.equal(record.fbaFee, 4.25);
});

test("Sorftime FBA projection keeps a no-fee product detail with ordinary code and message fields verified-empty", () => {
  const record = buildSorftimeFbaRecord({
    asin: "B0TEST0005",
    marketplace: "US",
    fetchedAt: "2026-08-25",
    response: {
      code: "PRODUCT_METADATA",
      message: "ordinary product detail text",
      asin: "B0TEST0005",
      title: "Ordinary product",
    },
  });

  assert.equal(record.status, "empty");
  assert.equal(record.fbaFee, null);
});

test("Sorftime FBA cache is used only for the requested ASIN's ready Sorftime record", () => {
  const sorftimeReady = { status: "ready", source: "sorftime", fbaFee: 4.25 };
  const legacyKeepa = { status: "ready", source: "keepa", fbaFee: 4.25 };

  assert.equal(shouldUseCachedSorftimeFbaRecord(sorftimeReady), true);
  assert.equal(shouldUseCachedSorftimeFbaRecord(legacyKeepa), false);
  assert.equal(
    requiresSorftimeFbaCredential(["B0TARGET01"], { B0TARGET01: legacyKeepa }),
    true,
  );
  assert.equal(
    requiresSorftimeFbaCredential(["B0TARGET01"], { B0OTHER001: sorftimeReady }),
    true,
  );
  assert.equal(
    requiresSorftimeFbaCredential(["B0TARGET01"], { B0TARGET01: sorftimeReady }),
    false,
  );
  assert.equal(
    requiresSorftimeFbaCredential(["B0TARGET01"], { B0TARGET01: sorftimeReady }, { forceRefresh: true }),
    true,
  );
});

test("Sorftime FBA requests retain the deliberate 300ms pacing contract", () => {
  assert.equal(SORFTIME_FBA_PACING_MS, 300);
});

test("generated Sorftime FBA type retains optional legacy display fields consumed by the page", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../scripts/build-sorftime-fba-fee.mjs"),
    "utf8",
  );

  assert.match(source, /packageWeight\?: string \| null;/);
  assert.match(source, /note\?: string;/);
});

test("FBA table renders each ready record with its truthful source label", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../app/page.tsx"),
    "utf8",
  );
  const fbaRow = source.slice(
    source.indexOf("<tr><th>FBA 费用"),
    source.indexOf("<tr><th>产品规格"),
  );

  assert.doesNotMatch(fbaRow, /FBA 费用<small className="insight-source">Keepa · 配送费/);
  assert.match(
    fbaRow,
    /record\?\.source === "keepa" \? "Keepa · 配送费" : "Sorftime · FBA 费用估算"/,
  );
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

test("Sorftime FBA projection treats a zero fee as empty rather than ready", () => {
  const record = buildSorftimeFbaRecord({
    asin: "B0TEST0006",
    marketplace: "US",
    fetchedAt: "2026-09-02",
    response: { data: { fba_fee: 0 } },
  });

  assert.equal(record.status, "empty");
  assert.equal(record.fbaFee, null);
});
