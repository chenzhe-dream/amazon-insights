import type { ReviewAnalysisBlockKey } from "../../../app/seller-sprite-review-analysis";
import {
  VOC_DIMENSIONS,
  canonicalTheme,
  isSkippedAlexaLine,
  parseAlexaThemeObservation,
  type VocDimension,
  type VocProductFamily,
} from "./theme-normalization";

export type LegacyVocProduct = Readonly<{
  asin: string;
  brand: string;
  productFamily?: VocProductFamily;
}>;

export type LegacyVocThemeAggregate = {
  label: string;
  mentionPct: number;
  displayText: string;
  brands: string[];
  sources: string[];
};

export type LegacyVocDimensionSummary = {
  key: VocDimension;
  label: string;
  guidance: string;
  themes: LegacyVocThemeAggregate[];
};

type AlexaRecord = Readonly<{
  captureStatus?: string;
  alexaReport?: Readonly<{ reviewCount?: number }>;
}> & Partial<Record<VocDimension, readonly string[]>>;

type ReviewRecord = Readonly<{
  status?: string;
  blocks?: readonly Readonly<{
    key: ReviewAnalysisBlockKey;
    rows: readonly Readonly<{ label: string; sharePct: number }>[];
  }>[];
}>;

export type LegacyVocSummaryInput = Readonly<{
  products: readonly LegacyVocProduct[];
  alexaVocData: Readonly<Record<string, AlexaRecord>>;
  reviewAnalysisData: Readonly<Record<string, ReviewRecord>>;
  dimensionLabels: readonly Readonly<{ key: string; label: string }>[];
  alexaSourceLabel: string;
  reviewSourceLabel: string;
}>;

type ThemeBucket = Map<
  string,
  {
    label: string;
    pcts: number[];
    brands: Set<string>;
    sources: Set<string>;
  }
>;

const REVIEW_BLOCK_TO_DIMENSION: Record<ReviewAnalysisBlockKey, VocDimension> = {
  consumerProfile: "audiences",
  scenarios: "scenarios",
  unmet: "unmet",
  positives: "positives",
  negatives: "negatives",
  motives: "motives",
};

export function buildLegacyVocDevelopmentSummary(
  input: LegacyVocSummaryInput,
): LegacyVocDimensionSummary[] {
  const totalProducts = input.products.length || 1;

  return VOC_DIMENSIONS.map((key) => {
    const bucket: ThemeBucket = new Map();
    collectAlexaThemes(input, key, bucket);
    collectReviewThemes(input, key, bucket);
    const themes = finalizeThemes(bucket, totalProducts);
    const label =
      input.dimensionLabels.find((dimension) => dimension.key === key)?.label ?? key;

    return {
      key,
      label: key === "motives" ? "核心购买动机" : label,
      guidance: buildGuidance(key, themes),
      themes,
    };
  });
}

export function hasLegacyVocDevelopmentData(
  products: readonly Readonly<{ asin: string }>[],
  alexaVocData: Readonly<Record<string, AlexaRecord>>,
  reviewAnalysisData: Readonly<Record<string, ReviewRecord>>,
) {
  return products.some((product) => {
    const alexa = alexaVocData[product.asin]?.captureStatus === "dialog";
    const review = reviewAnalysisData[product.asin]?.status === "ready";
    return alexa || review;
  });
}

function addTheme(
  bucket: ThemeBucket,
  label: string,
  pct: number | null,
  brand: string,
  source: string,
  dimension: VocDimension,
  family: VocProductFamily = "generic",
) {
  if (!label) return;
  const canonical = canonicalTheme(label, dimension, family);
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
  totalProducts: number,
) {
  if (entry.pcts.length) return entry.pcts.reduce((sum, value) => sum + value, 0);
  return entry.brands.size / totalProducts;
}

function finalizeThemes(
  bucket: ThemeBucket,
  totalProducts: number,
): LegacyVocThemeAggregate[] {
  const sorted = [...bucket.values()].sort((left, right) => {
    const leftWeight = themeWeight(left, totalProducts);
    const rightWeight = themeWeight(right, totalProducts);
    return rightWeight - leftWeight || left.label.localeCompare(right.label, "zh-CN");
  });
  const totalWeight =
    sorted.reduce(
      (sum, entry) => sum + themeWeight(entry, totalProducts),
      0,
    ) || 1;

  return sorted.map((entry) => {
    const mentionPct = (themeWeight(entry, totalProducts) / totalWeight) * 100;
    return {
      label: entry.label,
      mentionPct,
      displayText: `【${entry.label}】维度内占比 ${formatPct(mentionPct)}%`,
      brands: [...entry.brands],
      sources: [...entry.sources],
    };
  });
}

function collectAlexaThemes(
  input: LegacyVocSummaryInput,
  dimension: VocDimension,
  bucket: ThemeBucket,
) {
  const skipHeader =
    dimension === "audiences" ||
    dimension === "scenarios" ||
    dimension === "motives";
  for (const product of input.products) {
    const record = input.alexaVocData[product.asin];
    if (!record || record.captureStatus !== "dialog") continue;
    const lines = record[dimension] ?? [];
    lines.forEach((line, index) => {
      if (isSkippedAlexaLine(line)) return;
      if (skipHeader && index === 0 && line.includes("｜")) return;
      const observation = parseAlexaThemeObservation(
        line,
        dimension,
        record.alexaReport?.reviewCount,
      );
      addTheme(
        bucket,
        observation.rawLabel,
        observation.mentionPct,
        product.brand,
        input.alexaSourceLabel,
        dimension,
        product.productFamily ?? "generic",
      );
    });
  }
}

function collectReviewThemes(
  input: LegacyVocSummaryInput,
  dimension: VocDimension,
  bucket: ThemeBucket,
) {
  const blockKeys = (
    Object.entries(REVIEW_BLOCK_TO_DIMENSION) as Array<
      [ReviewAnalysisBlockKey, VocDimension]
    >
  )
    .filter(([, mappedDimension]) => mappedDimension === dimension)
    .map(([blockKey]) => blockKey);

  for (const product of input.products) {
    const analysis = input.reviewAnalysisData[product.asin];
    if (analysis?.status !== "ready" || !analysis.blocks) continue;
    for (const block of analysis.blocks) {
      if (!blockKeys.includes(block.key)) continue;
      for (const row of block.rows) {
        addTheme(
          bucket,
          row.label,
          row.sharePct,
          product.brand,
          input.reviewSourceLabel,
          dimension,
          product.productFamily ?? "generic",
        );
      }
    }
  }
}

function formatPct(value: number) {
  return value >= 1 ? value.toFixed(1) : value.toFixed(2);
}

function buildGuidance(
  key: VocDimension,
  themes: LegacyVocThemeAggregate[],
) {
  const top = themes.slice(0, 3).map((theme) => theme.label);
  const common = themes
    .filter(
      (theme) =>
        theme.brands.length >=
        Math.max(2, Math.ceil(themes[0]?.brands.length ?? 0)),
    )
    .slice(0, 4);

  switch (key) {
    case "attention":
      return top.length
        ? `立项前先验证最高频关注：${top.join("、")}；其中 ${common.map((item) => item.label).join("、") || top.join("、")} 为跨竞品共性。`
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
  }
}
