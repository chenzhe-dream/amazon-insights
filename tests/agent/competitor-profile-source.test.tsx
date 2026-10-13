import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompetitorOverviewSnapshotProps, Product } from "../../app/project-report-views/competitor-overview";

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
  return nextLoad(url, context);
} });
const { CompetitorOverviewMatrix, PriceStrategyRow } = await import("../../app/project-report-views/competitor-overview");
const product = {
  asin: "B07PX9Y715", brand: "Test", title: "A title mentioning color is not variation evidence", image: "", price: 49.99,
  sales: null, rating: null, reviews: null, rank: null, subRank: null, rankCategory: "—", subRankCategory: "—",
  buyBoxSeller: "Verified merchant", fulfillment: "FBM", packageSize: "76.2 × 30.48 × 14.61 cm", packageWeight: "2.5 kg",
  specifications: ["等待同步"], launch: "2026-07-13", format: "—", variants: "3", history: [], prices: [], ranks: [],
  variantShare: [], variantDetails: [], sellingPoints: [], strengths: [], weaknesses: [], unmet: [], scenarios: [], audiences: [],
  keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 }, catalogSource: "sorftime-fallback", synced: false,
} satisfies Product;
function render(item: Product, extra = {}) {
  return renderToStaticMarkup(<CompetitorOverviewMatrix {...{
    products: [item], market: "US", slugParam: null, salesTrendByAsin: {}, ratingByAsin: {}, fbaFeeByAsin: {},
    childSalesByAsin: {}, priceStrategyByAsin: {}, sellingTranslationsByAsin: {}, categoryTrendByNode: {},
    presentation: "snapshot", ...extra,
  } as CompetitorOverviewSnapshotProps & { presentation: "snapshot" }} />);
}
test("fallback profile fields display only with their own verified source", () => {
  const html = render({ ...product, catalogFieldSources: { buyBoxSeller: "sorftime", fulfillment: "sorftime", launch: "sorftime", variants: "sorftime", packageSize: "sorftime" } } as Product);
  for (const value of [product.buyBoxSeller, product.fulfillment, product.launch, product.packageSize]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /2\.5 kg|SellerSprite 已同步/);
  assert.match(html, /Sorftime · 商品参数/);
});
test("historical fallback values without field receipts remain missing", () => {
  const html = render(product);
  for (const value of [product.buyBoxSeller, product.fulfillment, product.launch, product.packageSize, product.packageWeight]) assert.ok(!html.includes(value), value);
});
test("primary SellerSprite fields remain preferred", () => {
  const html = render({ ...product, catalogSource: "sellerSprite", synced: true });
  for (const value of [product.buyBoxSeller, product.fulfillment, product.launch, product.packageSize, product.packageWeight]) assert.ok(html.includes(value), value);
  assert.match(html, /SellerSprite 已同步/);
});
test("snapshot price analysis keeps complete evidence without a toggle", () => {
  const html = render(product, { priceStrategyByAsin: { [product.asin]: { status: "ready", currentPrice: 49.99, anchor: "Anchor evidence", promotion: "Promotion evidence", psychology: "Psychology evidence", evidence: "Complete provenance" } } });
  for (const value of ["Anchor evidence", "Promotion evidence", "Psychology evidence", "Complete provenance"]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<button/);
});
test("specification fallback requires verified listing identity and source, preserving primary content", () => {
  const listing = { asin: product.asin, marketplace: "US", status: "ready", source: "Sorftime", specifications: ["Material: Birch wood", "Product dimensions: 29.9 inches"] };
  const extra = (record: object) => ({ listingContentByAsin: { [product.asin]: record } });
  assert.match(render(product, extra(listing)), /Material: Birch wood/);
  for (const changed of [{ source: undefined }, { source: "unknown" }, { asin: "B000000000" }, { marketplace: "UK" }, { status: "error" }]) {
    assert.doesNotMatch(render(product, extra({ ...listing, ...changed })), /Material: Birch wood|Product dimensions: 29\.9 inches/);
  }
  const primary = { ...product, catalogSource: "sellerSprite" as const, synced: true, specifications: ["Verified primary specification"] };
  const html = render(primary, extra(listing));
  assert.match(html, /Verified primary specification/);
  assert.doesNotMatch(html, /Material: Birch wood/);
});
test("variation axes use scoped child attributes only when primary theme is missing", () => {
  const children = { childSalesByAsin: { [product.asin]: [{ asin: "B0CJV11YQF", variant: "Color:Claw", sales: 30, observedAt: "2026-10-13" }] } };
  assert.match(render(product, children), /颜色/);
  assert.match(render({ ...product, synced: true, catalogSource: "sellerSprite", format: "—" }, children), /颜色/);
  const primary = render({ ...product, synced: true, catalogSource: "sellerSprite", format: "Size" }, children);
  assert.match(primary, /尺寸/);
  assert.doesNotMatch(primary, />颜色</);
  assert.match(render(product), /暂无数据/);
});
test("one accessible price toggle controls all nine initially compact cells", () => {
  const products = Array.from({ length: 9 }, (_, index) => ({ ...product, asin: `B00000000${index}` }));
  const strategies = Object.fromEntries(products.map(item => [item.asin, { status: "ready", currentPrice: item.price, anchor: "Full anchor", promotion: "Full promotion", psychology: "Full psychology", evidence: "Full evidence" }]));
  const html = renderToStaticMarkup(<table><tbody><PriceStrategyRow products={products} priceStrategyByAsin={strategies} presentation="page" /></tbody></table>);
  assert.equal((html.match(/<button /g) ?? []).length, 1);
  assert.match(html, /type="button"[^>]*aria-expanded="false"/);
  const ids = html.match(/aria-controls="([^"]+)"/)?.[1].split(" ");
  assert.equal(ids?.length, 9);
  for (const id of ids ?? []) assert.ok(html.includes(`id="${id}" class="price-strategy-details" hidden=""`));
  assert.equal((html.match(/当前价 \$49\.99/g) ?? []).length, 9);
  assert.equal((html.match(/Full evidence/g) ?? []).length, 9, "collapsing preserves all analysis data");
});
test("retained specs reject invalid independent provenance instead of borrowing the new gallery timestamp", () => {
  const fetchedAt = "2026-10-13T10:00:00.000Z";
  const provenance = { jobId: "current-job", asin: product.asin, marketplace: "US", connector: "sorftime", operation: "product_detail", tool: "product_detail", fetchedAt };
  const specificationsProvenance = { ...provenance, operation: "product_content", tool: "product_content", fetchedAt: "2026-10-12T09:00:00.000Z" };
  const record = { asin: product.asin, marketplace: "US", status: "ready", source: "Sorftime", fetchedAt, provenance, specificationsProvenance, specifications: ["Retained exact specification"] };
  const extra = (value: object) => ({ listingContentByAsin: { [product.asin]: value } });
  assert.match(render(product, extra(record)), /Retained exact specification/);
  for (const changed of [{ jobId: "older-job" }, { asin: "B000000000" }, { marketplace: "CA" }, { connector: "unknown" }, { tool: "product_detail" }, { fetchedAt: "2099-01-01" }]) {
    assert.doesNotMatch(render(product, extra({ ...record, specificationsProvenance: { ...specificationsProvenance, ...changed } })), /Retained exact specification/);
  }
});
