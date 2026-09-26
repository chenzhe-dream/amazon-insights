export type PriceBandInputItem = {
  priceBand: string;
  sales: {
    last3Months: number;
    last6Months: number;
    y2024: number;
    y2025: number;
  };
};

export type PriceBandMetrics = {
  priceBand: string;
  linkCount: number;
  trendMissingLinkCount: number;
  last3Months: number;
  last3MonthsSharePct: number | null;
  last6Months: number;
  last6MonthsSharePct: number | null;
  y2025: number;
  y2025SharePct: number | null;
  y2024: number;
  y2024SharePct: number | null;
  avgLast6MonthsMonthlyPerLink: number;
  avgY2025MonthlyPerLink: number;
};

function pct(part: number, total: number) {
  if (!total) return null;
  return Number(((part / total) * 100).toFixed(2));
}

function priceBandSortKey(band: string) {
  const match = band.match(/(\d+)/);
  return match ? Number(match[1]) : 9999;
}

export function resolveY2025MonthDivisor(fetchedAt?: string, referenceDate = new Date()) {
  const ref = fetchedAt ? new Date(fetchedAt) : referenceDate;
  if (Number.isNaN(ref.getTime())) return 12;
  if (ref.getFullYear() > 2025) return 12;
  if (ref.getFullYear() < 2025) return 1;
  return Math.max(1, ref.getMonth() + 1);
}

function emptyMetrics(priceBand: string): PriceBandMetrics {
  return {
    priceBand,
    linkCount: 0,
    trendMissingLinkCount: 0,
    last3Months: 0,
    last3MonthsSharePct: null,
    last6Months: 0,
    last6MonthsSharePct: null,
    y2025: 0,
    y2025SharePct: null,
    y2024: 0,
    y2024SharePct: null,
    avgLast6MonthsMonthlyPerLink: 0,
    avgY2025MonthlyPerLink: 0,
  };
}

export function buildPriceBandAnalysis(
  items: Array<PriceBandInputItem & { trendMissing?: boolean }>,
  options?: { fetchedAt?: string },
): PriceBandMetrics[] {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const byBand = new Map<string, PriceBandMetrics>();

  for (const item of items) {
    const band = item.priceBand?.trim() || "—";
    const current = byBand.get(band) ?? emptyMetrics(band);
    current.linkCount += 1;
    if (item.trendMissing) current.trendMissingLinkCount += 1;
    current.last3Months += item.sales.last3Months ?? 0;
    current.last6Months += item.sales.last6Months ?? 0;
    current.y2024 += item.sales.y2024 ?? 0;
    current.y2025 += item.sales.y2025 ?? 0;
    byBand.set(band, current);
  }

  const rows = [...byBand.values()].sort(
    (left, right) => priceBandSortKey(left.priceBand) - priceBandSortKey(right.priceBand),
  );

  const totals = rows.reduce(
    (acc, row) => ({
      last3Months: acc.last3Months + row.last3Months,
      last6Months: acc.last6Months + row.last6Months,
      y2024: acc.y2024 + row.y2024,
      y2025: acc.y2025 + row.y2025,
    }),
    { last3Months: 0, last6Months: 0, y2024: 0, y2025: 0 },
  );

  return rows.map(row => ({
    ...row,
    last3MonthsSharePct: pct(row.last3Months, totals.last3Months),
    last6MonthsSharePct: pct(row.last6Months, totals.last6Months),
    y2025SharePct: pct(row.y2025, totals.y2025),
    y2024SharePct: pct(row.y2024, totals.y2024),
    avgLast6MonthsMonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.last6Months / row.linkCount / 6) : 0,
    avgY2025MonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.y2025 / row.linkCount / y2025MonthDivisor) : 0,
  }));
}

export type ListingYearInputItem = {
  listingYear: string;
  onlineDate: string | null;
  sales: PriceBandInputItem["sales"];
  trendMissing?: boolean;
};

