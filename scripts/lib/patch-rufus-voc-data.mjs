import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFormalWorktreeRoot } from "./formal-worktree-root.mjs";

function escapeTsString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatStringArray(items, indent = "      ") {
  if (!items?.length) return `${indent}[]`;
  return `${indent}[\n${items.map(item => `${indent}  "${escapeTsString(item)}"`).join(",\n")}\n${indent}]`;
}

function readCatalogMeta(asin, catalogPath) {
  if (!fs.existsSync(catalogPath)) return null;
  const source = fs.readFileSync(catalogPath, "utf8");
  const block = source.match(new RegExp(`"asin":\\s*"${asin}"[\\s\\S]*?\\}`, "m"));
  if (!block) return null;
  const rating = Number(block[0].match(/"rating":\s*([0-9.]+)/)?.[1] ?? 0);
  const reviews = Number(block[0].match(/"reviews":\s*([0-9]+)/)?.[1] ?? 0);
  return { rating, reviews };
}

export function buildRufusVocEntry(
  asin,
  parsed,
  capturedAt = new Date().toISOString().slice(0, 10),
  captureNote,
  { catalogPath } = {},
) {
  const catalog = catalogPath ? readCatalogMeta(asin, catalogPath) : null;
  const rating = parsed.rating ?? catalog?.rating ?? 0;
  const reviewCount = parsed.reviewCount ?? catalog?.reviews ?? 0;
  const sections = parsed.sections ?? {};
  const overall =
    parsed.overallConclusion?.trim() ||
    `Alexa 七问报告已录入（${capturedAt}），总体结论待人工补全。`;
  const note =
    captureNote ??
    parsed.captureNote ??
    `来源：Alexa for Shopping 对话框录入（${capturedAt}）`;

  const lines = [
    `  ${asin}: {`,
    `    captureStatus: "dialog",`,
    `    alexaReport: {`,
    `      title: "顾客评价深度分析",`,
    `      asin: "${asin}",`,
    `      rating: ${rating},`,
    `      reviewCount: ${reviewCount},`,
    parsed.starBreakdown ? `      starBreakdown: "${escapeTsString(parsed.starBreakdown)}",` : null,
    `      prompt: rufusVocMeta.prompt,`,
    `      overallConclusion: "${escapeTsString(overall)}",`,
    `      captureNote: "${escapeTsString(note)}",`,
    `      captureStatus: "dialog",`,
    `    },`,
    `    attention: ${formatStringArray(sections.attention)},`,
    `    positives: ${formatStringArray(sections.positives)},`,
    `    negatives: ${formatStringArray(sections.negatives)},`,
    `    unmet: ${formatStringArray(sections.unmet)},`,
    `    audiences: ${formatStringArray(sections.audiences)},`,
    `    scenarios: ${formatStringArray(sections.scenarios)},`,
    `    motives: ${formatStringArray(sections.motives)},`,
    `  },`,
  ].filter(Boolean);

  return lines.join("\n");
}

export function renderRufusVocData(source, asin, parsed, options = {}) {
  const capturedAt = options.capturedAt ?? new Date().toISOString().slice(0, 10);
  const entry = buildRufusVocEntry(asin, parsed, capturedAt, options.captureNote, {
    catalogPath: options.catalogPath,
  });

  const existing = new RegExp(`\\n\\s*${asin}:\\s*[\\s\\S]*?(?=\\n\\s*[A-Z0-9]{10}:|\\n};\\n\\nexport const rufusVocDimensions)`, "m");
  if (existing.test(source)) {
    source = source.replace(existing, `\n${entry}`);
  } else {
    source = source.replace(/\n};\n\nexport const rufusVocDimensions/, `\n${entry}\n};\n\nexport const rufusVocDimensions`);
  }

  const pendingCount = (source.match(/captureStatus:\s*"pending"/g) ?? []).length;
  const dialogCount = (source.match(/captureStatus:\s*"dialog"/g) ?? []).length;
  source = source.replace(
    /limitation:\s*"[^"]*"/,
    `limitation: "${dialogCount} 个 ASIN 已录入 VOC 核心主题矩阵${pendingCount ? ` · ${pendingCount} 个待 Alexa 抓取` : ""}。"`
  );
  source = source.replace(
    /capturedAt:\s*"[^"]*"/,
    `capturedAt: "${capturedAt}"`
  );

  return source;
}

export function patchRufusVocData(asin, parsed, options = {}) {
  const worktree = resolveFormalWorktreeRoot({
    env: options.env,
    cwd: options.cwd,
    worktree: options.worktree,
  });
  const target = path.join(worktree, "app", "rufus-voc-data.ts");
  if (!fs.existsSync(target)) throw new Error(`missing ${target}`);
  const capturedAt = options.capturedAt ?? new Date().toISOString().slice(0, 10);
  const source = renderRufusVocData(fs.readFileSync(target, "utf8"), asin, parsed, {
    ...options,
    capturedAt,
    catalogPath: path.join(worktree, "app", "competitor-data.ts"),
  });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, source, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return { asin, capturedAt, target };
}
