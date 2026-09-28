export type SellerSpriteMarketNiche = {
  marketplace: string;
  nodeId: string;
  nodeIdPath: string;
  categoryName: string;
  categoryNameLocale: string;
  categoryPath: string;
  categoryPathLocale: string;
  fetchedAt: string;
  currency: string;
  sampleProducts: number | null;
  brands: number | null;
  sellers: number | null;
  totalProducts: number | null;
  totalUnits: number | null;
  totalRevenue: number | null;
  avgUnits: number | null;
  avgRevenue: number | null;
  avgPrice: number | null;
  avgRatings: number | null;
  avgRating: number | null;
  avgBsr: number | null;
  avgSellers: number | null;
  avgProfit: number | null;
  avgWeightLb: number | null;
  avgWeightG: number | null;
  avgVolumeIn3: number | null;
  avgVolumeCm3: number | null;
  ebcProportion: number | null;
  amazonSelfProportion: number | null;
  fbaProportion: number | null;
  fbmProportion: number | null;
  sellerNationLabel: string;
  sellerNationShare: number | null;
  returnRatio: number | null;
  avgReturnRatio: number | null;
  searchToPurchaseRatio: number | null;
  hlAvgUnits: number | null;
  hlAvgRevenue: number | null;
  hlAvgBsr: number | null;
  hlAvgPrice: number | null;
  hlAvgRating: number | null;
  productCrn: number | null;
  brandCrn: number | null;
  sellerCrn: number | null;
  newCount: number | null;
  newRatio: number | null;
  newAvgPrice: number | null;
  newAvgRatings: number | null;
  newAvgRating: number | null;
  newAvgUnits: number | null;
  newAvgRevenue: number | null;
  firstShelfDate: string | null;
  lastShelfDate: string | null;
  topImages: Array<{ asin: string; image: string }>;
};

export type SellerSpriteDistProduct = {
  asin: string;
  title?: string;
  units?: number | null;
  price?: number | null;
  rating?: number | null;
  ratings?: number | null;
  imageUrl?: string;
  profit?: number | null;
  fba?: number | null;
};

/** 卖家精灵 competitor_lookup 返回的单 ASIN 毛利率（%） */
export type SellerSpriteAsinProfit = {
  profit: number | null;
  price: number | null;
  fba: number | null;
};

export type SellerSpriteDistRow = {
  label: string;
  products: number | null;
  units: number | null;
  unitsShare: number | null;
  revenue: number | null;
  rating: number | null;
  ratings: number | null;
  asinRatio: number | null;
  avgUnitsShare?: number | null;
  asins?: string[];
  items?: SellerSpriteDistProduct[];
};

export type SellerSpriteCrnRow = {
  rank: number;
  label: string;
  asin?: string;
  imageUrl?: string;
  products: number | null;
  newProducts: number | null;
  isNew: boolean;
  units: number | null;
  newUnits: number | null;
  unitsShare: number | null;
  newUnitsShare: number | null;
  revenue: number | null;
  newRevenue: number | null;
  revenueShare: number | null;
  newRevenueShare: number | null;
  asins?: string[];
  items?: SellerSpriteDistProduct[];
};

export type SellerSpriteTrendPoint = {
  month: string;
  value: number;
};

export type SellerSpriteKeywordTrend = {
  keyword: string;
  searches: number | null;
  points: SellerSpriteTrendPoint[];
};

/** 卖家精灵集中度默认按 Top100 样本聚合；旧缓存无此字段时需重新拉取 */
export const SELLERSPRITE_CONCENTRATION_SAMPLE = 100;
export const SELLERSPRITE_REPORT_VERSION = 5;

export type SellerSpriteProductDemand = {
  asinCount: number | null;
  returnRatio: number | null;
  avgReturnRatio: number | null;
  searchToPurchaseRatio: number | null;
  avgSearchToPurchaseRatio: number | null;
  pageViews: SellerSpriteTrendPoint[];
  updatedAt: string | null;
};

export type SellerSpriteMarketReport = {
  reportVersion?: number;
  sampleSize: number;
  concentrationSampleSize: number;
  productDemand: SellerSpriteProductDemand | null;
  products: SellerSpriteCrnRow[];
  brands: SellerSpriteCrnRow[];
  sellers: SellerSpriteCrnRow[];
  sellerTypes: SellerSpriteDistRow[];
  ebc: SellerSpriteDistRow[];
  countries: SellerSpriteDistRow[];
  listingAge: SellerSpriteDistRow[];
  listingTrend: SellerSpriteDistRow[];
  ratingCounts: SellerSpriteDistRow[];
  ratingValues: SellerSpriteDistRow[];
  prices: SellerSpriteDistRow[];
  keywordTrends: SellerSpriteKeywordTrend[];
  keywordSource?: "category-keywords" | "keyword-research";
  salesTrend: SellerSpriteTrendPoint[];
  salesAmountTrend: SellerSpriteTrendPoint[];
  /** 价格带样本 ASIN 的卖家精灵毛利率（competitor_lookup） */
  asinProfits?: Record<string, SellerSpriteAsinProfit>;
};

export const MARKET_REPORT_SECTIONS = [
  { id: "overview", title: "市场概览" },
  { id: "demand-keywords", title: "行业需求及趋势" },
  { id: "sales-trend", title: "行业销售趋势" },
  { id: "product-crn", title: "商品集中度" },
  { id: "brand-crn", title: "品牌集中度" },
  { id: "seller-crn", title: "卖家集中度" },
  { id: "seller-type", title: "卖家类型分布" },
  { id: "ebc", title: "A+视频分布" },
  { id: "seller-country", title: "卖家所属地分布" },
  { id: "product-demand", title: "商品需求趋势" },
  { id: "listing-age", title: "上架时间分布" },
  { id: "listing-trend", title: "上架趋势分布" },
  { id: "rating-count", title: "评分数分布" },
  { id: "rating-value", title: "评分值分布" },
  { id: "price", title: "价格分布" },
] as const;

export type MarketReportSectionId = (typeof MARKET_REPORT_SECTIONS)[number]["id"];

export function pickCrnKey(topN: number) {
  if (topN <= 5) return "top5" as const;
  if (topN <= 10) return "top10" as const;
  return "top20" as const;
}

export function pickNewKey(months: number) {
  if (months <= 1) return "l1" as const;
  if (months <= 3) return "l3" as const;
  if (months <= 6) return "l6" as const;
  return "l12" as const;
}

export function nicheBreadcrumb(niche: Pick<SellerSpriteMarketNiche, "categoryPath">) {
  return niche.categoryPath.replace(/ › /g, " > ");
}