export type ListingYearMetrics = Omit<PriceBandMetrics, "priceBand"> & {
  listingYear: string;
};

export type RecentNewProductShare = {
  windowMonths: number;
  cutoffYearMonth: string;
  newProductLinkCount: number;
  newProductLast6MonthsSales: number;
  totalLast6MonthsSales: number;
  sharePct: number | null;
};

function listingYearSortKey(year: string) {
  if (year === "—") return -1;
  const num = Number(year);
  return Number.isFinite(num) ? num : 0;
}

function emptyListingYearMetrics(listingYear: string): ListingYearMetrics {
  const empty = emptyMetrics(listingYear);
  const { priceBand: _priceBand, ...rest } = empty;
  return { listingYear, ...rest };
}

export function buildListingYearAnalysis(
  items: ListingYearInputItem[],
  options?: { fetchedAt?: string },
): ListingYearMetrics[] {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const byYear = new Map<string, ListingYearMetrics>();

  for (const item of items) {
    const year = item.listingYear?.trim() || "—";
    const current = byYear.get(year) ?? emptyListingYearMetrics(year);
    current.linkCount += 1;
    if (item.trendMissing) current.trendMissingLinkCount += 1;
    current.last3Months += item.sales.last3Months ?? 0;
    current.last6Months += item.sales.last6Months ?? 0;
    current.y2024 += item.sales.y2024 ?? 0;
    current.y2025 += item.sales.y2025 ?? 0;
    byYear.set(year, current);
  }

  const rows = [...byYear.values()].sort(
    (left, right) => listingYearSortKey(right.listingYear) - listingYearSortKey(left.listingYear),
  );

  const totals = rows.reduce(
    (acc, row) => ({
      last3Months: acc.last3Months + row.last3Months,
      last6Months: acc.last6Months + row.last6Months,
      y2024: acc.y2024 + row.y2024,
      y2025: acc.y2025 + row.y2025,
    }),
    { last3Months: 0, last6Months: 0, y2024: 0, y2025: 0 },
  );

  return rows.map(row => ({
    ...row,
    last3MonthsSharePct: pct(row.last3Months, totals.last3Months),
    last6MonthsSharePct: pct(row.last6Months, totals.last6Months),
    y2025SharePct: pct(row.y2025, totals.y2025),
    y2024SharePct: pct(row.y2024, totals.y2024),
    avgLast6MonthsMonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.last6Months / row.linkCount / 6) : 0,
    avgY2025MonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.y2025 / row.linkCount / y2025MonthDivisor) : 0,
  }));
}

export function computeRecentNewProductLast6MonthsShare(
  items: ListingYearInputItem[],
  options?: { fetchedAt?: string; windowMonths?: number },
): RecentNewProductShare {
  const windowMonths = options?.windowMonths ?? 6;
  const referenceDate = options?.fetchedAt ? new Date(options.fetchedAt) : new Date();
  const safeReferenceDate = Number.isNaN(referenceDate.getTime()) ? new Date() : referenceDate;
  const cutoff = new Date(safeReferenceDate.getFullYear(), safeReferenceDate.getMonth() - windowMonths, 1);
  const cutoffYearMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;

  let newProductLinkCount = 0;
  let newProductLast6MonthsSales = 0;
  let totalLast6MonthsSales = 0;

  for (const item of items) {
    totalLast6MonthsSales += item.sales.last6Months ?? 0;
    const listed = parseProductOnlineDate(item.onlineDate);
    if (listed && listed >= cutoff) {
      newProductLinkCount += 1;
      newProductLast6MonthsSales += item.sales.last6Months ?? 0;
    }
  }

  return {
    windowMonths,
    cutoffYearMonth,
    newProductLinkCount,
    newProductLast6MonthsSales,
    totalLast6MonthsSales,
    sharePct: pct(newProductLast6MonthsSales, totalLast6MonthsSales),
  };
}

