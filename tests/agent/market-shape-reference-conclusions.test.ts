import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildReferenceConclusions } from "../../app/market-shape-reference/conclusions";
import { ReferenceConclusionsView, ReferenceMarginConclusion, ReferenceSynthesisConclusion, ReferenceShapePriceConclusion, ReferenceBrandPriceConclusion } from "../../app/market-shape-reference/conclusions/view";
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

test("brand price cards explain pending evidence and translate every research grade without changing results", () => {
  const slot = buildReferenceConclusions(report, {}).brandPrice;
  assert.equal(slot.status, "ready");
  if (slot.status !== "ready") return;
  const before = JSON.stringify(slot.result);
  const html = renderToStaticMarkup(createElement(ReferenceBrandPriceConclusion, { result: slot.result }));
  assert.doesNotMatch(html, />[^<]*GRAY/);
  assert.match(html, /待验证/);
  assert.match(html, /价格带内真实品牌仅 1 个，样本不足/);
  assert.match(html, /样本：1 个商品 · 1 个品牌/);
  assert.match(html, /当前价格带样本/);
  for (const [grade, label] of [["GREEN", "优先研究"], ["YELLOW", "差异化研究"], ["RED", "暂缓"], ["GRAY", "待验证"]] as const) {
    const result = { ...slot.result, priceBands: [{ ...slot.result.priceBands[0], grade }] };
    const rendered = renderToStaticMarkup(createElement(ReferenceBrandPriceConclusion, { result }));
    assert.match(rendered, new RegExp(`>${label}</span>`));
  }
  assert.equal(JSON.stringify(slot.result), before);
});

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
  assert.equal(result.shapePrice.status, "ready");
  assert.equal(result.brandPrice.status, "ready");
  assert.equal(result.synthesis.status, "ready");
  const html = renderToStaticMarkup(createElement(ReferenceConclusionsView, { result }));
  assert.match(html, /上架年份 · 新品准入结论/);
  assert.match(html, /缺少 2024 销量/);
});

test("brand price uses complete recent periods without requiring unrelated annual history", () => {
  const incomplete: SorftimeCategoryDashboardReport = { ...report, products: [{ ...report.products[0], sales: { ...report.products[0].sales, y2024: null, y2025: null } }] };
  const result = buildReferenceConclusions(incomplete, { A: "Desk" });
  assert.equal(result.brandPrice.status, "ready");
  assert.equal(result.shapeSales.status, "insufficient");
});

test('optional annual columns never become zero-share price structure evidence',()=>{
 const source=structuredClone(report);source.products[0].sales.y2025=null;
 const result=buildReferenceConclusions(source,{A:'Desk',B:'Floor'});
 assert.equal(result.shapeSales.status,'ready','2025 is not used by the original shape entry rule');
 assert.equal(result.shapePrice.status,'ready');
 if(result.shapePrice.status==='ready'){
   assert.ok(JSON.stringify(result.shapePrice.result).includes('"y2025":null'));
 }
 source.products[0].sales.y2024=null;
 assert.equal(buildReferenceConclusions(source,{}).shapeSales.status,'insufficient','2024 is required for long trend');
 assert.equal(buildReferenceConclusions(source,{}).synthesis.status,'ready');
});

test("uncertain 1970 launch does not yield an unsupported listing-age conclusion", () => {
  const uncertain: SorftimeCategoryDashboardReport = { ...report, products: [{ ...report.products[0], onlineDate: "1970-01-01" }] };
  const result = buildReferenceConclusions(uncertain, {});
  assert.equal(result.listingYear.status, "insufficient");
  if (result.listingYear.status === "insufficient") assert.match(result.listingYear.reason, /日期待核实/);
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
 assert.equal(conflictResult.synthesis.status,'ready','annual conflict does not alter recent-only synthesis');
 assert.equal(conflictResult.shapeSales.status,'insufficient');
 for(const date of ['2026-08-99','2026-08-foo','2026-02-30'])assert.equal(buildReferenceConclusions({...recent,products:[{...recent.products[0],onlineDate:date}]},{A:'Desk'}).synthesis.status,'insufficient');
});

test("missing margin is excluded from observed margin evidence", () => {
  const noMargin: SorftimeCategoryDashboardReport = {
    ...report,
    products: report.products.map(p => ({ ...p, grossProfitMargin: null })),
  };
  const result = buildReferenceConclusions(noMargin, { A: "Desk", B: "Floor" });
  assert.equal(result.margin.status, "insufficient");
  assert.equal(result.synthesis.status, "insufficient");
});

