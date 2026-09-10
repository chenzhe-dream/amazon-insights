import { sorftimeSalesTrendData } from "../../sorftime-sales-trend-data";
import { type Product } from "../catalog/product-contracts";

export const colors = ["#2F80ED", "#7A67D8", "#29A7C7", "#F0A020", "#E65B6A", "#26A269", "#D45D9E", "#6C86B6", "#D26A3A", "#18A0A8"];

export type ChartMetric = "history" | "prices" | "ranks" | "revenue";

export function formatTrendMonthLabel(month: string, showYear = false) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  const monthNum = Number(match[2]);
  if (showYear) return `${match[1].slice(2)}/${monthNum}月`;
  return `${monthNum}月`;
}

export function formatTrendMonthTitle(month: string) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}

export function sorftimeMetricKey(metric: ChartMetric): "volume" | "amount" | "price" | "rank" {
  if (metric === "history") return "volume";
  if (metric === "revenue") return "amount";
  if (metric === "prices") return "price";
  return "rank";
}

export function isValidTrendValue(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value >= 0;
}

export function collectChartMonthKeys(products: Product[], field: ReturnType<typeof sorftimeMetricKey>, trendByAsin: typeof sorftimeSalesTrendData) {
  const months = new Set<string>();
  for (const product of products) {
    for (const point of trendByAsin[product.asin]?.[field] ?? []) {
      if (isValidTrendValue(point.value)) months.add(point.month);
    }
  }
  return [...months].sort().slice(-12);
}