function parseProductOnlineDate(raw: string | null | undefined) {
  if (!raw || raw === "null" || raw === "—") return null;
  const text = String(raw).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
      return new Date(year, month - 1, 1);
    }
  }
  const slashMatch = text.match(/^(\d{4})\/(\d{1,2})/);
  if (slashMatch) {
    const year = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
      return new Date(year, month - 1, 1);
    }
  }
  const ms = Number(text);
  if (Number.isFinite(ms) && ms > 1e11) {
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return new Date(date.getFullYear(), date.getMonth(), 1);
    }
  }
  return null;
}

export type BrandPriceBandInputItem = {
  brand: string;
  priceBand: string;
  sales: PriceBandInputItem["sales"];
  trendMissing?: boolean;
};

export type BrandPriceBandMetrics = Omit<PriceBandMetrics, "priceBand"> & {
  brand: string;
  priceBand: string;
  brandPriceBand: string;
};

export function formatBrandPriceBandLabel(brand: string, priceBand: string) {
  const safeBrand = brand?.trim() || "—";
  const safeBand = priceBand?.trim() || "—";
  return `${safeBrand} -- ${safeBand}`;
}

function emptyBrandPriceBandMetrics(brand: string, priceBand: string, brandPriceBand: string): BrandPriceBandMetrics {
  const empty = emptyMetrics(brandPriceBand);
  const { priceBand: _priceBand, ...rest } = empty;
  return { brand, priceBand, brandPriceBand, ...rest };
}

function brandPriceBandSortKey(left: BrandPriceBandMetrics, right: BrandPriceBandMetrics) {
  const brandCompare = left.brand.localeCompare(right.brand, "zh-CN");
  if (brandCompare !== 0) return brandCompare;
  return priceBandSortKey(left.priceBand) - priceBandSortKey(right.priceBand);
}

export function buildBrandPriceBandAnalysis(
  items: BrandPriceBandInputItem[],
  options?: { fetchedAt?: string },
): BrandPriceBandMetrics[] {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const bySegment = new Map<string, BrandPriceBandMetrics>();

  for (const item of items) {
    const brand = item.brand?.trim() || "—";
    const priceBand = item.priceBand?.trim() || "—";
    const brandPriceBand = formatBrandPriceBandLabel(brand, priceBand);
    const current = bySegment.get(brandPriceBand) ?? emptyBrandPriceBandMetrics(brand, priceBand, brandPriceBand);
    current.linkCount += 1;
    if (item.trendMissing) current.trendMissingLinkCount += 1;
    current.last3Months += item.sales.last3Months ?? 0;
    current.last6Months += item.sales.last6Months ?? 0;
    current.y2024 += item.sales.y2024 ?? 0;
    current.y2025 += item.sales.y2025 ?? 0;
    bySegment.set(brandPriceBand, current);
  }

  const rows = [...bySegment.values()].sort(brandPriceBandSortKey);

  const totals = rows.reduce(
    (acc, row) => ({
      last3Months: acc.last3Months + row.last3Months,
      last6Months: acc.last6Months + row.last6Months,
      y2024: acc.y2024 + row.y2024,
      y2025: acc.y2025 + row.y2025,
    }),
    { last3Months: 0, last6Months: 0, y2024: 0, y2025: 0 },
  );

  return rows.map(row => ({
    ...row,
    last3MonthsSharePct: pct(row.last3Months, totals.last3Months),
    last6MonthsSharePct: pct(row.last6Months, totals.last6Months),
    y2025SharePct: pct(row.y2025, totals.y2025),
    y2024SharePct: pct(row.y2024, totals.y2024),
    avgLast6MonthsMonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.last6Months / row.linkCount / 6) : 0,
    avgY2025MonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.y2025 / row.linkCount / y2025MonthDivisor) : 0,
  }));
}

