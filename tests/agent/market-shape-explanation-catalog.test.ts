import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMarketShapeExplanationCatalog,
  validateMarketShapeExplanationCatalog,
} from "../../server/domain/market-research/shape-explanation-catalog";
import { sourceCatalog } from "./helpers/market-shape-explanation-fixture";

const at = (value: any, path: string) =>
  path
    .split(/\.|\[|\]/)
    .filter(Boolean)
    .reduce(
      (v, key) => v[Number.isInteger(Number(key)) ? Number(key) : key],
      value,
    );

test("catalog exposes every aggregate as an immutable original-value cell", async () => {
  const source = await sourceCatalog(),
    catalog = buildMarketShapeExplanationCatalog(source);
  assert.deepEqual(validateMarketShapeExplanationCatalog(catalog), catalog);
  assert.equal(catalog.catalogId, source.catalogId);
  assert.equal(catalog.revisionId, source.revision.revisionId);
  assert.equal(catalog.rows.length, 52);
  assert.deepEqual(
    new Set(catalog.rows.map((r) => r.dimension)),
    new Set(["scope", "shape", "price", "brand", "age", "month"]),
  );
  for (const row of catalog.rows)
    for (const cell of row.cells)
      assert.equal(cell.value, at(source, cell.path), `${row.id}/${cell.id}`);
  const zero = catalog.rows.flatMap((r) => r.cells).find((c) => c.value === 0),
    nil = catalog.rows.flatMap((r) => r.cells).find((c) => c.value === null);
  assert.ok(zero);
  assert.ok(nil);
  assert.throws(() => {
    (catalog.rows as any).push({});
  });
  assert.ok(
    catalog.limitations.some((l) => l.code === "structure-source-warning"),
  );
  assert.ok(
    catalog.limitations.some((l) => l.code === "complete-common-members"),
  );
});

test("different denominators, unclassified members and monthly aggregates remain explicit", async () => {
  const source = await sourceCatalog(),
    catalog = buildMarketShapeExplanationCatalog(source);
  const rows = catalog.rows;
  const low = rows.find((r) => r.path === "analysis.shapes[0].bands[0]")!,
    high = rows.find((r) => r.path === "analysis.shapes[0].bands[1]")!;
  assert.notEqual(
    low.cells.find((c) => c.id === "salesShare.denominator")!.value,
    low.cells.find((c) => c.id === "linkShare.denominator")!.value,
  );
  assert.equal(high.cells.find((c) => c.id === "totalUnits")!.value, 10);
  assert.equal(
    rows
      .find(
        (r) =>
          r.dimension === "month" &&
          r.context.month === "2026-07" &&
          r.context.shape === "desk" &&
          r.context.priceBand === "high",
      )!
      .cells.find((c) => c.id === "totalUnits")!.value,
    0,
  );
  assert.ok(
    rows.some((r) => r.dimension === "shape" && r.context.shape === null),
  );
  assert.ok(
    rows.some(
      (r) =>
        r.dimension === "month" &&
        r.context.month === "2026-07" &&
        r.context.priceBand === "high",
    ),
  );
  assert.deepEqual(
    catalog.scope.requestedAsins,
    source.analysis.scope.requestedAsins,
  );
  assert.deepEqual(
    catalog.scope.eligibleAsins,
    source.analysis.scope.eligibleAsins,
  );
});

test("tampering with any catalog content or claimed digest is rejected", async () => {
  const built = buildMarketShapeExplanationCatalog(await sourceCatalog());
  for (const mutate of [
    (v: any) => (v.rows[0].cells[0].value = 999),
    (v: any) => (v.rows[0].context.coverageStatus = "forged"),
    (v: any) => (v.catalogId = "market-shape-price:" + "0".repeat(64)),
    (v: any) =>
      (v.explanationCatalogId = "market-shape-explanation:" + "0".repeat(64)),
  ]) {
    const copy = structuredClone(built) as any;
    mutate(copy);
    assert.throws(() => validateMarketShapeExplanationCatalog(copy));
  }
});

test("validation returns a frozen parsed copy instead of trusting mutable input", async () => {
  const mutable = structuredClone(
    buildMarketShapeExplanationCatalog(await sourceCatalog()),
  );
  const validated = validateMarketShapeExplanationCatalog(mutable);
  assert.notEqual(validated, mutable);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.rows[0].cells));
  assert.throws(() => {
    (validated.rows as any).push({});
  });
});

test("legacy v1 has an explicit structural gap without inventing brand or age rows", async () => {
  const catalog = buildMarketShapeExplanationCatalog(
    await sourceCatalog("market-shape-price-catalog/v1"),
  );
  assert.ok(
    catalog.limitations.some((l) => l.code === "structure-unavailable"),
  );
  assert.equal(
    catalog.rows.filter((r) => r.dimension === "brand" || r.dimension === "age")
      .length,
    0,
  );
  assert.ok(catalog.rows.some((r) => r.dimension === "scope"));
  assert.ok(catalog.rows.some((r) => r.dimension === "month"));
});


test('v3 explanation preserves actual request-bound price and monthly admission, not only the policy definition',async()=>{
  const source=await sourceCatalog('market-shape-price-catalog/v3',true);
  const catalog=buildMarketShapeExplanationCatalog(source);
  const limitation=catalog.limitations.find(l=>l.code==='source-admission-basis');
  assert.ok(limitation,'model cannot tell whether the policy was applied without the actual row provenance');
  const proofs=JSON.parse(limitation.detail);
  assert.deepEqual(proofs[0].price,source.products[0].referencePrice.provenance);
  assert.equal(proofs[0].price.currencyBasis,'provider-contract');
  assert.equal(proofs[0].observations[0].provenance.periodBasis,'request-bound');
  assert.equal(proofs[0].brand,source.structure!.products[0].brand.scopeBasis);
  assert.equal(proofs.length,source.products.length);
});
