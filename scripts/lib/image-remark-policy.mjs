export const IMAGE_REMARK_CONCURRENCY = 4;
export const IMAGE_REMARK_TIMEOUT_MS = 120_000;
export const IMAGE_REMARK_ESTIMATED_SECONDS_PER_IMAGE = 45;
export const IMAGE_REMARK_POLICY_DETAIL = "最多同时分析 4 张图片 · 单图上限 120 秒";

export function estimateImageRemarkSeconds(pendingStaticImageCount) {
  if (!Number.isSafeInteger(pendingStaticImageCount) || pendingStaticImageCount < 0) return 0;
  return pendingStaticImageCount * IMAGE_REMARK_ESTIMATED_SECONDS_PER_IMAGE;
}
