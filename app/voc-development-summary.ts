import { rufusVocData, rufusVocDimensions } from "./rufus-voc-data";
import { sorftimeReviewAnalysisData } from "./sorftime-review-analysis-data";
import type { ReviewAnalysisBlockKey } from "./seller-sprite-review-analysis";
import { canonicalTheme } from "./voc-theme-merge";

type VocSummaryKey = "attention" | "positives" | "negatives" | "unmet" | "audiences" | "scenarios" | "motives";

export type VocThemeAggregate = {
  label: string;
  mentionPct: number;
  displayText: string;
  brands: string[];
  sources: string[];
};

export type VocDevelopmentDimensionSummary = {
  key: VocSummaryKey;
  label: string;
  guidance: string;
  themes: VocThemeAggregate[];
};

const summaryKeys: VocSummaryKey[] = ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"];

const reviewBlockToSummaryKey: Record<ReviewAnalysisBlockKey, VocSummaryKey> = {
  consumerProfile: "audiences",
  scenarios: "scenarios",
  unmet: "unmet",
  positives: "positives",
  negatives: "negatives",
  motives: "motives",
};

type ThemeBucket = Map<
  string,
  {
    label: string;
    pcts: number[];
    brands: Set<string>;
    sources: Set<string>;
  }
>;


function formatPct(value: number) {
  return value >= 1 ? value.toFixed(1) : value.toFixed(2);
}

type ProductLite = { asin: string; brand: string; productFamily?: "scooter" | "lighting" | "generic" };

function addTheme(
  bucket: ThemeBucket,
  label: string,
  pct: number | null,
  brand: string,
  source: string,
  dimension: VocSummaryKey,
  family: ProductLite["productFamily"] = "generic"
) {
  if (!label) return;
  const canonical = canonicalTheme(label, dimension, family ?? "generic");
  if (!canonical.key) return;
  const current = bucket.get(canonical.key) ?? {
    label: canonical.label,
    pcts: [],
    brands: new Set<string>(),
    sources: new Set<string>(),
  };
  if (pct !== null && Number.isFinite(pct)) current.pcts.push(pct);
  current.brands.add(brand);
  current.sources.add(source);
  bucket.set(canonical.key, current);
}

function themeWeight(
  entry: { pcts: number[]; brands: Set<string> },
  totalProducts: number
) {
  if (entry.pcts.length) return entry.pcts.reduce((sum, value) => sum + value, 0);
  return entry.brands.size / totalProducts;
}

function finalizeThemes(bucket: ThemeBucket, totalProducts: number): VocThemeAggregate[] {
  const sorted = [...bucket.values()].sort((a, b) => {
    const weightA = themeWeight(a, totalProducts);
    const weightB = themeWeight(b, totalProducts);
    return weightB - weightA || a.label.localeCompare(b.label, "zh-CN");
  });

  const totalWeight = sorted.reduce((sum, entry) => sum + themeWeight(entry, totalProducts), 0) || 1;

  return sorted.map(entry => {
    const weight = themeWeight(entry, totalProducts);
    const mentionPct = (weight / totalWeight) * 100;

    return {
      label: entry.label,
      mentionPct,
      displayText: `【${entry.label}】维度内占比 ${formatPct(mentionPct)}%`,
      brands: [...entry.brands],
      sources: [...entry.sources],
    };
  });
}

function extractAttentionTitle(line: string) {
  const match = line.match(/^\d+\.\s*(.+?)：/);
  return match?.[1]?.trim() ?? line.slice(0, 28);
}

function extractBracketLabel(line: string) {
  const match = line.match(/【([^】]+)】/);
  return match?.[1]?.trim() ?? line.slice(0, 28);
}

function extractUnmetLabel(line: string) {
  const text = line.replace(/^\d+\.\s*/, "").trim();
  const hope = text.match(/^希望(.+?)([，。]|$)/);
  return (hope?.[1] ?? text).slice(0, 32);
}

function extractTableLabel(line: string) {
  return line.split("｜")[0]?.trim() ?? line;
}

function isSkippedLine(line: string) {
  return line.includes("待在 Alexa") || line.includes("尚未在 Alexa");
}

function extractMentionPct(line: string, reviewCount?: number) {
  const pctMatch = line.match(/约\s*([\d.]+)\s*%/);
  if (pctMatch) return parseFloat(pctMatch[1]);

  if (reviewCount) {
    const countMatch = line.match(/(\d[\d,]*)\s*(?:条|次)/);
    if (countMatch) {
      const count = Number.parseInt(countMatch[1].replace(/,/g, ""), 10);
      if (count > 0) return (count / reviewCount) * 100;
    }
  }

  return null;
}

function collectAlexaThemes(
  products: ProductLite[],
  key: VocSummaryKey,
  bucket: ThemeBucket,
  skipHeader = false
) {
  const extractors: Record<VocSummaryKey, (line: string) => string> = {
    attention: extractAttentionTitle,
    positives: extractBracketLabel,
    negatives: extractBracketLabel,
    unmet: extractUnmetLabel,
    audiences: extractTableLabel,
    scenarios: extractTableLabel,
    motives: extractTableLabel,
  };

  products.forEach(product => {
    const record = rufusVocData[product.asin];
    if (!record || record.captureStatus !== "dialog") return;
    const reviewCount = record.alexaReport?.reviewCount;
    const lines = record[key] as string[];

    lines.forEach((line, index) => {
      if (isSkippedLine(line)) return;
      if (skipHeader && index === 0 && line.includes("｜")) return;
      const label = extractors[key](line);
      addTheme(bucket, label, extractMentionPct(line, reviewCount), product.brand, "VOC 核心主题", key, product.productFamily);
    });
  });
}

