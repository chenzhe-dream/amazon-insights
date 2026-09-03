import assert from "node:assert/strict";
import test from "node:test";

import { CatalogSourceStatus } from "../../app/catalog-source-status";

test("Sorftime fallback is visible without claiming SellerSprite-only fields", () => {
  const html = renderProduct({
    catalogSource: "sorftime-fallback",
    synced: false,
  });

  assert.match(html, /Sorftime 基础数据/);
  assert.match(html, /SellerSprite 专属字段暂缺/);
  assert.doesNotMatch(html, /SellerSprite 已同步/);
});

test("SellerSprite catalog keeps its preferred source label without a fallback gap", () => {
  const html = renderProduct({
    catalogSource: "sellerSprite",
    synced: true,
  });

  assert.match(html, /SellerSprite 已同步/);
  assert.doesNotMatch(html, /Sorftime 基础数据|SellerSprite 专属字段暂缺/);
});

function renderProduct(product: Parameters<typeof CatalogSourceStatus>[0]["product"]) {
  const element = CatalogSourceStatus({ product });
  return String(element.props.children);
}
