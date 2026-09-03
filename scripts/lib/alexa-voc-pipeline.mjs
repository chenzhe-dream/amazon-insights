import fs from "node:fs";
import path from "node:path";
import { renderRufusVocData } from "./patch-rufus-voc-data.mjs";
import { resolveFormalWorktreeRoot } from "./formal-worktree-root.mjs";
import { commitAlexaVocUpdateSync } from "./alexa-publication-state.mjs";
import {
  incompleteAlexaVocReportError,
  processAlexaVocText,
  validateAlexaVocReportLimits,
} from "./alexa-voc-processing.mjs";

export { processAlexaVocText, validateAlexaVocReportLimits } from "./alexa-voc-processing.mjs";

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

export function saveAlexaVocToSystem(asin, rawText, options = {}) {
  validateAlexaVocReportLimits(rawText);
  if (!rawText?.trim()) {
    throw new Error("empty_report");
  }
  const worktree = resolveFormalWorktreeRoot({
    env: options.env,
    cwd: options.cwd,
    worktree: options.worktree,
  });
  const catalogPath = path.join(worktree, "app", "competitor-data.ts");
  const catalog = readCatalogMeta(asin, catalogPath);
  const processed = processAlexaVocText(rawText, asin, {
    reviewCount: options.reviewCount ?? catalog?.reviews ?? 0,
    rating: options.rating ?? catalog?.rating ?? 0,
  });
  if (!processed.reportAsin || processed.reportAsin !== asin) {
    throw new Error("asin_mismatch_report");
  }
  if (processed.filled < 3) {
    throw incompleteAlexaVocReportError(processed);
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
