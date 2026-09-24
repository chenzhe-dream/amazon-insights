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
