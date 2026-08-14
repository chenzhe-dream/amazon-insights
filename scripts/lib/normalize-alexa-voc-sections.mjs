/**
 * 将 Alexa 七问原文解析结果规范化为 rufus-voc-data 矩阵使用的字符串格式。
 * 对齐既有 ASIN：vocAttention / vocPositive / vocNegative / 表格式人群场景动机。
 */

const TABLE_HEADER =
  /^(关注点|依据来源|数据依据|好评点|差评点|未满足需求|人群分类|人群特征|特征|场景|说明|动机|重要性)(\t|｜|$)/i;

const INTRO_SKIP = /^根据\d+次|^顾客重点关注|^以下是|^如下/i;
const QUOTE_LINE = /^["“].*["”]$/;
const QA_LINE = /^Q&A|^官方/i;

function splitCols(line) {
  if (line.includes("｜")) return line.split("｜").map(part => part.trim());
  if (line.includes("\t")) return line.split("\t").map(part => part.trim());
  return [line.trim()];
}

function vocPct(mentions, reviews) {
  const value = (Number(mentions) / Number(reviews)) * 100;
  return value >= 1 ? value.toFixed(1) : value.toFixed(2);
}

function formatMentions(mentions) {
  const value = Number(String(mentions).replace(/,/g, ""));
  return Number.isFinite(value) ? value.toLocaleString() : String(mentions);
}

function isThemeStatsLine(line) {
  return /(\d+)次提及[，,]\s*(\d+(?:\.\d+)?)%/.test(line) || /维度(\d+)条负面/.test(line);
}

function parseThemeStats(line, reviewCount) {
  let match = line.match(/^(.+?)（(.+?)维度(\d+)次(?:提及)?(?:[，,]\s*(\d+(?:\.\d+)?)%|[，,])?/);
  if (match) {
    const [, title, dimension, mentions, rawPct] = match;
    let pct = rawPct;
    if (reviewCount && (!pct || /正面|负面|好评|差评/.test(line))) {
      pct = vocPct(mentions, reviewCount);
    }
    return {
      label: title.trim(),
      dimension: dimension.trim(),
      mentions,
      pct,
    };
  }

  match = line.match(/^(.+?)（(.+?)\s+(\d+)次提及[，,]\s*(\d+(?:\.\d+)?)%/);
  if (match) {
    const [, title, dimension, mentions, rawPct] = match;
    const pct =
      reviewCount && /正面|负面|好评|差评/.test(line) ? vocPct(mentions, reviewCount) : rawPct;
    return { label: title.trim(), dimension: dimension.trim(), mentions, pct };
  }

  match = line.match(/^(.+?)（(\d+)次提及[，,]\s*(\d+(?:\.\d+)?)%/);
  if (match) {
    const [, label, mentions, pct] = match;
    return { label: label.trim(), dimension: "", mentions, pct };
  }

  match = line.match(/^(.+?)（.+?维度(\d+)条负面(?:，占(\d+(?:\.\d+)?)%)?/);
  if (match) {
    const [, label, mentions] = match;
    return {
      label: label.trim(),
      dimension: "",
      mentions,
      pct: reviewCount ? vocPct(mentions, reviewCount) : undefined,
      negative: true,
    };
  }

  return null;
}

function formatPositive(label, mentions, reviewCount, mixed = false, pctOverride) {
  const pct = pctOverride ?? vocPct(mentions, reviewCount);
  if (mixed) {
    return `【${label}】约 ${pct}% 评论提及（Mixed，${formatMentions(mentions)} 条）`;
  }
  return `【${label}】约 ${pct}% 评论提及（${formatMentions(mentions)} 条）`;
}

function formatNegative(label, mentions, reviewCount, note = "", pctOverride) {
  const pct = pctOverride ?? vocPct(mentions, reviewCount);
  const suffix = note ? ` · ${note}` : "";
  return `【${label}】约 ${pct}% 评论提及（${formatMentions(mentions)} 条）${suffix}`;
}

function normalizeAttention(lines, reviewCount = 0) {
  const out = [];
  let index = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || TABLE_HEADER.test(line) || INTRO_SKIP.test(line)) continue;
    if (QUOTE_LINE.test(line) || QA_LINE.test(line)) continue;

    const stats = parseThemeStats(line, reviewCount);
    if (stats) {
      index += 1;
      const pct = stats.pct ?? (reviewCount ? vocPct(stats.mentions, reviewCount) : "—");
      const dimensionPart = stats.dimension ? `${stats.dimension} ` : "";
      out.push(
        `${index}. ${stats.label}（${dimensionPart}${formatMentions(stats.mentions)} 条提及，约 ${pct}%）。`
      );
      continue;
    }

    if (/^\d+[\.\)、]/.test(line)) {
      out.push(line.replace(/^\d+[\.\)、]\s*/, `${++index}. `));
      continue;
    }

    if (line.includes("维度") && /\d+次/.test(line) && !line.includes("次提及")) {
      index += 1;
      out.push(`${index}. ${line.replace(/[。．]$/, "")}。`);
      continue;
    }

    if (line.length > 10 && !line.startsWith("根据")) {
      index += 1;
      const cleaned = line.replace(/[。．]$/, "");
      out.push(`${index}. ${cleaned}。`);
    }
  }

  return out.slice(0, 8);
}

