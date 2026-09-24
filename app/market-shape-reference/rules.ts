import type { SorftimeCategoryDashboardProduct, SorftimeCategoryDashboardReport } from "./types";

export type ReferencePeriod = "last3Months" | "last6Months" | "y2025" | "y2024";
export const REFERENCE_PERIODS: readonly ReferencePeriod[] = ["last3Months", "last6Months", "y2025", "y2024"];
export type ReferencePeriodValues = Record<ReferencePeriod, number | null>;

export type ReferenceGroupRow = {
  label: string;
  linkCount: number;
  sales: ReferencePeriodValues;
  sharePct: ReferencePeriodValues;
  avgLast6MonthsMonthlyPerLink: number | null;
  avgY2025MonthlyPerLink: number | null;
  trendMissingLinkCount: number;
};

export type ReferenceMarginLabel = "优先进入" | "建议进入" | "谨慎进入" | "不建议进入" | "—";
export type ReferenceMarginCounts = Record<ReferenceMarginLabel, number>;

export type ReferenceShapeAnalysis = {
  overview: SorftimeCategoryDashboardReport["stats"] & { history: SorftimeCategoryDashboardReport["history"] };
  products: SorftimeCategoryDashboardProduct[];
  listingYears: ReferenceGroupRow[];
  shapes: ReferenceGroupRow[];
  shapePriceBands: ReferenceGroupRow[];
  brandPriceBands: ReferenceGroupRow[];
  synthesis: {
    linkCount: number;
    totalSales: ReferencePeriodValues;
    currentMonthlyVolume: number | null;
    currentMonthlyAmount: number | null;
    marginCounts: ReferenceMarginCounts;
    shapeCount: number;
    brandPriceBandCount: number;
    structuralPeriod: "2024 / 2025 / 近6个月 / 近3个月";
    sampleScope: string;
  };
};

