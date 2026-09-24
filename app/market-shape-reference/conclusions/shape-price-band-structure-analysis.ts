import type { ShapeAggregatedMetrics, ShapePriceBandMetrics } from "./shape-price-analysis";

export type ShapePriceBandAnalysisScope = {
  sampleScope: string;
  shapeCount: number;
  segmentCount: number;
  linkCount: number;
  structuralPeriod: string;
  confidence: "high" | "medium" | "low";
};

export type ShapePriceBandCoreStep = {
  id: "mainstream" | "shift" | "efficiency" | "direction";
  title: string;
  finding: string;
};

export type ShapePriceBandSegmentInsight = {
  productShape: string;
  priceBand: string;
  shapePriceBand: string;
  linkCount: number;
  last6MonthsSharePct: number | null;
  linkSharePct: number | null;
  demandGapPp: number | null;
  avgLast6MonthsMonthlyPerLink: number;
  shapeAvgLast6MonthsMonthlyPerLink: number;
  efficiencyRatio: number | null;
  shareByPeriod: {
    y2024: number | null;
    y2025: number | null;
    last6Months: number | null;
    last3Months: number | null;
  };
  tags: Array<"mainstream" | "niche" | "high-efficiency" | "demand-gap" | "oversupplied">;
};

export type PriceBandTier = "low" | "mid" | "high";

export type ShapePriceBandTierOpportunity = {
  tier: PriceBandTier;
  tierLabel: string;
  tierRule: string;
  priceRangeLabel: string;
  bands: string[];
  linkCount: number;
  last6MonthsSharePct: number | null;
  linkSharePct: number | null;
  demandGapPp: number | null;
  avgEfficiency: number;
  topBand: string | null;
  trendSummary: string;
  opportunityLabel: string;
  recommendation: string;
  priority: "P0" | "P1" | "P2" | "P3";
};

export type ShapePriceBandShapeInsight = {
  productShape: string;
  linkCount: number;
  last6Months: number;
  mainstreamBands: string[];
  nicheBands: string[];
  structuralShift: "upscale" | "downscale" | "stable" | "mixed";
  structuralShiftSummary: string;
  topEfficiencyBands: Array<{ priceBand: string; avgLast6MonthsMonthlyPerLink: number }>;
  demandGapOpportunities: Array<{ priceBand: string; demandGapPp: number; last6MonthsSharePct: number | null }>;
  developmentDirections: string[];
  tierOpportunities: ShapePriceBandTierOpportunity[];
  segments: ShapePriceBandSegmentInsight[];
};

export type ShapePriceBandStructureResult = {
  summary: string;
  crossStructureSummary: string;
  coreSteps: ShapePriceBandCoreStep[];
  shapes: ShapePriceBandShapeInsight[];
  analysisScope: ShapePriceBandAnalysisScope;
};

const MAINSTREAM_MIN_SHARE_PCT = 8;
const MAINSTREAM_CUMULATIVE_TARGET = 65;
const NICHE_MAX_SHARE_PCT = 5;
const DEMAND_GAP_THRESHOLD_PP = 5;
const OVERSUPPLY_THRESHOLD_PP = 5;
const HIGH_EFFICIENCY_RATIO = 1.15;

function priceBandMidpoint(band: string) {
  const nums = band.match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return 9999;
  if (nums.length === 1) return nums[0];
  return (nums[0] + nums[1]) / 2;
}

function roundPct(value: number | null) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(2));
}

function weightedMidpoint(
  bands: Array<{ priceBand: string; sharePct: number | null }>,
) {
  let weighted = 0;
  let totalShare = 0;
  for (const band of bands) {
    const share = band.sharePct ?? 0;
    if (share <= 0) continue;
    weighted += priceBandMidpoint(band.priceBand) * share;
    totalShare += share;
  }
  if (totalShare <= 0) return null;
  return weighted / totalShare;
}

