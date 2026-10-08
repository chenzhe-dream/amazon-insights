export type ProductKeywordTrendPoint = {
  month: string;
  volume: number;
  abaRank: number | null;
  cpc: number | null;
};

export type ProductKeywordRow = {
  keyword: string;
  weeklySearchRank: number | null;
  weeklySearchVolume: number | null;
  monthlySearchVolume: number | null;
  cpcExactBid: number | null;
  peakSeason: string | null;
  trend: ProductKeywordTrendPoint[];
  yearlySearchVolume: Record<string, number>;
};

export type ProductKeywordSearchReport = {
  /** Explicit saved user grouping overrides automatic regrouping. */
  manualGroups?: Record<string, {id:string;name:string;features:string[]}|null>;
  /** Saved W1–W4 labels are authoritative for the corresponding dimension summaries. */
  manualDimensions?: Record<string, {W1:string[];W2:string[];W3:string[];W4:string[]}>;
  productName: string;
  marketplace: string;
  queryMode: "keyword_extends";
  keywords: ProductKeywordRow[];
  totalCount: number;
  fetchedPages: number;
  trendEnrichedCount: number;
  /** 五维/12类分类上下文（竞品页传入品牌与产品名词） */
  classifyContext?: import("../app/keyword-classifier").ClassifyKeywordContext;
};
