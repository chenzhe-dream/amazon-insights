import {CURRENT_SHAPE_CALCULATION_VERSION} from '../../../shared/market-shape-calculation-version';
import type { SorftimeCategoryDashboardReport as SavedReport } from "../types";
import { resolveProductPriceBand,referencePeriodContribution,hasReferencePeriodDateConflict,parseReferenceListingDate,resolveReferenceProductShape } from '../rules';
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

export type ReferenceConclusionSlot<T> =
  | { status: "ready"; result: T; warnings?: readonly string[]; scope?: {included:number;total:number;excludedAsins:string[]} }
  | { status: "insufficient"; reason: string };
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
  allowedShapes?: readonly string[],
): ReferenceConclusions {
  const current = (report.calculationVersion ?? CURRENT_SHAPE_CALCULATION_VERSION) === CURRENT_SHAPE_CALCULATION_VERSION;
  const selected = selectedAsins ? new Set(selectedAsins) : null;
  const sourceProducts=report.products.filter(product => selected === null || selected.has(product.asin));
  const conflicting=sourceProducts.find(product=>PERIODS.some(period=>hasReferencePeriodDateConflict(product,period,report.calculationVersion)));
  const products = sourceProducts.map(product=>({...product,...(current?{priceBand:resolveProductPriceBand(product)}:{}),sales:{...product.sales,
    y2024:referencePeriodContribution(product,'y2024',report.calculationVersion),y2025:referencePeriodContribution(product,'y2025',report.calculationVersion),
  }}));
  if (!products.length) return unavailable("所选范围没有 Sorftime 商品链接");

  // Each original analyzer is called only after its own required sales periods pass validation.
  const scoped = { ...report, products, topLinkCount: products.length } as OriginalReport;
  const sampleScope = `${scoped.marketplace} · ${scoped.categoryName} · TOP${scoped.topLinkCount}`;
  const shape = (asin: string) => {
    const product = products.find(item => item.asin === asin);
    const value = report.calculationVersion==='shape-reference/1'?assignments[asin]?.trim()||product?.productShape?.trim()||'—':product ? resolveReferenceProductShape(product, assignments) : '—';
    return value === '未分类' || (allowedShapes?.length && value !== '—' && !allowedShapes.includes(value)) ? '—' : value;
  };
  const sixMonthGap = missingSales(products, ["last6Months"]);
  const recentGap = missingSales(products, ["last3Months", "last6Months"]);
  const uncertainDate = report.calculationVersion === 'shape-reference/1' ? null : products.find(product => (current ? parseReferenceListingDate(product.onlineDate).status !== 'known' : parseReferenceListingDate(product.onlineDate).status === 'uncertain'));
  const listingDateGap = uncertainDate ? `${uncertainDate.asin} 上市日期待核实，当前结论数据不足` : null;
  const fullGap = conflicting?`${conflicting.asin} 年度销量与上市日期冲突，当前结论数据不足`:missingSales(products, PERIODS);
  const listingYear = sixMonthGap || listingDateGap ? insufficient(sixMonthGap ?? listingDateGap!) : ready(analyzeListingAgeSalesShare(buildListingAgeSalesShareInputsFromProducts(scoped.products, "last6Months"), {
    analysisDate: report.fetchedAt, salesPeriod: "last6Months", sampleScope,
    categoryName: report.categoryName, marketplace: report.marketplace,
  }));
  const priceMissing = current ? products.find(p => !(typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0) && (!p.priceBand?.trim() || p.priceBand === '—')) : null;
  const priceGap = priceMissing ? `${priceMissing.asin} 缺少价格及价格带，当前结论数据不足` : null;
  const marginMissing = current ? products.find(p => typeof p.grossProfitMargin !== 'number' || !Number.isFinite(p.grossProfitMargin)) : null;
  const marginGap = marginMissing ? `${marginMissing.asin} 缺少毛利润率，综合结论数据不足` : null;
  const allMarginsMissing = current && products.every(p => typeof p.grossProfitMargin !== 'number' || !Number.isFinite(p.grossProfitMargin));
  const marginBlock = sixMonthGap ?? priceGap ?? (allMarginsMissing ? marginGap : null);
  const margin = marginBlock ? insufficient(marginBlock) : ready(buildTopSalesMarginEntryConclusion(scoped.products, { getProductShape: shape }));
  const brandPrice = recentGap || priceGap ? insufficient(recentGap ?? priceGap!) : ready(analyzeBrandPriceOpportunity(buildBrandPriceOpportunityInputsFromProducts(scoped.products, {
    getShape: shape,
  }), { analysisDate: report.fetchedAt, sampleScope, categoryName: report.categoryName, marketplace: report.marketplace }));
  if (!current && fullGap) return {
    listingYear, margin,
    listingYearRows: insufficient(fullGap), shapeSales: insufficient(fullGap), shapePrice: insufficient(fullGap),
    brandPrice: report.calculationVersion === 'shape-reference/1' ? insufficient(fullGap) : brandPrice,
    synthesis: insufficient(fullGap),
  };
  const listingYearRows = fullGap || listingDateGap ? insufficient(fullGap ?? listingDateGap!) : ready(buildListingYearAnalysis(scoped.products.map(product => ({
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
  // Annual shares are optional to the price structure analyzer. Do not let
  // the original row builder's missing-as-zero fallback turn them into evidence.
  if (current) for (const period of ['y2024','y2025'] as const) {
    if (missingSales(products,[period])) {
      for (const row of shapeRows) row[`${period}SharePct`] = null;
      for (const row of shapeAggregates) row[`${period}SharePct`] = null;
    }
  }
  const shapeSalesGap = current ? missingSales(products,['last3Months','last6Months','y2024']) : fullGap;
  const shapeSales = shapeSalesGap ? insufficient(shapeSalesGap) : ready(analyzeShapeSalesShare(shapeAggregates));
  const shapePriceGap = recentGap ?? priceGap;
  const shapePrice = shapePriceGap ? insufficient(shapePriceGap) : ready(analyzeShapePriceBandStructure({
    rows: shapeRows, shapeAggregates, sampleScope,
    structuralPeriod: "2024 / 2025 / 近6个月 / 近3个月",
  }));
  const synthesisGap = (current ? recentGap ?? (allMarginsMissing ? marginGap : null) : fullGap) ?? listingDateGap;
  const synthesisWarnings = current ? [priceGap, !allMarginsMissing ? marginGap : null].filter((value): value is string => Boolean(value)) : [];
  const synthesis = synthesisGap
    ? insufficient(synthesisGap)
    : { status: "ready" as const, result: buildMarketStructureSynthesis(scoped, { getProductShape: shape }), ...(synthesisWarnings.length ? { warnings: synthesisWarnings } : {}) };
  return { listingYear, listingYearRows, margin, shapeSales, shapePrice, brandPrice, synthesis };
}
