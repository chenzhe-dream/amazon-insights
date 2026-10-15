import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketShapeReferenceView, type SorftimeCategoryDashboardReport } from "../../app/market-shape-reference/view";
import { buildReferenceShapeAnalysis } from "../../app/market-shape-reference/rules";
import { buildReferenceConclusions } from "../../app/market-shape-reference/conclusions";

const report: SorftimeCategoryDashboardReport = {
  marketplace: "US", sorftimeSite: "US", nodeId: "123", categoryName: "Desk lamps", fetchedAt: "2026-09-24T00:00:00.000Z",
  note: "当前销量与金额为最近30天，截至 2026-09-24；历史为实际日历月。",
  stats: { top100MonthlyVolume: 200, top100MonthlyAmount: 4000, top3ProductSharePct: 25, top3BrandSharePct: null, top3SellerSharePct: null, amazonOwnedSharePct: null, averagePrice: 20, medianPrice: 20, returnRatePct: null },
  history: { volume: [], avgPrice: [], amount: [], listingMonopoly: [], brandMonopoly: [], sellerMonopoly: [] },
  products: [{ rank: 1, asin: "B000000001", title: "Desk lamp", brand: "Acme", imageUrl: "", monthlySalesVolume: 200, monthlySalesAmount: 4000,
    sales: { last3Months: 600, last6Months: 1100, y2024: 1800, y2025: 1900, monthsAvailable: 24 },
    monthlyTrend: { volume: [{ month: "2026-08", value: 200 }], amount: [{ month: "2026-08", value: 4000 }] },
    price: 20, categoryRank: "", productCategory: "Desk lamps", productShape: "", productShapeHint: null, bsrRank: 1,
    deliveryType: "FBA", reviewCount: 10, starRating: 4.5, seller: "Acme", sellerOrigin: null, onlineDate: "2024-01-01", grossProfitMargin: 65, priceBand: "$20-30" }],
  productSalesTotals: { last3Months: 600, last6Months: 1100, y2024: 1800, y2025: 1900, monthsAvailable: 24 }, topLinkCount: 100,
};

test('existing coverage disclosure separates supplied margins from price conflicts',()=>{
  const value=structuredClone(report);
  value.products[0].marginSource={basis:'detail',note:'Sorftime 商品详情毛利润率；同ASIN、同售价 20'};
  value.products.push({...structuredClone(value.products[0]),asin:'B000000002',grossProfitMargin:null,marginSource:{basis:'price-mismatch',note:'详情售价与商品池售价不同，未混用毛利润率'}});
  const html=renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={value.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}}/>);
  assert.match(html,/毛利润率：可用1\/2件，商品详情补充1件，待核实1件/);
  assert.match(html,/B000000002：详情售价与商品池售价不同/);
  assert.match(html,/title="Sorftime 商品详情毛利润率；同ASIN、同售价 20"/);
});

test('partial table totals disclose known sums and never average only observed links', () => {
  const value = structuredClone(report);
  value.products[0].sales.last6Months = 600;
  value.products.push({...structuredClone(value.products[0]), asin:'B000000002', sales:{...value.products[0].sales,last6Months:null}});
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={value.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}} />);
  assert.match(html, /单链月均按全部链接计算/);
  const totals = [...html.matchAll(/<tr class="shape-price-total-row">(.*?)<\/tr>/g)].map(match=>match[1]);
  assert.ok(totals.length >= 3);
  assert.ok(totals.every(row=>row.includes('已知 600')));
  assert.ok(totals.filter(row=>row.includes('合计')).every(row=>/<td>2<\/td><td[^>]*>未知<\/td><td>—<\/td>/.test(row)));
});

test('product table exposes only batch checkboxes and retains excluded sample recovery', () => {
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{B000000001:'折叠款'}} selectedAsins={[]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.doesNotMatch(html, /aria-label="选择 B000000001"/);
  assert.match(html, /aria-label="批量选择 B000000001"/);
  assert.match(html, /恢复/);
  assert.match(html, /折叠款/);
  assert.match(html, /shape-ref-trend-mini/);
  assert.doesNotMatch(html, /shape-ref-trend-values/);
});

test("summary status distinguishes computed conclusions from missing evidence", () => {
  const render = (value: SorftimeCategoryDashboardReport) => renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  const knownShape = structuredClone(report); knownShape.products[0].productShape="Desk";
  const complete = render(knownShape);
  assert.match(complete, /原版五维结论/);
  assert.doesNotMatch(complete, /规则草稿/);
  const missing = structuredClone(knownShape);
  missing.products[0].sales.y2024 = null;
  const partial = render(missing);
  assert.match(partial, /原版五维结论/);
  assert.match(partial, /B000000001 缺少 2024 销量/);

});

