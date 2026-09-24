import type { ShapeAggregatedMetrics } from "./shape-price-analysis";

export type ShapeShareTrendDirection = "rising" | "declining" | "stable";

export type ShapeEntryPriority = "优先切入" | "机会较大" | "谨慎跟进" | "暂不优先";

export type ShapeSalesShareInsight = {
  productShape: string;
  last3MonthsSharePct: number | null;
  last6MonthsSharePct: number | null;
  y2025SharePct: number | null;
  y2024SharePct: number | null;
  linkCount: number;
  avgLast6MonthsMonthlyPerLink: number;
  trendDirection: ShapeShareTrendDirection;
  trendDeltaPp: number | null;
  recentMomentumPp: number | null;
  trendLabel: string;
  entryPriority: ShapeEntryPriority;
  recommendation: string;
  entryScore: number;
};

export type ShapeSalesShareAnalysisResult = {
  summary: string;
  risingShapes: ShapeSalesShareInsight[];
  decliningShapes: ShapeSalesShareInsight[];
  priorityEntries: ShapeSalesShareInsight[];
  insights: ShapeSalesShareInsight[];
};

const TREND_SIGNIFICANT_PP = 3;
const RECENT_MOMENTUM_PP = 1.5;
const MAINSTREAM_MIN_SHARE_PCT = 15;

