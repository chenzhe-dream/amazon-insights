type ManualVocRecordMap = Readonly<Record<string, { normalizedRecord?: unknown } | null | undefined>>;

export function summarizeVocReadiness(asins: readonly string[], records: ManualVocRecordMap) {
  const scope = [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(Boolean))];
  const missing = scope.filter(asin => !records[asin]?.normalizedRecord);
  return Object.freeze({
    ready: scope.length - missing.length,
    total: scope.length,
    missing: Object.freeze(missing),
    canSubmit: scope.length >= 3 && missing.length === 0,
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
