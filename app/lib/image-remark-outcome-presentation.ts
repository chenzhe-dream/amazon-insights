import { ImageRemarkOutcomeSchema } from "../../shared/agent-contracts";
export function imageRemarkFailureReason(raw: unknown): string {
  const parsed = ImageRemarkOutcomeSchema.safeParse(raw);
  if (!parsed.success) return "尚无图片分析结果";
  const outcome = parsed.data;
  if (outcome.status === "ready") return "图片备注已就绪";
  if (outcome.status === "upstream-empty") return "上游未返回可用图片备注";
  if (outcome.status === "timeout") return "图片分析超过 120 秒";
  const diagnostic = outcome.diagnostic;
  if (!diagnostic) return "图片分析连接器失败（历史原因未记录）";
  if (diagnostic.errorClass === "http") return `图片分析请求失败（HTTP ${diagnostic.httpStatus ?? "未知"}）`;
  return {network:"图片分析网络异常", "invalid-json":"图片分析返回无效 JSON", "invalid-output":"图片分析返回无效分析内容",governance:"图片分析未获本地请求许可"}[diagnostic.errorClass];
}
