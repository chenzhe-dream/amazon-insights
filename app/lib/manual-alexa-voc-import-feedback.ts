const IMPORT_ERROR_COPY: Readonly<Record<number, string>> = Object.freeze({
  401: "登录已失效，请重新登录后导入；已粘贴内容仍保留。",
  403: "导入失败：项目、站点或 ASIN 与当前任务不匹配，或当前账号无权访问。",
  400: "导入失败：请求格式无效，请重新选择 ASIN 后再试。",
  413: "导入失败：报告内容过长，请粘贴完整七问正文并删除无关内容。",
  422: "导入失败：报告内容无法处理，请检查粘贴内容后重试。",
  503: "导入失败：Manual Alexa VOC 录入服务暂不可用。",
});

export function manualAlexaVocImportErrorMessage(status: number, payload: unknown) {
  const fixedCopy = IMPORT_ERROR_COPY[status];
  if (fixedCopy) return fixedCopy;
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error.trim();
  }
  return "导入失败";
}
