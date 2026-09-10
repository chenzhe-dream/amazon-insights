import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AmazonStarRating, RatingCell } from "../../app/components/amazon-star-rating";

test("AmazonStarRating clamps fill and label while compact mode hides the value", () => {
  const high = renderToStaticMarkup(createElement(AmazonStarRating, { rating: 6 }));
  const lowCompact = renderToStaticMarkup(createElement(AmazonStarRating, { rating: -1, compact: true }));

  assert.match(high, /aria-label="5\.0 星，满分 5 星"/);
  assert.match(high, /width:100%/);
  assert.match(high, />5\.0<\/span>/);
  assert.match(lowCompact, /amazon-star-rating-compact/);
  assert.match(lowCompact, /aria-label="0\.0 星，满分 5 星"/);
  assert.match(lowCompact, /width:0%/);
  assert.doesNotMatch(lowCompact, /amazon-star-rating-value/);
});

test("RatingCell distinguishes unavailable reviews from a measured zero", () => {
  const unavailable = renderToStaticMarkup(createElement(RatingCell, { rating: 4.2, reviews: null }));
  const zero = renderToStaticMarkup(createElement(RatingCell, { rating: 4.2, reviews: 0 }));

  assert.doesNotMatch(unavailable, / 条<\/small>/);
  assert.match(zero, />0 条<\/small>/);
});