function known(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A missing value makes the aggregate unknown; zero is retained when observed. */
export function sumKnown(values: readonly (number | null | undefined)[]): number | null {
  if (!values.length) return null;
  let total = 0;
  for (const value of values) {
    const numeric = known(value);
    if (numeric === null) return null;
    total += numeric;
  }
  return total;
}

function percentage(part: number | null, whole: number | null): number | null {
  return part === null || whole === null || whole <= 0
    ? null
    : Number(((part / whole) * 100).toFixed(2));
}

export function formatPriceBand(price: number | null | undefined): string {
  const value = known(price);
  if (value === null || value <= 0) return "—";
  const low = Math.floor(value / 10) * 10;
  return `$${low}-${low + 10}`;
}

export function resolveProductPriceBand(product: Pick<SorftimeCategoryDashboardProduct, "priceBand" | "price">): string {
  const stored = product.priceBand?.trim();
  return stored && stored !== "—" ? stored : formatPriceBand(product.price);
}

export function resolveSorftimeMarginEntryLabel(marginPct: number | null | undefined): {
  tone: "green" | "yellow" | "red" | "muted";
  label: ReferenceMarginLabel;
  title: string;
} {
  const value = known(marginPct);
  if (value === null) return { tone: "muted", label: "—", title: "缺少 Sorftime 毛利润率" };
  if (value >= 70) return { tone: "green", label: "优先进入", title: "≥70%：利润空间充足，可重点评估并优先立项" };
  if (value >= 60) return { tone: "green", label: "建议进入", title: "60%～＜70%：利润空间较好，结合市场容量、竞争强度和差异化能力判断进入" };
  if (value >= 50) return { tone: "yellow", label: "谨慎进入", title: "50%～＜60%：利润安全边际较低，仅在竞争较弱、推广成本可控或产品差异化明显时考虑" };
  return { tone: "red", label: "不建议进入", title: "＜50%：难以覆盖广告、退货、促销及价格竞争等成本，原则上不立项" };
}

/** Source convention: 2025 is year-to-date until December, then twelve months. */
export function resolveY2025MonthDivisor(fetchedAt?: string, referenceDate = new Date()): number {
  const date = fetchedAt ? new Date(fetchedAt) : referenceDate;
  if (Number.isNaN(date.getTime())) return 12;
  if (date.getFullYear() > 2025) return 12;
  if (date.getFullYear() < 2025) return 1;
  return Math.max(1, date.getMonth() + 1);
}

export function getReferencePeriodTotals(products: readonly SorftimeCategoryDashboardProduct[]): ReferencePeriodValues {
  return Object.fromEntries(REFERENCE_PERIODS.map(period => [
    period,
    sumKnown(products.map(product => product.sales?.[period])),
  ])) as ReferencePeriodValues;
}

export function resolveListingYear(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  const year = text.match(/^(\d{4})[-/]/)?.[1];
  return year ?? "—";
}

function groupRows(
  products: readonly SorftimeCategoryDashboardProduct[],
  getLabel: (product: SorftimeCategoryDashboardProduct) => string,
  totals: ReferencePeriodValues,
  y2025Divisor: number,
  denominatorForGroup?: (label: string) => ReferencePeriodValues,
): ReferenceGroupRow[] {
  const groups = new Map<string, SorftimeCategoryDashboardProduct[]>();
  for (const product of products) {
    const label = getLabel(product).trim() || "—";
    groups.set(label, [...(groups.get(label) ?? []), product]);
  }
  return [...groups].map(([label, members]) => {
    const sales = getReferencePeriodTotals(members);
    const denominator = denominatorForGroup?.(label) ?? totals;
    const sharePct = Object.fromEntries(REFERENCE_PERIODS.map(period => [
      period, percentage(sales[period], denominator[period]),
    ])) as ReferencePeriodValues;
    const six = sales.last6Months;
    const y2025 = sales.y2025;
    return {
      label,
      linkCount: members.length,
      sales,
      sharePct,
      avgLast6MonthsMonthlyPerLink: six === null ? null : Math.round(six / members.length / 6),
      avgY2025MonthlyPerLink: y2025 === null ? null : Math.round(y2025 / members.length / y2025Divisor),
      trendMissingLinkCount: members.filter(product =>
        (product.sales?.monthsAvailable ?? 0) === 0 && (known(product.monthlySalesVolume) ?? 0) > 0,
      ).length,
    };
  });
}

function priceBandSortKey(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

export function buildReferenceShapeAnalysis(
  report: SorftimeCategoryDashboardReport,
  assignments: Readonly<Record<string, string>>,
  selectedAsins?: readonly string[],
): ReferenceShapeAnalysis {
  const selected = selectedAsins ? new Set(selectedAsins) : null;
  const products = report.products.filter(product => selected === null || selected.has(product.asin));
  const totals = getReferencePeriodTotals(products);
  const divisor = resolveY2025MonthDivisor(report.fetchedAt);
  const shape = (product: SorftimeCategoryDashboardProduct) =>
    assignments[product.asin]?.trim() || product.productShape?.trim() || "—";
  const priceBand = (product: SorftimeCategoryDashboardProduct) => resolveProductPriceBand(product);
  const listingYears = groupRows(products, product => resolveListingYear(product.onlineDate), totals, divisor)
    .sort((a, b) => b.label.localeCompare(a.label));
  const shapes = groupRows(products, shape, totals, divisor)
    .sort((a, b) => (b.sales.last6Months ?? -1) - (a.sales.last6Months ?? -1));
  const shapeTotals = new Map(shapes.map(row => [row.label, row.sales]));
  const shapePriceBands = groupRows(products, product => `${shape(product)} · ${priceBand(product)}`, totals, divisor,
    label => shapeTotals.get(label.split(" · ")[0]) ?? totals)
    .sort((a, b) => {
      const [ashape, aband] = a.label.split(" · "), [bshape, bband] = b.label.split(" · ");
      return ashape.localeCompare(bshape, "zh-CN") || priceBandSortKey(aband) - priceBandSortKey(bband);
    });
  const brandPriceBands = groupRows(products, product => `${product.brand?.trim() || "—"} · ${priceBand(product)}`, totals, divisor)
    .sort((a, b) => {
      const [abrand, aband] = a.label.split(" · "), [bbrand, bband] = b.label.split(" · ");
      return abrand.localeCompare(bbrand, "zh-CN") || priceBandSortKey(aband) - priceBandSortKey(bband);
    });
  const marginCounts: ReferenceMarginCounts = {
    "优先进入": 0, "建议进入": 0, "谨慎进入": 0, "不建议进入": 0, "—": 0,
  };
  for (const product of products) marginCounts[resolveSorftimeMarginEntryLabel(product.grossProfitMargin).label]++;
  return {
    overview: { ...report.stats, history: report.history },
    products,
    listingYears,
    shapes,
    shapePriceBands,
    brandPriceBands,
    synthesis: {
      linkCount: products.length,
      totalSales: totals,
      currentMonthlyVolume: sumKnown(products.map(product => product.monthlySalesVolume)),
      currentMonthlyAmount: sumKnown(products.map(product => product.monthlySalesAmount)),
      marginCounts,
      shapeCount: shapes.length,
      brandPriceBandCount: brandPriceBands.length,
      structuralPeriod: "2024 / 2025 / 近6个月 / 近3个月",
      sampleScope: `${report.marketplace} · ${report.categoryName} · TOP${report.topLinkCount ?? products.length}`,
    },
  };
}

export function sortPriceBandLabels(labels: readonly string[]): string[] {
  return [...labels].sort((a, b) => priceBandSortKey(a) - priceBandSortKey(b) || a.localeCompare(b));
}
