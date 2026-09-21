import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogEntryFromSellerSprite } from "../../scripts/lib/catalog-sync.mjs";

test("catalog retains every complete original bullet for translation", () => {
  const features = Array.from({ length: 5 }, (_, index) => `Original bullet ${index + 1}: ${"Complete product description. ".repeat(12)}`);
  const entry = buildCatalogEntryFromSellerSprite({ asin: "B000000001", title: "Product", features }, []);
  assert.deepEqual(entry.listingBullets, features);
  assert.equal(entry.strengths.length, 3);
});
