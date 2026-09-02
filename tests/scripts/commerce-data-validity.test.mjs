import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCatalogRatingReviewConflict,
  positiveMoneyOrNull,
} from "../../scripts/lib/commerce-data-validity.mjs";
import { buildStrategy } from "../../scripts/build-sorftime-price-strategy.mjs";
import { buildSorftimeRatingRecord } from "../../scripts/build-sorftime-rating.mjs";

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
