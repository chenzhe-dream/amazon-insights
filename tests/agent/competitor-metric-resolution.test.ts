import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveFbaMetric,
  resolvePriceMetric,
  resolveRatingMetric,
} from "../../app/lib/competitor-metric-resolution";

test("invalid Sorftime price and conflicting zero rating fall back to catalog with a re-sync label", () => {
  assert.deepEqual(resolvePriceMetric({ status: "ready", currentPrice: 0 }, 49.99), {
    source: "catalog", value: 49.99, state: "conflict", label: "Sorftime 数据冲突，待重新同步",
  });
  assert.deepEqual(resolveRatingMetric({ status: "ready", rating: 0, reviewCount: 0 }, { rating: 4.2, reviews: 42 }), {
    source: "catalog", value: { rating: 4.2, reviewCount: 42 }, state: "conflict", label: "Sorftime 数据冲突，待重新同步",
  });
});

test("genuine zero-review ratings stay valid while zero FBA is missing", () => {
  assert.deepEqual(resolveRatingMetric({ status: "ready", rating: 0, reviewCount: 0 }, { rating: 0, reviews: 0 }), {
    source: "sorftime", value: { rating: 0, reviewCount: 0 }, state: "ready", label: null,
  });
  assert.deepEqual(resolveFbaMetric({ status: "ready", fbaFee: 0 }), {
    source: "missing", value: null, state: "missing", label: "暂未返回 FBA 配送费",
  });
});
