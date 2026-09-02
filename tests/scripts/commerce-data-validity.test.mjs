import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCatalogRatingReviewConflict,
  positiveMoneyOrNull,
} from "../../scripts/lib/commerce-data-validity.mjs";
import { buildPriceStrategyUiExport, buildStrategy } from "../../scripts/build-sorftime-price-strategy.mjs";
import {
  buildSorftimeRatingRecord,
  shouldReuseSorftimeRatingRecord,
} from "../../scripts/build-sorftime-rating.mjs";

test("positive commerce money rejects zero, negative, non-finite, and string values", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "4.25"]) {
    assert.equal(positiveMoneyOrNull(value), null);
  }
  assert.equal(positiveMoneyOrNull(4.25), 4.25);
});

test("zero rating and reviews conflict only with positive catalog evidence", () => {
  assert.equal(hasCatalogRatingReviewConflict(0, 0, { rating: 4.2, reviews: 42 }), true);
  assert.equal(hasCatalogRatingReviewConflict(0, 0, { rating: 0, reviews: 0 }), false);
  assert.equal(hasCatalogRatingReviewConflict(4.2, 0, { rating: 4.2, reviews: 42 }), false);
});

test("price strategy rejects an invalid current price but retains a positive currentPrice", () => {
  assert.equal(buildStrategy({ price: 0, coupon: 0, prices: [{ value: 19.99 }] }), null);
  const strategy = buildStrategy({ price: 19.99, coupon: 0, prices: [] });
  assert.equal(strategy.currentPrice, 19.99);
});

test("rating generator marks catalog-conflicting zero records empty but preserves verified zero reviews", () => {
  assert.equal(buildSorftimeRatingRecord({
    asin: "B0TEST0001", marketplace: "US", fetchedAt: "2026-09-02", rating: 0, reviewCount: 0,
    catalog: { rating: 4.2, reviews: 42 },
  }).status, "empty");
  assert.equal(buildSorftimeRatingRecord({
    asin: "B0TEST0001", marketplace: "US", fetchedAt: "2026-09-02", rating: 4.2, reviewCount: 0,
    catalog: { rating: 4.2, reviews: 42 },
  }).status, "ready");
});

test("rating generator keeps absent or string zero metrics empty but accepts numeric zero", () => {
  for (const value of [null, undefined, "", "0"]) {
    const record = buildSorftimeRatingRecord({
      asin: "B0TEST0002", marketplace: "US", fetchedAt: "2026-09-02", rating: value, reviewCount: value,
      catalog: { rating: 0, reviews: 0 },
    });
    assert.deepEqual(
      { status: record.status, rating: record.rating, reviewCount: record.reviewCount },
      { status: "empty", rating: null, reviewCount: null },
      String(value),
    );
  }
  assert.equal(buildSorftimeRatingRecord({
    asin: "B0TEST0002", marketplace: "US", fetchedAt: "2026-09-02", rating: 0, reviewCount: 0,
    catalog: { rating: 0, reviews: 0 },
  }).status, "ready");
});

test("rating cache rejects scoped zero records that conflict with positive catalog evidence", () => {
  const record = {
    asin: "B0TEST0001",
    marketplace: "US",
    fetchedAt: "2026-09-02",
    status: "ready",
    rating: 0,
    reviewCount: 0,
  };
  for (const [catalog, expected] of [
    [{ rating: 4.4, reviews: 0 }, false],
    [{ rating: 0, reviews: 941 }, false],
    [{ rating: 0, reviews: 0 }, true],
  ]) {
    assert.equal(shouldReuseSorftimeRatingRecord({
      record,
      catalog,
      asin: record.asin,
      marketplace: record.marketplace,
      forceRefresh: false,
    }), expected);
  }
});

test("price strategy UI export preserves machine-readable ready status and current price", () => {
  const source = buildPriceStrategyUiExport({
    records: {
      B0TEST0001: {
        asin: "B0TEST0001", marketplace: "US", fetchedAt: "2026-09-02", source: "Sorftime",
        status: "ready", currentPrice: 19.99, anchor: "price", promotion: "none", psychology: "none", evidence: "fixture",
      },
    },
    marketplace: "US",
    fetchedAt: "2026-09-02",
  });
  assert.match(source, /"status": "ready"/);
  assert.match(source, /"currentPrice": 19\.99/);
});