test("summary keeps a usable conclusion when one product lacks price evidence and shows the warning", () => {
  const missingPrice = structuredClone(report);
  missingPrice.products[0].price = null;
  missingPrice.products[0].priceBand = "—";
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={missingPrice} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.match(html, /总分暂不可计算/);
  assert.match(html, /本维缺失项/);
  assert.match(html, /价格及价格带/);
  assert.match(html, /价格\/价格带：可用0\/1件，待补1件/);
  assert.doesNotMatch(html, /综合判断尚缺数据/);
});

test("non-positive source price is shown as unknown instead of a real zero price", () => {
  const invalidPrice = structuredClone(report);
  invalidPrice.products[0].price = null;
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={invalidPrice} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.match(html, />未知<\/td>/);
  assert.match(html, /价格\/价格带：可用0\/1件，待补1件/);
});

test("unknown data summary explains persisted source gaps without treating them as zero", () => {
  const value = structuredClone(report);
  value.products[0].monthlySalesVolume = null;
  value.products[0].monthlySalesAmount = null;
  value.products[0].price = null;
  value.products[0].grossProfitMargin = null;
  value.products[0].sales.last6Months = null;
  value.products[0].salesHistory = { status: "failed", errorCode: "upstream-temporary" };
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.match(html, /未知数据原因（/);
  assert.match(html, /商品池未返回有效正数价格/);
  assert.match(html, /近6个月历史销量：1 条<\/strong> · 历史销量请求失败（上游暂不可用）/);
  assert.match(html, /缺失不会补成 0，也不代表连接失败/);
});

test("margin cards keep missing margins unknown and explain both denominators", () => {
  const value = structuredClone(report);
  value.products.push({ ...structuredClone(value.products[0]), asin: "B000000002", grossProfitMargin: null });
  const before = JSON.stringify(value);
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={value.products.map(p => p.asin)} onAssignment={() => {}} onSelected={() => {}} />);
  assert.match(html, /毛利标签占比按有毛利数据的链接计算/);
  assert.match(html, /缺失占比按全部所选链接计算/);
  assert.match(html, /100%/);
  assert.match(html, /50%/);
  assert.match(html, /不含采购、头程、广告/);
  assert.doesNotMatch(html, /有效链接平均毛利润率/);
  assert.equal(JSON.stringify(value), before);
});

test("reference view renders the seven original regions from supplied evidence", () => {
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{ B000000001: "折叠款" }} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  for (const heading of ["类目销量看板", "TOP 销售商品", "上架年份", "商品形态 · 销量占比", "商品形态 · 价格带", "品牌 · 价格带", "类目商品链接调研 · 最终结论"]) assert.ok(html.includes(heading), heading);
  assert.ok(html.includes("折叠款"));
  assert.ok(html.includes("建议进入"));
  assert.ok(html.includes("最近30天"));
  assert.ok(html.includes("$20-30"));
  assert.ok(html.includes("2026-08"));
  assert.ok(html.includes("4,000"));
  assert.ok(html.includes("调整product列宽"));
  assert.ok(html.includes("月销售额估算"));
});

test("pool control describes current capacity and cache reuse", () => {
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{}} selectedAsins={[]} onAssignment={() => {}} onSelected={() => {}} requestedPoolSize={200} onPoolSizeChange={() => {}} />);
  assert.match(html, /当前报告商品池容量（优先复用缓存）/);
  assert.match(html, /aria-label="当前报告商品池采集上限"/);
  assert.match(html, /<option value="150">150<\/option>/);
  assert.match(html, /<option value="200"[^>]*>200<\/option>/);
  assert.match(html, /<option value="300">300<\/option>/);
});

test("missing current and historical values remain unknown", () => {
  const missing = structuredClone(report);
  missing.products[0].monthlySalesVolume = null as never;
  missing.products[0].sales.last6Months = null as never;
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={missing} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.ok(html.includes("未知"));
  assert.ok(!html.includes("近6个月历史销量 0"));
});

test("manual assignment and selection change the same render without saved state", () => {
  const initial = renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{}} selectedAsins={[]} onAssignment={() => {}} onSelected={() => {}} />);
  const updated = renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{ B000000001: "折叠款" }} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.ok(initial.includes("已选 0"));
  assert.ok(updated.includes("已选 1"));
  assert.ok(updated.includes("折叠款"));
  assert.ok(!initial.includes("折叠款"));
});

