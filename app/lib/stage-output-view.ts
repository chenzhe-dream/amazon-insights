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
  childSalesByAsin: Record<string, unknown>;
  priceStrategyByAsin: Record<string, unknown>;
  imageRemarksByAsin: Record<string, unknown>;
  imageRemarkOutcomesByAsin: Record<string, unknown>;
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
  const childSalesOutput = availableData(snapshot, "child_sales") as { rowsByAsin?: Record<string, unknown> } | null;
  const priceStrategyOutput = availableData(snapshot, "price_strategy") as { strategyByAsin?: Record<string, unknown> } | null;
  const imageRemarksOutput = availableData(snapshot, "image_remarks") as { remarksByAsin?: Record<string, unknown>; outcomesByAsin?: Record<string, unknown> } | null;
  const baseTraffic = fallbacks.trafficData;
  const stageTrafficOverview = Object.fromEntries(Object.entries(trafficOutput?.listingByAsin ?? {}).map(([asin, value]) => {
    const record = asRecord(value);
    const prior = baseTraffic.overview[asin];
    if (hasMalformedTrafficArray(record)) return [asin, null];
    const full = mergeFullTrafficRecord(record, prior);
    if (full) return [asin, full];
    const totalScore = ownFinite(record, "total") ?? prior?.totalScore;
    const natural = ownFinite(record, "natural");
    const advertising = ownFinite(record, "advertising");
    if (totalScore === undefined && natural === undefined && advertising === undefined) return [asin, prior ?? null];
    return [asin, {
      totalScore: totalScore ?? 0,
      naturalAd: natural === undefined && advertising === undefined ? (prior?.naturalAd ?? []) : [
        { label: "自然流量", score: natural ?? prior?.naturalAd?.[0]?.score ?? 0, ratio: totalScore && natural !== undefined ? natural / totalScore * 100 : prior?.naturalAd?.[0]?.ratio ?? 0 },
        { label: "广告流量", score: advertising ?? prior?.naturalAd?.[1]?.score ?? 0, ratio: totalScore && advertising !== undefined ? advertising / totalScore * 100 : prior?.naturalAd?.[1]?.ratio ?? 0 },
      ],
      adChannels: prior?.adChannels ?? [], recommendationSources: prior?.recommendationSources ?? [],
      children: prior?.children ?? [], childCount: prior?.childCount, updatedThrough: prior?.updatedThrough ?? null,
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
    childSalesByAsin: { ...fallbacks.childSalesByAsin, ...(childSalesOutput?.rowsByAsin ?? {}) } as T["childSalesByAsin"],
    priceStrategyByAsin: { ...fallbacks.priceStrategyByAsin, ...(priceStrategyOutput?.strategyByAsin ?? {}) } as T["priceStrategyByAsin"],
    imageRemarksByAsin: { ...fallbacks.imageRemarksByAsin, ...(imageRemarksOutput?.remarksByAsin ?? {}) } as T["imageRemarksByAsin"],
    imageRemarkOutcomesByAsin: { ...fallbacks.imageRemarkOutcomesByAsin, ...(imageRemarksOutput?.outcomesByAsin ?? {}) } as T["imageRemarkOutcomesByAsin"],
    trafficData: {
      overview: { ...baseTraffic.overview, ...stageTrafficOverview },
      monthlyTrend: { ...baseTraffic.monthlyTrend, ...stageTrafficMonthly },
      meta: baseTraffic.meta,
    } satisfies TrafficDisplayData,
  };
}

function mergeFullTrafficRecord(record: Record<string, unknown>, prior: TrafficDisplayData["overview"][string]) {
  if (!hasOwn(record, "naturalAd") && !hasOwn(record, "adChannels") && !hasOwn(record, "recommendationSources") && !hasOwn(record, "children")) return null;
  const arrays = ["naturalAd", "adChannels", "recommendationSources", "children"] as const;
  if (arrays.some(key => hasOwn(record, key) && !Array.isArray(record[key]))) return null;
  return {
    totalScore: ownFinite(record, "totalScore") ?? ownFinite(record, "total") ?? prior?.totalScore ?? 0,
    naturalAd: hasOwn(record, "naturalAd") ? record.naturalAd as never[] : prior?.naturalAd ?? [],
    adChannels: hasOwn(record, "adChannels") ? record.adChannels as never[] : prior?.adChannels ?? [],
    recommendationSources: hasOwn(record, "recommendationSources") ? record.recommendationSources as never[] : prior?.recommendationSources ?? [],
    children: hasOwn(record, "children") ? record.children as never[] : prior?.children ?? [],
    childCount: ownFinite(record, "childCount") ?? prior?.childCount,
    updatedThrough: hasOwn(record, "updatedThrough") && (record.updatedThrough === null || typeof record.updatedThrough === "string")
      ? record.updatedThrough as string | null : prior?.updatedThrough ?? null,
  };
}

function hasMalformedTrafficArray(record: Record<string, unknown>) {
  return ["naturalAd", "adChannels", "recommendationSources", "children"]
    .some(key => hasOwn(record, key) && !Array.isArray(record[key]));
}

const hasOwn = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function ownFinite(value: Record<string, unknown>, key: string): number | undefined {
  if (!hasOwn(value, key)) return undefined;
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : undefined;
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
