import {z} from "zod";
import {MarketSiteSchema, type MarketSite} from "../../shared/market-sites";
import type {ManualAlexaVocRecord} from "../../shared/agent-contracts";
import type {Product} from "../project-report-views/competitor-overview";
import type {SellerSpriteReviewAnalysisRecord} from "../seller-sprite-review-analysis";
import {reviewMissingMessage} from "../lib/voc-review-display";
import type {ExportModuleContext, ExportModuleRead} from "./export-module-context";
import {buildCurrentPageAnalysisInputs, publishedReviewRecords, readManualVocRecords, type CurrentPageAnalysisInputs} from "./read-voc-definition-export";

const reviewSchema = z.object({
  asin:z.string(), marketplace:z.string(), sampledReviews:z.number().finite().nonnegative(),
  mentionTopics:z.number().finite().nonnegative().optional(), fetchedAt:z.string(),
  status:z.enum(["ready", "pending", "error"]), statusMessage:z.string().optional(),
  family:z.enum(["scooter", "lighting", "generic"]).optional(),
  blocks:z.array(z.object({
    key:z.enum(["consumerProfile", "scenarios", "unmet", "positives", "negatives", "motives"]),
    label:z.string(), rows:z.array(z.object({label:z.string(), sharePct:z.number().finite(), reason:z.string(),
      metricKind:z.enum(["review_sample_incidence", "customers_say_topic_share"]).optional(),
      numerator:z.number().finite().optional(), denominator:z.number().finite().optional()})),
  })),
});

export type VocSnapshotSources = Readonly<{
  products: Product[];
  market: MarketSite;
  manualRecords: ManualAlexaVocRecord[];
  reviewRecords: Record<string, SellerSpriteReviewAnalysisRecord>;
  reviewUpdatedAt: string;
  reviewMissingMessages: Record<string, string>;
  analysisInputs: CurrentPageAnalysisInputs | null;
}>;

/** Reads saved manual records and the frozen published sources. No history, writes or generated defaults. */
export async function readPageSnapshotVoc(context: ExportModuleContext, read: ExportModuleRead, products: readonly Product[]): Promise<VocSnapshotSources> {
  const market = MarketSiteSchema.parse(context.marketplace);
  if (context.version && context.version.marketplace !== market) throw new Error("已发布 VOC 站点来源范围不匹配");
  if (products.length !== context.asins.length || context.asins.some(asin => products.filter(product => product.asin === asin).length !== 1))
    throw new Error("VOC 商品来源范围不匹配");
  const manualRecords = await readManualVocRecords(context,read);
  const reviewRecords = Object.fromEntries(Object.entries(publishedReviewRecords(context)).map(([asin, record]) => [asin, reviewSchema.parse(record)]));
  const reviewStage = context.version?.stageOutputs.reviews;
  const inputs = buildCurrentPageAnalysisInputs(context,manualRecords);
  // Keep only review presentation fields while preserving the page's candidate-only rule policy.
  const analysisInputs = inputs ? {...inputs, sources:{...inputs.sources, reviewFallbackCandidates:reviewRecords}} : null;
  return structuredClone({products:[...products], market, manualRecords, reviewRecords,
    reviewUpdatedAt: reviewStage && "updatedAt" in reviewStage ? reviewStage.updatedAt : "暂无已保存评论结果",
    reviewMissingMessages:Object.fromEntries(context.asins.map(asin => [asin, reviewStage
      ? reviewMissingMessage(reviewStage,asin) : "暂无已保存的当前项目评论结果。"])),
    analysisInputs});
}
