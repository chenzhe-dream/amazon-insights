import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildReferenceConclusions } from "../../app/market-shape-reference/conclusions";
import { ReferenceConclusionsView, ReferenceShapePriceConclusion } from "../../app/market-shape-reference/conclusions/view";
import type { SorftimeCategoryDashboardReport } from "../../app/market-shape-reference/types";

const product = (asin: string, shape: string, price: number, sales: number, year: string) => ({
  rank: 1, asin, title: asin, brand: "Brand A", imageUrl: "", monthlySalesVolume: sales,
  monthlySalesAmount: sales * price, sales: { last3Months: sales * 3, last6Months: sales * 6, y2024: year>'2024-12-31'?0:sales * 12, y2025: sales * 12, monthsAvailable: 12 },
  monthlyTrend: { volume: [], amount: [] }, price, categoryRank: "", productCategory: "", productShape: shape,
  productShapeHint: null, bsrRank: 1, deliveryType: "FBA", reviewCount: 10, starRating: 4.5,
  seller: "Seller A", sellerOrigin: "US", onlineDate: year, grossProfitMargin: 65, priceBand: `$${Math.floor(price / 10) * 10}-${Math.floor(price / 10) * 10 + 10}`,
});

const report: SorftimeCategoryDashboardReport = {
  marketplace: "US", sorftimeSite: "US", nodeId: "1", categoryName: "Lamps", fetchedAt: "2025-12-31T00:00:00Z", note: "",
  stats: { top100MonthlyVolume: 300, top100MonthlyAmount: 9000, top3ProductSharePct: 50, top3BrandSharePct: 50, top3SellerSharePct: 50, amazonOwnedSharePct: 0, averagePrice: 30, medianPrice: 30, returnRatePct: null },
  history: { volume: [], avgPrice: [], amount: [], listingMonopoly: [], brandMonopoly: [], sellerMonopoly: [] },
  products: [product("A", "Desk", 25, 100, "2024-01-01"), product("B", "Floor", 45, 200, "2025-01-01")],
  productSalesTotals: { last3Months: 900, last6Months: 1800, y2024: 3600, y2025: 3600, monthsAvailable: 12 },
  topLinkCount: 2,
};

test("builds the five original rich conclusion sections from the same scoped products", () => {
  const result = buildReferenceConclusions(report, { A: "Desk", B: "Floor" });
  assert.equal(result.listingYear.status, "ready");
  assert.equal(result.margin.status, "ready");
  assert.equal(result.shapeSales.status, "ready");
  assert.equal(result.shapePrice.status, "ready");
  assert.equal(result.brandPrice.status, "ready");
  assert.equal(result.synthesis.status, "ready");
  if (result.listingYear.status !== "ready" || result.shapeSales.status !== "ready" || result.shapePrice.status !== "ready" || result.brandPrice.status !== "ready" || result.synthesis.status !== "ready") return;
  assert.equal(result.listingYear.result.analysisScope.validProductCount, 2);
  assert.equal(result.shapeSales.result.insights.length, 2);
  assert.equal(result.shapePrice.result.analysisScope.linkCount, 2);
  assert.equal(result.brandPrice.result.analysisScope.validLinkCount, 2);
  assert.equal(result.synthesis.result.moduleSections.length, 5);
});

test("missing historical sales stay unknown instead of becoming zero-valued conclusions", () => {
  const incomplete: SorftimeCategoryDashboardReport = { ...report, products: [{ ...report.products[0], sales: { ...report.products[0].sales, y2024: null } }] };
  const result = buildReferenceConclusions(incomplete, { A: "Desk" });
  assert.equal(result.listingYear.status, "ready");
  assert.equal(result.margin.status, "ready");
  assert.equal(result.shapeSales.status, "insufficient");
  assert.equal(result.shapePrice.status, "insufficient");
  assert.equal(result.brandPrice.status, "insufficient");
  assert.equal(result.synthesis.status, "insufficient");
  if (result.synthesis.status === "insufficient") assert.match(result.synthesis.reason, /2024/);
  const html = renderToStaticMarkup(createElement(ReferenceConclusionsView, { result }));
  assert.match(html, /上架年份 · 新品准入结论/);
  assert.match(html, /缺少 2024 销量/);
});

test("missing six-month sales blocks only modules that need that period", () => {
  const incomplete: SorftimeCategoryDashboardReport = { ...report, products: [{ ...report.products[0], sales: { ...report.products[0].sales, last6Months: null } }] };
  const result = buildReferenceConclusions(incomplete, { A: "Desk" });
  assert.equal(result.listingYear.status, "insufficient");
  assert.equal(result.margin.status, "insufficient");
  if (result.margin.status === "insufficient") assert.match(result.margin.reason, /近6个月/);
});

test("a confirmed new listing has no pre-launch annual contribution and does not block the original conclusions",()=>{
 const recent={...report,products:[{...report.products[0],onlineDate:'2026-08-01',sales:{...report.products[0].sales,y2024:null,y2025:null}}]};
 const result=buildReferenceConclusions(recent,{A:'Desk'});
 assert.equal(result.synthesis.status,'ready');assert.equal(result.shapeSales.status,'ready');
 assert.equal(recent.products[0].sales.y2024,null,'do not rewrite missing provider observations');
 const unknownDate={...recent,products:[{...recent.products[0],onlineDate:null}]};
 assert.equal(buildReferenceConclusions(unknownDate,{A:'Desk'}).synthesis.status,'insufficient');
 const conflict={...recent,products:[{...recent.products[0],sales:{...recent.products[0].sales,y2024:5}}]};
 const conflictResult=buildReferenceConclusions(conflict,{A:'Desk'});
 assert.equal(conflictResult.synthesis.status,'insufficient');
 if(conflictResult.synthesis.status==='insufficient')assert.match(conflictResult.synthesis.reason,/冲突/);
 for(const date of ['2026-08-99','2026-08-foo','2026-02-30'])assert.equal(buildReferenceConclusions({...recent,products:[{...recent.products[0],onlineDate:date}]},{A:'Desk'}).synthesis.status,'insufficient');
});

