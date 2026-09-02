import type { TrafficDisplayData } from "../sif-listing-traffic-data";
import type { StageOutputSnapshot } from "./stage-output-browser";

type StageOutputFallbacks = {
  keywordAnalysisByAsin: Record<string, unknown>;
  keywordEnrichmentByKeyword: Record<string, unknown>;
  reviewAnalysisByAsin: Record<string, unknown>;
  ratingByAsin: Record<string, unknown>;
  salesTrendByAsin: Record<string, unknown>;
  fbaFeeByAsin: Record<string, unknown>;
  listingContentByAsin: Record<string, unknown>;
  categoryTrendByNode: Record<string, unknown>;
  trafficData: TrafficDisplayData;
};

export function buildStageOutputView<T extends StageOutputFallbacks>(snapshot: StageOutputSnapshot, fallbacks: T) {
  const keywordOutput = availableData(snapshot, "keywords") as { analysisByAsin?: Record<string, unknown>; enrichmentByKeyword?: Record<string, unknown> } | null;
  const reviewOutput = availableData(snapshot, "reviews") as { analysisByAsin?: Record<string, unknown>; ratingByAsin?: Record<string, unknown> } | null;
  const salesOutput = availableData(snapshot, "sales_trend") as { trendByAsin?: Record<string, unknown> } | null;
  const fbaOutput = availableData(snapshot, "fba") as { feeByAsin?: Record<string, unknown> } | null;
  const listingOutput = availableData(snapshot, "listing") as { contentByAsin?: Record<string, unknown> } | null;
  const categoryOutput = availableData(snapshot, "category") as { trendByNode?: Record<string, unknown> } | null;
  const trafficOutput = availableData(snapshot, "traffic") as { listingByAsin?: Record<string, unknown>; monthlyByAsin?: Record<string, unknown> } | null;
  const baseTraffic = fallbacks.trafficData;
  const stageTrafficOverview = Object.fromEntries(Object.entries(trafficOutput?.listingByAsin ?? {}).map(([asin, value]) => {
    const record = asRecord(value);
    if (Array.isArray(record.naturalAd)) return [asin, record];
    const totalScore = finiteNumber(record.total);
    const natural = finiteNumber(record.natural);
    const advertising = finiteNumber(record.advertising);
    return [asin, {
      totalScore,
      naturalAd: [
        { label: "自然流量", score: natural, ratio: totalScore > 0 ? natural / totalScore * 100 : 0 },
        { label: "广告流量", score: advertising, ratio: totalScore > 0 ? advertising / totalScore * 100 : 0 },
      ],
      adChannels: [], recommendationSources: [], children: [], updatedThrough: null,
    }];
  })) as TrafficDisplayData["overview"];
  const stageTrafficMonthly = Object.fromEntries(Object.entries(trafficOutput?.monthlyByAsin ?? {}).map(([asin, value]) => {
    const points = Array.isArray(asRecord(value).points) ? (asRecord(value).points as unknown[]).map(rawPoint => {
      const point = asRecord(rawPoint);
      const month = typeof point.month === "string" ? point.month : "";
      const natural = finiteNumber(point.natural);
      const ad = typeof point.ad === "number" ? point.ad : finiteNumber(point.advertising);
      return { month, label: month ? `${Number(month.slice(5, 7))}月` : "", natural, ad, total: natural + ad };
    }) : [];
    return [asin, { asin, points }];
  })) as TrafficDisplayData["monthlyTrend"];

  return {
    keywordAnalysisByAsin: { ...fallbacks.keywordAnalysisByAsin, ...(keywordOutput?.analysisByAsin ?? {}) } as T["keywordAnalysisByAsin"],
    keywordEnrichmentByKeyword: { ...fallbacks.keywordEnrichmentByKeyword, ...(keywordOutput?.enrichmentByKeyword ?? {}) } as T["keywordEnrichmentByKeyword"],
    reviewAnalysisByAsin: { ...fallbacks.reviewAnalysisByAsin, ...(reviewOutput?.analysisByAsin ?? {}) } as T["reviewAnalysisByAsin"],
    ratingByAsin: { ...fallbacks.ratingByAsin, ...(reviewOutput?.ratingByAsin ?? {}) } as T["ratingByAsin"],
    salesTrendByAsin: { ...fallbacks.salesTrendByAsin, ...(salesOutput?.trendByAsin ?? {}) } as T["salesTrendByAsin"],
    fbaFeeByAsin: { ...fallbacks.fbaFeeByAsin, ...(fbaOutput?.feeByAsin ?? {}) } as T["fbaFeeByAsin"],
    listingContentByAsin: { ...fallbacks.listingContentByAsin, ...(listingOutput?.contentByAsin ?? {}) } as T["listingContentByAsin"],
    categoryTrendByNode: { ...fallbacks.categoryTrendByNode, ...(categoryOutput?.trendByNode ?? {}) } as T["categoryTrendByNode"],
    trafficData: {
      overview: { ...baseTraffic.overview, ...stageTrafficOverview },
      monthlyTrend: { ...baseTraffic.monthlyTrend, ...stageTrafficMonthly },
      meta: baseTraffic.meta,
    } satisfies TrafficDisplayData,
  };
}

function availableData(snapshot: StageOutputSnapshot, stage: keyof StageOutputSnapshot): unknown | null {
  const projection = snapshot[stage];
  return projection && "data" in projection ? projection.data : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