function pickMainstreamBands(bands: ShapePriceBandMetrics[]) {
  const sorted = [...bands].sort(
    (left, right) => (right.last6MonthsSharePct ?? 0) - (left.last6MonthsSharePct ?? 0),
  );
  const selected: ShapePriceBandMetrics[] = [];
  let cumulative = 0;
  for (const band of sorted) {
    const share = band.last6MonthsSharePct ?? 0;
    if (share <= 0 && selected.length) continue;
    if (share >= MAINSTREAM_MIN_SHARE_PCT || selected.length === 0 || cumulative < MAINSTREAM_CUMULATIVE_TARGET) {
      selected.push(band);
      cumulative += share;
    }
    if (cumulative >= MAINSTREAM_CUMULATIVE_TARGET && selected.length >= 1) break;
  }
  return selected;
}

function inferStructuralShift(
  bands: ShapePriceBandMetrics[],
): { shift: ShapePriceBandShapeInsight["structuralShift"]; summary: string } {
  const shareRows = bands.map(band => ({
    priceBand: band.priceBand,
    y2024: band.y2024SharePct,
    y2025: band.y2025SharePct,
    last6Months: band.last6MonthsSharePct,
    last3Months: band.last3MonthsSharePct,
  }));
  const y2024Mid = weightedMidpoint(shareRows.map(row => ({ priceBand: row.priceBand, sharePct: row.y2024 })));
  const y2025Mid = weightedMidpoint(shareRows.map(row => ({ priceBand: row.priceBand, sharePct: row.y2025 })));
  const last6Mid = weightedMidpoint(shareRows.map(row => ({ priceBand: row.priceBand, sharePct: row.last6Months })));
  const last3Mid = weightedMidpoint(shareRows.map(row => ({ priceBand: row.priceBand, sharePct: row.last3Months })));

  const anchors = [y2024Mid, y2025Mid, last6Mid, last3Mid].filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (anchors.length < 2 || last3Mid == null) {
    return { shift: "mixed", summary: "各周期占比数据不足，暂无法判断价格带迁移方向。" };
  }

  const baseline = y2024Mid ?? y2025Mid ?? last6Mid ?? last3Mid;
  const recent = last3Mid ?? last6Mid;
  if (baseline == null || recent == null) {
    return { shift: "mixed", summary: "缺少可对比的历史占比，暂无法判断价格带迁移方向。" };
  }

  const deltaPct = ((recent - baseline) / Math.max(baseline, 1)) * 100;
  if (deltaPct >= 8) {
    return {
      shift: "upscale",
      summary: `需求重心向更高价格带迁移（加权中枢 ${Math.round(baseline)} → ${Math.round(recent)}，+${deltaPct.toFixed(0)}%）。`,
    };
  }
  if (deltaPct <= -8) {
    return {
      shift: "downscale",
      summary: `需求重心向更低价格带迁移（加权中枢 ${Math.round(baseline)} → ${Math.round(recent)}，${deltaPct.toFixed(0)}%）。`,
    };
  }
  return {
    shift: "stable",
    summary: `主流价格带结构相对稳定（加权中枢 ${Math.round(baseline)} → ${Math.round(recent)}）。`,
  };
}

const TIER_LABELS: Record<PriceBandTier, string> = {
  low: "低价带",
  mid: "中价带",
  high: "高价带",
};

const TIER_RULES: Record<PriceBandTier, string> = {
  low: "形态内价格最低的约 1/3 价格带",
  mid: "形态内价格居中的约 1/3 价格带",
  high: "形态内价格最高的约 1/3 价格带",
};

function sortBandsByPrice(bands: readonly string[]) {
  return [...bands].sort((left, right) => priceBandMidpoint(left) - priceBandMidpoint(right));
}

function formatTierPriceRange(bands: readonly string[]) {
  if (!bands.length) return "—";
  const sorted = sortBandsByPrice(bands);
  if (sorted.length === 1) return sorted[0];
  return `${sorted[0]} – ${sorted[sorted.length - 1]}`;
}

