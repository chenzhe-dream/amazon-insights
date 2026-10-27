import type { SellerSpriteReviewAnalysisRecord } from "../seller-sprite-review-analysis";
import type { StageOutputEntry } from "./stage-output-browser";

type ReviewRecord = SellerSpriteReviewAnalysisRecord;
export function reviewMissingMessage(entry: StageOutputEntry | undefined, asin: string): string {
  if (!entry) return "当前项目评论结果尚未读取；无可信同步任务时不会使用全局缓存。";
  if (entry.stageStatus === "missing-output") return "当前项目评论结果读取失败，已停止自动重试；可重新进入 VOC 页读取。";
  if (entry.stageStatus === "done") return "当前同步结果未包含此 ASIN 的评论分析。";
  const cause = entry.gap.items?.find(item => item.asin === asin)?.causeCode ?? entry.gap.reasonCode;
  if (cause === "UPSTREAM_EMPTY") return "本次评论接口未提供可用样本或主题，原因待核实；不等于商品没有本地评论。";
  if (cause === "CONNECT_TIMEOUT") return "评论请求超时，未获得可用结果。";
  if (cause === "MCP_SCHEMA") return "评论响应结构无法解析，未获得可用结果。";
  return "评论请求失败，未获得可用结果。";
}
export function scopedReviewRecords(records: Record<string, ReviewRecord>, asins: readonly string[], marketplace: string): Record<string, ReviewRecord> {
  return Object.fromEntries(asins.flatMap(asin => {
    const record = records[asin];
    return record?.asin === asin && record.marketplace === marketplace ? [[asin, record]] : [];
  }));
}

export function reviewEmptyMessage(record: ReviewRecord | undefined): string {
  if (!record) return "正在读取当前项目评论结果；尚无可核验记录。";
  const provider = record.sourceProvider === "sellerSprite" ? "卖家精灵" : "Sorftime";
  if (record.status === "error") return `${provider} 评论请求失败，未获得可用分析结果。`;
  if (record.status === "pending" && record.terminalReason === "valid-empty" && record.sampledReviews === 0 && (record.mentionTopics ?? 0) === 0) return `${provider} 本次接口返回 0 条评论样本，待补充；不代表商品没有评论。`;
  if (/^No reviews found\.?$|明确.*无评论|暂无评论样本|没有评论|无评论样本/i.test(record.statusMessage ?? "")) return `${provider} 明确返回无评论样本。`;
  if (record.status !== "ready") return record.statusMessage || "评论数据尚未就绪。";
  if (record.sampledReviews > 0 && record.statusMessage && record.blocks.every(block => block.rows.length === 0)) return `已读取 ${record.sampledReviews} 条评论样本；${record.statusMessage}`;
  if (record.sampledReviews > 0) return `已读取 ${record.sampledReviews} 条评论样本，本维度暂无匹配主题。`;
  if ((record.mentionTopics ?? 0) > 0) return "已返回 Customers Say 主题，本维度暂无匹配；评论样本尚不可用。";
  return "未获得可分析的评论样本或 Customers Say 主题。";
}

export function reviewEvidenceText(record: ReviewRecord | undefined): string {
  if (!record) return "来源：当前项目同步结果";
  const provider = record.sourceProvider === "sellerSprite" ? "卖家精灵" : "Sorftime";
  const topics = record.sourceProvider === "sellerSprite" ? "" : ` · Customers Say 主题：${record.status === "error" ? "未取得" : record.mentionTopics ?? "未提供"}`;
  return `来源：${provider} · 评论样本：${record.status === "error" ? "未取得" : record.sampledReviews}${topics} · 采集时间：${record.fetchedAt || "未提供"}`;
}
