/** SIF MCP · ops_get_asin_traffic_trend · Listing 聚合 · 近6个月父ASIN自然/广告流量 */

import { sifMonthlyTrafficRawByAsin, sifMonthlyTrafficRawMeta } from "./sif-monthly-traffic-trend-raw-data";

export type MonthlyTrafficPoint = {
  month: string;
  label: string;
  natural: number;
  ad: number;
  total: number;
};

export type SifMonthlyTrafficSeries = {
  asin: string;
  points: MonthlyTrafficPoint[];
};

function monthLabel(ym: string) {
  const month = Number(ym.slice(5, 7));
  return `${month}月`;
}

function round(value: number) {
  return Math.round(value);
}

function buildSeries(
  asin: string,
  dates: string[],
  nf: Array<{ score: number } | null>,
  ad: Array<{ score: number } | null>,
): SifMonthlyTrafficSeries {
  return {
    asin,
    points: dates.map((date, index) => {
      const natural = round(nf[index]?.score ?? 0);
      const adScore = round(ad[index]?.score ?? 0);
      return {
        month: date,
        label: monthLabel(date),
        natural,
        ad: adScore,
        total: natural + adScore,
      };
    }),
  };
}

export const sifMonthlyTrafficMonths = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"] as const;

export const sifMonthlyTrafficTrend: Record<string, SifMonthlyTrafficSeries> = Object.fromEntries(
  Object.entries(sifMonthlyTrafficRawByAsin).map(([asin, raw]) => [
    asin,
    buildSeries(asin, raw.dates?.length ? raw.dates : [...sifMonthlyTrafficMonths], raw.nf ?? [], raw.ad ?? []),
  ]),
);

export const sifMonthlyTrafficMeta = {
  source: sifMonthlyTrafficRawMeta.source,
  period: sifMonthlyTrafficRawMeta.period,
  country: sifMonthlyTrafficRawMeta.country,
  listingSearch: true,
  updatedThrough: sifMonthlyTrafficRawMeta.updatedThrough,
  months: sifMonthlyTrafficMonths.map(monthLabel),
  naturalColor: "#55BB6A",
  adColor: "#FFB03B",
  note: "父 ASIN Listing 聚合口径；8月为当月未完结数据",
};