test("amount history stays visible when volume history is unavailable", () => {
  const amountOnly = structuredClone(report);
  amountOnly.products[0].monthlyTrend.volume = [];
  const html = renderToStaticMarkup(<MarketShapeReferenceView report={amountOnly} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  assert.ok(html.includes('2026-08：销量 未知；销售额 4,000'));
  assert.ok(html.includes('销量 未知'));assert.ok(html.includes('销售额 4,000'));
});

test('single-month history displays values without pretending to be a trend',()=>{
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{}} selectedAsins={['B000000001']} onAssignment={()=>{}} onSelected={()=>{}}/>);
 assert.match(html,/单月数据，暂无法判断趋势/);
 assert.doesNotMatch(html,/class="shape-ref-trend-pair"/);
 assert.match(html,/2026-08/);assert.match(html,/4,000/);
 const multiple=structuredClone(report);multiple.products[0].monthlyTrend.volume.unshift({month:'2026-07',value:100});
 const multiHtml=renderToStaticMarkup(<MarketShapeReferenceView report={multiple} assignments={{}} selectedAsins={['B000000001']} onAssignment={()=>{}} onSelected={()=>{}}/>);
 assert.match(multiHtml,/class="shape-ref-trend-mini"/);
});

test('observed zero keeps a visible preview mark while wholly missing data stays unknown',()=>{
 const value=structuredClone(report);value.products[0].monthlyTrend={volume:[{month:'2026-08',value:0}],amount:[]};
 const render=()=>renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={['B000000001']} onAssignment={()=>{}} onSelected={()=>{}}/>);
 const zero=render();assert.match(zero,/2026-08：销量 0；销售额 未知/);assert.match(zero,/width="4" height="1"/);
 value.products[0].monthlyTrend.volume[0].value=null;
 const missing=render();assert.match(missing,/月度销量与销售额均缺失/);assert.doesNotMatch(missing,/class="shape-ref-trend-mini"/);
});

test('original business tables show metrics and keep coverage in tooltips or collapsed details',()=>{
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={report} assignments={{}} selectedAsins={['B000000001']} onAssignment={()=>{}} onSelected={()=>{}}/>);
 const tables=html.match(/<table[^>]*shape-price-table[\s\S]*?<\/table>/g)??[];
 assert.equal(tables.length,5); // Four original aggregates plus the restored TOP 10 brand layout.
 for(const table of tables)assert.doesNotMatch(table.replace(/<[^>]*>/g,''),/可计算/);
 assert.match(html,/<details class="shape-history-coverage"/);
});

test('known aggregate coverage, original editing tools and missing year average column are visible',()=>{
 const value=structuredClone(report);value.calculationVersion='shape-known-coverage/2';
 value.products.push({...structuredClone(value.products[0]),asin:'B000000002',sales:{last3Months:null,last6Months:null,y2024:null,y2025:null,monthsAvailable:0}});
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{B000000001:'灯 · 层架',B000000002:'灯'}} selectedAsins={value.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}}/>);
 assert.match(html,/已知销量内占比/);assert.match(html,/可计算 1\/2/);assert.match(html,/批量清除形态/);assert.match(html,/管理形态名称/);assert.match(html,/形态价格带局部筛选/);
 assert.equal((html.match(/aria-label="2025年单链月均排序"/g)??[]).length,4);
});

test('fixed scooter names keep an old label visible without allowing new arbitrary labels',()=>{
 const value=structuredClone(report);value.categoryName='Kick Scooters';
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{B000000001:'旧分类'}} selectedAsins={['B000000001']} onAssignment={()=>{}} onSelected={()=>{}}/>);
 assert.match(html,/<select[^>]*aria-label="B000000001 人工形态"/);assert.match(html,/三轮滑板车/);assert.match(html,/旧标签待确认：旧分类/);
});

test('fixed-shape legacy labels remain visible but do not enter shape statistics',()=>{
 const value=structuredClone(report);value.categoryName='Kick Scooters';
 const assignments={B000000001:'旧分类'};
 const allowed=['三轮滑板车','小两轮滑板车','大两轮滑板车'];
 const analysis=buildReferenceShapeAnalysis(value,assignments,['B000000001'],allowed);
 assert.equal(analysis.shapes[0]?.label,'未分类');
 const conclusions=buildReferenceConclusions(value,assignments,['B000000001'],allowed);
 assert.doesNotMatch(JSON.stringify(conclusions),/旧分类/);
});


test('missing history still renders a factual summary without a full score and lists every affected product',()=>{
 const value=structuredClone(report);
 value.products[0].sales.last6Months=null;
 value.products.push({...structuredClone(value.products[0]),asin:'B000000002',sales:{...value.products[0].sales,last3Months:null}});
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={value.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}}/>);
 const summary=html.slice(html.indexOf('id="market-structure-synthesis-conclusion"'));
 assert.doesNotMatch(summary,/阶段总结/);
 assert.match(summary,/新品准入机会/);assert.match(summary,/机会方向/);assert.match(summary,/主要风险/);
 assert.match(summary,/所选 2 条商品保留在报告中/);
 assert.match(summary,/有效样本 0\/2 条/);assert.match(summary,/本维近6个月已知销量 未知/);
 assert.match(summary,/B000000001/);assert.match(summary,/B000000002/);
 assert.match(summary,/近6个月销量/);
 assert.doesNotMatch(summary,/\d+\/100/);
});
