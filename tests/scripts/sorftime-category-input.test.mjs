import assert from "node:assert/strict";
import test from "node:test";

import { selectSorftimeCategoryInputs } from "../../scripts/lib/sorftime-category-input.mjs";

test("category sync retains requested ASINs that are absent from the SellerSprite catalog", () => {
  const inputs = selectSorftimeCategoryInputs(
    [{ asin: "B0CATALOG1", subRankCategory: "Existing category" }],
    ["B0REQUEST1"],
  );

  assert.deepEqual(inputs, [{ asin: "B0REQUEST1", subRankCategory: "" }]);
});

test("category sync preserves catalog category metadata for a requested catalog ASIN", () => {
  const inputs = selectSorftimeCategoryInputs(
    [{ asin: "B0CATALOG1", subRankCategory: "Existing category" }],
    ["B0CATALOG1"],
  );

  assert.deepEqual(inputs, [{ asin: "B0CATALOG1", subRankCategory: "Existing category" }]);
});
