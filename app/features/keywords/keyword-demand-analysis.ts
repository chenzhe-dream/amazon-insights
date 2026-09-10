import {
  classifyKeyword,
  categoryMeta,
  keywordMeaningGroups,
  keywordMeaningTaxonomy,
  type ClassifyKeywordContext,
  type KeywordCategory,
  type KeywordMeaningGroup,
} from "./keyword-classifier";
import {
  sifKeywordAnalysisData,
  sifKeywordAnalysisMeta,
  type SifKeywordAnalysisRecord,
  type SifKeywordRecord,
} from "../../sif-keyword-analysis-data";
import {
  sifKeywordEnrichmentData,
  type KeywordSearchTrendPoint,
} from "../../sif-keyword-enrichment-data";

export type KeywordDemandProduct = {
  asin: string;
  brand: string;
  title?: string;
  subRankCategory?: string;
  image?: string;
  price?: number | null;
};

export type KeywordDemandSources = Readonly<{
  analysisByAsin?: typeof sifKeywordAnalysisData;
  enrichmentByKeyword?: typeof sifKeywordEnrichmentData;
}>;

export type ClassifiedKeyword = SifKeywordRecord & {
  category: KeywordCategory;
  categoryLabel: string;
  categoryDescription: string;
};

export type AggregatedKeyword = {
  keyword: string;
  category: KeywordCategory;
  categoryLabel: string;
  aggregateShare: number;
  maxShare: number;
  searchVolume: number | null;
  abaRank: number | null;
  competitorCount: number;
  competitors: Array<{ asin: string; brand: string; trafficShare: number | null }>;
  listingHint: string;
};

export type CategoryBucket = {
  id: KeywordCategory;
  label: string;
  shortLabel: string;
  description: string;
  group: KeywordMeaningGroup;
  groupLabel: string;
  color: string;
  listingHint: string;
  keywordCount: number;
  shareSum: number;
  sharePct: number;
  insight: string;
  keywords: AggregatedKeyword[];
};

export type CategoryGroupBucket = {
  id: KeywordMeaningGroup;
  label: string;
  keywordCount: number;
  sharePct: number;
  categories: CategoryBucket[];
};

export type CompetitorKeywordMix = {
  asin: string;
  brand: string;
  image?: string;
  status: SifKeywordAnalysisRecord["status"];
  totalKeywordsInPeriod: number | null;
  topKeywordsAnalyzed: number;
  mix: Array<{ id: KeywordCategory; label: string; count: number; shareSum: number; sharePct: number }>;
  keywords: ClassifiedKeyword[];
};

export type KeywordDemandAnalysis = {
  meta: typeof sifKeywordAnalysisMeta & {
    asinCount: number;
    readyCount: number;
    totalKeywords: number;
    uniqueKeywords: number;
    taxonomyVersion: string;
  };
  headline: string;
  summaryInsight: string;
  categories: CategoryBucket[];
  categoryGroups: CategoryGroupBucket[];
  topCategories: CategoryBucket[];
  competitorBreakdown: CompetitorKeywordMix[];
  hasData: boolean;
};

export type KeywordComparisonMatrixCell = {
  asin: string;
  brand: string;
  image?: string;
  trafficShare: number | null;
  isTop: boolean;
};

export type KeywordComparisonMatrixRow = {
  keyword: string;
  category: KeywordCategory;
  categoryLabel: string;
  categoryColor: string;
  searchVolume: number | null;
  searchVolumeMonth: string | null;
  abaRank: number | null;
  coverageCount: number;
  coverageTotal: number;
  maxShare: number;
  searchTrend: KeywordSearchTrendPoint[];
  bidLow: number | null;
  bidMedian: number | null;
  bidHigh: number | null;
  clickConversionRate: number | null;
  top3ClickShare: number | null;
  top3ConversionShare: number | null;
  cells: KeywordComparisonMatrixCell[];
};

export type KeywordComparisonMatrix = {
  competitors: Array<{ asin: string; brand: string; image?: string; ready: boolean }>;
  rows: KeywordComparisonMatrixRow[];
  totalRows: number;
};

const TAXONOMY_VERSION = "meaning-v2-12";

function normalizeKeyword(keyword: string) {
  return keyword.trim().toLowerCase();
}