function groupSegmentsByPriceTier(
  segments: ShapePriceBandSegmentInsight[],
): Map<PriceBandTier, ShapePriceBandSegmentInsight[]> {
  const sorted = [...segments].sort(
    (left, right) => priceBandMidpoint(left.priceBand) - priceBandMidpoint(right.priceBand),
  );
  const byTier = new Map<PriceBandTier, ShapePriceBandSegmentInsight[]>([
    ["low", []],
    ["mid", []],
    ["high", []],
  ]);
  const n = sorted.length;
  if (n === 0) return byTier;
  if (n === 1) {
    byTier.get("mid")!.push(sorted[0]);
    return byTier;
  }
  if (n === 2) {
    byTier.get("low")!.push(sorted[0]);
    byTier.get("high")!.push(sorted[1]);
    return byTier;
  }

  const third = Math.floor(n / 3);
  const remainder = n % 3;
  const lowCount = third + (remainder > 0 ? 1 : 0);
  const highCount = third + (remainder > 1 ? 1 : 0);
  const midCount = n - lowCount - highCount;

  byTier.get("low")!.push(...sorted.slice(0, lowCount));
  byTier.get("mid")!.push(...sorted.slice(lowCount, lowCount + midCount));
  byTier.get("high")!.push(...sorted.slice(lowCount + midCount));
  return byTier;
}

function tierTrendSummary(segments: ShapePriceBandSegmentInsight[]) {
  const deltas = segments
    .map(segment => {
      const baseline = segment.shareByPeriod.y2024 ?? segment.shareByPeriod.y2025;
      const recent = segment.shareByPeriod.last3Months ?? segment.shareByPeriod.last6Months;
      if (baseline == null || recent == null) return null;
      return recent - baseline;
    })
    .filter((value): value is number => value != null);
  if (!deltas.length) return "占比趋势数据不足";
  const avgDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  if (avgDelta >= 1.5) return "近端占比上升";
  if (avgDelta <= -1.5) return "近端占比回落";
  return "占比相对稳定";
}

function pickTierLeadBand(segments: ShapePriceBandSegmentInsight[]) {
  if (!segments.length) return null;
  const scored = segments.map(segment => {
    let score = 0;
    if (segment.tags.includes("demand-gap")) score += (segment.demandGapPp ?? 0) * 2;
    if (segment.tags.includes("high-efficiency")) score += (segment.efficiencyRatio ?? 0) * 10;
    if (segment.tags.includes("mainstream")) score += segment.last6MonthsSharePct ?? 0;
    const baseline = segment.shareByPeriod.y2024 ?? segment.shareByPeriod.y2025;
    const recent = segment.shareByPeriod.last3Months ?? segment.shareByPeriod.last6Months;
    if (baseline != null && recent != null) score += (recent - baseline) * 3;
    if (segment.tags.includes("oversupplied")) score -= 8;
    return { segment, score };
  });
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.segment ?? segments[0];
}

