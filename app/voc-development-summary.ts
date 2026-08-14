import { rufusVocData, rufusVocDimensions } from "./rufus-voc-data";
import { sorftimeReviewAnalysisData } from "./sorftime-review-analysis-data";
import {
  buildLegacyVocDevelopmentSummary,
  hasLegacyVocDevelopmentData,
  type LegacyVocDimensionSummary,
  type LegacyVocProduct,
  type LegacyVocThemeAggregate,
} from "../server/domain/voc/legacy-summary";
import type { VocDimension } from "../server/domain/voc/theme-normalization";

type VocSummaryKey = VocDimension;
type ProductLite = LegacyVocProduct;

export type VocThemeAggregate = LegacyVocThemeAggregate;
export type VocDevelopmentDimensionSummary = LegacyVocDimensionSummary;

export function buildVocDevelopmentSummary(
  products: readonly ProductLite[],
): VocDevelopmentDimensionSummary[] {
  return buildLegacyVocDevelopmentSummary({
    products,
    alexaVocData: rufusVocData,
    reviewAnalysisData: sorftimeReviewAnalysisData,
    dimensionLabels: rufusVocDimensions,
    alexaSourceLabel: "VOC 核心主题",
    reviewSourceLabel: "Sorftime 评论分析",
  });
}

export function hasVocDevelopmentData(products: readonly Readonly<{ asin: string }>[]) {
  return hasLegacyVocDevelopmentData(
    products,
    rufusVocData,
    sorftimeReviewAnalysisData,
  );
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
