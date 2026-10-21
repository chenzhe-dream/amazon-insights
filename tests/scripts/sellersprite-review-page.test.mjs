import assert from "node:assert/strict";
import test from "node:test";
import { parseSellerSpriteReviewPage } from "../../scripts/lib/sellersprite-mcp-client.mjs";

test("SellerSprite review page requires a successful array envelope", () => {
  assert.deepEqual(parseSellerSpriteReviewPage({ code: "OK", data: { items: [{ author: "A", content: "fun", star: 5 }], total: 1, pages: 1 } }), { items: [{ author: "A", content: "fun", star: 5 }], total: 1, pages: 1 });
  for (const payload of [{ code: "ERR", message: "denied" }, { code: "OK", data: { items: "bad" } }, { message: "unknown" }, { code: "OK" }]) {
    assert.throws(() => parseSellerSpriteReviewPage(payload));
  }
});
