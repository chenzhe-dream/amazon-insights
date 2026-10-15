import {
  analyzeBrandPriceOpportunity,
  buildBrandPriceOpportunityInputsFromProducts,
} from "./brand-price-opportunity-analysis";
import {
  analyzeListingAgeSalesShare,
  buildListingAgeSalesShareInputsFromProducts,
  listingAgeEntryColorLabel,
  type ListingAgeEntryColor,
} from "./listing-age-sales-share-analysis";
import {
  buildShapeAggregatesFromPriceBandRows,
  buildShapePriceBandAnalysis,
  computeRecentNewProductLast6MonthsShare,
  type ShapeAggregatedMetrics,
  type ShapePriceBandMetrics,
} from "./shape-price-analysis";
import {
  analyzePriceBandMarginDifficulty,
  buildTopSalesMarginEntryConclusion,
  formatOnlineDateYear,
  formatPriceBand,
  formatPriceBandHardToEnterMessage,
  isProductSalesTrendMissing,
  resolveProductMarginEntryLabel,
  type PriceBandMarginDifficulty,
  type ShapeMarginEntryBandGuide,
  type ShapeMarginEntryGuide,
  type SorftimeCategoryDashboardProduct,
  type SorftimeCategoryDashboardReport,
  type TopSalesMarginEntryConclusion,
} from "./sorftime-category-dashboard";

export type MarketStructureVerdict =
  | "优先立项调研"
  | "可差异化切入"
  | "谨慎进入"
  | "暂缓进入"
  | "数据不足";

export type MarketStructureVerdictColor = "green" | "light_green" | "yellow" | "red" | "gray";

export type MarginMarketAccessSectionDetail = {
  headline: string;
  salesShareByLabel: Array<{ label: string; pct: number }>;
  favorableSalesPct: number;
  accessibleSalesPct: number;
  linkGreenSharePct: number;
  withMarginCount: number;
  totalLinks: number;
  shapeGuides: ShapeMarginEntryGuide[];
  shapeNote: string | null;
  emptyMessage: string | null;
};

export type MarketStructureModuleSection = {
  key:
    | "newProductEntry"
    | "shapePriceDistribution"
    | "marginMarketAccess"
    | "productShapeDirection"
    | "layoutLearning";
  title: string;
  score: number;
  maxScore: number;
  text: string;
  marginAccessDetail?: MarginMarketAccessSectionDetail;
};

export type MarketStructureSynthesisOptions = {
  getProductShape?: (asin: string) => string;
};

const MODULE_MAX_SCORE = 20;

