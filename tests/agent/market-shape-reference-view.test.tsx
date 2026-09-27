import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketShapeReferenceView, type SorftimeCategoryDashboardReport } from "../../app/market-shape-reference/view";

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

test("summary status distinguishes computed conclusions from missing evidence", () => {
  const render = (value: SorftimeCategoryDashboardReport) => renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{}} selectedAsins={["B000000001"]} onAssignment={() => {}} onSelected={() => {}} />);
  const complete = render(report);
  assert.match(complete, /规则结论已生成/);
  assert.doesNotMatch(complete, /规则草稿/);
  const missing = structuredClone(report);
  missing.products[0].sales.y2024 = null;
  const partial = render(missing);
  assert.match(partial, /综合结论待补数据/);
  assert.match(partial, /B000000001 缺少 2024 销量/);
  assert.doesNotMatch(partial, /规则结论已生成/);
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
  for (const heading of ["类目销量看板", "TOP 销售商品", "上架年份", "商品形态 · 销量占比", "商品形态 · 价格带", "品牌 · 价格带", "市场结构综合结论"]) assert.ok(html.includes(heading), heading);
  assert.ok(html.includes("折叠款"));
  assert.ok(html.includes("建议进入"));
  assert.ok(html.includes("最近30天"));
  assert.ok(html.includes("$20-30"));
  assert.ok(html.includes("2026-08"));
  assert.ok(html.includes("4,000"));
  assert.ok(html.includes("调整product列宽"));
  assert.ok(html.includes("月销售额估算"));
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
  assert.ok(html.includes('2026-08　未知 / 4,000'));
});

test('known aggregate coverage, original editing tools and missing year average column are visible',()=>{
 const value=structuredClone(report);value.calculationVersion='shape-known-coverage/2';
 value.products.push({...structuredClone(value.products[0]),asin:'B000000002',sales:{last3Months:null,last6Months:null,y2024:null,y2025:null,monthsAvailable:0}});
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{B000000001:'灯 · 层架',B000000002:'灯'}} selectedAsins={value.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}}/>);
 assert.match(html,/已知销量内占比/);assert.match(html,/可计算 1\/2/);assert.match(html,/批量清除形态/);assert.match(html,/管理形态名称/);assert.match(html,/形态价格带局部筛选/);
 assert.equal((html.match(/2025年单链月均/g)??[]).length,4);
});

test('fixed scooter names keep an old label visible without allowing new arbitrary labels',()=>{
 const value=structuredClone(report);value.categoryName='Kick Scooters';
 const html=renderToStaticMarkup(<MarketShapeReferenceView report={value} assignments={{B000000001:'旧分类'}} selectedAsins={['B000000001']} onAssignment={()=>{}} onSelected={()=>{}}/>);
 assert.match(html,/<select[^>]*aria-label="B000000001 人工形态"/);assert.match(html,/三轮滑板车/);assert.match(html,/旧标签待确认：旧分类/);
});
