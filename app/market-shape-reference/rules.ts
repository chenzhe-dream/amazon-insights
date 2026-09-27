import type { SorftimeCategoryDashboardProduct, SorftimeCategoryDashboardReport } from "./types";

export type ReferencePeriod = "last3Months" | "last6Months" | "y2025" | "y2024";
export const REFERENCE_PERIODS: readonly ReferencePeriod[] = ["last3Months", "last6Months", "y2025", "y2024"];
export type ReferencePeriodValues = Record<ReferencePeriod, number | null>;
export type ReferenceCoverage = { known: number; total: number; missing: number; notApplicable: number };
export type ReferencePeriodCoverage = Record<ReferencePeriod, ReferenceCoverage>;
export const CURRENT_SHAPE_CALCULATION_VERSION = 'shape-known-coverage/2' as const;

export type ReferenceGroupRow = {
  label: string;
  shape?: string;
  brand?: string;
  priceBand?: string;
  linkCount: number;
  sales: ReferencePeriodValues;
  coverage: ReferencePeriodCoverage;
  sharePct: ReferencePeriodValues;
  avgLast6MonthsMonthlyPerLink: number | null;
  avgY2025MonthlyPerLink: number | null;
  trendMissingLinkCount: number;
};

export type ReferenceMarginLabel = "优先进入" | "建议进入" | "谨慎进入" | "不建议进入" | "—";
export type ReferenceMarginCounts = Record<ReferenceMarginLabel, number>;

