import fs from "node:fs";
import path from "node:path";
import { ALEXA_VOC_DIMENSIONS, parseAlexaVocReport } from "./parse-alexa-voc-report.mjs";
import { normalizeAlexaVocSections } from "./normalize-alexa-voc-sections.mjs";
import { renderRufusVocData } from "./patch-rufus-voc-data.mjs";
import { resolveFormalWorktreeRoot } from "./formal-worktree-root.mjs";
import { commitAlexaVocUpdateSync } from "./alexa-publication-state.mjs";

const MAX_REPORT_BYTES = 128 * 1024;
const MAX_REPORT_LINES = 1_000;
const MAX_REPORT_LINE_LENGTH = 2_048;
const MAX_REPORT_TABLE_ROWS = 256;

function isTableRow(line) {
  const text = line.trim();
  return text.includes("｜") || text.includes("\t") || /^\|?.+?\|.+?\|?$/.test(text);
}

function labelFor(key) {
  return ALEXA_VOC_DIMENSIONS.find(dimension => dimension.key === key)?.label ?? key;
}

function incompleteReportError({ detected, missing, invalid }) {
  const invalidText = invalid.length
    ? `；无效：${invalid.map(label => `${label}（内容未形成有效条目）`).join("、")}`
    : "";
  return new Error(`incomplete_report；检测到：${detected.join("、") || "无"}；缺失：${missing.map(labelFor).join("、")}${invalidText}`);
}

export function validateAlexaVocReportLimits(rawText) {
  const text = String(rawText ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new Error("report_limits_bytes");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > MAX_REPORT_LINES) throw new Error("report_limits_lines");
  if (lines.some((line) => line.length > MAX_REPORT_LINE_LENGTH)) throw new Error("report_limits_item_length");
  const tableRows = lines.filter(isTableRow);
  if (tableRows.length > MAX_REPORT_TABLE_ROWS) throw new Error("report_limits_table_rows");
}

function readCatalogMeta(asin, catalogPath) {
  if (!fs.existsSync(catalogPath)) return null;
  const source = fs.readFileSync(catalogPath, "utf8");
  const block = source.match(new RegExp(`"asin":\\s*"${asin}"[\\s\\S]*?\\}`, "m"));
  if (!block) return null;
  return {
    rating: Number(block[0].match(/"rating":\s*([0-9.]+)/)?.[1] ?? 0),
    reviews: Number(block[0].match(/"reviews":\s*([0-9]+)/)?.[1] ?? 0),
  };
}

export function processAlexaVocText(rawText, asin, options = {}) {
  validateAlexaVocReportLimits(rawText);
  const parsed = parseAlexaVocReport(rawText, asin);
  const worktree = resolveFormalWorktreeRoot({
    env: options.env,
    cwd: options.cwd,
    worktree: options.worktree,
  });
  const catalogPath = path.join(worktree, "app", "competitor-data.ts");
  const catalog = readCatalogMeta(asin, catalogPath);
  const reviewCount = parsed.reviewCount ?? options.reviewCount ?? catalog?.reviews ?? 0;
  parsed.reviewCount = reviewCount || parsed.reviewCount;
  parsed.rating = parsed.rating ?? catalog?.rating ?? null;
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
    asin: parsed.asin || asin,
    sections: normalized,
    filled,
    missing,
    detected,
    invalid,
    ok: filled >= 5 && Boolean(normalized.positives.length && normalized.negatives.length),
  };
}

export function saveAlexaVocToSystem(asin, rawText, options = {}) {
  validateAlexaVocReportLimits(rawText);
  const worktree = resolveFormalWorktreeRoot({
    env: options.env,
    cwd: options.cwd,
    worktree: options.worktree,
  });
  const parsedReport = parseAlexaVocReport(rawText);
  if (!parsedReport.asin || parsedReport.asin !== asin) {
    throw new Error("asin_mismatch_report");
  }
  const processed = processAlexaVocText(rawText, asin, { ...options, worktree });
  if (!rawText?.trim()) {
    throw new Error("empty_report");
  }
  if (processed.filled < 3) {
    throw incompleteReportError(processed);
  }

  const captureMode = options.captureMode ?? "paste";
  const capturedAt = options.capturedAt ?? new Date().toISOString().slice(0, 10);
  const captureNote =
    captureMode === "chrome"
      ? `来源：Alexa for Shopping 对话框读取（${capturedAt}）`
      : captureMode === "auto"
        ? `来源：Alexa for Shopping 自动抓取（${capturedAt}）`
        : `来源：Alexa for Shopping 对话框粘贴录入（${capturedAt}）`;

  const publication = commitAlexaVocUpdateSync({
    worktree,
    asin,
    cacheContent: rawText.trim(),
    fileOps: options.fileOps,
    render: (source) => renderRufusVocData(source.replace(/\r\n/g, "\n"), asin, {
      ...processed,
      overallConclusion:
        processed.overallConclusion ||
        `Alexa 七问报告已录入（${capturedAt}），总体结论待人工补全。`,
    }, {
      capturedAt,
      captureNote,
      catalogPath: path.join(worktree, "app", "competitor-data.ts"),
    }),
  });

  return { ...processed, ...publication };
}
