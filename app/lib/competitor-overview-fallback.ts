import type { SorftimeSalesTrendRecord } from "../sorftime-sales-trend-data";

type TrendField = "price" | "rank";
type OverviewSource = "sellerSprite" | "sorftime" | null;

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

export function latestReadyTrendValue(
  record: SorftimeSalesTrendRecord | undefined,
  field: TrendField,
): number | null {
  if (record?.status !== "ready") return null;

  for (let index = record[field].length - 1; index >= 0; index -= 1) {
    const value = record[field][index]?.value;
    if (isFiniteNonNegative(value)) return value;
  }

  return null;
}

export function resolveOverviewPrice(
  productPrice: number | null,
  trendRecord: SorftimeSalesTrendRecord | undefined,
): { value: number | null; source: OverviewSource } {
  if (isFiniteNonNegative(productPrice)) return { value: productPrice, source: "sellerSprite" };

  const value = latestReadyTrendValue(trendRecord, "price");
  return value === null ? { value: null, source: null } : { value, source: "sorftime" };
}

export function resolveOverviewRank(
  productRank: number | null,
  _productSubRank: number | null,
  trendRecord: SorftimeSalesTrendRecord | undefined,
): { value: number | null; source: OverviewSource } {
  if (isFiniteNonNegative(productRank)) {
    return { value: productRank, source: "sellerSprite" };
  }

  const value = latestReadyTrendValue(trendRecord, "rank");
  return value === null ? { value: null, source: null } : { value, source: "sorftime" };
}
