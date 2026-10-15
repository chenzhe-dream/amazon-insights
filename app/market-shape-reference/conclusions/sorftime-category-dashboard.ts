
export type SorftimeTrendPoint = { month: string; value: number };

export type SorftimeProductSalesSummary = {
  last3Months: number;
  last6Months: number;
  y2024: number;
  y2025: number;
  monthsAvailable: number;
};

export type SorftimeProductMonthlyTrend = {
  volume: SorftimeTrendPoint[];
  amount: SorftimeTrendPoint[];
};

export type SorftimeCategoryDashboardProduct = {
  rank: number;
  asin: string;
  title: string;
  brand: string;
  imageUrl: string;
  monthlySalesVolume: number;
  monthlySalesAmount: number;
  sales: SorftimeProductSalesSummary;
  monthlyTrend: SorftimeProductMonthlyTrend;
  price: number;
  categoryRank: string;
  productCategory: string;
  productShape: string;
  productShapeHint: string | null;
  bsrRank: number | null;
  deliveryType: string;
  reviewCount: number;
  starRating: number | null;
  seller: string;
  sellerOrigin: string | null;
  onlineDate: string | null;
  grossProfitMargin: number | null;
  priceBand: string;
};

export type SorftimeCategoryDashboardReport = {
  marketplace: string;
  sorftimeSite: string;
  nodeId: string;
  categoryName: string;
  fetchedAt: string;
  note: string;
  stats: {
    top100MonthlyVolume: number;
    top100MonthlyAmount: number;
    top3ProductSharePct: number | null;
    top3BrandSharePct: number | null;
    top3SellerSharePct: number | null;
    amazonOwnedSharePct: number | null;
    averagePrice: number | null;
    medianPrice: number | null;
    returnRatePct: number | null;
  };
  history: {
    volume: SorftimeTrendPoint[];
    avgPrice: SorftimeTrendPoint[];
    amount: SorftimeTrendPoint[];
    listingMonopoly: SorftimeTrendPoint[];
    brandMonopoly: SorftimeTrendPoint[];
    sellerMonopoly: SorftimeTrendPoint[];
  };
  products: SorftimeCategoryDashboardProduct[];
  productSalesTotals: SorftimeProductSalesSummary;
  topLinkCount: number;
};

export const TOP_LINK_COUNT_OPTIONS = [50, 100, 150, 200, 250, 300] as const;
export type TopLinkCount = (typeof TOP_LINK_COUNT_OPTIONS)[number];

export function normalizeTopLinkCount(value: unknown): TopLinkCount {
  const count = Number(value);
  return TOP_LINK_COUNT_OPTIONS.includes(count as TopLinkCount) ? (count as TopLinkCount) : 100;
}

const SITE_MAP: Record<string, string> = {
  US: "US",
  JP: "JP",
  UK: "GB",
  DE: "DE",
  FR: "FR",
  IT: "IT",
  ES: "ES",
  CA: "CA",
  IN: "IN",
  MX: "MX",
};

function toSorftimeSite(marketplace: string) {
  return SITE_MAP[marketplace] ?? marketplace;
}

function toNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatPriceBand(price: number | null | undefined) {
  const p = price == null || Number.isNaN(price) ? null : price;
  if (p == null || p <= 0) return "—";
  const low = Math.floor(p / 10) * 10;
  return `$${low}-${low + 10}`;
}

export function resolveProductPriceBand(product: Pick<SorftimeCategoryDashboardProduct, "priceBand" | "price">) {
  const band = product.priceBand?.trim();
  return band && band !== "—" ? band : formatPriceBand(product.price);
}

export function sortPriceBandLabels(bands: readonly string[]) {
  return [...bands].sort((left, right) => {
    const leftMatch = left.match(/(\d+)/);
    const rightMatch = right.match(/(\d+)/);
    const leftKey = leftMatch ? Number(leftMatch[1]) : 9999;
    const rightKey = rightMatch ? Number(rightMatch[1]) : 9999;
    return leftKey - rightKey || left.localeCompare(right);
  });
}

export function collectProductPriceBands(products: readonly SorftimeCategoryDashboardProduct[]) {
  const bands = new Set<string>();
  for (const product of products) {
    bands.add(resolveProductPriceBand(product));
  }
  return sortPriceBandLabels([...bands]);
}

