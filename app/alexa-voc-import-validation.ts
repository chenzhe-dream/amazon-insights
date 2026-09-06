export function hasManualAlexaVocText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

function normalizeReportAsinCandidate(value: string | undefined) {
  const candidate = value?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9]{10}$/.test(candidate) && /\d/.test(candidate)
    ? candidate
    : null;
}

function extractManualAlexaVocPrimaryAsin(value: unknown) {
  const openingLines = String(value ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  const titleCandidate = openingLines
    .slice(0, 2)
    .join(" ")
    .match(/[（(]([A-Z0-9]{10})[）)]/i)?.[1];
  const explicitCandidate = openingLines
    .filter(line => !/^(?:竞品|对比|comparison)\s*ASIN\b/i.test(line))
    .join("\n")
    .match(/\bASIN\s*[:：]?\s*[([]?([A-Z0-9]{10})[)\]]?/i)?.[1];
  return normalizeReportAsinCandidate(titleCandidate)
    ?? normalizeReportAsinCandidate(explicitCandidate);
}

export function manualAlexaVocPrimaryAsinAdvisory(value: unknown, targetAsin: string) {
  const detectedAsin = extractManualAlexaVocPrimaryAsin(value);
  const normalizedTarget = targetAsin.trim().toUpperCase();
  if (!detectedAsin || detectedAsin === normalizedTarget) return null;
  return `报告标题识别为 ${detectedAsin}；继续导入将写入当前目标 ${normalizedTarget}。`;
}
