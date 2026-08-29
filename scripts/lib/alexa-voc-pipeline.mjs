import fs from "node:fs";
import path from "node:path";
import { parseAlexaVocReport } from "./parse-alexa-voc-report.mjs";
import { normalizeAlexaVocSections } from "./normalize-alexa-voc-sections.mjs";
import { renderRufusVocData } from "./patch-rufus-voc-data.mjs";
import { resolveFormalWorktreeRoot } from "./formal-worktree-root.mjs";
import { commitAlexaVocUpdateSync } from "./alexa-publication-state.mjs";

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
    throw new Error(`incomplete_report · 仅识别 ${processed.filled}/7 个维度 · 缺失 ${processed.missing.join(", ")}`);
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
    render: (source) => renderRufusVocData(source, asin, {
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
