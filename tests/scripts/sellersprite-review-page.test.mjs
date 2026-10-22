import assert from "node:assert/strict";
import test from "node:test";
import { parseSellerSpriteReviewPage } from "../../scripts/lib/sellersprite-mcp-client.mjs";

test("SellerSprite review page requires a successful array envelope", () => {
  assert.deepEqual(parseSellerSpriteReviewPage({ code: "OK", data: { items: [{ author: "A", content: "fun", star: 5 }], total: 1, pages: 1 } }), { items: [{ author: "A", content: "fun", star: 5 }], total: 1, pages: 1 });
  for (const payload of [{ code: "ERR", message: "denied" }, { code: "OK", data: { items: "bad" } }, { message: "unknown" }, { code: "OK" }]) {
    assert.throws(() => parseSellerSpriteReviewPage(payload));
  }
});

test("malformed review items carry schema classification without including provider content", () => {
  assert.throws(() => parseSellerSpriteReviewPage({code:"OK",data:{items:"private-body-sentinel"}}), error => {
    assert.equal(error.kind,"schema");
    assert.doesNotMatch(error.message,/private-body-sentinel/);
    return true;
  });
});

test("an explicit zero-result terminal page may have null items", () => {
  const data = {items:null,total:0,pages:0,page:1,hasNextPage:false};
  assert.deepEqual(parseSellerSpriteReviewPage({code:'OK',data}), {items:[],total:0,pages:0});
  for (const patch of [{total:1},{pages:1},{hasNextPage:true},{total:undefined},{pages:undefined},{hasNextPage:undefined},{items:undefined},{items:'bad'}]) {
    assert.throws(() => parseSellerSpriteReviewPage({code:'OK',data:{...data,...patch}}));
  }
});