function fmtPct(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}%`;
}

function isAssignedShape(shape: string) {
  return shape !== "—";
}

function inferTrendDirection(
  y2024Share: number | null,
  last3MonthsShare: number | null,
  last6MonthsShare: number | null,
): {
  direction: ShapeShareTrendDirection;
  deltaPp: number | null;
  recentMomentumPp: number | null;
  label: string;
} {
  if (y2024Share == null || last3MonthsShare == null) {
    return { direction: "stable", deltaPp: null, recentMomentumPp: null, label: "占比数据不足" };
  }

  const deltaPp = last3MonthsShare - y2024Share;
  const recentMomentumPp =
    last6MonthsShare != null ? last3MonthsShare - last6MonthsShare : null;

  let direction: ShapeShareTrendDirection = "stable";
  if (deltaPp >= TREND_SIGNIFICANT_PP) direction = "rising";
  else if (deltaPp <= -TREND_SIGNIFICANT_PP) direction = "declining";

  const recentText =
    recentMomentumPp != null && Math.abs(recentMomentumPp) >= RECENT_MOMENTUM_PP
      ? recentMomentumPp > 0
        ? "，近端继续走强"
        : "，近端有所回落"
      : "";

  if (direction === "rising") {
    return {
      direction,
      deltaPp,
      recentMomentumPp,
      label: `2024 ${fmtPct(y2024Share)} → 近3个月 ${fmtPct(last3MonthsShare)}（+${deltaPp.toFixed(1)}pp${recentText}）`,
    };
  }
  if (direction === "declining") {
    return {
      direction,
      deltaPp,
      recentMomentumPp,
      label: `2024 ${fmtPct(y2024Share)} → 近3个月 ${fmtPct(last3MonthsShare)}（${deltaPp.toFixed(1)}pp${recentText}）`,
    };
  }
  return {
    direction,
    deltaPp,
    recentMomentumPp,
    label: `2024 ${fmtPct(y2024Share)} → 近3个月 ${fmtPct(last3MonthsShare)}（基本稳定${recentText}）`,
  };
}

function inferEntryPriority(input: {
  trendDirection: ShapeShareTrendDirection;
  last6MonthsSharePct: number | null;
  last3MonthsSharePct: number | null;
  avgLast6MonthsMonthlyPerLink: number;
  isTopShareShape: boolean;
}): { priority: ShapeEntryPriority; recommendation: string; entryScore: number } {
  const share6m = input.last6MonthsSharePct ?? 0;
  const share3m = input.last3MonthsSharePct ?? 0;
  const efficiency = input.avgLast6MonthsMonthlyPerLink;

  if (input.trendDirection === "rising") {
    if (input.isTopShareShape || share6m >= MAINSTREAM_MIN_SHARE_PCT) {
      return {
        priority: "优先切入",
        recommendation: `主流形态且占比持续上升，近6个月占 TOP ${fmtPct(share6m)}，适合作为首要跟进方向，但需强控成本与差异化。`,
        entryScore: share6m + (input.trendDirection === "rising" ? 20 : 0) + efficiency * 0.01,
      };
    }
    if (share6m >= 8) {
      return {
        priority: "机会较大",
        recommendation: `占比上升且近6个月占 TOP ${fmtPct(share6m)}，需求在向该形态迁移，切入机会较大，可小批量验证。`,
        entryScore: share6m + 12 + efficiency * 0.01,
      };
    }
    return {
      priority: "机会较大",
      recommendation: `占比虽小（近6个月 ${fmtPct(share6m)}）但趋势向上，可作为增长型细分方向观察。`,
      entryScore: share6m + 10,
    };
  }

  if (input.trendDirection === "declining") {
    if (share6m >= MAINSTREAM_MIN_SHARE_PCT) {
      return {
        priority: "谨慎跟进",
        recommendation: `仍是基本盘（近6个月 ${fmtPct(share6m)}），但占比趋势下滑，适合防守型跟进，不宜同质化铺货。`,
        entryScore: share6m - 5,
      };
    }
    return {
      priority: "暂不优先",
      recommendation: `近6个月仅占 TOP ${fmtPct(share6m)} 且占比下行，短期切入机会偏弱，除非有明确差异化规格。`,
      entryScore: share6m - 10,
    };
  }

  if (share6m >= MAINSTREAM_MIN_SHARE_PCT || input.isTopShareShape) {
    return {
      priority: "谨慎跟进",
      recommendation: `近6个月占 TOP ${fmtPct(share6m)}，份额较稳，可维持基本盘布局，优先找形态内高毛利价格带。`,
      entryScore: share6m,
    };
  }
  if (share6m >= 8 && efficiency >= 800) {
    return {
      priority: "机会较大",
      recommendation: `份额稳定（近6个月 ${fmtPct(share6m)}），单链月均 ${Math.round(efficiency)} 件，效率尚可，可作次级验证方向。`,
      entryScore: share6m + 5,
    };
  }
  return {
    priority: "暂不优先",
    recommendation: `近6个月占 TOP ${fmtPct(share6m)}，份额与趋势均不突出，暂不作为优先切入形态。`,
    entryScore: share6m,
  };
}

function buildShapeInsight(
  row: ShapeAggregatedMetrics,
  isTopShareShape: boolean,
): ShapeSalesShareInsight {
  const trend = inferTrendDirection(row.y2024SharePct, row.last3MonthsSharePct, row.last6MonthsSharePct);
  const entry = inferEntryPriority({
    trendDirection: trend.direction,
    last6MonthsSharePct: row.last6MonthsSharePct,
    last3MonthsSharePct: row.last3MonthsSharePct,
    avgLast6MonthsMonthlyPerLink: row.avgLast6MonthsMonthlyPerLink,
    isTopShareShape,
  });

  return {
    productShape: row.productShape,
    last3MonthsSharePct: row.last3MonthsSharePct,
    last6MonthsSharePct: row.last6MonthsSharePct,
    y2025SharePct: row.y2025SharePct,
    y2024SharePct: row.y2024SharePct,
    linkCount: row.linkCount,
    avgLast6MonthsMonthlyPerLink: row.avgLast6MonthsMonthlyPerLink,
    trendDirection: trend.direction,
    trendDeltaPp: trend.deltaPp,
    recentMomentumPp: trend.recentMomentumPp,
    trendLabel: trend.label,
    entryPriority: entry.priority,
    recommendation: entry.recommendation,
    entryScore: entry.entryScore,
  };
}

export function analyzeShapeSalesShare(rows: readonly ShapeAggregatedMetrics[]): ShapeSalesShareAnalysisResult {
  const assigned = rows.filter(row => isAssignedShape(row.productShape));
  if (!assigned.length) {
    return {
      summary: "缺少已标注的商品形态，请先在 TOP 销售表设置形态后再看趋势与切入结论。",
      risingShapes: [],
      decliningShapes: [],
      priorityEntries: [],
      insights: [],
    };
  }

  const topShape = assigned.reduce(
    (best, row) => ((row.last6MonthsSharePct ?? 0) > (best.last6MonthsSharePct ?? 0) ? row : best),
    assigned[0],
  );

  const insights = assigned
    .map(row => buildShapeInsight(row, row.productShape === topShape.productShape))
    .sort((left, right) => right.entryScore - left.entryScore);

  const risingShapes = insights.filter(item => item.trendDirection === "rising");
  const decliningShapes = insights.filter(item => item.trendDirection === "declining");
  const priorityEntries = insights.filter(
    item => item.entryPriority === "优先切入" || item.entryPriority === "机会较大",
  );

  const risingText = risingShapes.length
    ? risingShapes.map(item => item.productShape).join("、")
    : "暂无";
  const decliningText = decliningShapes.length
    ? decliningShapes.map(item => item.productShape).join("、")
    : "暂无";
  const shareSorted = [...assigned].sort(
    (left, right) => (right.last6MonthsSharePct ?? 0) - (left.last6MonthsSharePct ?? 0),
  );
  const topShareText = shareSorted
    .slice(0, 3)
    .map(row => `${row.productShape}（${fmtPct(row.last6MonthsSharePct)}）`)
    .join("、");

  const summary = `近6个月 TOP 样本共 ${assigned.length} 种形态：上升 ${risingText}；下滑 ${decliningText}。占比靠前：${topShareText || "—"}。`;

  return {
    summary,
    risingShapes,
    decliningShapes,
    priorityEntries,
    insights,
  };
}