function buildTierRecommendation(
  tier: PriceBandTier,
  tierLabel: string,
  bands: string[],
  sharePct: number | null,
  linkSharePct: number | null,
  demandGapPp: number | null,
  avgEfficiency: number,
  shapeAvg: number,
  lead: ShapePriceBandSegmentInsight | null,
  trendSummary: string,
  structuralShift: ShapePriceBandShapeInsight["structuralShift"],
): Pick<ShapePriceBandTierOpportunity, "opportunityLabel" | "recommendation" | "priority"> {
  if (!bands.length || !lead) {
    return {
      opportunityLabel: "样本不足",
      recommendation: `${tierLabel}（${bands.join("、") || "—"}）有效样本不足，暂无法给出机会判断。`,
      priority: "P3",
    };
  }

  const bandRange = formatTierPriceRange(bands);
  const shareText = sharePct != null ? `${sharePct.toFixed(1)}%` : "—";
  const gapText =
    demandGapPp != null && demandGapPp >= DEMAND_GAP_THRESHOLD_PP
      ? `需求占比 ${shareText}，高于链接布局 ${demandGapPp.toFixed(1)}pp`
      : demandGapPp != null && demandGapPp <= -OVERSUPPLY_THRESHOLD_PP
        ? `链接布局偏多 ${Math.abs(demandGapPp).toFixed(1)}pp，竞争拥挤`
        : `需求占比 ${shareText}，供需大致匹配`;
  const effRatio = shapeAvg > 0 ? avgEfficiency / shapeAvg : null;
  const effText =
    effRatio != null && effRatio >= HIGH_EFFICIENCY_RATIO
      ? `单链月均 ${Math.round(avgEfficiency)} 件，效率高于形态均值`
      : effRatio != null && effRatio >= 1
        ? `单链月均 ${Math.round(avgEfficiency)} 件，效率接近或略高于形态均值`
        : `单链月均 ${Math.round(avgEfficiency)} 件，效率一般，需验证供应链`;

  if (demandGapPp != null && demandGapPp >= DEMAND_GAP_THRESHOLD_PP && (effRatio ?? 0) >= 1) {
    return {
      opportunityLabel: "供需缺口",
      recommendation: `${tierLabel} ${bandRange}：${gapText}；${effText}；重点关注 ${lead.priceBand}（${trendSummary}）。`,
      priority: sharePct != null && sharePct >= 10 ? "P0" : "P1",
    };
  }

  if (tier === "high" && (structuralShift === "upscale" || trendSummary === "近端占比上升")) {
    return {
      opportunityLabel: "高端升级",
      recommendation: `${tierLabel} ${bandRange}：需求向更高价位迁移，${lead.priceBand} ${effText}；适合差异化高端款或配置升级验证。`,
      priority: (effRatio ?? 0) >= HIGH_EFFICIENCY_RATIO ? "P0" : "P1",
    };
  }

  if (tier === "low" && (sharePct ?? 0) >= MAINSTREAM_MIN_SHARE_PCT) {
    return {
      opportunityLabel: "主流基本盘",
      recommendation: `${tierLabel} ${bandRange}：已是形态内主流区间（需求占比 ${shareText}），${gapText}；跟随立项需强控成本，优先看 ${lead.priceBand} 的效率与差异化空间。`,
      priority: demandGapPp != null && demandGapPp <= -OVERSUPPLY_THRESHOLD_PP ? "P2" : "P1",
    };
  }

  if ((effRatio ?? 0) >= HIGH_EFFICIENCY_RATIO && (sharePct ?? 0) >= 5) {
    return {
      opportunityLabel: "效率领先",
      recommendation: `${tierLabel} ${bandRange}：${lead.priceBand} ${effText}，${gapText}；可作为该形态的优先验证价位。`,
      priority: "P1",
    };
  }

  if (demandGapPp != null && demandGapPp <= -OVERSUPPLY_THRESHOLD_PP) {
    return {
      opportunityLabel: "竞争饱和",
      recommendation: `${tierLabel} ${bandRange}：链接布局明显多于需求份额，${lead.priceBand} 竞争拥挤；除非有显著差异点，否则不作为首选切入带。`,
      priority: "P3",
    };
  }

  if ((sharePct ?? 0) < NICHE_MAX_SHARE_PCT && (effRatio ?? 0) >= HIGH_EFFICIENCY_RATIO) {
    return {
      opportunityLabel: "小众高效",
      recommendation: `${tierLabel} ${bandRange}：体量不大但 ${lead.priceBand} ${effText}；适合小规模测款或细分场景切入。`,
      priority: "P2",
    };
  }

  return {
    opportunityLabel: "持续观察",
    recommendation: `${tierLabel} ${bandRange}：${gapText}；${effText}；${trendSummary}，建议结合 ${lead.priceBand} 继续跟踪。`,
    priority: "P2",
  };
}

