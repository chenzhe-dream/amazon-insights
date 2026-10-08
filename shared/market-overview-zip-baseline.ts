export const MARKET_OVERVIEW_ZIP_RULE_VERSION = "zip-code-v1" as const;

export const MARKET_OVERVIEW_ZIP_DIMENSIONS = [
  { key: "marketDemand", max: 25 },
  { key: "marketCompetition", max: 20 },
  { key: "marketMaturity", max: 10 },
  { key: "newEntryBarrier", max: 15 },
  { key: "productOpportunity", max: 15 },
  { key: "priceOpportunity", max: 15 },
] as const;

export const MARKET_OVERVIEW_ZIP_GRADE_THRESHOLDS = [80, 70, 60, 50, 40] as const;

/** ZIP branches reach 14 product-opportunity points and 13 price-opportunity points. */
export const MARKET_OVERVIEW_ZIP_SCORE_MAX = 97 as const;
