import { ALEXA_VOC_DIMENSIONS, parseAlexaVocReport } from "./parse-alexa-voc-report.mjs";
import { normalizeAlexaVocSections } from "./normalize-alexa-voc-sections.mjs";

const MAX_REPORT_BYTES = 128 * 1024;
const MAX_REPORT_LINES = 1_000;
const MAX_REPORT_LINE_LENGTH = 2_048;
const MAX_REPORT_TABLE_ROWS = 256;

function isTableRow(line) {
  const text = line.trim();
  return text.includes("｜") || text.includes("\t") || /^\|.+\|$/.test(text) || /^[^|]+(?:\|[^|]+){2,}$/.test(text);
}

function labelFor(key) {
  return ALEXA_VOC_DIMENSIONS.find(dimension => dimension.key === key)?.label ?? key;
}

export function validateAlexaVocReportLimits(rawText) {
  const text = String(rawText ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new Error("report_limits_bytes");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > MAX_REPORT_LINES) throw new Error("report_limits_lines");
  if (lines.some(line => line.length > MAX_REPORT_LINE_LENGTH)) throw new Error("report_limits_item_length");
  if (lines.filter(isTableRow).length > MAX_REPORT_TABLE_ROWS) throw new Error("report_limits_table_rows");
}

export function processAlexaVocText(rawText, asin, options = {}) {
  validateAlexaVocReportLimits(rawText);
  const parsed = parseAlexaVocReport(rawText);
  const reviewCount = parsed.reviewCount ?? options.reviewCount ?? 0;
  const rating = parsed.rating ?? options.rating ?? null;
  const normalized = normalizeAlexaVocSections(parsed.sections, { reviewCount });
  const filled = Object.values(normalized).filter(items => items.length > 0).length;
  const missing = Object.entries(normalized)
    .filter(([, items]) => !items.length)
    .map(([key]) => key);
  const detected = ALEXA_VOC_DIMENSIONS
    .filter(dimension => parsed.detectedKeys.includes(dimension.key))
    .map(dimension => dimension.label);
  const invalid = ALEXA_VOC_DIMENSIONS
    .filter(dimension => parsed.detectedKeys.includes(dimension.key) && !normalized[dimension.key].length)
    .map(dimension => dimension.label);

  return {
    ...parsed,
    reportAsin: parsed.asin || "",
    asin: parsed.asin || asin,
    rating,
    reviewCount,
    sections: normalized,
    filled,
    missing,
    detected,
    invalid,
    ok: filled >= 5 && Boolean(normalized.positives.length && normalized.negatives.length),
  };
}

export function incompleteAlexaVocReportError({ detected, missing, invalid }) {
  const invalidText = invalid.length
    ? `；无效：${invalid.map(label => `${label}（内容未形成有效条目）`).join("、")}`
    : "";
  return new Error(`incomplete_report；检测到：${detected.join("、") || "无"}；缺失：${missing.map(labelFor).join("、")}${invalidText}`);
}
