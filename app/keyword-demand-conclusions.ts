import { createProductRuleSession, keywordRuleSources } from "./lib/product-structure-analysis";
import type { AnalysisInputScope, AnalysisRuleTrace } from "../shared/product-structure-rules";
import {
  buildKeywordComparisonMatrix,
  resolveKeywordSearchVolume,
  type AggregatedKeyword,
  type CategoryBucket,
  type KeywordDemandAnalysis,
  type KeywordDemandProduct,
  type KeywordDemandSources,
} from "./keyword-demand-analysis";
import type { KeywordCategory } from "./keyword-classifier";
import { sifKeywordEnrichmentData, type KeywordSearchTrendPoint } from "./sif-keyword-enrichment-data";

export type LaunchConclusionItem = {
  label: string;
  value: string;
  /** Only candidates accepted by the shared per-ASIN rules. */
  acceptedValue?: string;
  ruleDecisionIds?: string[];
};

export type LaunchConclusionSection = {
  id: string;
  title: string;
  items: LaunchConclusionItem[];
};

export type FunctionDemandRow = {
  keyword: string;
  type: "基础必备" | "高关注" | "差异化" | "待验证" | "数据不足";
  volume: number | null;
  coverage: number;
  action: string;
};

export type KeywordComboRow = {
  keyword: string;
  elements: string;
  volume: number | null;
};

export type KeywordLaunchVerdict = {
  grade: "A" | "B" | "C" | "D";
  gradeLabel: string;
  opportunityType: string;
  matrixLabel: string;
  recommendLaunch: boolean;
  productProposal: string;
};

export type KeywordLaunchConclusions = {
  ruleTrace?: AnalysisRuleTrace;
  headline: string;
  verdict: KeywordLaunchVerdict;
  sections: LaunchConclusionSection[];
  functionMatrix: FunctionDemandRow[];
  keywordCombos: KeywordComboRow[];
  dataGaps: string[];
  hasData: boolean;
};

/** @deprecated 保留类型兼容，UI 已切换为 KeywordLaunchConclusions */
export type KeywordDemandConclusionDimension = {
  id: string;
  label: string;
  trafficSharePct: number;
  keywordCount: number;
  topKeywords: string;
  searchVolumeTotal: number | null;
  topSearchKeyword: string | null;
  topSearchVolume: number | null;
  conclusion: string;
};

/** @deprecated */
export type KeywordDemandConclusions = KeywordLaunchConclusions & {
  summary: string;
  dimensions: KeywordDemandConclusionDimension[];
};

function normalizeKeyword(keyword: string) {
  return keyword.trim().toLowerCase();
}

function resolveVolume(keyword: string, fallback: number | null | undefined, enrichment = sifKeywordEnrichmentData) {
  const enrich = enrichment[normalizeKeyword(keyword)];
  return resolveKeywordSearchVolume(enrich?.searchTrend ?? [], fallback).volume;
}

function resolveTrend(keyword: string, enrichment = sifKeywordEnrichmentData): KeywordSearchTrendPoint[] {
  return enrichment[normalizeKeyword(keyword)]?.searchTrend ?? [];
}

function formatVolume(value: number | null | undefined) {
  if (value == null || value <= 0) return "—";
  if (value >= 10000) return `约 ${(value / 10000).toFixed(1)} 万/月`;
  return `约 ${value.toLocaleString()}/月`;
}

function formatKeywordList(keywords: AggregatedKeyword[], limit = 3) {
  if (!keywords.length) return "—";
  return keywords
    .slice(0, limit)
    .map(item => `「${item.keyword}」`)
    .join("、");
}

function pickKeywords(categories: CategoryBucket[], ids: KeywordCategory[], enrichment = sifKeywordEnrichmentData) {
  return categories
    .filter(item => ids.includes(item.id))
    .flatMap(item => item.keywords)
    .sort(
      (a, b) =>
        b.aggregateShare - a.aggregateShare ||
        (resolveVolume(b.keyword, b.searchVolume, enrichment) ?? 0) - (resolveVolume(a.keyword, a.searchVolume, enrichment) ?? 0),
    );
}