test('current synthesis guards missing date but keeps partial price and margin evidence visible', () => {
  for (const patch of [{onlineDate:null},{price:null,priceBand:'—'},{grossProfitMargin:null}]) {
    const source = structuredClone(report); Object.assign(source.products[0],patch);
    const synthesis = buildReferenceConclusions(source,{}).synthesis;
    if (patch.onlineDate === null) assert.equal(synthesis.status,'insufficient',JSON.stringify(patch));
    else {
      assert.equal(synthesis.status,'ready',JSON.stringify(patch));
      assert.match((synthesis.warnings ?? []).join(' '), patch.price === null ? /缺少价格及价格带/ : /缺少毛利润率/);
    }
  }
  const partial=structuredClone(report);partial.products[0].grossProfitMargin=null;
  assert.equal(buildReferenceConclusions(partial,{}).margin.status,'ready','original margin analyzer explains observed subset');
  const legacy=structuredClone(partial);legacy.calculationVersion='shape-known-coverage/2';
  assert.equal(buildReferenceConclusions(legacy,{}).synthesis.status,'ready','saved old semantics');
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

test('legacy annual date interpretation keeps a saved missing-year conclusion unavailable',()=>{
 const source=structuredClone(report);source.calculationVersion='shape-reference/1';source.products=source.products.slice(0,1);source.products[0].onlineDate='2026/01/01';source.products[0].sales.y2024=null;source.products[0].sales.y2025=null;
 const result=buildReferenceConclusions(source,{});assert.equal(result.synthesis.status,'insufficient');assert.equal(result.brandPrice.status,'insufficient');
});

test('restored original detail panels and embedded confidence remain visible', () => {
  const result = buildReferenceConclusions(report, {});
  assert.equal(result.brandPrice.status, 'ready');
  if(result.brandPrice.status !== 'ready') return;
  const html = renderToStaticMarkup(createElement(ReferenceBrandPriceConclusion, {result:result.brandPrice.result, embedded:true}));
  assert.match(html, /TOP 10 品牌布局/);
  assert.match(html, /置信度/);
  assert.match(html, /Brand A/);
});


test('margin guidance and embedded final confidence are restored without mutating rule results',()=>{
 const result=buildReferenceConclusions(report,{});
 if(result.margin.status!=='ready'||result.synthesis.status!=='ready') return assert.fail('fixture must produce complete conclusions');
 const before=JSON.stringify(result);
 const marginHtml=renderToStaticMarkup(createElement(ReferenceMarginConclusion,{result:result.margin.result}));
 assert.match(marginHtml,/market-structure-margin-shape-card/);
 assert.match(marginHtml,/Desk/);assert.match(marginHtml,/Floor/);assert.match(marginHtml,/形态内销量占比/);
 const html=renderToStaticMarkup(createElement(ReferenceSynthesisConclusion,{result:result.synthesis.result,embedded:true}));
 assert.match(html,/五维结构综合 · 置信度/);
 assert.match(html,/优先\/建议进入销量占比/);
 assert.match(html,/market-structure-margin-shape-tiers-merged/);
 assert.equal(JSON.stringify(result),before);
});


test('original final layout analyzes dimensions independently and keeps partial scores unknown',async()=>{
 const {buildReferenceSynthesisPresentation}=await import('../../app/market-shape-reference/conclusions/synthesis-presentation');
 const source=structuredClone(report);source.products[0].onlineDate='';
 const result=buildReferenceSynthesisPresentation(source,{},undefined);
 const age=result.moduleSections.find(s=>s.key==='newProductEntry')!;
 const margin=result.moduleSections.find(s=>s.key==='marginMarketAccess')!;
 assert.equal(age.coverage!.known,1);assert.equal(age.score,null);
 assert.equal(margin.coverage!.known,2);assert.notEqual(margin.score,null);
 assert.ok(margin.marginAccessDetail);assert.equal(result.score,null);
 source.products[0].onlineDate='2024-01-01';source.products[0].grossProfitMargin=null;
 const next=buildReferenceSynthesisPresentation(source,{});
 assert.notEqual(next.moduleSections.find(s=>s.key==='newProductEntry')!.score,null);
 assert.equal(next.moduleSections.find(s=>s.key==='marginMarketAccess')!.score,null);
 const html=renderToStaticMarkup(createElement(ReferenceSynthesisConclusion,{result:next,embedded:true}));
 for(const title of ['新品准入机会','价格带分布 · 形态分化','市场准入 · 形态×价格带','商品形态方向切入','品牌 · 商品形态 · 价格带布局方向','机会方向','主要风险'])assert.ok(html.includes(title));
 assert.doesNotMatch(html,/阶段总结|NaN|undefined/);assert.match(html,/总分暂不可计算/);
});

test('complete final presentation agrees with original scores and empty samples never score',async()=>{
 const {buildReferenceSynthesisPresentation}=await import('../../app/market-shape-reference/conclusions/synthesis-presentation');
 const expected=buildReferenceConclusions(report,{}).synthesis;
 assert.equal(expected.status,'ready');if(expected.status!=='ready')return;
 const complete=buildReferenceSynthesisPresentation(report,{});
 assert.equal(complete.score,expected.result.score);
 assert.deepEqual(complete.moduleSections.map(s=>[s.key,s.score,s.text]),expected.result.moduleSections.map(s=>[s.key,s.score,s.text]));
 const none=buildReferenceSynthesisPresentation(report,{},[]);
 assert.equal(none.score,null);assert.ok(none.moduleSections.every(s=>s.score===null&&s.coverage!.known===0));
 const source=structuredClone(report);source.products.forEach(p=>{p.sales.last6Months=null;});
 const before=JSON.stringify(source);const missing=buildReferenceSynthesisPresentation(source,{});
 assert.ok(missing.moduleSections.every(s=>s.score===null));assert.equal(JSON.stringify(source),before);
 source.products.forEach(p=>p.sales.last6Months=0);
 assert.equal(buildReferenceSynthesisPresentation(source,{}).score,null);
});

test('missing shapes are not a fake assigned group and do not block independent margin analysis',async()=>{
 const {buildReferenceSynthesisPresentation}=await import('../../app/market-shape-reference/conclusions/synthesis-presentation');
 const source=structuredClone(report);source.products.forEach(p=>p.productShape='未分类');
 const result=buildReferenceSynthesisPresentation(source,{});
 assert.equal(result.moduleSections.find(s=>s.key==='productShapeDirection')!.coverage!.known,0);
 assert.equal(result.moduleSections.find(s=>s.key==='shapePriceDistribution')!.score,null);
 assert.equal(result.moduleSections.find(s=>s.key==='marginMarketAccess')!.coverage!.known,2);
 assert.equal(result.score,null);
});


test('other original summaries reuse valid evidence with an explicit scope instead of all-or-nothing blocking',async()=>{
 const {buildAvailableReferenceConclusions}=await import('../../app/market-shape-reference/conclusions/available-conclusions');
 const source=structuredClone(report);source.products[0].sales.last6Months=null;
 const next=buildAvailableReferenceConclusions(source,{});
 for(const key of ['margin','listingYear','brandPrice','shapePrice'] as const){
  const slot=next[key];assert.equal(slot.status,'ready',key);if(slot.status!=='ready')continue;
  assert.equal(slot.scope?.included,1);assert.equal(slot.scope?.total,2);assert.deepEqual(slot.scope?.excludedAsins,['A']);
 }
 assert.equal(buildReferenceConclusions(source,{}).margin.status,'insufficient');
});


test('missing three-month trend does not hide six-month dimension text or fabricate a total',async()=>{
 const {buildReferenceSynthesisPresentation}=await import('../../app/market-shape-reference/conclusions/synthesis-presentation');
 const source=structuredClone(report);source.products[0].sales.last3Months=null;
 const result=buildReferenceSynthesisPresentation(source,{});
 assert.equal(result.score,null);assert.ok(result.moduleSections.every(s=>s.coverage!.known===2));
 assert.ok(result.risks.some(r=>r.includes('近3个月销量')&&r.includes('A')));
 const subset=buildReferenceSynthesisPresentation(report,{},['B']);assert.equal(subset.highlights.top3ListingSharePct,null);
});

test('shape summary restores rising and declining groups',()=>{
 const result=buildReferenceConclusions(report,{}).shapeSales;
 if(result.status!=='ready')return assert.fail('fixture must be ready');
 const html=renderToStaticMarkup(createElement(ReferenceConclusionsView,{result:buildReferenceConclusions(report,{})}));
 assert.match(html,/近6个月销量占比/);assert.match(html,/上升趋势/);assert.match(html,/下滑趋势/);
});

test('unclassified products retain their known sales in shape denominators',async()=>{
 const {buildReferenceSynthesisPresentation}=await import('../../app/market-shape-reference/conclusions/synthesis-presentation');
 const {buildAvailableReferenceConclusions}=await import('../../app/market-shape-reference/conclusions/available-conclusions');
 const source=structuredClone(report);source.products[1].productShape='未分类';
 const presentation=buildReferenceSynthesisPresentation(source,{});
 const direction=presentation.moduleSections.find(s=>s.key==='productShapeDirection')!;
 assert.equal(direction.coverage!.known,1);
 assert.equal(direction.coverage!.sales,1800);
 assert.match(direction.text,/33\.3%/);assert.doesNotMatch(direction.text,/100\.0%/);
 const shape=buildAvailableReferenceConclusions(source,{}).shapeSales;
 assert.equal(shape.status,'ready');if(shape.status==='ready')assert.ok(Math.abs(shape.result.insights[0].last6MonthsSharePct!-100/3)<0.1);
});