export type MarketStructureSynthesisResult = {
  version: "2.0.0";
  categoryName: string;
  marketplace: string;
  sampleScope: string;
  topLinkCount: number;
  score: number;
  verdict: MarketStructureVerdict;
  verdictColor: MarketStructureVerdictColor;
  verdictDefinition: string;
  summary: string;
  finalVerdict: string;
  crossSignals: string[];
  moduleSections: MarketStructureModuleSection[];
  opportunities: string[];
  risks: string[];
  recommendedActions: string[];
  confidence: "high" | "medium" | "low" | "insufficient";
  highlights: {
    primaryPriceBand: string | null;
    primaryBrandPriceBand: string | null;
    listingAgeType: string;
    marginGreenSharePct: number;
    top3ListingSharePct: number | null;
    hardToEnterBands: PriceBandMarginDifficulty[];
  };
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fmtPct(value: number | null | undefined, digits = 1) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function priceBandMidpoint(band: string) {
  const nums = band.match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return 9999;
  if (nums.length === 1) return nums[0];
  return (nums[0] + nums[1]) / 2;
}

function resolveProductShape(getProductShape: ((asin: string) => string) | undefined, asin: string) {
  const shape = getProductShape?.(asin)?.trim();
  return shape || "—";
}

function isAssignedShape(shape: string) {
  return shape !== "—";
}

function topOverallPriceBand(products: SorftimeCategoryDashboardProduct[]) {
  const byBand = new Map<string, number>();
  for (const product of products) {
    const band = product.priceBand || formatPriceBand(product.price);
    byBand.set(band, (byBand.get(band) ?? 0) + (product.sales.last6Months ?? 0));
  }
  let best: { priceBand: string; sales: number } | null = null;
  for (const [priceBand, sales] of byBand.entries()) {
    if (!best || sales > best.sales) best = { priceBand, sales };
  }
  const total = [...byBand.values()].reduce((sum, value) => sum + value, 0);
  return best
    ? { ...best, sharePct: total > 0 ? (best.sales / total) * 100 : null }
    : null;
}

function buildMarginLabelSalesShare(products: SorftimeCategoryDashboardProduct[]) {
  const totals = new Map<string, number>();
  let total = 0;
  for (const product of products) {
    const label = resolveProductMarginEntryLabel(product);
    const sales = product.sales.last6Months ?? 0;
    totals.set(label, (totals.get(label) ?? 0) + sales);
    total += sales;
  }
  const share = (label: string) => (total > 0 ? ((totals.get(label) ?? 0) / total) * 100 : null);
  const accessible =
    (share("优先进入") ?? 0) + (share("建议进入") ?? 0) + (share("谨慎进入") ?? 0);
  const favorable = (share("优先进入") ?? 0) + (share("建议进入") ?? 0);
  return { totals, total, share, accessible, favorable };
}

type BrandShapeBandRow = {
  brand: string;
  productShape: string;
  priceBand: string;
  last6Months: number;
  linkCount: number;
  shapeSharePct: number | null;
};

function buildBrandShapeBandRows(
  products: SorftimeCategoryDashboardProduct[],
  getProductShape?: (asin: string) => string,
) {
  const combos = new Map<string, BrandShapeBandRow>();
  const shapeTotals = new Map<string, number>();
  for (const product of products) {
    if (!product.asin) continue;
    const productShape = resolveProductShape(getProductShape, product.asin);
    const priceBand = product.priceBand || formatPriceBand(product.price);
    const brand = product.brand?.trim() || "—";
    const key = `${brand}::${productShape}::${priceBand}`;
    const current =
      combos.get(key) ??
      ({
        brand,
        productShape,
        priceBand,
        last6Months: 0,
        linkCount: 0,
        shapeSharePct: null,
      } satisfies BrandShapeBandRow);
    current.last6Months += product.sales.last6Months ?? 0;
    current.linkCount += 1;
    combos.set(key, current);
    if (isAssignedShape(productShape)) {
      shapeTotals.set(productShape, (shapeTotals.get(productShape) ?? 0) + (product.sales.last6Months ?? 0));
    }
  }
  return [...combos.values()]
    .map(row => ({
      ...row,
      shapeSharePct:
        isAssignedShape(row.productShape) && (shapeTotals.get(row.productShape) ?? 0) > 0
          ? (row.last6Months / (shapeTotals.get(row.productShape) ?? 1)) * 100
          : null,
    }))
    .sort((left, right) => right.last6Months - left.last6Months);
}

type ShapeMarginStats = {
  linkCount: number;
  withMarginCount: number;
  below50Count: number;
  favorableCount: number;
  marginSum: number;
  priceSum: number;
  priceCount: number;
};

type ProductShapeDirectionEntry = {
  productShape: string;
  last6Months: number;
  topSharePct: number | null;
  linkCount: number;
  avgMarginPct: number | null;
  below50LinkSharePct: number | null;
  favorableLinkSharePct: number | null;
  avgPrice: number | null;
  mainstreamBands: string[];
  directionRole: string;
  recommendation: string;
  entryScore: number;
};

function buildShapeMarginStats(
  products: SorftimeCategoryDashboardProduct[],
  getProductShape?: (asin: string) => string,
) {
  const byShape = new Map<string, ShapeMarginStats>();
  for (const product of products) {
    if (!product.asin) continue;
    const productShape = resolveProductShape(getProductShape, product.asin);
    if (!isAssignedShape(productShape)) continue;
    const current =
      byShape.get(productShape) ??
      ({
        linkCount: 0,
        withMarginCount: 0,
        below50Count: 0,
        favorableCount: 0,
        marginSum: 0,
        priceSum: 0,
        priceCount: 0,
      } satisfies ShapeMarginStats);
    current.linkCount += 1;
    const price = Number(product.price);
    if (Number.isFinite(price) && price > 0) {
      current.priceSum += price;
      current.priceCount += 1;
    }
    const margin = product.grossProfitMargin == null ? NaN : Number(product.grossProfitMargin);
    if (Number.isFinite(margin)) {
      current.withMarginCount += 1;
      current.marginSum += margin;
      if (margin < 50) current.below50Count += 1;
      const entryLabel = resolveProductMarginEntryLabel(product);
      if (entryLabel === "优先进入" || entryLabel === "建议进入") current.favorableCount += 1;
    }
    byShape.set(productShape, current);
  }
  return byShape;
}

function inferShapeDirectionRole(input: {
  productShape: string;
  topSharePct: number | null;
  avgMarginPct: number | null;
  avgPrice: number | null;
  isTopShareShape: boolean;
  isHighestPriceShape: boolean;
}) {
  const share = input.topSharePct ?? 0;
  const margin = input.avgMarginPct ?? 0;
  if (input.isTopShareShape && share >= 25) {
    return margin >= 50 ? "市场基本盘" : "量大低毛利基本盘";
  }
  if (input.isHighestPriceShape && share >= 8) {
    return "高客单方向";
  }
  if (share >= 10 && margin >= 50) {
    return "可验证细分";
  }
  if (share < 10 && margin >= 55) {
    return "小众高毛利";
  }
  if (share >= 10 && margin < 50) {
    return "谨慎跟进";
  }
  return "持续观察";
}

function buildShapeDirectionRecommendation(entry: ProductShapeDirectionEntry) {
  const shareText = fmtPct(entry.topSharePct);
  const marginText = entry.avgMarginPct != null ? `${entry.avgMarginPct.toFixed(1)}%` : "—";
  const priceText = entry.avgPrice != null ? `$${Math.round(entry.avgPrice)}` : "—";
  const bandText = entry.mainstreamBands.slice(0, 2).join("、") || "—";
  const favorableText = fmtPct(entry.favorableLinkSharePct);

  switch (entry.directionRole) {
    case "市场基本盘":
      return `${entry.productShape}：TOP 销量占比 ${shareText}，均毛利 ${marginText}，均价 ${priceText}，主攻 ${bandText}，承担类目基本盘，适合跟进入门主流带并强控供应链成本。`;
    case "量大低毛利基本盘":
      return `${entry.productShape}：TOP 销量占比 ${shareText}，但均毛利仅 ${marginText}（${fmtPct(entry.below50LinkSharePct)} 链接低于 50%），需求大却难常规铺货，建议避开同质化低价带或找带内高毛利细分。`;
    case "高客单方向":
      return `${entry.productShape}：TOP 销量占比 ${shareText}，均毛利 ${marginText}，均价 ${priceText} 为形态最高，偏中高端客单，适合差异化高端款或配置升级验证。`;
    case "可验证细分":
      return `${entry.productShape}：TOP 销量占比 ${shareText}，均毛利 ${marginText}（${favorableText} 链接可进入），主攻 ${bandText}，体量适中且毛利尚可，适合小批量差异化切入。`;
    case "小众高毛利":
      return `${entry.productShape}：TOP 销量占比 ${shareText}，均毛利 ${marginText}，体量不大但利润空间较好，可作细分场景测款方向。`;
    case "谨慎跟进":
      return `${entry.productShape}：TOP 销量占比 ${shareText}，均毛利 ${marginText}，有一定需求但毛利安全边际偏低，需明显规格/场景差异后再切入。`;
    default:
      return `${entry.productShape}：TOP 销量占比 ${shareText}，均毛利 ${marginText}，主攻 ${bandText}，样本或毛利数据有限，建议结合形态·价格带表继续跟踪。`;
  }
}

function buildProductShapeDirectionEntries(
  products: SorftimeCategoryDashboardProduct[],
  shapeAggregates: ShapeAggregatedMetrics[],
  shapeSummaries: ReturnType<typeof summarizeShapePriceDistribution>,
  getProductShape?: (asin: string) => string,
): ProductShapeDirectionEntry[] {
  const marginByShape = buildShapeMarginStats(products, getProductShape);
  const mainstreamByShape = new Map(shapeSummaries.map(item => [item.productShape, item.mainstream]));
  const sortedByShare = [...shapeAggregates]
    .filter(item => isAssignedShape(item.productShape))
    .sort((left, right) => (right.last6MonthsSharePct ?? 0) - (left.last6MonthsSharePct ?? 0));

  const topShape = sortedByShare[0]?.productShape ?? null;
  let highestPrice = -1;
  let highestPriceShape: string | null = null;
  for (const aggregate of sortedByShare) {
    const margin = marginByShape.get(aggregate.productShape);
    const avgPrice =
      margin && margin.priceCount > 0 ? margin.priceSum / margin.priceCount : null;
    if (avgPrice != null && avgPrice > highestPrice) {
      highestPrice = avgPrice;
      highestPriceShape = aggregate.productShape;
    }
  }

  return sortedByShare.map(aggregate => {
    const margin = marginByShape.get(aggregate.productShape);
    const avgMarginPct =
      margin && margin.withMarginCount > 0
        ? Math.round((margin.marginSum / margin.withMarginCount) * 10) / 10
        : null;
    const below50LinkSharePct =
      margin && margin.withMarginCount > 0
        ? (margin.below50Count / margin.withMarginCount) * 100
        : null;
    const favorableLinkSharePct =
      margin && margin.withMarginCount > 0
        ? (margin.favorableCount / margin.withMarginCount) * 100
        : null;
    const avgPrice =
      margin && margin.priceCount > 0 ? margin.priceSum / margin.priceCount : null;
    const directionRole = inferShapeDirectionRole({
      productShape: aggregate.productShape,
      topSharePct: aggregate.last6MonthsSharePct,
      avgMarginPct,
      avgPrice,
      isTopShareShape: aggregate.productShape === topShape,
      isHighestPriceShape: aggregate.productShape === highestPriceShape,
    });
    const entry: ProductShapeDirectionEntry = {
      productShape: aggregate.productShape,
      last6Months: aggregate.last6Months,
      topSharePct: aggregate.last6MonthsSharePct,
      linkCount: aggregate.linkCount,
      avgMarginPct,
      below50LinkSharePct,
      favorableLinkSharePct,
      avgPrice,
      mainstreamBands: mainstreamByShape.get(aggregate.productShape) ?? [],
      directionRole,
      recommendation: "",
      entryScore:
        (aggregate.last6MonthsSharePct ?? 0) +
        (avgMarginPct ?? 0) * 0.5 +
        (favorableLinkSharePct ?? 0) * 0.1,
    };
    entry.recommendation = buildShapeDirectionRecommendation(entry);
    return entry;
  });
}

function formatProductShapeDirectionText(entries: ProductShapeDirectionEntry[]) {
  if (!entries.length) {
    return "缺少已标注的商品形态样本，请先在 TOP 销售表设置商品形态后再看方向切入。";
  }

  const shareOverview = entries
    .slice(0, 4)
    .map(item => `${item.productShape} ${fmtPct(item.topSharePct)}`)
    .join(" · ");
  const summary = `${entries.length > 1 ? "多种形态对应不同市场逻辑，不宜用同一标准判断" : "当前有效样本仅识别到一种已标注形态，暂不作多形态比较"}；近6个月 TOP 样本：${shareOverview}。`;
  const lines = entries.slice(0, 3).map(item => item.recommendation);
  return [summary, ...lines].join("");
}

function scoreProductShapeDirectionModule(entries: ProductShapeDirectionEntry[]) {
  if (!entries.length) return 6;
  let score = 8;
  if (entries.length >= 2) score += 3;
  if (entries.length >= 3) score += 2;
  const favorable = entries.filter(
    item =>
      item.directionRole === "市场基本盘" ||
      item.directionRole === "高客单方向" ||
      item.directionRole === "可验证细分" ||
      item.directionRole === "小众高毛利",
  ).length;
  const risky = entries.filter(item => item.directionRole === "量大低毛利基本盘").length;
  if (favorable >= 2) score += 4;
  else if (favorable >= 1) score += 2;
  if (risky >= 2) score -= 4;
  else if (risky >= 1) score -= 2;
  return clamp(Math.round(score), 0, MODULE_MAX_SCORE);
}

function summarizeShapePriceDistribution(rows: ShapePriceBandMetrics[]) {
  const byShape = new Map<string, ShapePriceBandMetrics[]>();
  for (const row of rows) {
    if (!isAssignedShape(row.productShape)) continue;
    const list = byShape.get(row.productShape) ?? [];
    list.push(row);
    byShape.set(row.productShape, list);
  }

  const summaries = [...byShape.entries()].map(([productShape, bands]) => {
    const sortedBands = [...bands].sort(
      (left, right) => priceBandMidpoint(left.priceBand) - priceBandMidpoint(right.priceBand),
    );
    const mainstream = [...bands]
      .sort((left, right) => (right.last6MonthsSharePct ?? 0) - (left.last6MonthsSharePct ?? 0))
      .slice(0, 2)
      .map(row => row.priceBand);
    const spread =
      sortedBands.length >= 2
        ? priceBandMidpoint(sortedBands[sortedBands.length - 1].priceBand) -
          priceBandMidpoint(sortedBands[0].priceBand)
        : 0;
    return { productShape, mainstream, spread, bandCount: bands.length };
  });

  return summaries.sort((left, right) => right.bandCount - left.bandCount);
}

function scoreNewProductEntryModule(
  halfYearSalesShare: number | null,
  halfYearEfficiency: number | null,
  entryColor: ListingAgeEntryColor,
) {
  const share = halfYearSalesShare ?? 0;
  let score = 6;
  if (share >= 10) score = 12;
  if (share >= 25) score += 4;
  if (share >= 40) score += 2;
  if ((halfYearEfficiency ?? 0) >= 0.8) score += 2;
  if (entryColor === "green" || entryColor === "light_green") score += 2;
  if (share < 10) score -= 4;
  return clamp(Math.round(score), 0, MODULE_MAX_SCORE);
}

function scoreShapePriceDistributionModule(summaries: ReturnType<typeof summarizeShapePriceDistribution>) {
  if (!summaries.length) return 6;
  let score = 8;
  if (summaries.length >= 2) score += 4;
  if (summaries.length >= 3) score += 2;
  const avgSpread = summaries.reduce((sum, item) => sum + item.spread, 0) / summaries.length;
  if (avgSpread >= 40) score += 4;
  else if (avgSpread >= 20) score += 2;
  if (summaries.some(item => item.bandCount >= 4)) score += 2;
  return clamp(Math.round(score), 0, MODULE_MAX_SCORE);
}

function scoreMarginMarketAccessModule(input: {
  favorableSalesSharePct: number;
  accessibleSalesSharePct: number;
  greenLinkSharePct: number;
  redLinkSharePct: number;
}) {
  let score = 8;
  if (input.favorableSalesSharePct >= 45) score += 6;
  else if (input.favorableSalesSharePct >= 30) score += 4;
  else if (input.favorableSalesSharePct >= 15) score += 2;
  if (input.accessibleSalesSharePct >= 70) score += 2;
  if (input.greenLinkSharePct >= 35) score += 2;
  if (input.redLinkSharePct >= 35) score -= 6;
  else if (input.redLinkSharePct >= 20) score -= 3;
  return clamp(Math.round(score), 0, MODULE_MAX_SCORE);
}


type BrandShapeLayoutSummary = {
  brand: string;
  last6Months: number;
  linkCount: number;
  shapeCount: number;
  shapes: Array<{
    productShape: string;
    priceBands: string[];
    last6Months: number;
    linkCount: number;
  }>;
};

function buildBrandShapeLayoutSummaries(rows: BrandShapeBandRow[]): BrandShapeLayoutSummary[] {
  const byBrand = new Map<string, BrandShapeBandRow[]>();
  for (const row of rows) {
    if (row.brand === "—") continue;
    const list = byBrand.get(row.brand) ?? [];
    list.push(row);
    byBrand.set(row.brand, list);
  }

  return [...byBrand.entries()]
    .map(([brand, brandRows]) => {
      const byShape = new Map<string, BrandShapeBandRow[]>();
      for (const row of brandRows) {
        if (!isAssignedShape(row.productShape)) continue;
        const list = byShape.get(row.productShape) ?? [];
        list.push(row);
        byShape.set(row.productShape, list);
      }

      const shapes = [...byShape.entries()]
        .map(([productShape, shapeRows]) => {
          const sortedBands = [...shapeRows].sort((left, right) => right.last6Months - left.last6Months);
          return {
            productShape,
            priceBands: sortedBands.map(item => item.priceBand),
            last6Months: shapeRows.reduce((sum, item) => sum + item.last6Months, 0),
            linkCount: shapeRows.reduce((sum, item) => sum + item.linkCount, 0),
          };
        })
        .sort((left, right) => right.last6Months - left.last6Months);

      return {
        brand,
        last6Months: brandRows.reduce((sum, item) => sum + item.last6Months, 0),
        linkCount: brandRows.reduce((sum, item) => sum + item.linkCount, 0),
        shapeCount: shapes.length,
        shapes,
      };
    })
    .filter(item => item.shapes.length > 0)
    .sort((left, right) => right.last6Months - left.last6Months);
}

function formatBrandShapeLayoutLine(summary: BrandShapeLayoutSummary) {
  const salesText = Math.round(summary.last6Months).toLocaleString();
  const meta = `${summary.linkCount} 链接，近6个月 ${salesText}`;

  if (summary.shapeCount === 1) {
    const shape = summary.shapes[0];
    const bands = shape.priceBands.slice(0, 2).join("、") || "—";
    return `${summary.brand}：单形态 ${shape.productShape}，主攻 ${bands}（${meta}）`;
  }

  const shapeParts = summary.shapes.slice(0, 3).map(shape => {
    const band = shape.priceBands[0] || "—";
    return `${shape.productShape} ${band}`;
  });
  const more = summary.shapeCount > 3 ? " 等" : "";
  return `${summary.brand}：${summary.shapeCount} 形态分层 — ${shapeParts.join("、")}${more}（${meta}）`;
}

function scoreLayoutLearningModule(layoutSummaries: BrandShapeLayoutSummary[]) {
  const topBrands = layoutSummaries.slice(0, 10);
  if (!topBrands.length) return 6;
  let score = 10;
  const multiShape = topBrands.filter(item => item.shapeCount >= 2).length;
  const richLayout = topBrands.filter(
    item => item.shapeCount >= 2 && item.shapes.every(shape => shape.priceBands.length >= 1),
  ).length;
  if (multiShape >= 2) score += 4;
  if (richLayout >= 2) score += 4;
  if (multiShape >= 1) score += 2;
  if (topBrands.length >= 5) score += 2;
  return clamp(Math.round(score), 0, MODULE_MAX_SCORE);
}

function verdictFromScore(score: number, hasEnoughData: boolean): {
  verdict: MarketStructureVerdict;
  color: MarketStructureVerdictColor;
  definition: string;
} {
  if (!hasEnoughData) {
    return {
      verdict: "数据不足",
      color: "gray",
      definition: "TOP 链接或关键字段缺失较多，以下结论仅供方向参考。",
    };
  }
  if (score >= 75) {
    return {
      verdict: "优先立项调研",
      color: "green",
      definition: "毛利、链接年龄、价格带与品牌结构形成共振，值得投入 VOC 与规格拆解。",
    };
  }
  if (score >= 58) {
    return {
      verdict: "可差异化切入",
      color: "light_green",
      definition: "类目存在可研究窗口，但需锁定具体价格带与差异化规格后再推进立项。",
    };
  }
  if (score >= 42) {
    return {
      verdict: "谨慎进入",
      color: "yellow",
      definition: "样本内机会与风险并存，建议小批量验证或避开头部主导价格带。",
    };
  }
  return {
    verdict: "暂缓进入",
    color: "red",
    definition: "链接结构对新品/新品牌不友好，除非具备明显成本或产品差异，否则不宜常规铺货。",
  };
}

function buildCrossSignals(input: {
  margin: ReturnType<typeof buildTopSalesMarginEntryConclusion>;
  listingAge: ReturnType<typeof analyzeListingAgeSalesShare>;
  halfYearNewProductShare: number;
  halfYearNewProductCutoff: string;
  topBand: ReturnType<typeof topOverallPriceBand>;
  brandPrice: ReturnType<typeof analyzeBrandPriceOpportunity>;
  marginSales: ReturnType<typeof buildMarginLabelSalesShare>;
  shapeSummaries: ReturnType<typeof summarizeShapePriceDistribution>;
  brandShapeLeaders: BrandShapeBandRow[];
  topHardBand: PriceBandMarginDifficulty | null;
}) {
  const signals: string[] = [];
  const halfYearShare = input.halfYearNewProductShare;

  if (halfYearShare >= 10) {
    signals.push(
      `近6个月上架半年内（${input.halfYearNewProductCutoff} 及之后上架）销量占比 ${fmtPct(halfYearShare)}，达到新品准入线（≥10%）`,
    );
  } else {
    signals.push(
      `近6个月上架半年内（${input.halfYearNewProductCutoff} 及之后上架）销量占比 ${fmtPct(halfYearShare)}，低于 10% 新品准入线`,
    );
  }
  if (input.shapeSummaries.length >= 2) {
    signals.push(
      `${input.shapeSummaries
        .slice(0, 3)
        .map(item => `${item.productShape}（${item.bandCount} 价格带）`)
        .join("、")} 价格带分化明显，可承载差异化定价`,
    );
  }
  if (input.marginSales.favorable >= 30) {
    signals.push(
      `优先/建议进入链接近6个月销量占比 ${fmtPct(input.marginSales.favorable)}，市场准入空间较充足`,
    );
  }
  if (input.brandShapeLeaders[0]) {
    const lead = input.brandShapeLeaders[0];
    signals.push(
      `${lead.brand} 在 ${lead.productShape} · ${lead.priceBand} 近6个月销量领先${lead.shapeSharePct != null ? `（占该形态 ${fmtPct(lead.shapeSharePct)}）` : ""}`,
    );
  }
  if (input.topHardBand) {
    signals.push(`${formatPriceBandHardToEnterMessage(input.topHardBand)}，不宜把销量最大等同于可常规切入`);
  }
  if (
    input.topBand &&
    input.brandPrice.classification.primaryResearchBand &&
    input.topBand.priceBand === input.brandPrice.classification.primaryResearchBand &&
    !input.topHardBand
  ) {
    signals.push(`品牌·价格带与主销带均指向 ${input.topBand.priceBand}，可作为首要拆解区间`);
  }
  if (!signals.length) {
    signals.push("五维结构信号未出现极端冲突，建议按下方动作逐条验证后再定立项");
  }
  return signals.slice(0, 4);
}

function buildMarginMarketAccessDetail(input: {
  margin: TopSalesMarginEntryConclusion;
  marginSales: ReturnType<typeof buildMarginLabelSalesShare>;
  topHardBand: PriceBandMarginDifficulty | null;
}): MarginMarketAccessSectionDetail {
  const { margin, marginSales, topHardBand } = input;
  let emptyMessage: string | null = null;
  if (!margin.shapeGuides.length) {
    emptyMessage = topHardBand
      ? formatPriceBandHardToEnterMessage(topHardBand)
      : "请先在 TOP 销售表设置商品形态，以生成形态×价格带的市场准入结论";
  }

  return {
    headline: margin.headline,
    salesShareByLabel: [
      { label: "优先/建议进入", pct: marginSales.favorable },
      {
        label: "谨慎/不建议进入",
        pct: (marginSales.share("谨慎进入") ?? 0) + (marginSales.share("不建议进入") ?? 0),
      },
    ],
    favorableSalesPct: marginSales.favorable,
    accessibleSalesPct: marginSales.accessible,
    linkGreenSharePct: margin.greenSharePct,
    withMarginCount: margin.withMarginCount,
    totalLinks: margin.totalLinks,
    shapeGuides: margin.shapeGuides,
    shapeNote:
      margin.shapeGuides.length >= 2
        ? "不同形态下优先/建议与谨慎/不建议价格带分化明显，立项需按形态×价格带交叉筛选，不可只看全样本汇总占比"
        : null,
    emptyMessage,
  };
}

function buildMarginMarketAccessText(detail: MarginMarketAccessSectionDetail) {
  return [
    detail.headline,
    `近6个月销量口径：优先+建议进入合计 ${fmtPct(detail.favorableSalesPct)}，可进入市场空间 ${fmtPct(detail.accessibleSalesPct)}。链接数口径：可进入毛利标签 ${fmtPct(detail.linkGreenSharePct)}（${detail.withMarginCount}/${detail.totalLinks} 条有毛利数据）`,
  ].join("。");
}

export function buildMarketStructureSynthesis(
  report: SorftimeCategoryDashboardReport,
  options: MarketStructureSynthesisOptions = {},
): MarketStructureSynthesisResult {
  const products = report.products;
  const getProductShape = options.getProductShape;
  const topLinkCount = report.topLinkCount ?? products.length;
  const sampleScope = `${report.marketplace} · ${report.categoryName} · TOP${topLinkCount}`;

  const margin = buildTopSalesMarginEntryConclusion(
    products,
    getProductShape ? { getProductShape: asin => resolveProductShape(getProductShape, asin) } : undefined,
  );
  const marginSales = buildMarginLabelSalesShare(products);
  const hardToEnterBands = margin.hardToEnterBands.length
    ? margin.hardToEnterBands
    : analyzePriceBandMarginDifficulty(products).filter(row => row.hardToEnter);
  const topHardBand = hardToEnterBands[0] ?? null;
  const listingAge = analyzeListingAgeSalesShare(
    buildListingAgeSalesShareInputsFromProducts(products, "last6Months"),
    {
      analysisDate: report.fetchedAt,
      salesPeriod: "last6Months",
      categoryName: report.categoryName,
      marketplace: report.marketplace,
      sampleScope,
    },
  );
  const shapePriceRows = buildShapePriceBandAnalysis(
    products.map(product => ({
      productShape: product.asin ? resolveProductShape(getProductShape, product.asin) : "—",
      priceBand: product.priceBand || formatPriceBand(product.price),
      sales: product.sales,
      trendMissing: isProductSalesTrendMissing(product),
    })),
    { fetchedAt: report.fetchedAt },
  );
  const shapeSummaries = summarizeShapePriceDistribution(shapePriceRows);
  const shapeAggregates = buildShapeAggregatesFromPriceBandRows(shapePriceRows, { fetchedAt: report.fetchedAt });
  const productShapeDirections = buildProductShapeDirectionEntries(
    products,
    shapeAggregates,
    shapeSummaries,
    getProductShape,
  );
  const topBand = topOverallPriceBand(products);
  const brandShapeLeaders = buildBrandShapeBandRows(products, getProductShape);
  const brandShapeLayouts = buildBrandShapeLayoutSummaries(brandShapeLeaders);
  const brandPrice = analyzeBrandPriceOpportunity(
    buildBrandPriceOpportunityInputsFromProducts(products),
    {
      analysisDate: report.fetchedAt,
      categoryName: report.categoryName,
      marketplace: report.marketplace,
      sampleScope,
    },
  );

  const halfYearNewProduct = computeRecentNewProductLast6MonthsShare(
    products.map(product => ({
      listingYear: formatOnlineDateYear(product.onlineDate),
      onlineDate: product.onlineDate,
      sales: product.sales,
      trendMissing: isProductSalesTrendMissing(product),
    })),
    { fetchedAt: report.fetchedAt, windowMonths: 6 },
  );
  const halfYearSalesShare = halfYearNewProduct.sharePct ?? 0;
  const halfYearProductSharePct =
    products.length > 0 ? (halfYearNewProduct.newProductLinkCount / products.length) * 100 : 0;
  const halfYearEfficiency =
    halfYearProductSharePct > 0 ? halfYearSalesShare / halfYearProductSharePct : null;

  const newProductScore = scoreNewProductEntryModule(
    halfYearSalesShare,
    halfYearEfficiency,
    listingAge.classification.entryColor,
  );
  const shapePriceScore = scoreShapePriceDistributionModule(shapeSummaries);
  const marginAccessScore = scoreMarginMarketAccessModule({
    favorableSalesSharePct: marginSales.favorable,
    accessibleSalesSharePct: marginSales.accessible,
    greenLinkSharePct: margin.greenSharePct,
    redLinkSharePct: margin.redSharePct,
  });
  const productShapeDirectionScore = scoreProductShapeDirectionModule(productShapeDirections);
  const layoutScore = scoreLayoutLearningModule(brandShapeLayouts);

  const score = clamp(
    newProductScore + shapePriceScore + marginAccessScore + productShapeDirectionScore + layoutScore - (topHardBand ? 6 : 0),
    0,
    100,
  );
  const hasEnoughData =
    products.length >= 10 &&
    margin.withMarginCount >= Math.min(10, Math.floor(products.length * 0.5)) &&
    shapeSummaries.length >= 1;
  const verdictPack = verdictFromScore(score, hasEnoughData);

  const newProductText = [
    `近6个月上架半年内（${halfYearNewProduct.cutoffYearMonth} 及之后上架）链接销量占比 ${fmtPct(halfYearSalesShare)}${halfYearSalesShare >= 10 ? "，达到新品准入线（≥10%）" : "，低于 10% 新品准入线"}。`,
    `市场类型「${listingAge.classification.marketType}」· ${listingAgeEntryColorLabel(listingAge.classification.entryColor)} · 效率指数 ${halfYearEfficiency?.toFixed(2) ?? "—"}。`,
    `3 年+老品销量占比 ${fmtPct(listingAge.coreMetrics.older3ySalesShare)}。`,
  ].join(" ");

  const shapePriceText =
    shapeSummaries.length > 0
      ? shapeSummaries
          .slice(0, 4)
          .map(item => `${item.productShape} 覆盖 ${item.bandCount} 个价格带，主流 ${item.mainstream.join("、") || "—"}。`)
          .join("") +
        (shapeSummaries.length >= 2 ? "不同形态价格带分化较大，可容纳多价位差异化切入。" : "")
      : "商品形态尚未标注或缺少有效价格带组合，请先在 TOP 销售表设置形态后再看分化。";

  const marginAccessDetail = buildMarginMarketAccessDetail({ margin, marginSales, topHardBand });
  const marginAccessText = buildMarginMarketAccessText(marginAccessDetail);

  const productShapeDirectionText = formatProductShapeDirectionText(productShapeDirections);

  const topLayoutBrands = brandShapeLayouts.slice(0, 3);
  const multiShapeLayoutBrands = brandShapeLayouts.filter(item => item.shapeCount >= 2);
  const layoutText = [
    topLayoutBrands.length
      ? topLayoutBrands.map(item => `${formatBrandShapeLayoutLine(item)}。`).join("")
      : "缺少已标注形态的品牌布局样本，请先在 TOP 销售表设置商品形态。",
    multiShapeLayoutBrands.length >= 2
      ? "可学习头部品牌在多种商品形态下分别布局不同价格带的组合方式。"
      : multiShapeLayoutBrands.length === 1
        ? `可对标 ${multiShapeLayoutBrands[0].brand} 的多形态×价格带组合，拆解各形态主图、规格与卖点差异。`
        : "样本内头部品牌以单形态为主，可先拆解形态内多价格带链接的规格组合。",
  ].join(" ");

  const moduleSections: MarketStructureModuleSection[] = [
    {
      key: "newProductEntry",
      title: "新品准入机会",
      score: newProductScore,
      maxScore: MODULE_MAX_SCORE,
      text: newProductText,
    },
    {
      key: "shapePriceDistribution",
      title: "价格带分布 · 形态分化",
      score: shapePriceScore,
      maxScore: MODULE_MAX_SCORE,
      text: shapePriceText,
    },
    {
      key: "marginMarketAccess",
      title: "市场准入 · 形态×价格带",
      score: marginAccessScore,
      maxScore: MODULE_MAX_SCORE,
      text: marginAccessText,
      marginAccessDetail,
    },
    {
      key: "productShapeDirection",
      title: "商品形态方向切入",
      score: productShapeDirectionScore,
      maxScore: MODULE_MAX_SCORE,
      text: productShapeDirectionText,
    },
    {
      key: "layoutLearning",
      title: "品牌 · 商品形态 · 价格带布局方向",
      score: layoutScore,
      maxScore: MODULE_MAX_SCORE,
      text: layoutText,
    },
  ];

  const crossSignals = buildCrossSignals({
    margin,
    listingAge,
    halfYearNewProductShare: halfYearSalesShare,
    halfYearNewProductCutoff: halfYearNewProduct.cutoffYearMonth,
    topBand,
    brandPrice,
    marginSales,
    shapeSummaries,
    brandShapeLeaders,
    topHardBand,
  });

  const healthierBand = analyzePriceBandMarginDifficulty(products).find(
    row => !row.hardToEnter && (row.last6MonthsSalesSharePct ?? 0) >= 5,
  );

  const opportunities: string[] = [];
  if (halfYearSalesShare >= 10) {
    opportunities.push(
      `上架半年内链接近6个月销量占比 ${fmtPct(halfYearSalesShare)}，可继续验证新品切入窗口`,
    );
  }
  if (shapeSummaries.length >= 2) {
    opportunities.push(
      `在 ${shapeSummaries
        .slice(0, 2)
        .map(item => item.productShape)
        .join("、")} 等形态下选择不同价格带做差异化`,
    );
  }
  if (marginSales.favorable >= 25) {
    opportunities.push(`优先/建议进入链接近6个月销量占比 ${fmtPct(marginSales.favorable)}，市场准入空间尚可`);
  }
  const topShapeDirection = productShapeDirections[0];
  if (topShapeDirection) {
    opportunities.push(
      `优先从 ${topShapeDirection.productShape} 方向切入（TOP 占比 ${fmtPct(topShapeDirection.topSharePct)}，${topShapeDirection.directionRole}）`,
    );
  } else if (brandShapeLeaders[0]) {
    opportunities.push(
      `拆解 ${brandShapeLeaders[0].brand} 在 ${brandShapeLeaders[0].productShape} · ${brandShapeLeaders[0].priceBand} 的规格与卖点组合`,
    );
  }
  if (topHardBand) {
    opportunities.push(
      `避开难切入主销带 ${topHardBand.priceBand}，优先寻找 Sorftime 毛利润 ≥50% 的次级价格带`,
    );
    if (healthierBand) {
      opportunities.push(
        `可对比 ${healthierBand.priceBand}（份额 ${fmtPct(healthierBand.last6MonthsSalesSharePct)}，带内均毛利 ${healthierBand.avgMarginPct?.toFixed(1) ?? "—"}%）作为备选切入区间`,
      );
    }
  } else if (topBand && (topBand.sharePct ?? 0) >= 10) {
    opportunities.push(`优先拆解主销价格带 ${topBand.priceBand} 的头部链接规格、评分与卖点`);
  }
  if (!opportunities.length) {
    opportunities.push("先补齐 VOC、关键词与全成本毛利，再决定是否投入开款");
  }

  const risks: string[] = [
    ...listingAge.risks.slice(0, 2),
    ...brandPrice.risks.slice(0, 2),
  ];
  for (const band of hardToEnterBands.slice(0, 2)) {
    risks.push(`${formatPriceBandHardToEnterMessage(band)}，常规铺货易被价格与广告成本挤压`);
  }
  if (margin.redSharePct >= 25) {
    risks.push(`TOP 样本中 ${margin.redSharePct}% 链接处于「不建议进入」毛利标签`);
  }
  if (report.stats.returnRatePct != null && report.stats.returnRatePct >= 8) {
    risks.push(`类目退货率 ${fmtPct(report.stats.returnRatePct, 2)}，立项需额外预留售后成本`);
  }
  const uniqueRisks = [...new Set(risks)].slice(0, 5);

  const recommendedActions: string[] = [
    "将 TOP 销售、上架年份、商品形态·价格带、品牌·价格带五块数据交叉验证，确定 1–2 个目标形态×价格带",
    ...listingAge.recommendedActions.slice(0, 1),
    ...brandPrice.recommendedActions.slice(0, 1),
    "对标 TOP 品牌多形态×价格带布局，拆解主图、规格与卖点组合，再进入 VOC / 关键词 / 全成本核算",
  ].slice(0, 5);

  const confidence: MarketStructureSynthesisResult["confidence"] =
    !hasEnoughData
      ? "insufficient"
      : margin.missingCount / Math.max(products.length, 1) > 0.2 ||
          listingAge.analysisScope.confidence === "low"
        ? "medium"
        : "high";

  const summary = [
    `${sampleScope} 五维链接结构综合得分 ${score}/100，判定「${verdictPack.verdict}」。`,
    crossSignals[0] ?? "",
    halfYearSalesShare >= 10
      ? `上架半年内链接近6个月销量占比 ${fmtPct(halfYearSalesShare)}，新品准入机会可继续验证。`
      : `上架半年内链接近6个月销量占比 ${fmtPct(halfYearSalesShare)}，新品准入偏弱。`,
    marginSales.favorable >= 20
      ? `优先/建议进入链接近6个月销量占比 ${fmtPct(marginSales.favorable)}。`
      : topHardBand
        ? `${topHardBand.priceBand} 属于难切入价格带，需避开低毛利主销带。`
        : "",
  ]
    .filter(Boolean)
    .join(" ");

  const finalVerdict = [
    `基于 TOP 销售、上架年份、商品形态·价格带、品牌·价格带五类分析，${report.categoryName} 类目商品链接调研结论是：${verdictPack.verdict}。`,
    halfYearSalesShare >= 10
      ? `近6个月上架半年内链接销量占比 ${fmtPct(halfYearSalesShare)}（≥10% 准入线），新品仍有机会获取销量。`
      : `近6个月上架半年内链接销量占比 ${fmtPct(halfYearSalesShare)}，新品准入需更谨慎。`,
    shapeSummaries.length >= 2
      ? `不同商品形态价格带分化明显，可在多价位做差异化。`
      : `商品形态价格带分化尚不清晰，建议先补标形态。`,
    `市场准入（毛利润）视角：优先+建议进入链接近6个月销量占比 ${fmtPct(marginSales.favorable)}。`,
    brandShapeLeaders[0]
      ? `头部组合 ${brandShapeLeaders[0].brand} · ${brandShapeLeaders[0].productShape} · ${brandShapeLeaders[0].priceBand} 值得优先拆解学习。`
      : "品牌·形态·价格带头部组合待样本补全后确认。",
    topHardBand || verdictPack.verdict === "暂缓进入" || verdictPack.verdict === "谨慎进入"
      ? "暂不建议在量大但低毛利价格带做常规同质化铺货，除非具备明显成本或产品差异。"
      : "下一步应进入 VOC、关键词与供应链成本验证，而非直接定款。",
  ].join("");

  return {
    version: "2.0.0",
    categoryName: report.categoryName,
    marketplace: report.marketplace,
    sampleScope,
    topLinkCount,
    score,
    verdict: verdictPack.verdict,
    verdictColor: verdictPack.color,
    verdictDefinition: verdictPack.definition,
    summary,
    finalVerdict,
    crossSignals,
    moduleSections,
    opportunities: opportunities.slice(0, 4),
    risks: uniqueRisks,
    recommendedActions,
    confidence,
    highlights: {
      primaryPriceBand: topBand?.priceBand ?? null,
      primaryBrandPriceBand: brandPrice.classification.primaryResearchBand,
      listingAgeType: listingAge.classification.marketType,
      marginGreenSharePct: margin.greenSharePct,
      top3ListingSharePct: report.stats.top3ProductSharePct,
      hardToEnterBands,
    },
  };
}

export function marketStructureVerdictLabel(verdict: MarketStructureVerdict) {
  return verdict;
}