export type ReferenceShapeAnalysis = {
  calculationVersion: 'shape-reference/1' | typeof CURRENT_SHAPE_CALCULATION_VERSION;
  overview: SorftimeCategoryDashboardReport["stats"] & { history: SorftimeCategoryDashboardReport["history"] };
  products: SorftimeCategoryDashboardProduct[];
  listingYears: ReferenceGroupRow[];
  shapes: ReferenceGroupRow[];
  shapePriceBands: ReferenceGroupRow[];
  brandPriceBands: ReferenceGroupRow[];
  synthesis: {
    linkCount: number;
    totalSales: ReferencePeriodValues;
    coverage: ReferencePeriodCoverage;
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

export function sumObserved(values: readonly (number | null | undefined)[]): number | null {
  const observed = values.map(known).filter((value): value is number => value !== null);
  return observed.length ? observed.reduce((sum, value) => sum + value, 0) : null;
}

export function getReferencePeriodCoverage(products: readonly SorftimeCategoryDashboardProduct[]): ReferencePeriodCoverage {
  return Object.fromEntries(REFERENCE_PERIODS.map(period => {
    const notApplicable = products.filter(product => isReferencePeriodBeforeLaunch(product, period) && !hasReferencePeriodDateConflict(product, period)).length;
    const knownCount = products.filter(product => !isReferencePeriodBeforeLaunch(product, period) && referencePeriodContribution(product, period) !== null).length;
    return [period, { known: knownCount, total: products.length, missing: products.length - knownCount - notApplicable, notApplicable }];
  })) as ReferencePeriodCoverage;
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

export function getReferencePeriodTotals(products: readonly SorftimeCategoryDashboardProduct[], calculationVersion: 'shape-reference/1' | typeof CURRENT_SHAPE_CALCULATION_VERSION = CURRENT_SHAPE_CALCULATION_VERSION): ReferencePeriodValues {
  return Object.fromEntries(REFERENCE_PERIODS.map(period => [
    period,
    (calculationVersion === 'shape-reference/1' ? sumKnown : sumObserved)(products.map(product => referencePeriodContribution(product, period, calculationVersion))),
  ])) as ReferencePeriodValues;
}

export function resolveReferenceProductShape(product: Pick<SorftimeCategoryDashboardProduct, 'asin' | 'productShape'>, assignments: Readonly<Record<string, string>>): string {
  return Object.prototype.hasOwnProperty.call(assignments, product.asin)
    ? assignments[product.asin]?.trim() || '未分类'
    : product.productShape?.trim() || '—';
}

export type ReferenceListingDate = { raw: string | null; status: 'known' | 'uncertain' | 'missing'; year: number | null; month: number | null };
export function parseReferenceListingDate(value: string | null | undefined): ReferenceListingDate {
  const raw = value?.trim() || null;
  if (!raw || raw === 'null' || raw === '—') return { raw, status: 'missing', year: null, month: null };
  const text = raw.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/);
  const numeric = Number(raw);
  const timestamp = !text && Number.isFinite(numeric) && numeric > 1e11 ? new Date(numeric) : null;
  const year = text ? Number(text[1]) : timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.getUTCFullYear() : null;
  const month = text ? Number(text[2]) : timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.getUTCMonth() + 1 : null;
  const day = text ? Number(text[3] ?? 1) : timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.getUTCDate() : null;
  const date = year !== null && month !== null && day !== null ? new Date(Date.UTC(year, month - 1, day)) : null;
  const valid = date && date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
  if (!valid) return { raw, status: 'uncertain', year: null, month: null };
  if (year === 1970) return { raw, status: 'uncertain', year: null, month: null };
  return { raw, status: 'known', year, month };
}

export function isReferencePeriodBeforeLaunch(product: SorftimeCategoryDashboardProduct, period: ReferencePeriod, calculationVersion?: string): boolean {
  if (period !== 'y2024' && period !== 'y2025') return false;
  if(calculationVersion==='shape-reference/1'){
    const launch=product.onlineDate?.match(/^(\d{4})-(0[1-9]|1[0-2])(?:-(\d{2}))?$/);if(!launch)return false;
    const year=Number(launch[1]),month=Number(launch[2]),day=Number(launch[3]??1),date=new Date(Date.UTC(year,month-1,day));
    return year>=1900&&date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day&&year>Number(period.slice(1));
  }
  const launch = parseReferenceListingDate(product.onlineDate);
  return launch.status === 'known' && launch.year! > Number(period.slice(1));
}

export function hasReferencePeriodDateConflict(product: SorftimeCategoryDashboardProduct, period: ReferencePeriod, calculationVersion?: string): boolean {
  return isReferencePeriodBeforeLaunch(product,period,calculationVersion)&&(known(product.sales?.[period])??0)>0;
}

/** A confirmed pre-launch year contributes nothing; unavailable post-launch data stays unknown. */
export function referencePeriodContribution(product: SorftimeCategoryDashboardProduct, period: ReferencePeriod, calculationVersion?: string): number | null {
  if(hasReferencePeriodDateConflict(product,period,calculationVersion))return null;
  return isReferencePeriodBeforeLaunch(product,period,calculationVersion)?0:known(product.sales?.[period]);
}

export function resolveListingYear(value: string | null | undefined): string {
  const listing = parseReferenceListingDate(value);
  return listing.status === 'known' ? String(listing.year) : listing.status === 'uncertain' ? '待核实' : '—';
}

function groupRows(
  products: readonly SorftimeCategoryDashboardProduct[],
  getLabel: (product: SorftimeCategoryDashboardProduct) => string,
  totals: ReferencePeriodValues,
  y2025Divisor: number,
  denominatorForGroup?: (members: SorftimeCategoryDashboardProduct[]) => ReferencePeriodValues,
  calculationVersion: 'shape-reference/1' | typeof CURRENT_SHAPE_CALCULATION_VERSION = CURRENT_SHAPE_CALCULATION_VERSION,
  parts?: (members: SorftimeCategoryDashboardProduct[]) => Pick<ReferenceGroupRow, 'shape' | 'brand' | 'priceBand'>,
  getKey?: (product: SorftimeCategoryDashboardProduct) => string,
): ReferenceGroupRow[] {
  const groups = new Map<string, SorftimeCategoryDashboardProduct[]>();
  for (const product of products) {
    const key = getKey?.(product) ?? (getLabel(product).trim() || "—");
    groups.set(key, [...(groups.get(key) ?? []), product]);
  }
  return [...groups.values()].map(members => {
    const label = getLabel(members[0]).trim() || '—';
    const sales = getReferencePeriodTotals(members, calculationVersion);
    const coverage = getReferencePeriodCoverage(members);
    const denominator = denominatorForGroup?.(members) ?? totals;
    const sharePct = Object.fromEntries(REFERENCE_PERIODS.map(period => [
      period, percentage(sales[period], denominator[period]),
    ])) as ReferencePeriodValues;
    const six = sales.last6Months;
    const y2025 = sales.y2025;
    return {
      label,
      ...parts?.(members),
      linkCount: members.length,
      sales,
      coverage,
      sharePct,
      avgLast6MonthsMonthlyPerLink: six === null ? null : Math.round(six / (calculationVersion === 'shape-reference/1' ? members.length : coverage.last6Months.known) / 6),
      avgY2025MonthlyPerLink: y2025 === null || (calculationVersion !== 'shape-reference/1' && coverage.y2025.known === 0) ? null : Math.round(y2025 / (calculationVersion === 'shape-reference/1' ? members.length : coverage.y2025.known) / y2025Divisor),
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
  const calculationVersion = report.calculationVersion ?? CURRENT_SHAPE_CALCULATION_VERSION;
  const selected = selectedAsins ? new Set(selectedAsins) : null;
  const products = report.products.filter(product => selected === null || selected.has(product.asin));
  const totals = getReferencePeriodTotals(products, calculationVersion);
  const coverage = getReferencePeriodCoverage(products);
  const divisor = resolveY2025MonthDivisor(report.fetchedAt);
  const shape = (product: SorftimeCategoryDashboardProduct) => calculationVersion==='shape-reference/1'
    ? assignments[product.asin]?.trim()||product.productShape?.trim()||'—' : resolveReferenceProductShape(product, assignments);
  const priceBand = (product: SorftimeCategoryDashboardProduct) => resolveProductPriceBand(product);
  const listingYears = groupRows(products, product => calculationVersion === 'shape-reference/1'
    ? product.onlineDate?.trim().match(/^(\d{4})[-/]/)?.[1] ?? '—'
    : resolveListingYear(product.onlineDate), totals, divisor, undefined, calculationVersion)
    .sort((a, b) => b.label.localeCompare(a.label));
  const shapes = groupRows(products, shape, totals, divisor, undefined, calculationVersion)
    .sort((a, b) => (b.sales.last6Months ?? -1) - (a.sales.last6Months ?? -1));
  const shapeTotals = new Map(shapes.map(row => [row.label, row.sales]));
  const shapePriceBands = groupRows(products, product => `${shape(product)} · ${priceBand(product)}`, totals, divisor,
    members => shapeTotals.get(calculationVersion === 'shape-reference/1' ? `${shape(members[0])} · ${priceBand(members[0])}`.split(' · ')[0] : shape(members[0])) ?? totals,
    calculationVersion, members => ({ shape: shape(members[0]), priceBand: priceBand(members[0]) }),
    calculationVersion === 'shape-reference/1' ? undefined : product => JSON.stringify([shape(product), priceBand(product)]))
    .sort((a, b) => {
      if (calculationVersion === 'shape-reference/1') {
        const [ashape, aband] = a.label.split(' · '), [bshape, bband] = b.label.split(' · ');
        return ashape.localeCompare(bshape, 'zh-CN') || priceBandSortKey(aband) - priceBandSortKey(bband);
      }
      return a.shape!.localeCompare(b.shape!, "zh-CN") || priceBandSortKey(a.priceBand!) - priceBandSortKey(b.priceBand!);
    });
  const brandPriceBands = groupRows(products, product => `${product.brand?.trim() || "—"} · ${priceBand(product)}`, totals, divisor, undefined, calculationVersion,
    members => ({ brand: members[0].brand?.trim() || '—', priceBand: priceBand(members[0]) }),
    calculationVersion === 'shape-reference/1' ? undefined : product => JSON.stringify([product.brand?.trim() || '—', priceBand(product)]))
    .sort((a, b) => {
      if (calculationVersion === 'shape-reference/1') {
        const [abrand, aband] = a.label.split(' · '), [bbrand, bband] = b.label.split(' · ');
        return abrand.localeCompare(bbrand, 'zh-CN') || priceBandSortKey(aband) - priceBandSortKey(bband);
      }
      return a.brand!.localeCompare(b.brand!, "zh-CN") || priceBandSortKey(a.priceBand!) - priceBandSortKey(b.priceBand!);
    });
  const marginCounts: ReferenceMarginCounts = {
    "优先进入": 0, "建议进入": 0, "谨慎进入": 0, "不建议进入": 0, "—": 0,
  };
  for (const product of products) marginCounts[resolveSorftimeMarginEntryLabel(product.grossProfitMargin).label]++;
  return {
    calculationVersion,
    overview: { ...report.stats, history: report.history },
    products,
    listingYears,
    shapes,
    shapePriceBands,
    brandPriceBands,
    synthesis: {
      linkCount: products.length,
      totalSales: totals,
      coverage,
      currentMonthlyVolume: (calculationVersion === 'shape-reference/1' ? sumKnown : sumObserved)(products.map(product => product.monthlySalesVolume)),
      currentMonthlyAmount: (calculationVersion === 'shape-reference/1' ? sumKnown : sumObserved)(products.map(product => product.monthlySalesAmount)),
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