export function findTopBrandPriceBandByLast6Months(rows: readonly BrandPriceBandMetrics[]) {
  if (!rows.length) return null;
  return rows.reduce((best, row) => (row.last6Months > best.last6Months ? row : best), rows[0]);
}

export type BrandAggregatedMetrics = {
  brand: string;
  linkCount: number;
  last3Months: number;
  last3MonthsSharePct: number | null;
  last6Months: number;
  last6MonthsSharePct: number | null;
  y2025: number;
  y2025SharePct: number | null;
  y2024: number;
  y2024SharePct: number | null;
  avgLast6MonthsMonthlyPerLink: number;
  avgY2025MonthlyPerLink: number;
};

export type BrandPriceBandSortMetric =
  | "brand"
  | "last3Months"
  | "last3MonthsSharePct"
  | "last6Months"
  | "last6MonthsSharePct"
  | "y2025"
  | "y2025SharePct"
  | "y2024"
  | "y2024SharePct"
  | "linkCount"
  | "avgLast6MonthsMonthlyPerLink"
  | "avgY2025MonthlyPerLink";

export function buildBrandAggregatesFromPriceBandRows(
  rows: readonly BrandPriceBandMetrics[],
  options?: { fetchedAt?: string },
): BrandAggregatedMetrics[] {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const byBrand = new Map<
    string,
    {
      brand: string;
      linkCount: number;
      last3Months: number;
      last6Months: number;
      y2025: number;
      y2024: number;
    }
  >();

  for (const row of rows) {
    const brand = row.brand?.trim() || "—";
    const current = byBrand.get(brand) ?? {
      brand,
      linkCount: 0,
      last3Months: 0,
      last6Months: 0,
      y2025: 0,
      y2024: 0,
    };
    current.linkCount += row.linkCount;
    current.last3Months += row.last3Months;
    current.last6Months += row.last6Months;
    current.y2025 += row.y2025;
    current.y2024 += row.y2024;
    byBrand.set(brand, current);
  }

  const aggregates = [...byBrand.values()];
  const totals = aggregates.reduce(
    (acc, row) => ({
      last3Months: acc.last3Months + row.last3Months,
      last6Months: acc.last6Months + row.last6Months,
      y2024: acc.y2024 + row.y2024,
      y2025: acc.y2025 + row.y2025,
    }),
    { last3Months: 0, last6Months: 0, y2024: 0, y2025: 0 },
  );

  return aggregates.map(row => ({
    ...row,
    last3MonthsSharePct: pct(row.last3Months, totals.last3Months),
    last6MonthsSharePct: pct(row.last6Months, totals.last6Months),
    y2025SharePct: pct(row.y2025, totals.y2025),
    y2024SharePct: pct(row.y2024, totals.y2024),
    avgLast6MonthsMonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.last6Months / row.linkCount / 6) : 0,
    avgY2025MonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.y2025 / row.linkCount / y2025MonthDivisor) : 0,
  }));
}

