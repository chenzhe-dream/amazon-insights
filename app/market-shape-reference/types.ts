/** Saved Sorftime category dashboard payload, with unavailable source numbers left unknown. */
export type SorftimeTrendPoint = { month: string; value: number | null };

export type SorftimeProductSalesSummary = {
  last3Months: number | null;
  last6Months: number | null;
  y2024: number | null;
  y2025: number | null;
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
  monthlySalesVolume: number | null;
  monthlySalesAmount: number | null;
  sales: SorftimeProductSalesSummary;
  salesHistory?: {
    status: 'queued' | 'running' | 'ready' | 'partial' | 'empty' | 'failed' | 'cancelled';
    errorCode: string | null;
  };
  monthlyTrend: SorftimeProductMonthlyTrend;
  price: number | null;
  categoryRank: string;
  productCategory: string;
  productShape: string;
  productShapeHint: string | null;
  bsrRank: number | null;
  deliveryType: string;
  reviewCount: number | null;
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
    top100MonthlyVolume: number | null;
    top100MonthlyAmount: number | null;
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
