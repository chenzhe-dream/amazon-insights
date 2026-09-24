import type { SorftimeCategoryDashboardReport as SavedReport } from "../types";
import {
  buildListingYearAnalysis,
  buildShapePriceBandAnalysis,
  buildShapeAggregatesFromPriceBandRows,
} from "./shape-price-analysis";
import { analyzeListingAgeSalesShare, buildListingAgeSalesShareInputsFromProducts } from "./listing-age-sales-share-analysis";
import { analyzeShapeSalesShare } from "./shape-sales-share-analysis";
import { analyzeShapePriceBandStructure } from "./shape-price-band-structure-analysis";
import { analyzeBrandPriceOpportunity, buildBrandPriceOpportunityInputsFromProducts } from "./brand-price-opportunity-analysis";
import { buildMarketStructureSynthesis } from "./market-structure-synthesis-analysis";
import { buildTopSalesMarginEntryConclusion, formatOnlineDateYear, formatPriceBand, isProductSalesTrendMissing } from "./sorftime-category-dashboard";
import type { SorftimeCategoryDashboardReport as OriginalReport } from "./sorftime-category-dashboard";

export type ReferenceConclusionSlot<T> = { status: "ready"; result: T } | { status: "insufficient"; reason: string };
export type ReferenceConclusions = {
  listingYear: ReferenceConclusionSlot<ReturnType<typeof analyzeListingAgeSalesShare>>;
  listingYearRows: ReferenceConclusionSlot<ReturnType<typeof buildListingYearAnalysis>>;
  margin: ReferenceConclusionSlot<ReturnType<typeof buildTopSalesMarginEntryConclusion>>;
  shapeSales: ReferenceConclusionSlot<ReturnType<typeof analyzeShapeSalesShare>>;
  shapePrice: ReferenceConclusionSlot<ReturnType<typeof analyzeShapePriceBandStructure>>;
  brandPrice: ReferenceConclusionSlot<ReturnType<typeof analyzeBrandPriceOpportunity>>;
  synthesis: ReferenceConclusionSlot<ReturnType<typeof buildMarketStructureSynthesis>>;
};

const PERIODS = ["last3Months", "last6Months", "y2024", "y2025"] as const;
const LABELS = { last3Months: "近3个月", last6Months: "近6个月", y2024: "2024", y2025: "2025" } as const;
const ready = <T,>(result: T): ReferenceConclusionSlot<T> => ({ status: "ready", result });
const insufficient = (reason: string): ReferenceConclusionSlot<never> => ({ status: "insufficient", reason });
const unavailable = (reason: string): ReferenceConclusions => ({
  listingYear: insufficient(reason), listingYearRows: insufficient(reason), margin: insufficient(reason),
  shapeSales: insufficient(reason), shapePrice: insufficient(reason), brandPrice: insufficient(reason), synthesis: insufficient(reason),
});

function missingSales(products: SavedReport["products"], periods: readonly (typeof PERIODS)[number][]): string | null {
  for (const product of products) for (const period of periods) {
    const value = product.sales?.[period];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `${product.asin} 缺少 ${LABELS[period]} 销量，当前结论数据不足`;
    }
  }
  return null;
}

/** Replays the original pure conclusion rules only when their numeric inputs are actually known. */
export function buildReferenceConclusions(
  report: SavedReport,
  assignments: Readonly<Record<string, string>>,
  selectedAsins?: readonly string[],
): ReferenceConclusions {
  const selected = selectedAsins ? new Set(selectedAsins) : null;
  const products = report.products.filter(product => selected === null || selected.has(product.asin));
  if (!products.length) return unavailable("所选范围没有 Sorftime 商品链接");

  // Each original analyzer is called only after its own required sales periods pass validation.
  const scoped = { ...report, products, topLinkCount: products.length } as OriginalReport;
  const sampleScope = `${scoped.marketplace} · ${scoped.categoryName} · TOP${scoped.topLinkCount}`;
  const shape = (asin: string) => assignments[asin]?.trim() || products.find(product => product.asin === asin)?.productShape?.trim() || "—";
  const sixMonthGap = missingSales(products, ["last6Months"]);
  const fullGap = missingSales(products, PERIODS);
  const listingYear = sixMonthGap ? insufficient(sixMonthGap) : ready(analyzeListingAgeSalesShare(buildListingAgeSalesShareInputsFromProducts(scoped.products, "last6Months"), {
    analysisDate: report.fetchedAt, salesPeriod: "last6Months", sampleScope,
    categoryName: report.categoryName, marketplace: report.marketplace,
  }));
  const margin = sixMonthGap ? insufficient(sixMonthGap) : ready(buildTopSalesMarginEntryConclusion(scoped.products, { getProductShape: shape }));
  if (fullGap) return {
    listingYear, margin,
    listingYearRows: insufficient(fullGap), shapeSales: insufficient(fullGap), shapePrice: insufficient(fullGap),
    brandPrice: insufficient(fullGap), synthesis: insufficient(fullGap),
  };
  const listingYearRows = ready(buildListingYearAnalysis(scoped.products.map(product => ({
    listingYear: formatOnlineDateYear(product.onlineDate),
    onlineDate: product.onlineDate,
    sales: product.sales,
    trendMissing: isProductSalesTrendMissing(product),
  })), { fetchedAt: report.fetchedAt }));
  const shapeRows = buildShapePriceBandAnalysis(scoped.products.map(product => ({
    productShape: shape(product.asin),
    priceBand: product.priceBand?.trim() || formatPriceBand(product.price),
    sales: product.sales,
    trendMissing: isProductSalesTrendMissing(product),
  })), { fetchedAt: report.fetchedAt });
  const shapeAggregates = buildShapeAggregatesFromPriceBandRows(shapeRows, { fetchedAt: report.fetchedAt });
  const shapeSales = ready(analyzeShapeSalesShare(shapeAggregates));
  const shapePrice = ready(analyzeShapePriceBandStructure({
    rows: shapeRows, shapeAggregates, sampleScope,
    structuralPeriod: "2024 / 2025 / 近6个月 / 近3个月",
  }));
  const brandPrice = ready(analyzeBrandPriceOpportunity(buildBrandPriceOpportunityInputsFromProducts(scoped.products, {
    getShape: shape,
  }), { analysisDate: report.fetchedAt, sampleScope, categoryName: report.categoryName, marketplace: report.marketplace }));
  const synthesis = ready(buildMarketStructureSynthesis(scoped, { getProductShape: shape }));
  return { listingYear, listingYearRows, margin, shapeSales, shapePrice, brandPrice, synthesis };
}