function buildTierOpportunities(
  segments: ShapePriceBandSegmentInsight[],
  shapeAvg: number,
  structuralShift: ShapePriceBandShapeInsight["structuralShift"],
): ShapePriceBandTierOpportunity[] {
  if (!segments.length) return [];

  const byTier = groupSegmentsByPriceTier(segments);
  const totalLinks = segments.reduce((sum, segment) => sum + segment.linkCount, 0);

  return (["low", "mid", "high"] as const).map(tier => {
    const tierSegments = byTier.get(tier) ?? [];
    const bands = sortBandsByPrice(tierSegments.map(segment => segment.priceBand));
    const linkSharePct =
      totalLinks > 0
        ? roundPct((tierSegments.reduce((sum, segment) => sum + segment.linkCount, 0) / totalLinks) * 100)
        : null;
    const last6MonthsSharePct = roundPct(
      tierSegments.reduce((sum, segment) => sum + (segment.last6MonthsSharePct ?? 0), 0),
    );
    const demandGapPp =
      last6MonthsSharePct != null && linkSharePct != null ? roundPct(last6MonthsSharePct - linkSharePct) : null;
    const linkCount = tierSegments.reduce((sum, segment) => sum + segment.linkCount, 0);
    const avgEfficiency =
      tierSegments.length > 0
        ? tierSegments.reduce((sum, segment) => sum + segment.avgLast6MonthsMonthlyPerLink, 0) / tierSegments.length
        : 0;
    const lead = pickTierLeadBand(tierSegments);
    const trendSummary = tierTrendSummary(tierSegments);
    const { opportunityLabel, recommendation, priority } = buildTierRecommendation(
      tier,
      TIER_LABELS[tier],
      bands,
      last6MonthsSharePct,
      linkSharePct,
      demandGapPp,
      avgEfficiency,
      shapeAvg,
      lead,
      trendSummary,
      structuralShift,
    );

    return {
      tier,
      tierLabel: TIER_LABELS[tier],
      tierRule: TIER_RULES[tier],
      priceRangeLabel: formatTierPriceRange(bands),
      bands,
      linkCount: Math.round(linkCount),
      last6MonthsSharePct,
      linkSharePct,
      demandGapPp,
      avgEfficiency,
      topBand: lead?.priceBand ?? null,
      trendSummary,
      opportunityLabel,
      recommendation,
      priority,
    };
  });
}

