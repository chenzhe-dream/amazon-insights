import { buildListingRecordFromProductDetailEvidence } from "./sorftime-listing-parse.mjs";
import { positiveMoneyOrNull } from "./commerce-data-validity.mjs";

function scopeOf(evidence) {
  return evidence
    ? { jobId: evidence.jobId, marketplace: evidence.marketplace, asin: evidence.asin }
    : null;
}

function scopeMatches(evidence, expected) {
  return evidence
    && evidence.source === "Sorftime"
    && (!expected || Object.entries(expected).every(([key, value]) => evidence[key] === value));
}

function provenance(evidence) {
  return {
    jobId: evidence.jobId,
    marketplace: evidence.marketplace,
    asin: evidence.asin,
    operation: evidence.operation,
    fetchedAt: evidence.fetchedAt,
    connector: "sorftime",
    tool: evidence.operation,
  };
}

function base(evidence) {
  return {
    asin: evidence.asin,
    marketplace: evidence.marketplace,
    fetchedAt: evidence.fetchedAt,
    source: "Sorftime",
    provenance: provenance(evidence),
  };
}

function categoryName(value) {
  return String(value ?? "").replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim();
}

function moduleEvidence(module, evidenceByOperation, expectedScope) {
  const detail = evidenceByOperation?.product_detail ?? null;
  const variations = evidenceByOperation?.product_variations ?? null;
  const category = evidenceByOperation?.category_trend_sales_count ?? null;
  const inferred = expectedScope ?? scopeOf(detail) ?? scopeOf(variations) ?? scopeOf(category);
  const valid = (evidence, operation) => scopeMatches(evidence, inferred) && evidence.operation === operation;
  if (["fba", "listing", "price_strategy"].includes(module)) {
    return valid(detail, "product_detail") ? { detail } : null;
  }
  if (module === "category") {
    return valid(detail, "product_detail") && valid(category, "category_trend_sales_count")
      ? { detail, category }
      : null;
  }
  if (module === "child_sales") {
    return valid(variations, "product_variations") ? { variations } : null;
  }
  return null;
}

export function buildScopedSorftimeModuleResult({
  module,
  normalResult,
  evidenceByOperation = {},
  expectedScope,
}) {
  if (normalResult?.status === "ready") return normalResult;
  const evidence = moduleEvidence(module, evidenceByOperation, expectedScope);
  if (!evidence) return null;
  if (module === "listing") return buildListingRecordFromProductDetailEvidence(evidence.detail);
  if (module === "fba") {
    const fbaFee = positiveMoneyOrNull(evidence.detail.data?.fbaFee);
    return {
      ...base(evidence.detail),
      status: fbaFee != null ? "ready" : "empty",
      fbaFee,
      ...(evidence.detail.data?.packageSize ? { packageSize: evidence.detail.data.packageSize } : {}),
      verifiedEmpty: fbaFee == null,
    };
  }
  if (module === "price_strategy") {
    const price = evidence.detail.data?.price;
    const coupon = evidence.detail.data?.coupon;
    const signed = evidence.detail.data?.couponEncoding === 'signed';
    const hasCoupon = Number.isFinite(coupon) && (signed ? coupon !== 0 : coupon > 0);
    const couponLabel = !hasCoupon ? '' : signed ? coupon < 0 ? `${Math.abs(coupon)}% 比例折扣` : `$${coupon.toFixed(2)} 固定金额券` : String(coupon);
    const currentPrice = positiveMoneyOrNull(price);
    if (currentPrice == null) return null;
    const couponText = hasCoupon ? `，Coupon ${couponLabel}` : "";
    return {
      ...base(evidence.detail),
      status: "ready",
      currentPrice,
      coupon: Number.isFinite(coupon) ? coupon : 0,
      anchor: `当前售价 $${currentPrice.toFixed(2)}${couponText}。`,
      promotion: hasCoupon
        ? `Sorftime product_detail 返回有效 Coupon${signed ? `：${couponLabel}` : ''}。`
        : "Sorftime product_detail 暂未返回有效 Coupon。",
      psychology: "以当前公开售价作为可核验价格锚点。",
      evidence: "Sorftime · same-job product_detail（price/coupon）",
    };
  }
  if (module === "category") {
    const points = evidence.category.data?.points ?? [];
    if (!points.length) return null;
    return {
      ...base(evidence.category),
      status: "ready",
      nodeId: evidence.category.data.nodeId ?? evidence.detail.data.nodeId,
      categoryName: categoryName(evidence.category.data.categoryName ?? evidence.detail.data.categoryName),
      topCategory: categoryName(evidence.category.data.topCategory ?? evidence.detail.data.topCategory),
      sourceAsin: evidence.detail.asin,
      asins: [evidence.detail.asin],
      volume: points,
      avgPrice: [],
      amount: [],
      listingMonopoly: [],
      brandMonopoly: [],
      sellerMonopoly: [],
      note: "Sorftime 同任务 category_trend(SalesCount) 兜底；未取得的指标保持为空。",
    };
  }
  const rows = evidence.variations.data?.rows ?? [];
  const verifiedComplete = evidence.variations.data?.verifiedComplete === true;
  if (!verifiedComplete) return null;
  return {
    ...base(evidence.variations),
    status: rows.length ? "ready" : "empty",
    rows: rows.map(row => ({
      ...row,
      observedAt: evidence.variations.fetchedAt,
      source: "Sorftime",
      provenance: provenance(evidence.variations),
    })),
    verifiedEmpty: rows.length === 0 && verifiedComplete,
  };
}
