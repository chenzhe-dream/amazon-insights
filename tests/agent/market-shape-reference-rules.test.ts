import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReferenceShapeAnalysis,
  formatPriceBand,
  resolveSorftimeMarginEntryLabel,
  resolveY2025MonthDivisor,
} from "../../app/market-shape-reference/rules";
import type { SorftimeCategoryDashboardReport } from "../../app/market-shape-reference/types";

const product = (asin: string, price: number | null, sales: number | null, margin: number | null) => ({
  rank: Number(asin.slice(-1)), asin, title: asin, brand: "Brand A", imageUrl: "",
  monthlySalesVolume: 10, monthlySalesAmount: 100, price, priceBand: "",
  categoryRank: "", productCategory: "", productShape: "—", productShapeHint: null,
  bsrRank: null, deliveryType: "", reviewCount: 0, starRating: null,
  seller: "", sellerOrigin: null, onlineDate: "2025-07-01", grossProfitMargin: margin,
  sales: { last3Months: sales, last6Months: sales, y2024: null, y2025: sales, monthsAvailable: sales == null ? 0 : 1 },
  monthlyTrend: { volume: [], amount: [] },
});

const report = (): SorftimeCategoryDashboardReport => ({
  marketplace: "US", sorftimeSite: "US", nodeId: "1", categoryName: "Test",
  fetchedAt: "2025-09-24T00:00:00Z", note: "", topLinkCount: 2,
  stats: { top100MonthlyVolume: null, top100MonthlyAmount: null, top3ProductSharePct: null,
    top3BrandSharePct: null, top3SellerSharePct: null, amazonOwnedSharePct: null,
    averagePrice: null, medianPrice: null, returnRatePct: null },
  history: { volume: [], amount: [], avgPrice: [], listingMonopoly: [], brandMonopoly: [], sellerMonopoly: [] },
  products: [product("A1", 19.99, 90, 70), product("A2", 20, null, null)],
  productSalesTotals: { last3Months: null, last6Months: null, y2024: null, y2025: null, monthsAvailable: 1 },
});

test("ten-dollar bands use the source lower-inclusive boundaries", () => {
  assert.equal(formatPriceBand(19.99), "$10-20");
  assert.equal(formatPriceBand(20), "$20-30");
  assert.equal(formatPriceBand(null), "—");
});

test("margin labels follow 50, 60 and 70 percent thresholds without coercing null", () => {
  assert.equal(resolveSorftimeMarginEntryLabel(null).label, "—");
  assert.equal(resolveSorftimeMarginEntryLabel(49.99).label, "不建议进入");
  assert.equal(resolveSorftimeMarginEntryLabel(50).label, "谨慎进入");
  assert.equal(resolveSorftimeMarginEntryLabel(60).label, "建议进入");
  assert.equal(resolveSorftimeMarginEntryLabel(70).label, "优先进入");
});

test("2025 monthly divisor follows the source report date", () => {
  assert.equal(resolveY2025MonthDivisor("2025-09-24"), 9);
  assert.equal(resolveY2025MonthDivisor("2026-01-01"), 12);
});

test("unknown sales remain unknown through groups, shares and summary", () => {
  const result = buildReferenceShapeAnalysis(report(), { A1: "Shape A", A2: "Shape A" });
  assert.equal(result.shapes[0].sales.last6Months, null);
  assert.equal(result.shapes[0].sharePct.last6Months, null);
  assert.equal(result.shapePriceBands.length, 2);
  assert.equal(result.shapePriceBands[0].sales.last6Months, 90);
  assert.equal(result.shapePriceBands[1].sales.last6Months, null);
  assert.equal(result.synthesis.totalSales.last6Months, null);
  assert.equal(result.synthesis.marginCounts["—"], 1);
});

test("selected products set the denominator and observed zero remains zero", () => {
  const source = report();
  source.products[1].sales.last6Months = 0;
  const selected = buildReferenceShapeAnalysis(source, { A1: "Shape A", A2: "Shape B" }, ["A2"]);
  assert.equal(selected.products.length, 1);
  assert.equal(selected.synthesis.totalSales.last6Months, 0);
  assert.equal(selected.shapes[0].sales.last6Months, 0);
  assert.equal(selected.shapes[0].sharePct.last6Months, null);
  assert.equal(selected.synthesis.marginCounts["优先进入"], 0);
});

test("shape price-band shares use their own shape and numeric band order", () => {
  const source = report();
  source.products = [
    { ...product("A1", 25, 30, 65), brand: "Brand A" },
    { ...product("A2", 105, 70, 65), brand: "Brand A" },
    { ...product("A3", 35, 100, 65), brand: "Brand B" },
  ];
  const result = buildReferenceShapeAnalysis(source, { A1: "Shape A", A2: "Shape A", A3: "Shape B" });
  assert.deepEqual(result.shapePriceBands.map(row => row.label), ["Shape A · $20-30", "Shape A · $100-110", "Shape B · $30-40"]);
  assert.equal(result.shapePriceBands[0].sharePct.last6Months, 30);
  assert.equal(result.shapePriceBands[1].sharePct.last6Months, 70);
  assert.equal(result.shapePriceBands[2].sharePct.last6Months, 100);
});