function resolveAbaRank(trend: KeywordSearchTrendPoint[], fromSignals: number | null | undefined) {
  for (let index = trend.length - 1; index >= 0; index -= 1) {
    const rank = trend[index]?.abaRank;
    if (rank != null && rank > 0) return rank;
  }
  if (fromSignals != null && fromSignals > 0) return fromSignals;
  return null;
}

/** 与月搜索趋势同源：优先 keyword_history 最近完整月，回退 ASIN 反查词快照 */
export function resolveKeywordSearchVolume(
  trend: KeywordSearchTrendPoint[],
  fallback: number | null | undefined,
) {
  if (trend.length) {
    const latest = trend[trend.length - 1];
    if (latest.volume > 0) {
      return { volume: latest.volume, month: latest.month, source: "history" as const };
    }
  }
  if (fallback != null && fallback > 0) {
    return { volume: fallback, month: null, source: "asin_signals" as const };
  }
  return { volume: null, month: null, source: "none" as const };
}

function pickBetterAbaRank(current: number | null | undefined, next: number | null | undefined) {
  if (next == null || next <= 0) return current ?? null;
  if (current == null || current <= 0) return next;
  return Math.min(current, next);
}

function buildClassifyContext(products: KeywordDemandProduct[]): ClassifyKeywordContext {
  const brands = products.map(item => item.brand).filter(Boolean);
  const subCategory = products.find(item => item.subRankCategory)?.subRankCategory ?? "";
  const productNouns: string[] = [];
  if (/scooter/i.test(subCategory)) productNouns.push("scooter", "scooters", "kick scooter");
  if (/lamp|light/i.test(subCategory)) productNouns.push("lamp", "floor lamp", "light");
  if (/furniture/i.test(subCategory)) productNouns.push("furniture");
  return { brands, productNouns };
}

function classifyRow(row: SifKeywordRecord, context: ClassifyKeywordContext): ClassifiedKeyword {
  const category = classifyKeyword(row.keyword, context);
  const meta = categoryMeta(category);
  return { ...row, category, categoryLabel: meta.label, categoryDescription: meta.description };
}

function buildCategoryInsight(meta: ReturnType<typeof categoryMeta>, keywords: AggregatedKeyword[]) {
  if (!keywords.length) return `暂无${meta.label}，可结合 VOC 与标题结构补充。`;
  const top = keywords.slice(0, 3).map(item => item.keyword).join("、");
  return `${meta.description} · 高频词：${top}`;
}