function extractAgeBands(keywords: AggregatedKeyword[]) {
  const bands = new Map<string, number>();
  const pattern =
    /\b(\d+)\s*[-–]\s*(\d+)\b|\b(\d+)\s*\+?\s*year|\bages?\s*(\d+)\s*[-–]\s*(\d+)\b|\bfor\s+(\d+)\s*[-–]\s*(\d+)\b|\btoddlers?\b|\bbaby\b|\binfant\b/gi;
  for (const item of keywords) {
    const text = item.keyword.toLowerCase();
    if (/\btoddlers?\b|\bbaby\b|\binfant\b/.test(text)) {
      bands.set("幼儿/toddler", (bands.get("幼儿/toddler") ?? 0) + item.aggregateShare);
    }
    let match = pattern.exec(text);
    while (match) {
      if (match[1] && match[2]) bands.set(`${match[1]}-${match[2]} 岁`, (bands.get(`${match[1]}-${match[2]} 岁`) ?? 0) + item.aggregateShare);
      else if (match[3]) bands.set(`${match[3]}+ 岁`, (bands.get(`${match[3]}+ 岁`) ?? 0) + item.aggregateShare);
      else if (match[4] && match[5]) bands.set(`${match[4]}-${match[5]} 岁`, (bands.get(`${match[4]}-${match[5]} 岁`) ?? 0) + item.aggregateShare);
      else if (match[6] && match[7]) bands.set(`${match[6]}-${match[7]} 岁`, (bands.get(`${match[6]}-${match[7]} 岁`) ?? 0) + item.aggregateShare);
      match = pattern.exec(text);
    }
  }
  return [...bands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
}

function extractCalendarMonth(month: string): number | null {
  const iso = month.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (iso) {
    const value = Number(iso[2]);
    return value >= 1 && value <= 12 ? value : null;
  }
  const bare = month.match(/^(\d{1,2})$/);
  if (bare) {
    const value = Number(bare[1]);
    return value >= 1 && value <= 12 ? value : null;
  }
  const labeled = month.match(/(\d{1,2})\s*月/);
  if (labeled) {
    const value = Number(labeled[1]);
    return value >= 1 && value <= 12 ? value : null;
  }
  return null;
}

/** 季节性只按自然月表达（如 12月），不带年份，避免把某一年份事件写成季节规律 */
export function formatSeasonMonthLabel(month: string | number | null | undefined): string | null {
  if (month == null || month === "") return null;
  if (typeof month === "number") {
    return month >= 1 && month <= 12 ? `${month}月` : null;
  }
  const value = extractCalendarMonth(String(month).trim());
  return value == null ? null : `${value}月`;
}

function analyzeTrend(trends: KeywordSearchTrendPoint[][]) {
  const valid = trends.filter(item => item.length >= 6);
  if (!valid.length) return null;

  let yoySum = 0;
  let yoyCount = 0;
  /** 按自然月 1–12 汇总，跨年样本合并后判断季节高峰/低谷 */
  const monthlyTotals = new Map<number, number>();

  for (const trend of valid) {
    const recent = trend.slice(-3).reduce((s, p) => s + p.volume, 0) / 3;
    const earlier = trend.slice(0, 3).reduce((s, p) => s + p.volume, 0) / 3;
    if (earlier > 0) {
      yoySum += ((recent - earlier) / earlier) * 100;
      yoyCount += 1;
    }
    for (const point of trend) {
      const calendarMonth = extractCalendarMonth(point.month);
      if (calendarMonth == null) continue;
      monthlyTotals.set(calendarMonth, (monthlyTotals.get(calendarMonth) ?? 0) + point.volume);
    }
  }

  const months = [...monthlyTotals.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const peak = months[0];
  const trough = months[months.length - 1];
  const ratio = peak && trough && trough[1] > 0 ? peak[1] / trough[1] : null;
  const avgChange = yoyCount ? yoySum / yoyCount : null;

  let lifecycle: string;
  if (avgChange == null) lifecycle = "数据不足，暂无法判断生命周期";
  else if (avgChange >= 8) lifecycle = "增长期（近端月均需高于期初）";
  else if (avgChange <= -8) lifecycle = "衰退期（近端月均低于期初）";
  else lifecycle = "稳定期（近12个月波动有限）";

  return {
    avgChange,
    lifecycle,
    peakMonth: peak ? formatSeasonMonthLabel(peak[0]) : null,
    troughMonth: trough ? formatSeasonMonthLabel(trough[0]) : null,
    seasonRatio: ratio,
  };
}

function classifyDemandScale(headVolume: number | null, totalTop20: number | null) {
  if (headVolume == null) return "数据不足";
  if (headVolume >= 80000 || (totalTop20 ?? 0) >= 300000) return "大需求（头部词月搜 8 万+ 或 Top20 合计 30 万+，可支撑较高 MOQ）";
  if (headVolume >= 20000 || (totalTop20 ?? 0) >= 80000) return "中需求（具备稳定月销量空间，需精准定位岁段/功能）";
  return "小需求（宜控制首单，走长尾细分或差异化切入）";
}

function audienceToProductParams(audienceKw: AggregatedKeyword[], ageBands: string[]) {
  const hints: string[] = [];
  const text = audienceKw.map(item => item.keyword).join(" ");
  if (/\btoddlers?|\bbaby|\binfant|\b1[\s-]?3\b|\b2 year/i.test(text)) {
    hints.push("存在低幼搜索需求：先核对商品适龄限制、实际尺寸与操作难度，不直接认定适合低幼");
  }
  if (/\bboys?\b|\bgirls?\b|\bniñ[oa]s?\b/i.test(text)) {
    hints.push("核对人群偏好与使用反馈，再验证配色和场景展示方案");
  }
  if (/\bkids?|\bchildren\b/i.test(text)) {
    hints.push("核对儿童使用的适龄条件、尺寸与操作难度；配置需结合当前产品结构确认");
  }
  if (ageBands.length) hints.push(`搜索年龄线索：${ageBands.join("、")}；按已确认适龄范围验证实际尺寸`);
  return hints.length ? hints.join("；") : "需结合 VOC 将人群词转化为结构/安全/尺寸参数";
}

function buildFunctionMatrix(functionKw: AggregatedKeyword[], readyCount: number, enrichment = sifKeywordEnrichmentData): FunctionDemandRow[] {
  const volumes = functionKw.map(item => resolveVolume(item.keyword, item.searchVolume, enrichment)).filter((v): v is number => v != null && v > 0);
  const volThreshold = volumes.length ? volumes.sort((a, b) => b - a)[Math.floor(volumes.length * 0.5)] ?? 0 : 0;

  return functionKw.slice(0, 12).map(item => {
    const volume = resolveVolume(item.keyword, item.searchVolume, enrichment);
    const coverage = item.competitorCount;
    let type: FunctionDemandRow["type"];
    let action: string;

    if (volume == null || !Number.isFinite(volume) || volume <= 0) {
      type = "数据不足";
      action = "补齐有效月搜索量，再结合 VOC 评估配置优先级";
    } else if (coverage >= Math.max(2, readyCount - 1) && volume >= volThreshold * 0.5) {
      type = "基础必备";
      action = "必须配置并在标题/主图展示";
    } else if ((volume ?? 0) >= volThreshold) {
      type = "高关注";
      action = "优先配置，写入五点与 A+ 功能模块";
    } else if (coverage <= 1 && (volume ?? 0) >= 3000) {
      type = "差异化";
      action = "评估成本后作为差异化卖点或小批量测试";
    } else {
      type = "待验证";
      action = "已有搜索信号；结合 VOC、竞品实际功能及付费意愿验证配置价值";
    }

    return { keyword: item.keyword, type, volume, coverage, action };
  });
}

function buildKeywordCombos(allKeywords: AggregatedKeyword[], enrichment = sifKeywordEnrichmentData): KeywordComboRow[] {
  const productKw = allKeywords.filter(item => item.category === "core_product");
  const rootPattern = productKw.length
    ? new RegExp(productKw.slice(0, 3).map(k => k.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : /\b(scooter|scooters|lamp|lamps)\b/i;

  const MIN_COMBO_VOLUME = 10000;

  return allKeywords
    .filter(item => {
      const text = item.keyword.toLowerCase();
      if (!rootPattern.test(text)) return false;
      const signals = [
        /\bfor\b|\bwith\b|\b\d+\s*[-–]\s*\d+\b|\b\d+\s*year/i.test(text),
        item.category !== "core_product" && item.category !== "category",
      ];
      return signals.filter(Boolean).length >= 1 && text.split(/\s+/).length >= 3;
    })
    .map(item => {
      const parts: string[] = [];
      if (item.category === "core_product") parts.push("产品形态");
      if (item.category === "function") parts.push("功能");
      if (item.category === "audience" || item.category === "age") parts.push("人群/年龄");
      if (item.category === "scenario") parts.push("场景");
      if (item.category === "attribute_spec") parts.push("规格");
      if (item.category === "material_style") parts.push("材质/风格");
      if (item.category === "benefit" || item.category === "pain_need") parts.push("痛点/利益");
      if (!parts.length) parts.push("组合需求");
      return {
        keyword: item.keyword,
        elements: parts.join(" + "),
        volume: resolveVolume(item.keyword, item.searchVolume, enrichment),
      };
    })
    .filter(row => (row.volume ?? 0) > MIN_COMBO_VOLUME)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 8);
}

function inferProductForm(productKw: AggregatedKeyword[], specKw: AggregatedKeyword[]) {
  const combined = [...productKw, ...specKw].slice(0, 5);
  if (!combined.length) return "—";
  return formatKeywordList(combined, 4);
}

function buildPriceBand(products: KeywordDemandProduct[]) {
  const prices = products.map(item => item.price).filter((p): p is number => p != null && p > 0);
  if (!prices.length) return { text: "—", mid: null as number | null };
  const sorted = [...prices].sort((a, b) => a - b);
  const low = sorted[0]!;
  const high = sorted[sorted.length - 1]!;
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  return {
    text: `竞品样本 $${low.toFixed(0)}–$${high.toFixed(0)}（中位约 $${mid.toFixed(0)}）`,
    mid,
  };
}

function assessCompetition(matrix: ReturnType<typeof buildKeywordComparisonMatrix>, brandSharePct: number, enrichment = sifKeywordEnrichmentData) {
  const rows = matrix.rows.slice(0, 30);
  const withTop3 = rows
    .map(row => enrichment[normalizeKeyword(row.keyword)]?.top3ClickShare)
    .filter((v): v is number => v != null);
  const avgTop3Click = withTop3.length ? withTop3.reduce((s, v) => s + v, 0) / withTop3.length : null;
  const lowCoverageRows = rows.filter(row => row.coverageCount <= 1 && (row.searchVolume ?? 0) >= 5000);

  let difficulty: "低" | "中" | "高";
  if (avgTop3Click != null && avgTop3Click >= 45 && brandSharePct >= 15) difficulty = "高";
  else if (avgTop3Click != null && avgTop3Click >= 35) difficulty = "中";
  else difficulty = "低";

  return {
    difficulty,
    avgTop3Click,
    whiteSpaceCount: lowCoverageRows.length,
    detail:
      avgTop3Click != null
        ? `Top 词均 Top3 点击占比 ${avgTop3Click.toFixed(0)}%${brandSharePct >= 10 ? "，品牌词流量占比较高" : ""}${lowCoverageRows.length ? `，${lowCoverageRows.length} 个中等月搜词竞品覆盖≤1` : ""}`
        : "点击集中度数据不足，仅基于流量覆盖判断",
  };
}

function decideOpportunity(
  demandScale: string,
  trend: ReturnType<typeof analyzeTrend>,
  competition: ReturnType<typeof assessCompetition>,
  functionRows: FunctionDemandRow[],
  ageBandCount: number,
): KeywordLaunchVerdict {
  const isLarge = demandScale.startsWith("大");
  const isGrowing = (trend?.avgChange ?? 0) >= 5;
  const diffFeatures = functionRows.filter(item => item.type === "差异化").length;
  const highComp = competition.difficulty === "高";
  const lowComp = competition.difficulty === "低";
  const hasWhiteSpace = competition.whiteSpaceCount >= 3;

  let opportunityType: string;
  let matrixLabel: string;
  let grade: KeywordLaunchVerdict["grade"];

  if (isLarge && highComp) {
    opportunityType = "大需求升级型";
    matrixLabel = "高需求 × 高竞争 → 升级机会";
    grade = diffFeatures >= 2 ? "B" : "C";
  } else if (isGrowing && !highComp) {
    opportunityType = "增长需求切入型";
    matrixLabel = "中高需求 × 中低竞争 → 优先/增长机会";
    grade = "A";
  } else if (hasWhiteSpace || ageBandCount >= 2) {
    opportunityType = "长尾细分型";
    matrixLabel = lowComp ? "中低需求 × 低竞争 → 细分机会" : "细分需求 × 中等竞争 → 精准切入";
    grade = lowComp ? "A" : "B";
  } else if (competition.whiteSpaceCount >= 1 && diffFeatures >= 1) {
    opportunityType = "需求空白型";
    matrixLabel = "存在低覆盖需求组合 → 空白/组合机会";
    grade = "B";
  } else if (!isLarge && highComp) {
    opportunityType = "低价值机会";
    matrixLabel = "低需求 × 高竞争 → 不建议优先进入";
    grade = "D";
  } else {
    opportunityType = isLarge ? "大需求升级型" : "长尾细分型";
    matrixLabel = isLarge ? "高需求 × 中等竞争 → 升级机会" : "中等需求 → 优化后验证";
    grade = isLarge ? "B" : "C";
  }

  const gradeLabels: Record<KeywordLaunchVerdict["grade"], string> = {
    A: "A级：建议立项",
    B: "B级：优化后立项",
    C: "C级：继续观察",
    D: "D级：不建议立项",
  };

  const recommendLaunch = grade === "A" || grade === "B";

  return {
    grade,
    gradeLabel: gradeLabels[grade],
    opportunityType,
    matrixLabel,
    recommendLaunch,
    productProposal: "见下方「产品开发建议」",
  };
}

function buildProductProposal(
  productKw: AggregatedKeyword[],
  audienceKw: AggregatedKeyword[],
  ageBands: string[],
  scenarioKw: AggregatedKeyword[],
  functionRows: FunctionDemandRow[],
  specKw: AggregatedKeyword[],
  styleKw: AggregatedKeyword[],
  painKw: AggregatedKeyword[],
  priceMid: number | null,
) {
  const form = productKw[0]?.keyword ?? "该品类核心产品";
  const audience = audienceKw[0]?.keyword ?? "目标人群待 VOC 确认";
  const age = ageBands[0] ?? (ageBands.length ? ageBands.join("、") : "适龄区间待细化");
  const scenario = scenarioKw[0]?.keyword ?? "日常/通用场景";
  const baseFn = functionRows.filter(item => item.type === "基础必备" || item.type === "高关注").slice(0, 3).map(item => item.keyword);
  const diffFn = functionRows.filter(item => item.type === "差异化").slice(0, 2).map(item => item.keyword);
  const spec = specKw.slice(0, 2).map(item => item.keyword);
  const style = styleKw.slice(0, 2).map(item => item.keyword);
  const pain = painKw.slice(0, 2).map(item => item.keyword);

  const priceHint = priceMid ? `建议入门价带锚定竞品中位 $${priceMid.toFixed(0)} 附近，差异化功能可上探 10–15%` : "价格带需补充竞品售价样本";

  return [
    `建议开发：面向 ${audience}${age !== "适龄区间待细化" ? `（${age}）` : ""} 的 ${form}，`,
    `核心场景 ${scenario}；`,
    baseFn.length ? `基础功能：${baseFn.join("、")}；` : "",
    diffFn.length ? `差异化：${diffFn.join("、")}；` : "",
    spec.length || style.length ? `规格/外观：${[...spec, ...style].join("、")}；` : "",
    pain.length ? `解决痛点：${pain.join("、")}。` : "",
    priceHint,
  ]
    .filter(Boolean)
    .join("");
}

export function buildKeywordLaunchConclusions(
  analysis: KeywordDemandAnalysis,
  products: KeywordDemandProduct[],
  analysisScope?: Partial<AnalysisInputScope>,
  sources?: KeywordDemandSources,
): KeywordLaunchConclusions {
  const enrichment = sources?.enrichmentByKeyword ?? sifKeywordEnrichmentData;
  const ruleSession = createProductRuleSession(products, keywordRuleSources(analysis, analysisScope));
  const dataGaps: string[] = [];

  if (!analysis.hasData) {
    return {
      headline: "等待 SIF 关键词数据",
      verdict: {
        grade: "C",
        gradeLabel: "C级：继续观察",
        opportunityType: "—",
        matrixLabel: "—",
        recommendLaunch: false,
        productProposal: "同步关键词数据后再输出开品结论",
      },
      sections: [],
      functionMatrix: [],
      keywordCombos: [],
      dataGaps: ["SIF 反查流量词尚未同步，无法还原需求规模与开品方向"],
      hasData: false,
    };
  }

  const allKeywords = analysis.categories.flatMap(item => item.keywords);
  const productKw = pickKeywords(analysis.categories, ["core_product"], enrichment);
  const functionKw = pickKeywords(analysis.categories, ["function"], enrichment);
  const benefitKw = pickKeywords(analysis.categories, ["benefit"], enrichment);
  const painKw = pickKeywords(analysis.categories, ["pain_need"], enrichment);
  const audienceKw = pickKeywords(analysis.categories, ["audience"], enrichment);
  const ageKw = pickKeywords(analysis.categories, ["age"], enrichment);
  const scenarioKw = pickKeywords(analysis.categories, ["scenario"], enrichment);
  const specKw = pickKeywords(analysis.categories, ["attribute_spec"], enrichment);
  const styleKw = pickKeywords(analysis.categories, ["material_style"], enrichment);
  const holidayKw = pickKeywords(analysis.categories, ["holiday_season"], enrichment);
  const brandKw = pickKeywords(analysis.categories, ["brand_competitor"], enrichment);

  const withVolume = allKeywords
    .map(item => ({ ...item, volume: resolveVolume(item.keyword, item.searchVolume, enrichment) }))
    .filter(item => item.volume != null && item.volume > 0)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  const headVolume = withVolume[0]?.volume ?? null;
  const totalTop20 = withVolume.slice(0, 20).reduce((s, item) => s + (item.volume ?? 0), 0);
  const demandScale = classifyDemandScale(headVolume, totalTop20);

  const topTrends = withVolume.slice(0, 8).map(item => resolveTrend(item.keyword, enrichment)).filter(item => item.length >= 6);
  const trend = analyzeTrend(topTrends);
  if (!trend) dataGaps.push("近12个月搜索趋势样本不足，趋势/季节性判断置信度有限");

  const ageBands = extractAgeBands([...ageKw, ...audienceKw]).map(([label]) => label);
  const matrix = buildKeywordComparisonMatrix(products, { limit: 80, sources });
  const brandSharePct = analysis.categories.find(item => item.id === "brand_competitor")?.sharePct ?? 0;
  const competition = assessCompetition(matrix, brandSharePct, enrichment);

  const functionMatrix = buildFunctionMatrix(functionKw, analysis.meta.readyCount, enrichment);
  if (functionMatrix.some(row => row.type === "数据不足")) {
    dataGaps.push("部分功能词缺少有效月搜索量，暂不能判断配置优先级");
  }
  const keywordCombos = buildKeywordCombos(allKeywords, enrichment);
  const priceBand = buildPriceBand(products);

  const ruleSuggestion = (raw: string, id: string) => {
    if (!raw || raw === "—") return { value: "—", acceptedValue: undefined, ruleDecisionIds: [] as string[] };
    const evaluated = ruleSession.explain(raw, id);
    const relevant = ruleSession.decisions.filter(decision => evaluated.ruleDecisionIds.includes(decision.candidateId));
    const accepted = relevant.filter(decision => decision.outcome === "supported");
    const acceptedValue = accepted.length
      ? accepted.map(decision => products.length > 1 ? `【${decision.asin}】${decision.text}` : decision.text).join("；")
      : undefined;
    const status = acceptedValue
      ? `已通过适用性核对：${acceptedValue}`
      : "未进入正式产品配置；需按 ASIN 核对结构与需求依据";
    return { value: `需求假设：${raw}（${status}）`, acceptedValue, ruleDecisionIds: evaluated.ruleDecisionIds };
  };
  const suggestedForm = ruleSuggestion(inferProductForm(productKw, specKw), "keyword-product-form");
  const suggestedBase = ruleSuggestion(
    functionMatrix.filter(item => item.type === "基础必备" || item.type === "高关注").slice(0, 5).map(item => item.keyword).join("、") || "—",
    "keyword-base-features",
  );
  const suggestedDifferentiation = ruleSuggestion(
    functionMatrix.filter(item => item.type === "差异化").map(item => item.keyword).join("、") || "—",
    "keyword-differentiated-features",
  );
  const suggestedMaterial = ruleSuggestion(
    [...specKw.slice(0, 2), ...styleKw.slice(0, 2)].map(item => item.keyword).join("、") || "—",
    "keyword-material-spec",
  );

  if (!products.some(item => item.price != null)) {
    dataGaps.push("未传入竞品售价，价格带与利润判断需补充 catalog 价格");
  }

  const avgCpc = withVolume
    .slice(0, 10)
    .map(item => sifKeywordEnrichmentData[normalizeKeyword(item.keyword)]?.bidMedian)
    .filter((v): v is number => v != null);
  const cpcText = avgCpc.length ? `头部词 CPC 中位约 $${(avgCpc.reduce((s, v) => s + v, 0) / avgCpc.length).toFixed(2)}` : "—";

  if (!avgCpc.length) dataGaps.push("广告竞价/CPC  enrichment 不足，推广成本判断需补充");

  const verdict = decideOpportunity(demandScale, trend, competition, functionMatrix, ageBands.length);
  verdict.productProposal = buildProductProposal(
    productKw,
    audienceKw,
    ageBands,
    scenarioKw,
    functionMatrix,
    specKw,
    styleKw,
    painKw,
    priceBand.mid,
  );

  const sections: LaunchConclusionSection[] = [
    {
      id: "market_demand",
      title: "1. 市场需求概况",
      items: [
        { label: "核心需求规模", value: `${demandScale}；头部词 ${withVolume[0]?.keyword ?? "—"} ${formatVolume(headVolume)}` },
        {
          label: "近12个月趋势",
          value: trend
            ? trend.avgChange != null
              ? `近端较期初 ${trend.avgChange >= 0 ? "+" : ""}${trend.avgChange.toFixed(0)}% · ${trend.lifecycle}`
              : trend.lifecycle
            : "—",
        },
        {
          label: "旺季 / 淡季",
          value: trend?.peakMonth && trend.troughMonth
            ? `高峰 ${trend.peakMonth} · 低谷 ${trend.troughMonth}${trend.seasonRatio ? ` · 旺淡季倍率约 ${trend.seasonRatio.toFixed(1)}x` : ""}`
            : "—",
        },
        { label: "市场生命周期", value: trend?.lifecycle ?? "—" },
      ],
    },
    {
      id: "customer_profile",
      title: "2. 顾客需求画像",
      items: [
        { label: "核心使用人群", value: formatKeywordList(audienceKw, 4) },
        { label: "重点年龄段", value: ageBands.length ? ageBands.join("、") : formatKeywordList(ageKw, 3) },
        {
          label: "人群→产品参数",
          value: ruleSession.audience(audienceToProductParams(audienceKw, ageBands)).text,
          ruleDecisionIds: products.map(p => `keyword-audience:${p.asin}`),
        },
        { label: "主要使用场景", value: formatKeywordList(scenarioKw, 3) },
        {
          label: "核心购买动机",
          value: benefitKw.length ? formatKeywordList(benefitKw, 3) : formatKeywordList(productKw, 2),
        },
        { label: "功能搜索信号", value: formatKeywordList(functionKw, 4) },
        { label: "最关注属性/规格", value: formatKeywordList(specKw, 3) },
        { label: "主要痛点/未满足需求", value: painKw.length ? formatKeywordList(painKw, 3) : "流量词中痛点词不明显，需交叉 VOC 差评" },
      ],
    },
    {
      id: "competition",
      title: "3. 市场供给与竞争",
      items: [
        { label: "主流产品形态（搜索需求假设）", ...suggestedForm },
        { label: "主流价格带", value: priceBand.text },
        {
          label: "头部集中度",
          value: competition.avgTop3Click != null ? `Top 词均 Top3 点击 ${competition.avgTop3Click.toFixed(0)}%` : "—",
        },
        { label: "品牌/竞品词流量", value: brandKw.length ? `${formatKeywordList(brandKw, 2)}（占流量 ${brandSharePct.toFixed(0)}%）` : "品牌词占比低" },
        {
          label: "需求匹配缺口",
          value: competition.whiteSpaceCount > 0 ? `${competition.whiteSpaceCount} 个月搜≥5k 词竞品覆盖≤1，存在细分空白` : "暂无明显低覆盖词",
        },
        { label: "竞争进入难度", value: `${competition.difficulty} · ${competition.detail}` },
        { label: "广告成本信号", value: cpcText },
      ],
    },
    {
      id: "product_dev",
      title: "4. 产品开发建议",
      items: [
        {
          label: "建议产品定位",
          value: `${audienceKw[0]?.keyword ?? "目标用户"} · ${ageBands[0] ?? "适龄"} · ${scenarioKw[0]?.keyword ?? "通用场景"}`,
        },
        { label: "建议产品形态", ...suggestedForm },
        {
          label: "基础功能清单",
          ...suggestedBase,
        },
        {
          label: "差异化功能清单",
          ...suggestedDifferentiation,
        },
        {
          label: "建议材质与规格",
          ...suggestedMaterial,
        },
        {
          label: "建议颜色/SKU",
          value: styleKw.length ? `主推 ${formatKeywordList(styleKw, 3)} 变体` : "颜色词流量弱，SKU 宜从竞品变体结构反推",
        },
        { label: "建议目标售价", value: priceBand.text },
        {
          label: "建议首单策略",
          value: demandScale.startsWith("大")
            ? "需求体量大，可按主流岁段各 1 个主推色起量；旺季前 2–3 个月到货"
            : demandScale.startsWith("中")
              ? "中等需求，首单控制 2–3 个 SKU，优先覆盖最高月搜岁段"
              : "小需求/长尾，小批量测 1–2 个精准 SKU",
        },
        {
          label: "核心差异化卖点",
          value: painKw.length
            ? `痛点导向：${formatKeywordList(painKw, 2)}`
            : diffFeaturesSummary(functionMatrix, benefitKw),
        },
      ],
    },
    {
      id: "launch_decision",
      title: "5. 立项判断",
      items: [
        { label: "产品机会类型", value: verdict.opportunityType },
        { label: "机会矩阵", value: verdict.matrixLabel },
        { label: "产品机会等级", value: verdict.gradeLabel },
        { label: "是否建议立项", value: verdict.recommendLaunch ? "是" : "否（或换细分方向）" },
        { label: "立项依据", value: verdict.productProposal },
        {
          label: "主要风险",
          value: [
            competition.difficulty === "高" ? "头部集中、广告成本高" : null,
            trend?.seasonRatio && trend.seasonRatio >= 2.5 ? "季节性波动大，备货节奏风险" : null,
            brandSharePct >= 15 ? "品牌检索占比高，新品需强差异化" : null,
            holidayKw.length ? `节日词存在（${formatKeywordList(holidayKw, 2)}），需规划礼品季库存` : null,
          ]
            .filter(Boolean)
            .join("；") || "需补充专利/认证/VOC 交叉验证",
        },
        {
          label: "下一步验证",
          value: [
            "VOC 差评交叉确认痛点词",
            "竞品结构/成本拆解验证差异化功能",
            dataGaps.length ? "补齐数据：" + dataGaps[0] : null,
            "合规/专利检索（尤其儿童品类）",
          ]
            .filter(Boolean)
            .join(" · "),
        },
      ],
    },
  ];

  const headline = `${verdict.gradeLabel} · ${verdict.opportunityType} · ${demandScale.split("（")[0]}`;

  return {
    ruleTrace: ruleSession.trace(),
    headline,
    verdict,
    sections,
    functionMatrix,
    keywordCombos,
    dataGaps,
    hasData: true,
  };
}

function diffFeaturesSummary(functionRows: FunctionDemandRow[], benefitKw: AggregatedKeyword[]) {
  const diff = functionRows.filter(item => item.type === "差异化").map(item => item.keyword);
  if (diff.length) return diff.join("、");
  if (benefitKw.length) return formatKeywordList(benefitKw, 2);
  return "从竞品同质功能中做结构/体验升级";
}

/** 兼容旧调用 */
export function buildKeywordDemandConclusions(
  analysis: KeywordDemandAnalysis,
  products: KeywordDemandProduct[] = [],
): KeywordDemandConclusions {
  const launch = buildKeywordLaunchConclusions(analysis, products);
  return {
    ...launch,
    summary: launch.verdict.productProposal,
    dimensions: [],
  };
}