function brandAggregateSortValue(aggregate: BrandAggregatedMetrics, metric: BrandPriceBandSortMetric) {
  if (metric === "brand") return null;
  const value = aggregate[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function compareBrandAlphabetically(left: string, right: string) {
  if (left === "—" && right !== "—") return 1;
  if (right === "—" && left !== "—") return -1;
  return left.localeCompare(right, "en", { sensitivity: "base", numeric: true });
}

export function sortBrandPriceBandRowsByBrandAggregate(
  rows: readonly BrandPriceBandMetrics[],
  brandAggregates: readonly BrandAggregatedMetrics[],
  sort: { metric: BrandPriceBandSortMetric; dir: "asc" | "desc" } | null,
) {
  const effectiveSort = sort ?? { metric: "last6MonthsSharePct" as const, dir: "desc" as const };
  const sign = effectiveSort.dir === "asc" ? 1 : -1;

  if (effectiveSort.metric === "brand") {
    return [...rows].sort((left, right) => {
      const brandCompare = compareBrandAlphabetically(left.brand, right.brand);
      if (brandCompare !== 0) return sign * brandCompare;
      return priceBandSortKey(left.priceBand) - priceBandSortKey(right.priceBand);
    });
  }

  const brandMap = new Map(brandAggregates.map(item => [item.brand, item]));

  return [...rows].sort((left, right) => {
    const leftAggregate = brandMap.get(left.brand);
    const rightAggregate = brandMap.get(right.brand);
    const leftBrandValue = leftAggregate
      ? brandAggregateSortValue(leftAggregate, effectiveSort.metric)
      : -1;
    const rightBrandValue = rightAggregate
      ? brandAggregateSortValue(rightAggregate, effectiveSort.metric)
      : -1;
    if (leftBrandValue !== rightBrandValue) return sign * ((leftBrandValue ?? -1) - (rightBrandValue ?? -1));
    const brandCompare = compareBrandAlphabetically(left.brand, right.brand);
    if (brandCompare !== 0) return brandCompare;
    return priceBandSortKey(left.priceBand) - priceBandSortKey(right.priceBand);
  });
}

export type AggregatedSalesColumn = "last3Months" | "last6Months" | "y2024" | "y2025";

export function isListingYearSalesColumnNotApplicable(listingYear: string, column: AggregatedSalesColumn) {
  const year = Number(listingYear);
  if (!Number.isFinite(year)) return false;
  if (column === "y2024" && year >= 2025) return true;
  if (column === "y2025" && year >= 2026) return true;
  return false;
}

export type ShapePriceBandInputItem = {
  productShape: string;
  priceBand: string;
  sales: PriceBandInputItem["sales"];
  trendMissing?: boolean;
};

export type ShapePriceBandMetrics = Omit<PriceBandMetrics, "priceBand"> & {
  productShape: string;
  priceBand: string;
  shapePriceBand: string;
};

export function formatShapePriceBandLabel(productShape: string, priceBand: string) {
  const safeShape = productShape?.trim() || "—";
  const safeBand = priceBand?.trim() || "—";
  return `${safeShape} · ${safeBand}`;
}

function emptyShapePriceBandMetrics(
  productShape: string,
  priceBand: string,
  shapePriceBand: string,
): ShapePriceBandMetrics {
  const empty = emptyMetrics(shapePriceBand);
  const { priceBand: _priceBand, ...rest } = empty;
  return { productShape, priceBand, shapePriceBand, ...rest };
}

function shapePriceBandSortKey(left: ShapePriceBandMetrics, right: ShapePriceBandMetrics) {
  const shapeCompare = left.productShape.localeCompare(right.productShape, "zh-CN");
  if (shapeCompare !== 0) return shapeCompare;
  return priceBandSortKey(left.priceBand) - priceBandSortKey(right.priceBand);
}

export function buildShapePriceBandAnalysis(
  items: ShapePriceBandInputItem[],
  options?: { fetchedAt?: string },
): ShapePriceBandMetrics[] {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const bySegment = new Map<string, ShapePriceBandMetrics>();

  for (const item of items) {
    const productShape = item.productShape?.trim() || "—";
    const priceBand = item.priceBand?.trim() || "—";
    const shapePriceBand = formatShapePriceBandLabel(productShape, priceBand);
    const current =
      bySegment.get(shapePriceBand) ?? emptyShapePriceBandMetrics(productShape, priceBand, shapePriceBand);
    current.linkCount += 1;
    if (item.trendMissing) current.trendMissingLinkCount += 1;
    current.last3Months += item.sales.last3Months ?? 0;
    current.last6Months += item.sales.last6Months ?? 0;
    current.y2024 += item.sales.y2024 ?? 0;
    current.y2025 += item.sales.y2025 ?? 0;
    bySegment.set(shapePriceBand, current);
  }

  const rows = [...bySegment.values()].sort(shapePriceBandSortKey);
  const shapeTotals = new Map<
    string,
    { last3Months: number; last6Months: number; y2024: number; y2025: number }
  >();

  for (const row of rows) {
    const current = shapeTotals.get(row.productShape) ?? {
      last3Months: 0,
      last6Months: 0,
      y2024: 0,
      y2025: 0,
    };
    current.last3Months += row.last3Months;
    current.last6Months += row.last6Months;
    current.y2024 += row.y2024;
    current.y2025 += row.y2025;
    shapeTotals.set(row.productShape, current);
  }

  return rows.map(row => {
    const totals = shapeTotals.get(row.productShape) ?? {
      last3Months: 0,
      last6Months: 0,
      y2024: 0,
      y2025: 0,
    };
    return {
      ...row,
      last3MonthsSharePct: pct(row.last3Months, totals.last3Months),
      last6MonthsSharePct: pct(row.last6Months, totals.last6Months),
      y2025SharePct: pct(row.y2025, totals.y2025),
      y2024SharePct: pct(row.y2024, totals.y2024),
      avgLast6MonthsMonthlyPerLink:
        row.linkCount > 0 ? Math.round(row.last6Months / row.linkCount / 6) : 0,
      avgY2025MonthlyPerLink:
        row.linkCount > 0 ? Math.round(row.y2025 / row.linkCount / y2025MonthDivisor) : 0,
    };
  });
}

export function findTopShapePriceBandByLast6Months(rows: readonly ShapePriceBandMetrics[]) {
  if (!rows.length) return null;
  return rows.reduce((best, row) => (row.last6Months > best.last6Months ? row : best), rows[0]);
}

export type ShapeAggregatedMetrics = {
  productShape: string;
  linkCount: number;
  trendMissingLinkCount: number;
  last3Months: number;
  last3MonthsSharePct: number | null;
  last6Months: number;
  last6MonthsSharePct: number | null;
  y2025: number;
  y2025SharePct: number | null;
  y2024: number;
  y2024SharePct: number | null;
  avgLast6MonthsMonthlyPerLink: number;
  avgY2025MonthlyPerLink: number;
};

export type ShapePriceBandSortMetric =
  | "productShape"
  | "last3Months"
  | "last3MonthsSharePct"
  | "last6Months"
  | "last6MonthsSharePct"
  | "y2025"
  | "y2025SharePct"
  | "y2024"
  | "y2024SharePct"
  | "linkCount"
  | "avgLast6MonthsMonthlyPerLink"
  | "avgY2025MonthlyPerLink";

export function buildShapeAggregatesFromPriceBandRows(
  rows: readonly ShapePriceBandMetrics[],
  options?: { fetchedAt?: string },
): ShapeAggregatedMetrics[] {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const byShape = new Map<
    string,
    {
      productShape: string;
      linkCount: number;
      trendMissingLinkCount: number;
      last3Months: number;
      last6Months: number;
      y2025: number;
      y2024: number;
    }
  >();

  for (const row of rows) {
    const productShape = row.productShape?.trim() || "—";
    const current = byShape.get(productShape) ?? {
      productShape,
      linkCount: 0,
      trendMissingLinkCount: 0,
      last3Months: 0,
      last6Months: 0,
      y2025: 0,
      y2024: 0,
    };
    current.linkCount += row.linkCount;
    current.trendMissingLinkCount += row.trendMissingLinkCount;
    current.last3Months += row.last3Months;
    current.last6Months += row.last6Months;
    current.y2025 += row.y2025;
    current.y2024 += row.y2024;
    byShape.set(productShape, current);
  }

  const aggregates = [...byShape.values()];
  const totals = aggregates.reduce(
    (acc, row) => ({
      last3Months: acc.last3Months + row.last3Months,
      last6Months: acc.last6Months + row.last6Months,
      y2024: acc.y2024 + row.y2024,
      y2025: acc.y2025 + row.y2025,
    }),
    { last3Months: 0, last6Months: 0, y2024: 0, y2025: 0 },
  );

  return aggregates.map(row => ({
    ...row,
    last3MonthsSharePct: pct(row.last3Months, totals.last3Months),
    last6MonthsSharePct: pct(row.last6Months, totals.last6Months),
    y2025SharePct: pct(row.y2025, totals.y2025),
    y2024SharePct: pct(row.y2024, totals.y2024),
    avgLast6MonthsMonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.last6Months / row.linkCount / 6) : 0,
    avgY2025MonthlyPerLink:
      row.linkCount > 0 ? Math.round(row.y2025 / row.linkCount / y2025MonthDivisor) : 0,
  }));
}

function shapeAggregateSortValue(aggregate: ShapeAggregatedMetrics, metric: ShapePriceBandSortMetric) {
  if (metric === "productShape") return null;
  const value = aggregate[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function compareShapeAlphabetically(left: string, right: string) {
  if (left === "—" && right !== "—") return 1;
  if (right === "—" && left !== "—") return -1;
  return left.localeCompare(right, "zh-CN");
}

export function sortShapeAggregates(
  aggregates: readonly ShapeAggregatedMetrics[],
  sort: { metric: ShapePriceBandSortMetric; dir: "asc" | "desc" } | null,
): ShapeAggregatedMetrics[] {
  const effectiveSort = sort ?? { metric: "last6MonthsSharePct" as const, dir: "desc" as const };
  const sign = effectiveSort.dir === "asc" ? 1 : -1;
  return [...aggregates].sort((left, right) => {
    if (effectiveSort.metric === "productShape") {
      return sign * compareShapeAlphabetically(left.productShape, right.productShape);
    }
    const leftValue = shapeAggregateSortValue(left, effectiveSort.metric) ?? -1;
    const rightValue = shapeAggregateSortValue(right, effectiveSort.metric) ?? -1;
    if (leftValue !== rightValue) return sign * (leftValue - rightValue);
    return compareShapeAlphabetically(left.productShape, right.productShape);
  });
}

export function findTopShapeByLast6Months(aggregates: readonly ShapeAggregatedMetrics[]) {
  if (!aggregates.length) return null;
  return aggregates.reduce(
    (best, row) => (row.last6Months > best.last6Months ? row : best),
    aggregates[0],
  );
}

export type ShapePriceBandDisplayGroup = {
  productShape: string;
  subtotal: ShapeAggregatedMetrics;
  bands: ShapePriceBandMetrics[];
};

export function buildShapePriceBandDisplayGroups(
  rows: readonly ShapePriceBandMetrics[],
  shapeAggregates: readonly ShapeAggregatedMetrics[],
  sort: { metric: ShapePriceBandSortMetric; dir: "asc" | "desc" } | null,
): ShapePriceBandDisplayGroup[] {
  const effectiveSort = sort ?? { metric: "last6MonthsSharePct" as const, dir: "desc" as const };
  const sign = effectiveSort.dir === "asc" ? 1 : -1;
  const bandsByShape = new Map<string, ShapePriceBandMetrics[]>();

  for (const row of rows) {
    const list = bandsByShape.get(row.productShape) ?? [];
    list.push(row);
    bandsByShape.set(row.productShape, list);
  }

  for (const [shape, bands] of bandsByShape) {
    bands.sort((left, right) => priceBandSortKey(left.priceBand) - priceBandSortKey(right.priceBand));
    bandsByShape.set(shape, bands);
  }

  const orderedAggregates = [...shapeAggregates];
  if (effectiveSort.metric === "productShape") {
    orderedAggregates.sort((left, right) => sign * compareShapeAlphabetically(left.productShape, right.productShape));
  } else {
    orderedAggregates.sort((left, right) => {
      const leftValue = shapeAggregateSortValue(left, effectiveSort.metric) ?? -1;
      const rightValue = shapeAggregateSortValue(right, effectiveSort.metric) ?? -1;
      if (leftValue !== rightValue) return sign * (leftValue - rightValue);
      return compareShapeAlphabetically(left.productShape, right.productShape);
    });
  }

  return orderedAggregates.map(subtotal => ({
    productShape: subtotal.productShape,
    subtotal,
    bands: bandsByShape.get(subtotal.productShape) ?? [],
  }));
}

export type AggregatedSalesGrandTotal = {
  last3Months: number;
  last6Months: number;
  y2025: number;
  y2024: number;
  linkCount: number;
  trendMissingLinkCount: number;
  last3MonthsSharePct: number | null;
  last6MonthsSharePct: number | null;
  y2025SharePct: number | null;
  y2024SharePct: number | null;
  avgLast6MonthsMonthlyPerLink: number;
  avgY2025MonthlyPerLink: number;
};

type AggregatedSalesRollupSource = Pick<
  PriceBandMetrics,
  "last3Months" | "last6Months" | "y2025" | "y2024" | "linkCount" | "trendMissingLinkCount"
>;

export function buildAggregatedSalesGrandTotal(
  rows: readonly AggregatedSalesRollupSource[],
  options?: { fetchedAt?: string },
): AggregatedSalesGrandTotal {
  const y2025MonthDivisor = resolveY2025MonthDivisor(options?.fetchedAt);
  const grand = rows.reduce(
    (acc, row) => ({
      last3Months: acc.last3Months + row.last3Months,
      last6Months: acc.last6Months + row.last6Months,
      y2025: acc.y2025 + row.y2025,
      y2024: acc.y2024 + row.y2024,
      linkCount: acc.linkCount + row.linkCount,
      trendMissingLinkCount: acc.trendMissingLinkCount + row.trendMissingLinkCount,
    }),
    { last3Months: 0, last6Months: 0, y2025: 0, y2024: 0, linkCount: 0, trendMissingLinkCount: 0 },
  );

  return {
    ...grand,
    last3MonthsSharePct: grand.last3Months > 0 ? 100 : null,
    last6MonthsSharePct: grand.last6Months > 0 ? 100 : null,
    y2025SharePct: grand.y2025 > 0 ? 100 : null,
    y2024SharePct: grand.y2024 > 0 ? 100 : null,
    avgLast6MonthsMonthlyPerLink:
      grand.linkCount > 0 ? Math.round(grand.last6Months / grand.linkCount / 6) : 0,
    avgY2025MonthlyPerLink:
      grand.linkCount > 0 ? Math.round(grand.y2025 / grand.linkCount / y2025MonthDivisor) : 0,
  };
}

export function formatAggregatedSalesCell(
  volume: number,
  sharePct: number | null,
  opts: {
    trendMissingLinkCount: number;
    linkCount: number;
    notApplicable?: boolean;
  },
) {
  if (opts.notApplicable) {
    return {
      volumeText: "—",
      shareText: "—",
      title: "该年份链接在此周期尚未上架，不适用",
    };
  }
  if (volume === 0 && opts.trendMissingLinkCount > 0 && opts.trendMissingLinkCount >= opts.linkCount) {
    return {
      volumeText: "—",
      shareText: "—",
      title: `${opts.linkCount} 条链接近30天有销量，但 Sorftime 历史趋势未返回；请点「重新拉取」`,
    };
  }
  const volumeText = Math.round(volume).toLocaleString();
  const shareText = sharePct == null || Number.isNaN(sharePct) ? "—" : `${sharePct.toFixed(2)}%`;
  const title =
    opts.trendMissingLinkCount > 0
      ? `其中 ${opts.trendMissingLinkCount} 条链接历史趋势未返回，数值可能偏低`
      : undefined;
  return { volumeText, shareText, title };
}