export function buildKeywordDemandAnalysis(
  products: KeywordDemandProduct[],
  sources: KeywordDemandSources = {},
): KeywordDemandAnalysis {
  const analysisByAsin = sources.analysisByAsin ?? sifKeywordAnalysisData;
  const context = buildClassifyContext(products);
  const readyRecords = products
    .map(product => ({ product, record: analysisByAsin[product.asin] }))
    .filter(item => item.record?.status === "ready" && item.record.keywords.length);

  const aggregateMap = new Map<
    string,
    {
      keyword: string;
      category: KeywordCategory;
      searchVolume: number | null;
      abaRank: number | null;
      shareSum: number;
      maxShare: number;
      competitors: Array<{ asin: string; brand: string; trafficShare: number | null }>;
    }
  >();

  for (const { product, record } of readyRecords) {
    for (const row of record!.keywords) {
      const classified = classifyRow(row, context);
      const key = `${classified.category}::${normalizeKeyword(classified.keyword)}`;
      const share = classified.trafficShare ?? 0;
      const existing = aggregateMap.get(key);
      if (existing) {
        existing.shareSum += share;
        existing.maxShare = Math.max(existing.maxShare, share);
        existing.competitors.push({ asin: product.asin, brand: product.brand, trafficShare: classified.trafficShare });
        if (classified.searchVolume != null && (existing.searchVolume == null || classified.searchVolume > existing.searchVolume)) {
          existing.searchVolume = classified.searchVolume;
        }
        if (classified.abaRank != null && (existing.abaRank == null || classified.abaRank < existing.abaRank)) {
          existing.abaRank = classified.abaRank;
        }
      } else {
        aggregateMap.set(key, {
          keyword: classified.keyword,
          category: classified.category,
          searchVolume: classified.searchVolume,
          abaRank: classified.abaRank,
          shareSum: share,
          maxShare: share,
          competitors: [{ asin: product.asin, brand: product.brand, trafficShare: classified.trafficShare }],
        });
      }
    }
  }

  const aggregated = [...aggregateMap.values()].map(item => {
    const meta = categoryMeta(item.category);
    const competitorCount = item.competitors.length;
    return {
      keyword: item.keyword,
      category: item.category,
      categoryLabel: meta.label,
      aggregateShare: item.shareSum / competitorCount,
      maxShare: item.maxShare,
      searchVolume: item.searchVolume,
      abaRank: item.abaRank,
      competitorCount,
      competitors: item.competitors.sort((a, b) => (b.trafficShare ?? 0) - (a.trafficShare ?? 0)),
      listingHint: meta.listingHint,
    } satisfies AggregatedKeyword;
  });

  const totalShare = aggregated.reduce((sum, item) => sum + item.aggregateShare, 0);

  const categories: CategoryBucket[] = keywordMeaningTaxonomy.map(meta => {
    const keywords = aggregated
      .filter(item => item.category === meta.id)
      .sort((a, b) => b.aggregateShare - a.aggregateShare || b.competitorCount - a.competitorCount);
    const shareSum = keywords.reduce((sum, item) => sum + item.aggregateShare, 0);
    return {
      id: meta.id,
      label: meta.label,
      shortLabel: meta.shortLabel,
      description: meta.description,
      group: meta.group,
      groupLabel: meta.groupLabel,
      color: meta.color,
      listingHint: meta.listingHint,
      keywordCount: keywords.length,
      shareSum,
      sharePct: totalShare > 0 ? (shareSum / totalShare) * 100 : 0,
      insight: buildCategoryInsight(meta, keywords),
      keywords,
    };
  });

  const categoryGroups: CategoryGroupBucket[] = keywordMeaningGroups
    .map(group => {
      const groupCategories = categories.filter(item => item.group === group.id && item.keywordCount > 0);
      const keywordCount = groupCategories.reduce((sum, item) => sum + item.keywordCount, 0);
      const sharePct = groupCategories.reduce((sum, item) => sum + item.sharePct, 0);
      return { id: group.id, label: group.label, keywordCount, sharePct, categories: groupCategories };
    })
    .filter(item => item.keywordCount > 0)
    .sort((a, b) => b.sharePct - a.sharePct || b.keywordCount - a.keywordCount || a.label.localeCompare(b.label, "zh-CN"));

  const topCategories = categories.filter(item => item.keywordCount > 0).sort((a, b) => b.sharePct - a.sharePct);

  const competitorBreakdown: CompetitorKeywordMix[] = products.map(product => {
    const record = analysisByAsin[product.asin];
    const keywords = (record?.keywords ?? []).map(row => classifyRow(row, context));
    const mix = keywordMeaningTaxonomy.map(meta => {
      const rows = keywords.filter(item => item.category === meta.id);
      const shareSum = rows.reduce((sum, item) => sum + (item.trafficShare ?? 0), 0);
      const total = keywords.reduce((sum, item) => sum + (item.trafficShare ?? 0), 0);
      return {
        id: meta.id,
        label: meta.shortLabel,
        count: rows.length,
        shareSum,
        sharePct: total > 0 ? (shareSum / total) * 100 : 0,
      };
    });
    return {
      asin: product.asin,
      brand: product.brand,
      image: product.image,
      status: record?.status ?? "empty",
      totalKeywordsInPeriod: record?.totalKeywordsInPeriod ?? null,
      topKeywordsAnalyzed: record?.topKeywordsAnalyzed ?? 0,
      mix,
      keywords: keywords.sort((a, b) => (b.trafficShare ?? 0) - (a.trafficShare ?? 0)),
    };
  });

  const readyCount = competitorBreakdown.filter(item => item.status === "ready").length;
  const totalKeywords = competitorBreakdown.reduce((sum, item) => sum + item.keywords.length, 0);
  const uniqueKeywords = aggregated.length;
  const dominant = topCategories[0];

  const headline =
    readyCount === 0
      ? "等待 SIF 反查流量词同步"
      : `竞品流量词以${dominant?.label ?? "产品词"}为主（约 ${dominant?.sharePct.toFixed(0) ?? 0}% 流量份额）`;

  const activeGroups = categoryGroups.slice(0, 3).map(item => `${item.label} ${item.sharePct.toFixed(0)}%`).join(" · ");
  const summaryInsight =
    readyCount === 0
      ? "运行 npm run keywords:sync 拉取 SIF 反查流量词后，将按 12 类关键词标签自动分类。"
      : `已分析 ${readyCount} 个竞品、${uniqueKeywords} 个去重词 · 12 类标签 · 结构：${activeGroups || "待补充"}`;

  return {
    meta: {
      ...sifKeywordAnalysisMeta,
      asinCount: products.length,
      readyCount,
      totalKeywords,
      uniqueKeywords,
      taxonomyVersion: TAXONOMY_VERSION,
    },
    headline,
    summaryInsight,
    categories,
    categoryGroups,
    topCategories,
    competitorBreakdown,
    hasData: readyCount > 0,
  };
}