test("missing margin is excluded from observed margin evidence", () => {
  const noMargin: SorftimeCategoryDashboardReport = {
    ...report,
    products: report.products.map(p => ({ ...p, grossProfitMargin: null })),
  };
  const result = buildReferenceConclusions(noMargin, { A: "Desk", B: "Floor" });
  assert.equal(result.synthesis.status, "ready");
  if (result.synthesis.status !== "ready") return;
  const margin = result.synthesis.result.moduleSections.find(section => section.key === "marginMarketAccess")?.marginAccessDetail;
  assert.equal(margin?.withMarginCount, 0);
  assert.equal(margin?.linkGreenSharePct, 0);
});

test("renders the original five-dimension card structure with concrete conclusions", () => {
  const result = buildReferenceConclusions(report, { A: "Desk", B: "Floor" });
  const html = renderToStaticMarkup(createElement(ReferenceConclusionsView, { result }));
  assert.match(html, /market-structure-synthesis-verdict-card/);
  assert.match(html, /market-structure-dimension-grid/);
  assert.match(html, /机会方向/);
  assert.match(html, /主要风险/);
  assert.match(html, /商品形态 × 价格带/);
  assert.match(html, /品牌 × 价格带/);
});

test("embedded conclusion renders inside an existing section without another section wrapper", () => {
  const result = buildReferenceConclusions(report, { A: "Desk", B: "Floor" });
  assert.equal(result.shapePrice.status, "ready");
  if (result.shapePrice.status !== "ready") return;
  const html = renderToStaticMarkup(createElement(ReferenceShapePriceConclusion, { result: result.shapePrice.result, embedded: true }));
  assert.match(html, /listing-age-conclusion/);
  assert.doesNotMatch(html, /class="launch-section/);
});

test("complete input matches the preserved original reference analyzers", async t => {
  const source = "C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app/lib";
  if (!existsSync(`${source}/shape-price-analysis.ts`)) return t.skip("reference snapshot unavailable");
  const original = async (name: string) => import(pathToFileURL(`${source}/${name}.ts`).href);
  const [price, age, sales, bands, brand, synthesis, margin] = await Promise.all([
    original("shape-price-analysis"), original("listing-age-sales-share-analysis"), original("shape-sales-share-analysis"),
    original("shape-price-band-structure-analysis"), original("brand-price-opportunity-analysis"), original("market-structure-synthesis-analysis"), original("sorftime-category-dashboard"),
  ]);
  const actual = buildReferenceConclusions(report, { A: "Desk", B: "Floor" });
  assert.equal(actual.synthesis.status, "ready");
  if (actual.listingYear.status !== "ready" || actual.listingYearRows.status !== "ready" || actual.margin.status !== "ready" || actual.shapeSales.status !== "ready" || actual.shapePrice.status !== "ready" || actual.brandPrice.status !== "ready" || actual.synthesis.status !== "ready") return;
  const products = report.products;
  const sampleScope = "US · Lamps · TOP2";
  const yearRows = price.buildListingYearAnalysis(products.map(p => ({ listingYear: p.onlineDate?.slice(0, 4), sales: p.sales, trendMissing: false })), { fetchedAt: report.fetchedAt });
  const expectedAge = age.analyzeListingAgeSalesShare(age.buildListingAgeSalesShareInputsFromProducts(products), {
    analysisDate: report.fetchedAt, salesPeriod: "last6Months", sampleScope, categoryName: report.categoryName, marketplace: report.marketplace,
  });
  const shapeRows = price.buildShapePriceBandAnalysis(products.map(p => ({ productShape: p.productShape, priceBand: p.priceBand, sales: p.sales, trendMissing: false })), { fetchedAt: report.fetchedAt });
  const shapeAggregates = price.buildShapeAggregatesFromPriceBandRows(shapeRows, { fetchedAt: report.fetchedAt });
  const expectedBrand = brand.analyzeBrandPriceOpportunity(brand.buildBrandPriceOpportunityInputsFromProducts(products, { getShape: (asin: string) => ({ A: "Desk", B: "Floor" })[asin as "A" | "B"] }), {
    analysisDate: report.fetchedAt, sampleScope, categoryName: report.categoryName, marketplace: report.marketplace,
  });
  assert.deepEqual(actual.listingYearRows.result, yearRows);
  assert.deepEqual(actual.listingYear.result, expectedAge);
  assert.deepEqual(actual.margin.result, margin.buildTopSalesMarginEntryConclusion(products, { getProductShape: (asin: string) => ({ A: "Desk", B: "Floor" })[asin as "A" | "B"] }));
  assert.deepEqual(actual.shapeSales.result, sales.analyzeShapeSalesShare(shapeAggregates));
  assert.deepEqual(actual.shapePrice.result, bands.analyzeShapePriceBandStructure({ rows: shapeRows, shapeAggregates, sampleScope, structuralPeriod: "2024 / 2025 / 近6个月 / 近3个月" }));
  assert.deepEqual(actual.brandPrice.result, expectedBrand);
  assert.deepEqual(actual.synthesis.result, synthesis.buildMarketStructureSynthesis(report, { getProductShape: (asin: string) => ({ A: "Desk", B: "Floor" })[asin as "A" | "B"] }));
});