function normalizePositives(lines, reviewCount = 0) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !isThemeStatsLine(line)) continue;
    if (QUOTE_LINE.test(line)) continue;

    const stats = parseThemeStats(line, reviewCount);
    if (!stats || stats.negative) continue;

    const mixed = /mixed|褒贬/i.test(line);
    out.push(formatPositive(stats.label, stats.mentions, reviewCount, mixed, stats.pct));
  }
  return out.slice(0, 10);
}

function normalizeNegatives(lines, reviewCount = 0) {
  const out = [];
  let pendingLabel = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || QUOTE_LINE.test(line) || QA_LINE.test(line)) continue;

    const stats = parseThemeStats(line, reviewCount);
    if (stats) {
      pendingLabel = "";
      if (stats.negative || /负面|差评|故障|局限|问题/.test(line)) {
        out.push(formatNegative(stats.label, stats.mentions, reviewCount, "", stats.pct));
      } else {
        out.push(formatPositive(stats.label, stats.mentions, reviewCount, false, stats.pct));
      }
      continue;
    }

    if (/^【.+】/.test(line) && /约\s*\d/.test(line)) {
      out.push(line);
      continue;
    }

    if (!stats && !line.includes("（") && line.length <= 20) {
      pendingLabel = line;
      continue;
    }

    if (pendingLabel && line.length > 8 && !QUOTE_LINE.test(line)) {
      out.push(`【${pendingLabel}】${line.replace(/[。．]$/, "")}`);
      pendingLabel = "";
    }
  }

  return out.slice(0, 8);
}

function normalizeUnmet(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || TABLE_HEADER.test(line)) continue;
    if (/^未满足需求/.test(line)) continue;

    if (/^\d+[\.\)、]/.test(line)) {
      const cleaned = line.replace(/^\d+[\.\)、]\s*/, "").replace(/\t+/g, "：");
      if (cleaned.includes("：")) {
        out.push(`${out.length + 1}. ${cleaned.replace(/[。．]$/, "")}。`);
      } else {
        out.push(`${out.length + 1}. ${cleaned}`);
      }
      continue;
    }

    const cols = splitCols(line);
    if (cols.length >= 2) {
      out.push(`${out.length + 1}. ${cols[0]}：${cols.slice(1).join(" · ").replace(/[。．]$/, "")}。`);
    }
  }
  return out.slice(0, 8);
}

function normalizeTableLines(lines, header, headerAliases = []) {
  const out = [];
  let hasHeader = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const row = line.includes("\t") ? splitCols(line).join("｜") : line;
    if (headerAliases.some(alias => row.startsWith(alias))) continue;
    if (TABLE_HEADER.test(row) && !headerAliases.includes(row.split("｜")[0] + "｜" + (row.split("｜")[1] ?? ""))) {
      continue;
    }
    if (/^(人群分类|场景|动机)｜/.test(row)) {
      hasHeader = true;
      out.push(row);
      continue;
    }
    if (row.includes("｜")) out.push(row);
  }

  if (!hasHeader && out.length) out.unshift(header);
  return out;
}

function toYellowStars(stars) {
  const filled = (stars.match(/⭐/g) ?? []).length || (stars.match(/★/g) ?? []).length;
  if (!filled) return stars;
  return "⭐".repeat(Math.min(filled, 5));
}

function normalizeMotives(lines) {
  const rows = normalizeTableLines(lines, "动机｜重要性｜说明", ["人群特征｜依据", "场景｜依据", "动机｜重要性｜依据"]);
  return rows.map(row => {
    if (!row.includes("｜") || row.startsWith("动机｜")) return row;
    const parts = row.split("｜");
    if (parts.length >= 3 && /[⭐★]/.test(parts[1])) {
      parts[1] = toYellowStars(parts[1]);
      return parts.join("｜");
    }
    return row.replace(/[★⭐]+/g, match => toYellowStars(match));
  });
}

export function normalizeAlexaVocSections(sections = {}, options = {}) {
  const reviewCount = Number(options.reviewCount) || 0;

  return {
    attention: normalizeAttention(sections.attention ?? [], reviewCount),
    positives: normalizePositives(sections.positives ?? [], reviewCount),
    negatives: normalizeNegatives(sections.negatives ?? [], reviewCount),
    unmet: normalizeUnmet(sections.unmet ?? []),
    audiences: normalizeTableLines(sections.audiences ?? [], "人群分类｜特征", ["人群特征｜依据"]),
    scenarios: normalizeTableLines(sections.scenarios ?? [], "场景｜说明与示例", ["场景｜依据"]),
    motives: normalizeMotives(sections.motives ?? []),
  };
}