export function hasKeywordDemandData(products: KeywordDemandProduct[], sources: KeywordDemandSources = {}) {
  return buildKeywordDemandAnalysis(products, sources).hasData;
}

/** 跨竞品流量词对比矩阵：行=关键词，列=竞品，单元格=流量占比 */
export function buildKeywordComparisonMatrix(
  products: KeywordDemandProduct[],
  options: {
    category?: KeywordCategory | "all";
    limit?: number;
    /** 截取 limit 前的主排序；默认按共享率（有效竞品数） */
    sortBy?: "coverage" | "volume" | "aba";
    sortDir?: "asc" | "desc";
    sources?: KeywordDemandSources;
  } = {},
): KeywordComparisonMatrix {
  const analysisByAsin = options.sources?.analysisByAsin ?? sifKeywordAnalysisData;
  const enrichmentByKeyword = options.sources?.enrichmentByKeyword ?? sifKeywordEnrichmentData;
  const context = buildClassifyContext(products);
  const categoryFilter = options.category ?? "all";
  const limit = options.limit ?? 200;
  const sortBy = options.sortBy ?? "coverage";
  const sortDir = options.sortDir ?? "desc";

  const competitors = products.map(product => {
    const record = analysisByAsin[product.asin];
    return {
      asin: product.asin,
      brand: product.brand,
      image: product.image,
      ready: record?.status === "ready",
    };
  });

  const readyAsins = new Set(competitors.filter(item => item.ready).map(item => item.asin));
  const coverageTotal = readyAsins.size;

  const rowMap = new Map<
    string,
    {
      keyword: string;
      category: KeywordCategory;
      searchVolume: number | null;
      abaRank: number | null;
      cpcLow: number | null;
      cpcMedian: number | null;
      cpcHigh: number | null;
      clickConversionRate: number | null;
      top3ClickShare: number | null;
      top3ConversionShare: number | null;
      shares: Map<string, number | null>;
    }
  >();

  for (const product of products) {
    const record = analysisByAsin[product.asin];
    if (record?.status !== "ready") continue;
    for (const row of record.keywords) {
      const classified = classifyRow(row, context);
      if (categoryFilter !== "all" && classified.category !== categoryFilter) continue;

      const key = normalizeKeyword(classified.keyword);
      const existing = rowMap.get(key);
      if (existing) {
        const prev = existing.shares.get(product.asin);
        const next = classified.trafficShare;
        if (next != null && (prev == null || next > prev)) {
          existing.shares.set(product.asin, next);
        }
        if (classified.searchVolume != null && (existing.searchVolume == null || classified.searchVolume > existing.searchVolume)) {
          existing.searchVolume = classified.searchVolume;
        }
        existing.abaRank = pickBetterAbaRank(existing.abaRank, classified.abaRank);
        existing.cpcLow ??= row.cpcLow ?? null;
        existing.cpcMedian ??= row.cpcMedian ?? null;
        existing.cpcHigh ??= row.cpcHigh ?? null;
        existing.clickConversionRate ??= row.clickConversionRate ?? null;
        existing.top3ClickShare = Math.max(existing.top3ClickShare ?? 0, row.top3ClickShare ?? 0) || existing.top3ClickShare;
        existing.top3ConversionShare =
          Math.max(existing.top3ConversionShare ?? 0, row.top3ConversionShare ?? 0) || existing.top3ConversionShare;
      } else {
        const shares = new Map<string, number | null>();
        shares.set(product.asin, classified.trafficShare);
        rowMap.set(key, {
          keyword: classified.keyword,
          category: classified.category,
          searchVolume: classified.searchVolume,
          abaRank: classified.abaRank ?? null,
          cpcLow: row.cpcLow ?? null,
          cpcMedian: row.cpcMedian ?? null,
          cpcHigh: row.cpcHigh ?? null,
          clickConversionRate: row.clickConversionRate ?? null,
          top3ClickShare: row.top3ClickShare ?? null,
          top3ConversionShare: row.top3ConversionShare ?? null,
          shares,
        });
      }
    }
  }

  const rows: KeywordComparisonMatrixRow[] = [...rowMap.values()]
    .map(item => {
      const meta = categoryMeta(item.category);
      const enrich = enrichmentByKeyword[normalizeKeyword(item.keyword)];
      const searchTrend = enrich?.searchTrend ?? [];
      const cells: KeywordComparisonMatrixCell[] = competitors.map(competitor => ({
        asin: competitor.asin,
        brand: competitor.brand,
        image: competitor.image,
        trafficShare: item.shares.get(competitor.asin) ?? null,
        isTop: false,
      }));

      const ranked = cells
        .filter(cell => cell.trafficShare != null && cell.trafficShare > 0)
        .sort((a, b) => (b.trafficShare ?? 0) - (a.trafficShare ?? 0));
      const maxShare = ranked[0]?.trafficShare ?? 0;
      const topShare = maxShare;
      for (const cell of cells) {
        cell.isTop = cell.trafficShare != null && cell.trafficShare > 0 && cell.trafficShare === topShare;
      }

      const coverageCount = cells.filter(cell => cell.trafficShare != null && cell.trafficShare > 0).length;
      const volumeInfo = resolveKeywordSearchVolume(searchTrend, item.searchVolume);

      return {
        keyword: item.keyword,
        category: item.category,
        categoryLabel: meta.label,
        categoryColor: meta.color,
        searchVolume: volumeInfo.volume,
        searchVolumeMonth: volumeInfo.month,
        abaRank: resolveAbaRank(searchTrend, item.abaRank),
        coverageCount,
        coverageTotal,
        maxShare,
        searchTrend,
        bidLow: item.cpcLow ?? enrich?.bidLow ?? item.cpcMedian,
        bidMedian: item.cpcMedian ?? enrich?.bidMedian,
        bidHigh: item.cpcHigh ?? enrich?.bidHigh ?? item.cpcMedian,
        clickConversionRate: item.clickConversionRate ?? enrich?.clickConversionRate,
        top3ClickShare: item.top3ClickShare ?? enrich?.top3ClickShare,
        top3ConversionShare: item.top3ConversionShare ?? enrich?.top3ConversionShare,
        cells,
      };
    });

  const dir = sortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (sortBy === "volume") {
      const aVol = a.searchVolume;
      const bVol = b.searchVolume;
      if (aVol == null && bVol == null) return a.keyword.localeCompare(b.keyword);
      if (aVol == null) return 1;
      if (bVol == null) return -1;
      return dir * (aVol - bVol) || b.maxShare - a.maxShare || a.keyword.localeCompare(b.keyword);
    }
    if (sortBy === "aba") {
      const aRank = a.abaRank;
      const bRank = b.abaRank;
      if (aRank == null && bRank == null) return (b.searchVolume ?? 0) - (a.searchVolume ?? 0);
      if (aRank == null) return 1;
      if (bRank == null) return -1;
      // ABA 排名越小越热；升序=更热在前，降序=更冷在前
      return dir * (aRank - bRank) || (b.searchVolume ?? 0) - (a.searchVolume ?? 0);
    }
    return (
      dir * (a.coverageCount - b.coverageCount) ||
      b.maxShare - a.maxShare ||
      (b.searchVolume ?? 0) - (a.searchVolume ?? 0) ||
      a.keyword.localeCompare(b.keyword)
    );
  });

  return {
    competitors,
    rows: rows.slice(0, limit),
    totalRows: rows.length,
  };
}
