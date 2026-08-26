export const IMAGE_REMARK_OUTCOME_REASONS = Object.freeze({
  ready: "图片备注已就绪",
  "upstream-empty": "上游未返回可用图片备注",
  timeout: "图片分析超过 120 秒",
  "connector-failed": "图片分析连接器失败",
});

export const IMAGE_REMARK_OUTCOME_STATUSES = Object.freeze(
  Object.keys(IMAGE_REMARK_OUTCOME_REASONS),
);

export function imageRemarkOutcome(status) {
  const safeStatus = Object.hasOwn(IMAGE_REMARK_OUTCOME_REASONS, status)
    ? status
    : "upstream-empty";
  return {
    status: safeStatus,
    reason: IMAGE_REMARK_OUTCOME_REASONS[safeStatus],
  };
}
