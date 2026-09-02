import { hasCatalogRatingReviewConflict, positiveMoneyOrNull } from "../../scripts/lib/commerce-data-validity.mjs";

type MetricResolution<T> = {
  source: "sorftime" | "catalog" | "missing";
  value: T | null;
  state: "ready" | "conflict" | "missing";
  label: string | null;
};

const conflictLabel = "Sorftime 数据冲突，待重新同步";

export function resolvePriceMetric(record: { status?: string; currentPrice?: unknown } | undefined, catalogPrice: unknown): MetricResolution<number> {
  const sorftimePrice = record?.status === "ready" ? positiveMoneyOrNull(record.currentPrice) : null;
  if (sorftimePrice != null) return { source: "sorftime", value: sorftimePrice, state: "ready", label: null };
  const catalog = positiveMoneyOrNull(catalogPrice);
  if (record && catalog != null) return { source: "catalog", value: catalog, state: "conflict", label: conflictLabel };
  return { source: "missing", value: null, state: "missing", label: "暂无可用价格" };
}

export function resolveFbaMetric(record: { status?: string; fbaFee?: unknown } | undefined): MetricResolution<number> {
  const fee = record?.status === "ready" ? positiveMoneyOrNull(record.fbaFee) : null;
  return fee != null
    ? { source: "sorftime", value: fee, state: "ready", label: null }
    : { source: "missing", value: null, state: "missing", label: "暂未返回 FBA 配送费" };
}

export function resolveRatingMetric(
  record: { status?: string; rating?: number | null; reviewCount?: number | null } | undefined,
  catalog: { rating?: number | null; reviews?: number | null },
): MetricResolution<{ rating: number | null; reviewCount: number | null }> {
  const rating = record?.rating;
  const reviewCount = record?.reviewCount;
  if (record?.status === "ready" && typeof rating === "number" && typeof reviewCount === "number") {
    if (!hasCatalogRatingReviewConflict(rating, reviewCount, catalog)) {
      return { source: "sorftime", value: { rating, reviewCount }, state: "ready", label: null };
    }
  }
  if (typeof catalog.rating === "number" || typeof catalog.reviews === "number") {
    return { source: "catalog", value: { rating: catalog.rating, reviewCount: catalog.reviews }, state: "conflict", label: conflictLabel };
  }
  return { source: "missing", value: null, state: "missing", label: "暂无可用评分 / 评论" };
}
