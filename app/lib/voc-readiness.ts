type ManualVocRecordMap = Readonly<Record<string, { normalizedRecord?: unknown } | null | undefined>>;

export type VocReadiness = Readonly<{
  ready: number;
  total: number;
  missing: readonly string[];
  canSubmit: boolean;
}>;

export function summarizeVocReadiness(asins: readonly string[], records: ManualVocRecordMap) {
  const scope = [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(Boolean))];
  const missing = scope.filter(asin => !records[asin]?.normalizedRecord);
  return Object.freeze({
    ready: scope.length - missing.length,
    total: scope.length,
    missing: Object.freeze(missing),
    canSubmit: scope.length >= 3 && scope.length <= 10 && missing.length === 0,
  });
}

export function presentVocReadiness(readiness: VocReadiness, isRunning = false) {
  return Object.freeze({
    summary: `VOC 数据已准备 ${readiness.ready}/${readiness.total}`,
    missing: readiness.missing.length ? `待录入：${readiness.missing.join("、")}` : null,
    disabled: !readiness.canSubmit || isRunning,
    actionLabel: isRunning ? "VOC 分析运行中…" : "开始 VOC 独立分析",
  });
}

export async function submitReadyVocRun(
  asins: readonly string[],
  marketplace: string,
  records: ManualVocRecordMap,
  submit: (asins: string[], marketplace: string) => Promise<{ projectId: string; runId: string }>,
) {
  const readiness = summarizeVocReadiness(asins, records);
  if (!readiness.canSubmit) throw new Error(`以下 ASIN 尚未录入 Manual Alexa VOC：${readiness.missing.join("、")}`);
  return submit([...asins], marketplace);
}
