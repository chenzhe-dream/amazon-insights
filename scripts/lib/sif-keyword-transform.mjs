import { adaptSifKeywordResponse } from "./sif-keyword-strict-adapter.mjs";

export function buildSifKeywordAnalysis(asin, marketplace, payload, fetchedAt, queryWindow) {
  const adapted = adaptSifKeywordResponse(payload, asin, marketplace);
  if (adapted.kind === "schema-invalid") {
    return {
      asin,
      marketplace,
      fetchedAt,
      queryWindow: queryWindow ?? null,
      status: "schema-error",
      terminalReason: "schema-invalid",
      errorCode: adapted.errorCode,
      statusMessage: adapted.message,
      totalKeywordsInPeriod: null,
      topKeywordsAnalyzed: 0,
      keywords: [],
    };
  }

  const topKeywords = adapted.topKeywords;
  if (!topKeywords.length) {
    return {
      asin,
      marketplace,
      fetchedAt,
      queryWindow: queryWindow ?? null,
      status: "empty",
      terminalReason: "valid-empty",
      statusMessage: adapted.dataNotice ?? "SIF 未返回关键词",
      totalKeywordsInPeriod: adapted.summary?.total_keywords_in_period ?? null,
      topKeywordsAnalyzed: 0,
      keywords: [],
    };
  }

  const keywords = topKeywords.map(row => ({
    keyword: row.keyword,
    trafficShare: typeof row.traffic_share === "number" ? row.traffic_share * 100 : null,
    searchVolume: row.search_volume ?? null,
    abaRank: row.aba_rank ?? null,
    cpcMedian: row.cpc_median ?? null,
    cpcLow: row.cpc_low ?? row.cpc_min ?? null,
    cpcHigh: row.cpc_high ?? row.cpc_max ?? null,
    naturalRatio: typeof row.natural_ratio === "number" ? row.natural_ratio * 100 : null,
    trafficDependency: row.traffic_dependency ?? null,
    organicRank: row.organic_rank ?? null,
    rankEvolution: row.rank_evolution ?? null,
    keywordHealth: row.keyword_health ?? null,
    top3ClickShare: typeof row.top3_click_share === "number" ? row.top3_click_share * 100 : null,
    top3ConversionShare: typeof row.top3_conversion_share === "number" ? row.top3_conversion_share * 100 : null,
    clickConversionRate:
      typeof row.click_conversion_rate === "number"
        ? row.click_conversion_rate * (row.click_conversion_rate <= 1 ? 100 : 1)
        : typeof row.keyword_click_cvr === "number"
          ? row.keyword_click_cvr * (row.keyword_click_cvr <= 1 ? 100 : 1)
          : null,
  }));

  return {
    asin,
    marketplace,
    fetchedAt,
    status: "ready",
    queryWindow: queryWindow ?? null,
    totalKeywordsInPeriod: adapted.summary?.total_keywords_in_period ?? null,
    topKeywordsAnalyzed: adapted.summary?.top_keywords_analyzed ?? keywords.length,
    dataNotice: adapted.dataNotice,
    keywords,
  };
}

export function normalizeKeywordKey(keyword) {
  return keyword.trim().toLowerCase();
}

export function buildKeywordEnrichment(keyword, historyEntry, promotionEntry) {
  const dates = historyEntry?.dates ?? [];
  const volumes = historyEntry?.volumes ?? [];
  const ranks = historyEntry?.ranks ?? [];
  const start = Math.max(0, dates.length - 12);
  const searchTrend = dates.slice(start).map((month, index) => {
    const idx = start + index;
    return {
      month,
      volume: volumes[idx] ?? 0,
      abaRank: ranks[idx] ?? 0,
    };
  });

  const signals = promotionEntry?.supporting_signals ?? {};
  const listingLoss = signals.listing_loss_rate;
  const clickConversionRate =
    listingLoss != null
      ? Math.round((1 - listingLoss) * 1000) / 10
      : promotionEntry?.click_conversion_rate != null
        ? promotionEntry.click_conversion_rate
        : null;

  const latest = historyEntry?.latest ?? {};
  const top3ClickShare =
    typeof latest.top3_click_share === "number"
      ? latest.top3_click_share * 100
      : typeof signals.top_click_concentration === "number"
        ? signals.top_click_concentration * 100
        : null;
  const top3ConversionShare =
    typeof latest.top3_conversion_share === "number"
      ? latest.top3_conversion_share * 100
      : typeof signals.top_conversion_concentration === "number"
        ? signals.top_conversion_concentration * 100
        : null;

  return {
    keyword,
    searchTrend,
    bidLow: signals.cpc_fixed_exact_low ?? null,
    bidMedian: signals.cpc_fixed_exact ?? null,
    bidHigh: signals.cpc_fixed_exact_high ?? null,
    clickConversionRate,
    top3ClickShare,
    top3ConversionShare,
  };
}