function collectReviewThemesForKey(
  products: ProductLite[],
  data: Record<string, { status?: string; blocks?: Array<{ key: ReviewAnalysisBlockKey; rows: Array<{ label: string; sharePct: number }> }> }>,
  sourceLabel: string,
  summaryKey: VocSummaryKey,
  bucket: ThemeBucket
) {
  const blockKeys = (Object.entries(reviewBlockToSummaryKey) as Array<[ReviewAnalysisBlockKey, VocSummaryKey]>)
    .filter(([, mappedKey]) => mappedKey === summaryKey)
    .map(([blockKey]) => blockKey);

  products.forEach(product => {
    const analysis = data[product.asin];
    if (analysis?.status !== "ready" || !analysis.blocks) return;

    analysis.blocks.forEach(block => {
      if (!blockKeys.includes(block.key)) return;
      block.rows.forEach(row => {
        addTheme(bucket, row.label, row.sharePct, product.brand, sourceLabel, summaryKey, product.productFamily);
      });
    });
  });
}

function buildGuidance(key: VocSummaryKey, themes: VocThemeAggregate[]) {
  const top = themes.slice(0, 3).map(theme => theme.label);
  const common = themes.filter(theme => theme.brands.length >= Math.max(2, Math.ceil(themes[0]?.brands.length ?? 0))).slice(0, 4);

  switch (key) {
    case "attention":
      return top.length
        ? `立项前先验证最高频关注：${top.join("、")}；其中 ${common.map(item => item.label).join("、") || top.join("、")} 为跨竞品共性。`
        : "待汇总顾客关注点。";
    case "positives":
      return top.length
        ? `上市必须兑现的基础体验：${top.join("、")}；这些是类目好评底盘，不能明显弱于竞品。`
        : "待汇总好评主题。";
    case "negatives":
      return top.length
        ? `开发阶段重点规避：${top.join("、")}；优先从结构、备件与说明三方面降低同类差评。`
        : "待汇总差评主题。";
    case "unmet":
      return top.length
        ? `差异化机会集中在：${top.join("；")}；可作为新品功能清单与包装沟通点。`
        : "待汇总未满足需求。";
    case "audiences":
      return top.length
        ? `默认主攻人群：${top.join("、")}；文案与尺寸/承重规格需优先对齐这些人群。`
        : "待汇总使用人群。";
    case "scenarios":
      return top.length
        ? `首发场景建议覆盖：${top.join("、")}；主图、A+ 与视频素材按场景成套呈现。`
        : "待汇总使用场景。";
    case "motives":
      return top.length
        ? `核心购买理由应围绕：${top.join("、")}；详情页首屏与五点描述与上述动机对齐。`
        : "待汇总购买动机。";
    default:
      return "";
  }
}

export function buildVocDevelopmentSummary(
  products: ProductLite[]
): VocDevelopmentDimensionSummary[] {
  const totalProducts = products.length || 1;

  return summaryKeys.map(key => {
    const bucket: ThemeBucket = new Map();

    collectAlexaThemes(products, key, bucket, key === "audiences" || key === "scenarios" || key === "motives");
    collectReviewThemesForKey(products, sorftimeReviewAnalysisData, "Sorftime 评论分析", key, bucket);

    const label = rufusVocDimensions.find(dimension => dimension.key === key)?.label ?? key;
    const themes = finalizeThemes(bucket, totalProducts);

    return {
      key,
      label: key === "motives" ? "核心购买动机" : label,
      guidance: buildGuidance(key, themes),
      themes,
    };
  });
}

export function hasVocDevelopmentData(products: Array<{ asin: string }>) {
  return products.some(product => {
    const alexa = rufusVocData[product.asin]?.captureStatus === "dialog";
    const sorftime = sorftimeReviewAnalysisData[product.asin]?.status === "ready";
    return alexa || sorftime;
  });
}

export const vocDevBarPalette: Record<VocSummaryKey, string> = {
  attention: "#5DAFE8",
  positives: "#6BCB9A",
  negatives: "#E85D5D",
  unmet: "#F0923E",
  audiences: "#9B72D4",
  scenarios: "#5DAFE8",
  motives: "#F5C451",
};

export const vocDevelopmentSummaryMeta = {
  sources: ["VOC 核心主题", "智能评论分析 · Sorftime"],
  format: "【分类】+ 维度内占比（同一维度合计 100%）",
};

export const vocInsightRingDimensions: Array<{
  key: VocSummaryKey;
  num: string;
  en: string;
}> = [
  { key: "attention", num: "01", en: "CONCERNS" },
  { key: "positives", num: "02", en: "PROS" },
  { key: "negatives", num: "03", en: "CONS" },
  { key: "unmet", num: "04", en: "GAPS" },
  { key: "scenarios", num: "05", en: "SCENES" },
  { key: "audiences", num: "06", en: "USERS" },
  { key: "motives", num: "07", en: "MOTIVES" },
];
