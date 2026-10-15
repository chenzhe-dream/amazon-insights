// Explicit read allowlists. Unknown tools (including mutations) bypass persistence.
const reads = {
  sellerSprite: new Set([
    'product_node','market_research','market_research_statistics','market_brand_concentration',
    'market_ebc_distribution','market_listing_date_distribution','market_listing_trend_distribution',
    'market_price_distribution','market_product_demand_trend','market_rating_distribution',
    'market_ratings_count_distribution','market_seller_concentration','market_seller_country_distribution',
    'market_seller_type_concentration','market_product_concentration','keyword_research',
    'aba_research_trend','competitor_lookup','asin_detail','asin_sales_trend','review',
  ]),
  sif: new Set([
    'market_get_asin_keyword_signals','market_get_keyword_history','market_assess_keyword_promotion',
    'ops_get_listing_traffic_overview','ops_get_listing_traffic_structure','ops_get_asin_traffic_trend',
  ]),
};

export function sharedProviderTtl(provider, tool, payload) {
  if (!reads[provider]?.has(tool)) return 0;
  const data = payload?.data ?? payload;
  if ([data, data?.items, data?.details, data?.keywords, data?.top_keywords, data?.assessments].some(value => Array.isArray(value) && value.length === 0)) return 300_000;
  return (tool === 'asin_detail' || tool === 'competitor_lookup' ? 6 : 24) * 3600_000;
}