function buildShapeInsight(
  subtotal: ShapeAggregatedMetrics,
  bands: ShapePriceBandMetrics[],
): ShapePriceBandShapeInsight {
  const shapeAvg = subtotal.avgLast6MonthsMonthlyPerLink;
  const mainstream = pickMainstreamBands(bands);
  const mainstreamLabels = mainstream.map(band => band.priceBand);

  const segments: ShapePriceBandSegmentInsight[] = bands.map(band => {
    const linkSharePct =
      subtotal.linkCount > 0 ? roundPct((band.linkCount / subtotal.linkCount) * 100) : null;
    const demandGapPp =
      band.last6MonthsSharePct != null && linkSharePct != null
        ? roundPct(band.last6MonthsSharePct - linkSharePct)
        : null;
    const efficiencyRatio =
      shapeAvg > 0 ? Number((band.avgLast6MonthsMonthlyPerLink / shapeAvg).toFixed(2)) : null;

    const tags: ShapePriceBandSegmentInsight["tags"] = [];
    if (mainstreamLabels.includes(band.priceBand)) tags.push("mainstream");
    if ((band.last6MonthsSharePct ?? 0) < NICHE_MAX_SHARE_PCT && band.linkCount > 0) tags.push("niche");
    if (efficiencyRatio != null && efficiencyRatio >= HIGH_EFFICIENCY_RATIO) tags.push("high-efficiency");
    if (demandGapPp != null && demandGapPp >= DEMAND_GAP_THRESHOLD_PP) tags.push("demand-gap");
    if (demandGapPp != null && demandGapPp <= -OVERSUPPLY_THRESHOLD_PP) tags.push("oversupplied");

    return {
      productShape: band.productShape,
      priceBand: band.priceBand,
      shapePriceBand: band.shapePriceBand,
      linkCount: band.linkCount,
      last6MonthsSharePct: band.last6MonthsSharePct,
      linkSharePct,
      demandGapPp,
      avgLast6MonthsMonthlyPerLink: band.avgLast6MonthsMonthlyPerLink,
      shapeAvgLast6MonthsMonthlyPerLink: shapeAvg,
      efficiencyRatio,
      shareByPeriod: {
        y2024: band.y2024SharePct,
        y2025: band.y2025SharePct,
        last6Months: band.last6MonthsSharePct,
        last3Months: band.last3MonthsSharePct,
      },
      tags,
    };
  });

  const nicheBands = segments
    .filter(segment => segment.tags.includes("niche"))
    .map(segment => segment.priceBand);

  const { shift, summary: structuralShiftSummary } = inferStructuralShift(bands);

  const tierOpportunities = buildTierOpportunities(segments, shapeAvg, shift);

  const topEfficiencyBands = [...bands]
    .sort((left, right) => right.avgLast6MonthsMonthlyPerLink - left.avgLast6MonthsMonthlyPerLink)
    .slice(0, 3)
    .map(band => ({
      priceBand: band.priceBand,
      avgLast6MonthsMonthlyPerLink: band.avgLast6MonthsMonthlyPerLink,
    }));

  const demandGapOpportunities = segments
    .filter(segment => segment.tags.includes("demand-gap"))
    .sort((left, right) => (right.demandGapPp ?? 0) - (left.demandGapPp ?? 0))
    .map(segment => ({
      priceBand: segment.priceBand,
      demandGapPp: segment.demandGapPp ?? 0,
      last6MonthsSharePct: segment.last6MonthsSharePct,
    }));

  const developmentDirections = tierOpportunities
    .filter(item => item.priority === "P0" || item.priority === "P1")
    .sort((left, right) => {
      const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
      return rank[left.priority] - rank[right.priority];
    })
    .map(item => item.recommendation);

  if (!developmentDirections.length) {
    const watch = tierOpportunities.find(item => item.topBand);
    if (watch) developmentDirections.push(watch.recommendation);
  }

  if (!developmentDirections.length && topEfficiencyBands.length) {
    const best = topEfficiencyBands[0];
    developmentDirections.push(
      `${subtotal.productShape} · ${best.priceBand}：单链月均 ${best.avgLast6MonthsMonthlyPerLink.toLocaleString()} 件，效率领先，可作为强化价位验证`,
    );
  }

  return {
    productShape: subtotal.productShape,
    linkCount: subtotal.linkCount,
    last6Months: subtotal.last6Months,
    mainstreamBands: mainstreamLabels,
    nicheBands,
    structuralShift: shift,
    structuralShiftSummary,
    topEfficiencyBands,
    demandGapOpportunities,
    developmentDirections,
    tierOpportunities,
    segments,
  };
}

