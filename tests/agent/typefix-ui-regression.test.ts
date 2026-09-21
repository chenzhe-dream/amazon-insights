import assert from "node:assert/strict";
import test from "node:test";

import { resolveRatingMetric } from "../../app/lib/competitor-metric-resolution";

test("partial catalog rating evidence uses null for the missing display metric", () => {
  assert.deepEqual(resolveRatingMetric(undefined, { rating: 4.2 }).value, {
    rating: 4.2,
    reviewCount: null,
  });
  assert.deepEqual(resolveRatingMetric(undefined, { reviews: 42 }).value, {
    rating: null,
    reviewCount: 42,
  });
});
