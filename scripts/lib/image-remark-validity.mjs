/** Explicit whole-image/provider failures are not visual evidence. Limited uncertainty is allowed. */
export function isUnavailableImageRemark(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return /^(?:抱歉[，,。\s]*)?(?:当前)?(?:图片|图像)(?:内容)?(?:无法|不能)识别/.test(text) ||
    /^(?:抱歉[，,。\s]*)?(?:无法|不能|未能)识别(?:图片|图像)(?:内容|画面)/.test(text) ||
    /(?:(?:图片|图像|画面|视觉)(?:识别|转写)(?:与(?:图片|图像|画面|视觉)?(?:识别|转写))?|vision|image transcription)\s*(?:服务|service)\s*(?:当前|暂时|暂|currently|temporarily|is|is temporarily|is currently)?\s*(?:不可用|无法使用|unavailable)/i.test(text) ||
    /^(?:sorry[, .]*)?(?:I |we )?(?:cannot|can't|unable to) (?:view|see|access|analyze) (?:the |this )?image\b/i.test(text);
}

export function hasUsableImageRemark(note) {
  return typeof note?.remark === "string" && Boolean(note.remark.trim()) && !isUnavailableImageRemark(note.remark);
}

/** Reclassify old false positives without retrying the provider or losing genuine notes. */
export function revalidateCachedImageRemark(note, outcome) {
  if (!isUnavailableImageRemark(note?.remark)) return { note, outcome };
  return { note: null, outcome: { status: "connector-failed", attemptJobId: outcome?.attemptJobId,
    diagnostic: { stage: "response-output", httpStatus: null, errorClass: "invalid-output" } } };
}
