import fs from "node:fs";
import path from "node:path";
import { parseAlexaVocReport } from "./parse-alexa-voc-report.mjs";
import { normalizeAlexaVocSections } from "./normalize-alexa-voc-sections.mjs";
import { patchRufusVocData } from "./patch-rufus-voc-data.mjs";

const cacheDir = path.resolve("data/alexa-voc-cache");

export function processAlexaVocText(rawText, asin, options = {}) {
  const parsed = parseAlexaVocReport(rawText, asin);
  const normalized = normalizeAlexaVocSections(parsed.sections);
  const filled = Object.values(normalized).filter(items => items.length > 0).length;
  const missing = Object.entries(normalized)
    .filter(([, items]) => !items.length)
    .map(([key]) => key);

  return {
    ...parsed,
    asin: parsed.asin || asin,
    sections: normalized,
    filled,
    missing,
    ok: filled >= 5 && Boolean(normalized.positives.length && normalized.negatives.length),
  };
}

export function saveAlexaVocToSystem(asin, rawText, options = {}) {
  const processed = processAlexaVocText(rawText, asin, options);
  if (!rawText?.trim()) {
    throw new Error("empty_report");
  }
  if (processed.filled < 3) {
    throw new Error(`incomplete_report · 仅识别 ${processed.filled}/7 个维度 · 缺失 ${processed.missing.join(", ")}`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${asin}.txt`), rawText.trim(), "utf8");

  const captureMode = options.captureMode ?? "paste";
  const capturedAt = options.capturedAt ?? new Date().toISOString().slice(0, 10);
  const captureNote =
    captureMode === "chrome"
      ? `来源：Alexa for Shopping 对话框读取（${capturedAt}）`
      : captureMode === "auto"
        ? `来源：Alexa for Shopping 自动抓取（${capturedAt}）`
        : `来源：Alexa for Shopping 对话框粘贴录入（${capturedAt}）`;

  patchRufusVocData(
    asin,
    {
      ...processed,
      overallConclusion:
        processed.overallConclusion ||
        `Alexa 七问报告已录入（${capturedAt}），总体结论待人工补全。`,
    },
    {
      capturedAt,
      captureNote,
    }
  );

  return processed;
}