export function countProductsByPriceBand(products: readonly SorftimeCategoryDashboardProduct[]) {
  const counts = new Map<string, number>();
  for (const product of products) {
    const band = resolveProductPriceBand(product);
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  return counts;
}

export type TopSalesMultiSelectFilterState = string[] | null;
export type TopSalesPriceBandFilterState = TopSalesMultiSelectFilterState;

export function toggleTopSalesMultiSelectFilter(
  current: TopSalesMultiSelectFilterState,
  allOptions: readonly string[],
  option: string,
): TopSalesMultiSelectFilterState {
  if (current === null || current.length === 0) {
    return [option];
  }
  if (current.includes(option)) {
    const next = current.filter(item => item !== option);
    return next.length === 0 ? null : next;
  }
  const next = [...current, option];
  return next.length === allOptions.length ? null : next;
}

export function toggleTopSalesPriceBandFilter(
  current: TopSalesPriceBandFilterState,
  allBands: readonly string[],
  band: string,
): TopSalesPriceBandFilterState {
  return toggleTopSalesMultiSelectFilter(current, allBands, band);
}

export function filterProductsByPriceBand<T extends Pick<SorftimeCategoryDashboardProduct, "priceBand" | "price">>(
  products: readonly T[],
  filter: TopSalesPriceBandFilterState,
) {
  if (filter === null || filter.length === 0) return [...products];
  const allowed = new Set(filter);
  return products.filter(product => allowed.has(resolveProductPriceBand(product)));
}

export function resolveProductListingYear(product: Pick<SorftimeCategoryDashboardProduct, "onlineDate">) {
  return formatOnlineDateYear(product.onlineDate);
}

function sortListingYearLabels(years: readonly string[]) {
  return [...years].sort((left, right) => {
    if (left === "—") return 1;
    if (right === "—") return -1;
    const leftNum = Number(left);
    const rightNum = Number(right);
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return rightNum - leftNum;
    return right.localeCompare(left);
  });
}

export function collectProductListingYears(products: readonly SorftimeCategoryDashboardProduct[]) {
  const years = new Set<string>();
  for (const product of products) {
    years.add(resolveProductListingYear(product));
  }
  return sortListingYearLabels([...years]);
}

export function countProductsByListingYear(products: readonly SorftimeCategoryDashboardProduct[]) {
  const counts = new Map<string, number>();
  for (const product of products) {
    const year = resolveProductListingYear(product);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return counts;
}

export type TopSalesListingYearFilterState = TopSalesMultiSelectFilterState;

export function filterProductsByListingYear<T extends Pick<SorftimeCategoryDashboardProduct, "onlineDate">>(
  products: readonly T[],
  filter: TopSalesListingYearFilterState,
) {
  if (filter === null || filter.length === 0) return [...products];
  const allowed = new Set(filter);
  return products.filter(product => allowed.has(resolveProductListingYear(product)));
}

export function resolveProductBrand(product: Pick<SorftimeCategoryDashboardProduct, "brand">) {
  const brand = product.brand?.trim();
  return brand ? brand : "—";
}

function sortBrandLabels(brands: readonly string[]) {
  return [...brands].sort((left, right) => {
    if (left === "—") return 1;
    if (right === "—") return -1;
    return left.localeCompare(right, "zh-CN");
  });
}

export function collectProductBrands(products: readonly SorftimeCategoryDashboardProduct[]) {
  const brands = new Set<string>();
  for (const product of products) {
    brands.add(resolveProductBrand(product));
  }
  return sortBrandLabels([...brands]);
}

export function countProductsByBrand(products: readonly SorftimeCategoryDashboardProduct[]) {
  const counts = new Map<string, number>();
  for (const product of products) {
    const brand = resolveProductBrand(product);
    counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  return counts;
}

export type TopSalesBrandFilterState = TopSalesMultiSelectFilterState;

export function filterProductsByBrand<T extends Pick<SorftimeCategoryDashboardProduct, "brand">>(
  products: readonly T[],
  filter: TopSalesBrandFilterState,
) {
  if (filter === null || filter.length === 0) return [...products];
  const allowed = new Set(filter);
  return products.filter(product => allowed.has(resolveProductBrand(product)));
}

function normalizeProductTitleQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeProductTitleHaystack(title: string) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[\s\-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesProductTitleQuery(
  product: Pick<SorftimeCategoryDashboardProduct, "title">,
  query: string,
) {
  const normalized = normalizeProductTitleQuery(query);
  if (!normalized) return true;
  const haystack = normalizeProductTitleHaystack(product.title);
  return haystack.includes(normalized);
}

export function filterProductsByTitleQuery<T extends Pick<SorftimeCategoryDashboardProduct, "title">>(
  products: readonly T[],
  query: string,
) {
  const normalized = normalizeProductTitleQuery(query);
  if (!normalized) return [...products];
  return products.filter(product => matchesProductTitleQuery(product, normalized));
}

export function resolveProductMarginEntryLabel(
  product: Pick<SorftimeCategoryDashboardProduct, "grossProfitMargin">,
) {
  return resolveSorftimeMarginEntryLabel(product.grossProfitMargin).label;
}

export function collectProductMarginEntryLabels(products: readonly SorftimeCategoryDashboardProduct[]) {
  const labels = new Set<string>();
  for (const product of products) {
    labels.add(resolveProductMarginEntryLabel(product));
  }
  const order = [...SORFTIME_MARGIN_ENTRY_RULES.map(rule => rule.label), "—"];
  return [...labels].sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

export function countProductsByMarginEntryLabel(products: readonly SorftimeCategoryDashboardProduct[]) {
  const counts = new Map<string, number>();
  for (const product of products) {
    const label = resolveProductMarginEntryLabel(product);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

export type TopSalesMarginEntryConclusionTier = {
  label: string;
  tone: SorftimeMarginEntryTone;
  count: number;
  pct: number;
};

export type ShapeMarginEntryBandGuide = {
  priceBand: string;
  linkCount: number;
  avgMarginPct: number | null;
  last6MonthsSalesSharePct: number | null;
};

export type ShapeMarginEntryGuide = {
  productShape: string;
  linkCount: number;
  last6MonthsSalesSharePct: number | null;
  tiers: Record<MarginEntryLabel, ShapeMarginEntryBandGuide[]>;
};

export const MARGIN_ENTRY_LABELS = ["优先进入", "建议进入", "谨慎进入", "不建议进入"] as const;
export type MarginEntryLabel = (typeof MARGIN_ENTRY_LABELS)[number];

const MARGIN_ENTRY_LABEL_ORDER: readonly MarginEntryLabel[] = MARGIN_ENTRY_LABELS;

function priceBandMidpointForSort(band: string) {
  const nums = band.match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return 9999;
  if (nums.length === 1) return nums[0];
  return (nums[0] + nums[1]) / 2;
}

function sortPriceBandGuides(bands: ShapeMarginEntryBandGuide[]) {
  return [...bands].sort((left, right) => priceBandMidpointForSort(left.priceBand) - priceBandMidpointForSort(right.priceBand));
}

function pickDominantMarginEntryLabel(labelCounts: Map<string, number>) {
  let bestLabel: (typeof MARGIN_ENTRY_LABEL_ORDER)[number] | null = null;
  let bestCount = 0;
  for (const label of MARGIN_ENTRY_LABEL_ORDER) {
    const count = labelCounts.get(label) ?? 0;
    if (count > bestCount) {
      bestLabel = label;
      bestCount = count;
    }
  }
  return bestCount > 0 ? bestLabel : null;
}

export function buildShapeMarginEntryPriceBandGuide(
  products: readonly SorftimeCategoryDashboardProduct[],
  getProductShape: (asin: string) => string,
): ShapeMarginEntryGuide[] {
  type BandAgg = {
    priceBand: string;
    linkCount: number;
    labelCounts: Map<string, number>;
    marginSum: number;
    marginCount: number;
    last6MonthsSales: number;
  };

  const byShape = new Map<
    string,
    {
      linkCount: number;
      last6MonthsSales: number;
      bands: Map<string, BandAgg>;
    }
  >();

  for (const product of products) {
    const rawShape = getProductShape(product.asin).trim();
    const productShape = rawShape || "—";
    if (productShape === "—") continue;

    const priceBand = resolveProductPriceBand(product);
    const entryLabel = resolveProductMarginEntryLabel(product);
    const shapeBucket =
      byShape.get(productShape) ??
      ({
        linkCount: 0,
        last6MonthsSales: 0,
        bands: new Map<string, BandAgg>(),
      } satisfies (typeof byShape extends Map<string, infer V> ? V : never));

    shapeBucket.linkCount += 1;
    shapeBucket.last6MonthsSales += product.sales.last6Months ?? 0;

    const bandBucket =
      shapeBucket.bands.get(priceBand) ??
      ({
        priceBand,
        linkCount: 0,
        labelCounts: new Map<string, number>(),
        marginSum: 0,
        marginCount: 0,
        last6MonthsSales: 0,
      } satisfies BandAgg);

    bandBucket.linkCount += 1;
    bandBucket.last6MonthsSales += product.sales.last6Months ?? 0;
    bandBucket.labelCounts.set(entryLabel, (bandBucket.labelCounts.get(entryLabel) ?? 0) + 1);
    const margin = product.grossProfitMargin == null ? NaN : Number(product.grossProfitMargin);
    if (Number.isFinite(margin)) {
      bandBucket.marginCount += 1;
      bandBucket.marginSum += margin;
    }
    shapeBucket.bands.set(priceBand, bandBucket);
    byShape.set(productShape, shapeBucket);
  }

  // TOP share includes known sales of unclassified products; only shape cards omit unknown labels.
  const totalLast6MonthsSales = products.reduce((sum, product) => sum + (product.sales.last6Months ?? 0), 0);

  return [...byShape.entries()]
    .map(([productShape, shape]) => {
      const tiers = Object.fromEntries(
        MARGIN_ENTRY_LABEL_ORDER.map(label => [label, [] as ShapeMarginEntryBandGuide[]]),
      ) as ShapeMarginEntryGuide["tiers"];

      for (const band of shape.bands.values()) {
        const dominantLabel = pickDominantMarginEntryLabel(band.labelCounts);
        if (!dominantLabel) continue;
        tiers[dominantLabel].push({
          priceBand: band.priceBand,
          linkCount: band.linkCount,
          avgMarginPct:
            band.marginCount > 0 ? Math.round((band.marginSum / band.marginCount) * 10) / 10 : null,
          last6MonthsSalesSharePct:
            shape.last6MonthsSales > 0 ? pctOf(band.last6MonthsSales, shape.last6MonthsSales) : null,
        });
      }

      for (const label of MARGIN_ENTRY_LABEL_ORDER) {
        tiers[label] = sortPriceBandGuides(tiers[label]);
      }

      return {
        productShape,
        linkCount: shape.linkCount,
        last6MonthsSalesSharePct:
          totalLast6MonthsSales > 0 ? pctOf(shape.last6MonthsSales, totalLast6MonthsSales) : null,
        tiers,
      } satisfies ShapeMarginEntryGuide;
    })
    .sort((left, right) => (right.last6MonthsSalesSharePct ?? 0) - (left.last6MonthsSalesSharePct ?? 0));
}

/** 价格带销量份额大但链接毛利普遍低于 50% → 难切入 */
export type PriceBandMarginDifficulty = {
  priceBand: string;
  linkCount: number;
  withMarginCount: number;
  last6MonthsSales: number;
  last6MonthsSalesSharePct: number | null;
  below50Count: number;
  below50LinkSharePct: number | null;
  avgMarginPct: number | null;
  hardToEnter: boolean;
};

export const PRICE_BAND_HARD_ENTER_MIN_SALES_SHARE = 10;
export const PRICE_BAND_HARD_ENTER_MIN_LOW_MARGIN_LINK_SHARE = 50;
export const PRICE_BAND_HARD_ENTER_MIN_VALID_LINKS = 3;

export function analyzePriceBandMarginDifficulty(
  products: readonly SorftimeCategoryDashboardProduct[],
): PriceBandMarginDifficulty[] {
  const bandMap = new Map<
    string,
    {
      priceBand: string;
      linkCount: number;
      withMarginCount: number;
      last6MonthsSales: number;
      below50Count: number;
      marginSum: number;
    }
  >();

  let totalSales6m = 0;
  for (const product of products) {
    const priceBand = resolveProductPriceBand(product);
    const sales6m = product.sales.last6Months ?? 0;
    totalSales6m += sales6m;
    const current =
      bandMap.get(priceBand) ??
      ({
        priceBand,
        linkCount: 0,
        withMarginCount: 0,
        last6MonthsSales: 0,
        below50Count: 0,
        marginSum: 0,
      } satisfies (typeof bandMap extends Map<string, infer V> ? V : never));

    current.linkCount += 1;
    current.last6MonthsSales += sales6m;
    const margin = product.grossProfitMargin == null ? NaN : Number(product.grossProfitMargin);
    if (Number.isFinite(margin)) {
      current.withMarginCount += 1;
      current.marginSum += margin;
      if (margin < 50) current.below50Count += 1;
    }
    bandMap.set(priceBand, current);
  }

  return [...bandMap.values()]
    .map(row => {
      const below50LinkSharePct =
        row.withMarginCount > 0 ? pctOf(row.below50Count, row.withMarginCount) : null;
      const last6MonthsSalesSharePct =
        totalSales6m > 0 ? pctOf(row.last6MonthsSales, totalSales6m) : null;
      const avgMarginPct =
        row.withMarginCount > 0
          ? Math.round((row.marginSum / row.withMarginCount) * 10) / 10
          : null;
      const hardToEnter =
        (last6MonthsSalesSharePct ?? 0) >= PRICE_BAND_HARD_ENTER_MIN_SALES_SHARE &&
        row.withMarginCount >= PRICE_BAND_HARD_ENTER_MIN_VALID_LINKS &&
        (below50LinkSharePct ?? 0) >= PRICE_BAND_HARD_ENTER_MIN_LOW_MARGIN_LINK_SHARE;

      return {
        priceBand: row.priceBand,
        linkCount: row.linkCount,
        withMarginCount: row.withMarginCount,
        last6MonthsSales: row.last6MonthsSales,
        last6MonthsSalesSharePct,
        below50Count: row.below50Count,
        below50LinkSharePct,
        avgMarginPct,
        hardToEnter,
      } satisfies PriceBandMarginDifficulty;
    })
    .sort((left, right) => (right.last6MonthsSalesSharePct ?? 0) - (left.last6MonthsSalesSharePct ?? 0));
}

export function formatPriceBandHardToEnterMessage(row: PriceBandMarginDifficulty) {
  return `${row.priceBand} 近6个月销量份额 ${row.last6MonthsSalesSharePct?.toFixed(1) ?? "—"}%，但 ${row.below50LinkSharePct?.toFixed(1) ?? "—"}% 链接 Sorftime 毛利润低于 50%（带内均 ${row.avgMarginPct?.toFixed(1) ?? "—"}%），属于量大但难切入价格带`;
}

export type TopSalesMarginEntryConclusion = {
  totalLinks: number;
  withMarginCount: number;
  missingCount: number;
  avgMarginPct: number | null;
  tiers: TopSalesMarginEntryConclusionTier[];
  greenSharePct: number;
  yellowSharePct: number;
  redSharePct: number;
  headline: string;
  bullets: string[];
  hardToEnterBands: PriceBandMarginDifficulty[];
  shapeGuides: ShapeMarginEntryGuide[];
};

function pctOf(count: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

export function buildTopSalesMarginEntryConclusion(
  products: readonly SorftimeCategoryDashboardProduct[],
  options?: { getProductShape?: (asin: string) => string },
): TopSalesMarginEntryConclusion {
  const counts = countProductsByMarginEntryLabel(products);
  const totalLinks = products.length;
  const missingCount = counts.get("—") ?? 0;
  const withMarginCount = totalLinks - missingCount;

  const margins: number[] = [];
  for (const product of products) {
    const num = product.grossProfitMargin == null ? NaN : Number(product.grossProfitMargin);
    if (Number.isFinite(num)) margins.push(num);
  }
  const avgMarginPct =
    margins.length > 0 ? Math.round((margins.reduce((sum, value) => sum + value, 0) / margins.length) * 10) / 10 : null;

  const tiers: TopSalesMarginEntryConclusionTier[] = SORFTIME_MARGIN_ENTRY_RULES.map(rule => {
    const count = counts.get(rule.label) ?? 0;
    return {
      label: rule.label,
      tone: rule.tone,
      count,
      pct: pctOf(count, withMarginCount > 0 ? withMarginCount : totalLinks),
    };
  });

  if (missingCount > 0) {
    tiers.push({
      label: "—",
      tone: "muted",
      count: missingCount,
      pct: pctOf(missingCount, totalLinks),
    });
  }

  const priorityCount = counts.get("优先进入") ?? 0;
  const suggestCount = counts.get("建议进入") ?? 0;
  const cautiousCount = counts.get("谨慎进入") ?? 0;
  const rejectCount = counts.get("不建议进入") ?? 0;
  const greenCount = priorityCount + suggestCount;

  const greenSharePct = pctOf(greenCount, withMarginCount);
  const yellowSharePct = pctOf(cautiousCount, withMarginCount);
  const redSharePct = pctOf(rejectCount, withMarginCount);
  const bandDifficulty = analyzePriceBandMarginDifficulty(products);
  const hardToEnterBands = bandDifficulty.filter(row => row.hardToEnter);
  const topHardBand = hardToEnterBands[0] ?? null;

  let headline: string;
  if (withMarginCount === 0) {
    headline = `TOP${totalLinks} 链接均缺少 Sorftime 毛利润率，暂无法判断准入结构。`;
  } else if (topHardBand) {
    headline = `主销价格带 ${topHardBand.priceBand} 销量份额 ${topHardBand.last6MonthsSalesSharePct}% 但 ${topHardBand.below50LinkSharePct}% 链接毛利润低于 50%，需求大却难常规切入，立项应避开或寻找带内高毛利细分。`;
  } else if (greenSharePct >= 55) {
    headline = `TOP${totalLinks} 中 ${greenSharePct}% 链接处于「优先进入 / 建议进入」，类目平台费后毛利结构整体偏健康，可优先推进立项筛选。`;
  } else if (redSharePct >= 35) {
    headline = `TOP${totalLinks} 中 ${redSharePct}% 链接毛利率低于 50%，整体利润空间偏紧，进入需强成本管控与精准推广。`;
  } else if (yellowSharePct >= 40 && greenSharePct < 40) {
    headline = `TOP${totalLinks} 以「谨慎进入」为主（${yellowSharePct}%），利润安全边际有限，建议优先对标 60% 以上链接所在价格带。`;
  } else {
    headline = `TOP${totalLinks} 链接毛利结构分化明显：可进入 ${greenSharePct}%、需谨慎 ${yellowSharePct}%、不建议 ${redSharePct}%，需按标签与价格带交叉筛选后再定进入路径。`;
  }

  const bullets: string[] = [];
  const tierParts = SORFTIME_MARGIN_ENTRY_RULES.map(rule => {
    const tier = tiers.find(item => item.label === rule.label);
    if (!tier || tier.count === 0) return null;
    return `「${rule.label}」${tier.count} 条（${tier.pct}%）`;
  }).filter(Boolean);
  if (tierParts.length) {
    bullets.push(`标签分布：${tierParts.join(" · ")}。`);
  }
  for (const band of hardToEnterBands.slice(0, 3)) {
    bullets.push(`${formatPriceBandHardToEnterMessage(band)}，不宜作为常规跟随立项的首选价格带。`);
  }
  if (avgMarginPct != null) {
    bullets.push(`有效链接平均毛利润率 ${avgMarginPct.toFixed(1)}%（Sorftime 平台费后口径，不含采购/头程/广告）。`);
  }
  if (priorityCount > 0) {
    bullets.push(
      `「优先进入」${priorityCount} 条，可作为重点对标样本，优先拆解其价格带、规格与卖点组合。`,
    );
  }
  if (rejectCount > 0 && redSharePct >= 20) {
    bullets.push(
      `「不建议进入」${rejectCount} 条占比 ${redSharePct}%，说明类目存在低价/高费挤压，立项时需避开对应价格段或做明显差异化。`,
    );
  }
  if (missingCount > 0) {
    bullets.push(`另有 ${missingCount} 条缺少毛利润率数据（${pctOf(missingCount, totalLinks)}%），结论基于其余 ${withMarginCount} 条有效链接。`);
  }
  bullets.push("进入立项阶段后，应结合实际采购、头程、广告与退货成本重新核算全成本毛利率，不可仅依据 Sorftime 初筛标签定案。");

  const shapeGuides = options?.getProductShape
    ? buildShapeMarginEntryPriceBandGuide(products, options.getProductShape)
    : [];

  return {
    totalLinks,
    withMarginCount,
    missingCount,
    avgMarginPct,
    tiers,
    greenSharePct,
    yellowSharePct,
    redSharePct,
    headline,
    bullets,
    hardToEnterBands,
    shapeGuides,
  };
}

export function filterProductsByMarginEntryLabel<T extends Pick<SorftimeCategoryDashboardProduct, "grossProfitMargin">>(
  products: readonly T[],
  filter: TopSalesMultiSelectFilterState,
) {
  if (filter === null || filter.length === 0) return [...products];
  const allowed = new Set(filter);
  return products.filter(product => allowed.has(resolveProductMarginEntryLabel(product)));
}

export function formatOnlineDateYearMonth(raw: string | null | undefined) {
  if (!raw || raw === "null" || raw === "—") return "—";
  const text = String(raw).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
  const slashMatch = text.match(/^(\d{4})\/(\d{1,2})/);
  if (slashMatch) return `${slashMatch[1]}-${slashMatch[2].padStart(2, "0")}`;
  const ms = Number(text);
  if (Number.isFinite(ms) && ms > 1e11) {
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }
  }
  return "—";
}

export function formatOnlineDateYear(raw: string | null | undefined) {
  if (!raw || raw === "null" || raw === "—") return "—";
  const text = String(raw).trim();
  const yearMatch = text.match(/^(\d{4})/);
  if (yearMatch) return yearMatch[1];
  const ms = Number(text);
  if (Number.isFinite(ms) && ms > 1e11) {
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return String(date.getFullYear());
  }
  return "—";
}

export function parseProductOnlineDate(raw: string | null | undefined) {
  const yearMonth = formatOnlineDateYearMonth(raw);
  if (yearMonth === "—") return null;
  const [yearText, monthText] = yearMonth.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1);
}

export function isProductListedWithinMonths(
  onlineDate: string | null | undefined,
  months: number,
  referenceDate = new Date(),
) {
  const listed = parseProductOnlineDate(onlineDate);
  if (!listed) return false;
  const cutoff = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - months, 1);
  return listed >= cutoff;
}

export function formatGrossProfitMargin(value: number | null | undefined) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${num.toFixed(1)}%`;
}

/** Sorftime category_report.gross_profit_margin 字段说明（TOP 销量表表头） */
export const SORFTIME_GROSS_PROFIT_MARGIN_FIELD_HELP = {
  source: "Sorftime · category_report",
  formula: "毛利润率 = (售价 − 平台佣金 − FBA/FBM 配送费) ÷ 售价 × 100%",
  included: ["亚马逊销售佣金（Referral Fee，按类目费率估算）", "FBA 配送费，或 FBM 自配送费"],
  excluded: [
    "采购 / 出厂成本",
    "头程及关税",
    "广告费",
    "仓储费",
    "退货与售后",
    "优惠券 / 促销折扣",
    "包装与其他运营费用",
  ],
  note: "用于竞品横向对比平台费后空间，不等于立项清单中的「平台毛利润率」全成本口径。",
} as const;

export type SorftimeFieldHelp = {
  source: string;
  formula: string;
  included: readonly string[];
  excluded?: readonly string[];
  includedLabel?: string;
  excludedLabel?: string;
  note?: string;
};

export type SorftimeMarginEntryTone = "green" | "yellow" | "red" | "muted";

export type SorftimeMarginEntryLabel = {
  tone: SorftimeMarginEntryTone;
  label: string;
  title: string;
};

export function resolveSorftimeMarginEntryLabel(marginPct: number | null | undefined): SorftimeMarginEntryLabel {
  const num = marginPct == null ? NaN : Number(marginPct);
  if (!Number.isFinite(num)) {
    return {
      tone: "muted",
      label: "—",
      title: "缺少 Sorftime 毛利润率",
    };
  }
  if (num >= 70) {
    return {
      tone: "green",
      label: "优先进入",
      title: "≥70%：利润空间充足，可重点评估并优先立项",
    };
  }
  if (num >= 60) {
    return {
      tone: "green",
      label: "建议进入",
      title: "60%～＜70%：利润空间较好，结合市场容量、竞争强度和差异化能力判断进入",
    };
  }
  if (num >= 50) {
    return {
      tone: "yellow",
      label: "谨慎进入",
      title: "50%～＜60%：利润安全边际较低，仅在竞争较弱、推广成本可控或产品差异化明显时考虑",
    };
  }
  return {
    tone: "red",
    label: "不建议进入",
    title: "＜50%：难以覆盖广告、退货、促销及价格竞争等成本，原则上不立项",
  };
}

/** Sorftime 毛利润率准入分档（TOP 销量表「市场准入」列） */
export const SORFTIME_MARGIN_ENTRY_RULES = [
  {
    tone: "green" as const,
    threshold: "≥70%",
    colorLabel: "绿色",
    label: "优先进入",
    description: "利润空间充足，可重点评估并优先立项。",
  },
  {
    tone: "green" as const,
    threshold: "60%～＜70%",
    colorLabel: "绿色",
    label: "建议进入",
    description: "利润空间较好，结合市场容量、竞争强度和差异化能力判断进入。",
  },
  {
    tone: "yellow" as const,
    threshold: "50%～＜60%",
    colorLabel: "黄色",
    label: "谨慎进入",
    description: "利润安全边际较低，仅在竞争较弱、推广成本可控或产品差异化明显时考虑。",
  },
  {
    tone: "red" as const,
    threshold: "＜50%",
    colorLabel: "红色",
    label: "不建议进入",
    description: "难以覆盖广告、退货、促销及价格竞争等成本，原则上不立项。",
  },
] as const;

export const SORFTIME_MARGIN_ENTRY_RULES_SUPPLEMENT =
  "Sorftime 毛利润率仅作为市场初筛指标，进入立项阶段后，应根据实际采购、头程、佣金、FBA、广告及退货成本重新核算平台毛利率。";

export const SORFTIME_MARGIN_ENTRY_LABEL_FIELD_HELP: SorftimeFieldHelp = {
  source: "Sorftime 毛利润率准入规则",
  formula: "依据 category_report 毛利润率自动分档",
  includedLabel: "准入分档",
  included: SORFTIME_MARGIN_ENTRY_RULES.map(
    rule => `${rule.threshold}｜${rule.colorLabel}｜${rule.label}：${rule.description.replace(/。$/, "")}`,
  ),
  note: SORFTIME_MARGIN_ENTRY_RULES_SUPPLEMENT,
};

export function parseProductCategory(input: {
  categoryRank?: unknown;
  subcategory?: unknown;
  productCategory?: unknown;
}) {
  const categoryRank = String(input.categoryRank ?? "").trim();
  const categoryMatch = categoryRank.match(/Category:\s*([^,]+)/i);
  if (categoryMatch?.[1]?.trim()) return categoryMatch[1].trim();

  const subcategory = String(input.subcategory ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
  const subName = subcategory.replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim();
  if (subName) return subName;

  const rankInMatch = categoryRank.match(/#\d+\s+in\s+(.+)/i);
  if (rankInMatch?.[1]?.trim()) return rankInMatch[1].trim();

  const productCategory = String(input.productCategory ?? "").trim();
  if (productCategory) return productCategory;

  return "—";
}

export function emptySalesSummary(): SorftimeProductSalesSummary {
  return { last3Months: 0, last6Months: 0, y2024: 0, y2025: 0, monthsAvailable: 0 };
}

export function emptyMonthlyTrend(): SorftimeProductMonthlyTrend {
  return { volume: [], amount: [] };
}

export function mergeProductMonthlyTrend(
  volume: SorftimeTrendPoint[],
  amount: SorftimeTrendPoint[],
): Array<{ month: string; volume: number; amount: number; aov: number | null }> {
  const amountMap = new Map(amount.map(point => [point.month, point.value]));
  return [...volume]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(point => {
      const amountValue = amountMap.get(point.month) ?? 0;
      const volumeValue = point.value;
      return {
        month: point.month,
        volume: volumeValue,
        amount: amountValue,
        aov: volumeValue > 0 ? amountValue / volumeValue : null,
      };
    });
}

function sumTrendPoints(points: SorftimeTrendPoint[], predicate: (point: SorftimeTrendPoint) => boolean) {
  return points.filter(predicate).reduce((sum, point) => sum + point.value, 0);
}

export function isProductSalesTrendMissing(
  product: Pick<SorftimeCategoryDashboardProduct, "monthlySalesVolume" | "sales">,
) {
  return (product.sales?.monthsAvailable ?? 0) === 0 && (product.monthlySalesVolume ?? 0) > 0;
}

export function countTrendMissingProducts(products: SorftimeCategoryDashboardProduct[]) {
  return products.filter(product => isProductSalesTrendMissing(product)).length;
}

export function formatTopSalesHistoricalCell(
  product: Pick<SorftimeCategoryDashboardProduct, "monthlySalesVolume" | "sales">,
  value: number,
) {
  if (isProductSalesTrendMissing(product)) {
    return {
      text: "—",
      title:
        "近30天有销量，但 Sorftime product_trend 未返回月度历史（近3/6月、2024/2025 无法计算）。常见原因：① Sorftime 无该 ASIN 历史数据；② 批量拉取时限流未完成。请点「重新拉取」重试",
    };
  }
  return { text: Math.round(value).toLocaleString() };
}

/** 客户端/服务端缓存：任一近30天有销量的链接缺历史趋势，则视为未 enrich 完整 */
export function isDashboardReportComplete(report: SorftimeCategoryDashboardReport) {
  if (!Array.isArray(report.products) || report.products.length === 0) return false;

  const fieldsOk = report.products.every(product => {
    const y2024 = product.sales?.y2024;
    const y2025 = product.sales?.y2025;
    return Number.isFinite(y2024) && Number.isFinite(y2025) && Boolean(String(product.asin ?? "").trim());
  });
  if (!fieldsOk) return false;

  if (countTrendMissingProducts(report.products) > 0) return false;

  const hasRecentVolume = report.products.some(product => (product.monthlySalesVolume ?? 0) > 0);
  const hasTrendMonths = report.products.some(product => (product.sales?.monthsAvailable ?? 0) > 0);
  const hasMonthlyTrendSeries = report.products.some(product => (product.monthlyTrend?.volume?.length ?? 0) > 0);
  if (hasRecentVolume && !hasTrendMonths) return false;
  if (hasTrendMonths && !hasMonthlyTrendSeries) return false;

  return true;
}

export function buildProductSalesSummary(points: SorftimeTrendPoint[]): SorftimeProductSalesSummary {
  const sorted = [...points].sort((a, b) => a.month.localeCompare(b.month));
  const last3 = sorted.slice(-3);
  const last6 = sorted.slice(-6);
  return {
    monthsAvailable: sorted.length,
    last3Months: sumTrendPoints(sorted, point => last3.some(item => item.month === point.month)),
    last6Months: sumTrendPoints(sorted, point => last6.some(item => item.month === point.month)),
    y2024: sumTrendPoints(sorted, point => point.month.startsWith("2024")),
    y2025: sumTrendPoints(sorted, point => point.month.startsWith("2025")),
  };
}

function rollupProductSalesTotals(products: SorftimeCategoryDashboardProduct[]): SorftimeProductSalesSummary {
  return products.reduce(
    (acc, item) => ({
      monthsAvailable: Math.max(acc.monthsAvailable, item.sales.monthsAvailable),
      last3Months: acc.last3Months + (item.sales.last3Months ?? 0),
      last6Months: acc.last6Months + (item.sales.last6Months ?? 0),
      y2024: acc.y2024 + (item.sales.y2024 ?? 0),
      y2025: acc.y2025 + (item.sales.y2025 ?? 0),
    }),
    emptySalesSummary(),
  );
}

export function normalizeDashboardReport(report: SorftimeCategoryDashboardReport): SorftimeCategoryDashboardReport {
  const products = (Array.isArray(report.products) ? report.products : []).map((item, index) => {
    const sales = item.sales ?? emptySalesSummary();
    const categoryRank = String(item.categoryRank ?? "");
    const productCategory =
      item.productCategory && item.productCategory !== "—"
        ? item.productCategory
        : parseProductCategory({
            categoryRank,
            productCategory: item.productCategory,
          });
    const productShapeHint = item.productShapeHint ?? null;
    return {
      ...item,
      asin: String(item.asin ?? "").trim(),
      title: String(item.title ?? ""),
      brand: String(item.brand ?? "—"),
      imageUrl: String(item.imageUrl ?? ""),
      categoryRank,
      productCategory,
      productShapeHint,
      productShape: String(item.productShape ?? "").trim() || "—",
      sales: {
        monthsAvailable: Number.isFinite(Number(sales.monthsAvailable)) ? Number(sales.monthsAvailable) : 0,
        last3Months: Number.isFinite(Number(sales.last3Months)) ? Number(sales.last3Months) : 0,
        last6Months: Number.isFinite(Number(sales.last6Months)) ? Number(sales.last6Months) : 0,
        y2024: Number.isFinite(Number(sales.y2024)) ? Number(sales.y2024) : 0,
        y2025: Number.isFinite(Number(sales.y2025)) ? Number(sales.y2025) : 0,
      },
      monthlyTrend: {
        volume: Array.isArray(item.monthlyTrend?.volume) ? item.monthlyTrend.volume : [],
        amount: Array.isArray(item.monthlyTrend?.amount) ? item.monthlyTrend.amount : [],
      },
      rank: item.rank ?? index + 1,
      grossProfitMargin: Number.isFinite(Number(item.grossProfitMargin)) ? Number(item.grossProfitMargin) : null,
    };
  });

  return {
    ...report,
    products,
    productSalesTotals: rollupProductSalesTotals(products),
  };
}