function buildCoreSteps(shapes: ShapePriceBandShapeInsight[]): ShapePriceBandCoreStep[] {
  const mainstreamText = shapes
    .map(shape =>
      shape.mainstreamBands.length
        ? `${shape.productShape} → ${shape.mainstreamBands.slice(0, 3).join("、")}`
        : null,
    )
    .filter(Boolean)
    .join("；");

  const shiftText = shapes
    .map(shape => `${shape.productShape}：${shape.structuralShiftSummary}`)
    .join(" ");

  const efficiencyText = shapes
    .flatMap(shape =>
      shape.topEfficiencyBands.slice(0, 1).map(band => `${shape.productShape} · ${band.priceBand}（${band.avgLast6MonthsMonthlyPerLink.toLocaleString()} 件/链·月）`),
    )
    .slice(0, 3)
    .join("；");

  const directionText =
    shapes
      .flatMap(shape => shape.tierOpportunities.filter(item => item.priority === "P0" || item.priority === "P1"))
      .slice(0, 4)
      .map(item => item.recommendation)
      .join(" ") ||
    shapes.flatMap(shape => shape.developmentDirections).slice(0, 3).join(" ") ||
    "样本内暂未识别明显的供需错配价格带，建议结合交叉结构继续细分验证。";

  return [
    {
      id: "mainstream",
      title: "1. 找主流价格带（销量占比）",
      finding: mainstreamText || "暂无足够销量占比数据识别主流价格带。",
    },
    {
      id: "shift",
      title: "2. 看需求份额变化（结构变化）",
      finding: shiftText || "缺少跨周期占比，无法判断迁移方向。",
    },
    {
      id: "efficiency",
      title: "3. 比较链接效率（单链月均）",
      finding: efficiencyText || "暂无单链月均数据。",
    },
    {
      id: "direction",
      title: "4. 筛选产品开发方向（供需匹配）",
      finding: directionText,
    },
  ];
}

function buildSummary(shapes: ShapePriceBandShapeInsight[]) {
  if (!shapes.length) return "暂无商品形态 × 价格带样本，无法输出结构分析。";
  const lead = shapes.reduce(
    (best, shape) => (shape.last6Months > best.last6Months ? shape : best),
    shapes[0],
  );
  const p0 = lead.tierOpportunities.find(item => item.priority === "P0");
  const oppText = p0
    ? `；${lead.productShape} 优先关注 ${p0.tierLabel}（${p0.topBand ?? p0.bands[0] ?? "—"}）`
    : "";
  return `按形态分档评估高/中/低价带机会；近6个月主销形态为「${lead.productShape}」（${lead.last6Months.toLocaleString()} 件），主流带 ${lead.mainstreamBands.slice(0, 2).join("、") || "待识别"}${oppText}。`;
}

export function analyzeShapePriceBandStructure(input: {
  rows: readonly ShapePriceBandMetrics[];
  shapeAggregates: readonly ShapeAggregatedMetrics[];
  sampleScope?: string;
  structuralPeriod?: string;
}): ShapePriceBandStructureResult {
  const bandsByShape = new Map<string, ShapePriceBandMetrics[]>();
  for (const row of input.rows) {
    const list = bandsByShape.get(row.productShape) ?? [];
    list.push(row);
    bandsByShape.set(row.productShape, list);
  }

  const shapes = input.shapeAggregates
    .filter(shape => shape.productShape !== "—")
    .map(subtotal => buildShapeInsight(subtotal, bandsByShape.get(subtotal.productShape) ?? []));

  const linkCount = input.shapeAggregates.reduce((sum, shape) => sum + shape.linkCount, 0);
  const confidence: ShapePriceBandAnalysisScope["confidence"] =
    linkCount >= 50 && shapes.length >= 2
      ? "high"
      : linkCount >= 20
        ? "medium"
        : "low";

  const crossStructureSummary = shapes.length
    ? shapes
        .map(shape => `${shape.productShape}（${shape.linkCount} 链 · ${shape.segments.length} 价格带）`)
        .join(" · ")
    : "—";

  return {
    summary: buildSummary(shapes),
    crossStructureSummary: `交叉结构覆盖：${crossStructureSummary}`,
    coreSteps: buildCoreSteps(shapes),
    shapes,
    analysisScope: {
      sampleScope: input.sampleScope ?? `TOP 样本 · ${linkCount} 链接`,
      shapeCount: shapes.length,
      segmentCount: input.rows.length,
      linkCount,
      structuralPeriod: input.structuralPeriod ?? "2024 / 2025 / 近6个月 / 近3个月",
      confidence,
    },
  };
}
