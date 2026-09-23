import type { TrafficDisplayData } from "../sif-listing-traffic-data";
import { mergeTrafficRecord } from "./traffic-detail-view";
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

export function buildStageOutputView<T extends StageOutputFallbacks>(snapshot: StageOutputSnapshot, fallbacks: T, options: { authoritative?: boolean } = {}) {
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
  const detailAvailability = { ...baseTraffic.detailAvailability };
  const stageTrafficOverview = Object.fromEntries(Object.entries(trafficOutput?.listingByAsin ?? {}).filter(([asin]) => !baseTraffic.authoritativeListingAsins?.includes(asin)).map(([asin, value]) => {
    const merged = mergeTrafficRecord(value, baseTraffic.overview[asin], baseTraffic.detailAvailability?.[asin]);
    detailAvailability[asin] = merged.availability;
    return [asin, merged.overview];
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
    keywordAnalysisByAsin: scopedMap(fallbacks.keywordAnalysisByAsin, keywordOutput?.analysisByAsin, options.authoritative) as T["keywordAnalysisByAsin"],
    keywordEnrichmentByKeyword: scopedMap(fallbacks.keywordEnrichmentByKeyword, keywordOutput?.enrichmentByKeyword, options.authoritative) as T["keywordEnrichmentByKeyword"],
    reviewAnalysisByAsin: scopedMap(fallbacks.reviewAnalysisByAsin, reviewOutput?.analysisByAsin, options.authoritative) as T["reviewAnalysisByAsin"],
    ratingByAsin: scopedMap(fallbacks.ratingByAsin, reviewOutput?.ratingByAsin, options.authoritative) as T["ratingByAsin"],
    salesTrendByAsin: scopedMap(fallbacks.salesTrendByAsin, salesOutput?.trendByAsin, options.authoritative) as T["salesTrendByAsin"],
    fbaFeeByAsin: scopedMap(fallbacks.fbaFeeByAsin, fbaOutput?.feeByAsin, options.authoritative) as T["fbaFeeByAsin"],
    listingContentByAsin: scopedMap(fallbacks.listingContentByAsin, listingOutput?.contentByAsin, options.authoritative) as T["listingContentByAsin"],
    categoryTrendByNode: scopedMap(fallbacks.categoryTrendByNode, categoryOutput?.trendByNode, options.authoritative) as T["categoryTrendByNode"],
    childSalesByAsin: scopedMap(fallbacks.childSalesByAsin, childSalesOutput?.rowsByAsin, options.authoritative) as T["childSalesByAsin"],
    priceStrategyByAsin: scopedMap(fallbacks.priceStrategyByAsin, priceStrategyOutput?.strategyByAsin, options.authoritative) as T["priceStrategyByAsin"],
    imageRemarksByAsin: scopedMap(fallbacks.imageRemarksByAsin, imageRemarksOutput?.remarksByAsin, options.authoritative) as T["imageRemarksByAsin"],
    imageRemarkOutcomesByAsin: scopedMap(fallbacks.imageRemarkOutcomesByAsin, imageRemarksOutput?.outcomesByAsin, options.authoritative) as T["imageRemarkOutcomesByAsin"],
    trafficData: {
      ...(baseTraffic.authoritativeListingAsins ? { authoritativeListingAsins: baseTraffic.authoritativeListingAsins } : {}),
      overview: { ...baseTraffic.overview, ...stageTrafficOverview },
      monthlyTrend: { ...baseTraffic.monthlyTrend, ...stageTrafficMonthly },
      meta: baseTraffic.meta,
      detailAvailability,
    } satisfies TrafficDisplayData,
  };
}

function scopedMap(fallback: Record<string, unknown>, current: Record<string, unknown> | undefined, authoritative?: boolean) {
  return authoritative ? current ?? {} : { ...fallback, ...current };
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
