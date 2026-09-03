import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseVariationRows,
  selectChildSalesFallback,
} from "../../scripts/build-sorftime-child-sales.mjs";
import {
  createProductVariationsEvidence,
  readScopedSorftimeEvidence,
  writeScopedSorftimeEvidence,
} from "../../scripts/lib/scoped-sorftime-evidence.mjs";

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

test("schema-invalid and unknown direct variation responses cannot be replaced by same-job fallback", () => {
  const schemaInvalid = parseVariationRows({ data: [
    { Asin: "B000000001", SalesAmount: "not-a-number" },
  ] });
  const unknownContainer = parseVariationRows({ data: null });
  let fallbackCalls = 0;
  const fallback = () => {
    fallbackCalls += 1;
    return { status: "ready", rows: [{ asin: "B000000001", sales: 99 }] };
  };

  assert.equal(selectChildSalesFallback(schemaInvalid, fallback), null);
  assert.equal(selectChildSalesFallback(unknownContainer, fallback), null);
  assert.equal(fallbackCalls, 0);
});

test("normalized unknown variation evidence preserves safe shape metadata through write and read", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sorftime-variation-evidence-"));
  const scope = {
    jobId: "child-sales-schema-job",
    marketplace: "US",
    asin: "B000000001",
    fetchedAt: "2026-09-02T00:00:00.000Z",
  };
  try {
    const evidence = createProductVariationsEvidence({
      ...scope,
      response: {
        rows: [],
        containerRecognized: false,
        rawRowCount: 1,
        validSalesRowCount: 0,
      },
    });
    writeScopedSorftimeEvidence(evidence, { root });
    const reread = readScopedSorftimeEvidence({ ...scope, operation: "product_variations" }, { root });

    assert.deepEqual(
      {
        containerRecognized: reread?.data.containerRecognized,
        rawRowCount: reread?.data.rawRowCount,
        validSalesRowCount: reread?.data.validSalesRowCount,
      },
      { containerRecognized: false, rawRowCount: 1, validSalesRowCount: 0 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
