/**
 * Normalize parsed Alexa VOC records for the rufus-voc-data matrix.
 * String arrays remain supported for reports captured before structured parsing.
 */

const TABLE_HEADER = /^(关注点|依据来源|数据依据|好评点|差评点|未满足需求|人群分类|人群特征|特征|场景|说明|动机|重要性)(\t|｜|$)/i;
const INTRO_SKIP = /^根据\d+次|^顾客重点关注|^以下是|^如下/i;
const QUOTE_LINE = /^["“].*["”]$/;
const QA_LINE = /^Q&A|^官方/i;

function asRecords(value = []) {
  return value.map((item, index) => typeof item === "string"
    ? { kind: "text", source: "prose", text: item.trim(), cells: [item.trim()], lineStart: index + 1 }
    : item,
  ).filter(item => item && typeof item.text === "string");
}

function vocPct(mentions, reviews) {
  const value = (Number(mentions) / Number(reviews)) * 100;
  return value >= 1 ? value.toFixed(1) : value.toFixed(2);
}

function formatMentions(mentions) {
  const value = Number(String(mentions).replace(/,/g, ""));
  return Number.isFinite(value) ? value.toLocaleString() : String(mentions);
}

function parseThemeStats(line, reviewCount) {
  let match = line.match(/^(.+?)（(.+?)维度(\d+)次(?:提及)?(?:[，,]\s*(\d+(?:\.\d+)?)%|[，,])?/);
  if (match) {
    const [, title, dimension, mentions, rawPct] = match;
    return {
      label: title.trim(),
      dimension: dimension.trim(),
      mentions,
      pct: reviewCount && /正面|负面|好评|差评/.test(line) ? vocPct(mentions, reviewCount) : rawPct,
    };
  }
  match = line.match(/^(.+?)（(.+?)\s+(\d+)次提及[，,]\s*(\d+(?:\.\d+)?)%/);
  if (match) {
    const [, title, dimension, mentions, rawPct] = match;
    return {
      label: title.trim(),
      dimension: dimension.trim(),
      mentions,
      pct: reviewCount && /正面|负面|好评|差评/.test(line) ? vocPct(mentions, reviewCount) : rawPct,
    };
  }
  match = line.match(/^(.+?)（(\d+)次提及[，,]\s*(\d+(?:\.\d+)?)%/);
  if (match) {
    const [, label, mentions, pct] = match;
    return { label: label.trim(), dimension: "", mentions, pct };
  }
  match = line.match(/^(.+?)（.+?维度(\d+)条负面(?:，占(\d+(?:\.\d+)?)%)?/);
  if (match) {
    const [, label, mentions] = match;
    return { label: label.trim(), dimension: "", mentions, pct: reviewCount ? vocPct(mentions, reviewCount) : undefined, negative: true };
  }
  return null;
}

function formatPositive(label, mentions, reviewCount, mixed = false, pctOverride) {
  const pct = pctOverride ?? vocPct(mentions, reviewCount);
  return `【${label}】约 ${pct}% 评论提及（${mixed ? "Mixed，" : ""}${formatMentions(mentions)} 条）`;
}

function formatNegative(label, mentions, reviewCount, note = "", pctOverride) {
  const pct = pctOverride ?? vocPct(mentions, reviewCount);
  return `【${label}】约 ${pct}% 评论提及（${formatMentions(mentions)} 条）${note ? ` · ${note}` : ""}`;
}

function exactRate(value, name) {
  const rate = String(value ?? "").trim();
  return rate && rate !== "部分" && rate !== "不详" ? `${name} ${rate}` : rate;
}

function formatRatedTheme(cells, rateName) {
  const [label, rate, evaluation = "", example = ""] = cells;
  if (!label || !rate) return null;
  const details = [evaluation, example].filter(Boolean);
  return `【${label}】${exactRate(rate, rateName)}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function isStructured(record, columns) {
  return (record.source === "table" || record.source === "vertical") && record.cells?.length >= columns;
}

function normalizeAttention(records, reviewCount = 0) {
  const out = [];
  for (const record of asRecords(records)) {
    if (isStructured(record, 4)) {
      const [, label, mentions, reason] = record.cells;
      if (label && mentions && reason) out.push(`${out.length + 1}. ${label}（提及次数：${mentions}；为什么重要：${reason}）。`);
      continue;
    }
    const line = record.text.trim();
    if (!line || TABLE_HEADER.test(line) || INTRO_SKIP.test(line) || QUOTE_LINE.test(line) || QA_LINE.test(line)) continue;
    const stats = parseThemeStats(line, reviewCount);
    if (stats) {
      const pct = stats.pct ?? (reviewCount ? vocPct(stats.mentions, reviewCount) : "—");
      out.push(`${out.length + 1}. ${stats.label}（${stats.dimension ? `${stats.dimension} ` : ""}${formatMentions(stats.mentions)} 条提及，约 ${pct}%）。`);
    } else if (record.source === "numbered" || /^\d+[.、)）]/.test(line)) {
      out.push(`${out.length + 1}. ${line.replace(/^\d+[.、)）]\s*/, "")}`);
    } else if (line.length > 10 && !line.startsWith("根据")) {
      out.push(`${out.length + 1}. ${line.replace(/[。．]$/, "")}。`);
    }
  }
  return out.slice(0, 8);
}

function normalizeRatedThemes(records, reviewCount, rateName, negative = false) {
  const out = [];
  for (const record of asRecords(records)) {
    if (isStructured(record, 4)) {
      const formatted = formatRatedTheme(record.cells, rateName);
      if (formatted) out.push(formatted);
      continue;
    }
    if (record.source === "numbered" && record.cells?.[0]) {
      const [label, ...details] = record.cells;
      if (details.length) out.push(`【${label}】${details.join(" · ")}`);
      continue;
    }
    const line = record.text.trim();
    if (!line || QUOTE_LINE.test(line)) continue;
    const stats = parseThemeStats(line, reviewCount);
    if (!stats || (negative ? !stats.negative && !/负面|差评|故障|局限|问题/.test(line) : stats.negative)) continue;
    out.push(negative
      ? formatNegative(stats.label, stats.mentions, reviewCount, "", stats.pct)
      : formatPositive(stats.label, stats.mentions, reviewCount, /mixed|褒贬/i.test(line), stats.pct));
  }
  return out.slice(0, negative ? 8 : 10);
}

function normalizeUnmet(records) {
  const out = [];
  for (const record of asRecords(records)) {
    if (isStructured(record, 2)) {
      out.push(`${out.length + 1}. ${record.cells[0]}：${record.cells.slice(1).join(" · ").replace(/[。．]$/, "")}。`);
    } else if (record.source === "numbered" && record.cells?.[0]) {
      out.push(`${out.length + 1}. ${record.cells[0]}：${record.cells.slice(1).join(" · ").replace(/[。．]$/, "")}。`);
    } else if (/^\d+[.、)）]/.test(record.text)) {
      out.push(`${out.length + 1}. ${record.text.replace(/^\d+[.、)）]\s*/, "")}`);
    }
  }
  return out.slice(0, 8);
}

function normalizeTable(records, header, columns) {
  const rows = [];
  let tableHeader = header;
  for (const record of asRecords(records)) {
    if (isStructured(record, columns)) {
      rows.push(record.cells.slice(0, columns).join("｜"));
      continue;
    }
    const text = record.text.trim();
    if (!text) continue;
    const cells = text.includes("\t") ? text.split("\t") : text.includes("｜") ? text.split("｜") : text.includes("|") ? text.replace(/^\||\|$/g, "").split("|") : null;
    const normalizedCells = cells?.map(cell => cell.trim());
    if (normalizedCells && /^(人群分类|场景)\s*$/.test(normalizedCells[0])) {
      tableHeader = normalizedCells.join("｜");
    } else if (normalizedCells?.length >= columns) rows.push(normalizedCells.slice(0, columns).join("｜"));
    else if (record.source === "prose" && normalizedCells?.length >= 2) rows.push(normalizedCells.join("｜"));
    else if (record.source === "numbered" && record.cells?.[0]) {
      rows.push(`${record.cells[0]}｜${record.cells.slice(1).join(" · ")}`);
    }
  }
  return rows.length ? [tableHeader, ...rows] : [];
}

function toYellowStars(stars) {
  const filled = (stars.match(/⭐/g) ?? []).length || (stars.match(/★/g) ?? []).length;
  return filled ? "⭐".repeat(Math.min(filled, 5)) : stars;
}

function normalizeMotives(records) {
  const rows = [];
  for (const record of asRecords(records)) {
    if (isStructured(record, 3)) {
      rows.push(record.cells.slice(0, 3).join("｜"));
      continue;
    }
    if (record.source === "numbered" && record.cells?.[0]) {
      const [rawLabel, ...details] = record.cells;
      const titleStars = rawLabel.match(/(?:⭐|★){1,5}/u)?.[0] ?? "";
      const label = rawLabel.replace(/(?:⭐|★){1,5}/u, "").trim();
      let importance = titleStars;
      const descriptions = [];
      for (const detail of details) {
        const importanceMatch = detail.match(/^重要性[:：]\s*(.*)$/);
        if (importanceMatch) importance ||= importanceMatch[1];
        else if (!importance && /^(?:⭐|★){1,5}$/u.test(detail)) importance = detail;
        else if (!importance && !/^(?:说明|证据|依据|原因)[:：]/.test(detail)) importance = detail;
        else descriptions.push(detail);
      }
      rows.push([label, importance, descriptions.join(" · ")].join("｜"));
      continue;
    }
    const text = record.text.trim();
    if (text.includes("\t") || text.includes("｜") || text.includes("|")) {
      const cells = text.includes("\t") ? text.split("\t") : text.includes("｜") ? text.split("｜") : text.replace(/^\||\|$/g, "").split("|");
      if (cells.length >= 2) rows.push(cells.slice(0, 3).map(cell => cell.trim()).join("｜"));
    }
  }
  if (!rows.length) return [];
  return ["动机｜重要性｜说明", ...rows.map(row => {
    const parts = row.split("｜");
    if (parts.length >= 3) parts[1] = toYellowStars(parts[1]);
    return parts.join("｜");
  })];
}

export function normalizeAlexaVocSections(sections = {}, options = {}) {
  const reviewCount = Number(options.reviewCount) || 0;
  return {
    attention: normalizeAttention(sections.attention ?? [], reviewCount),
    positives: normalizeRatedThemes(sections.positives ?? [], reviewCount, "好评率"),
    negatives: normalizeRatedThemes(sections.negatives ?? [], reviewCount, "差评率", true),
    unmet: normalizeUnmet(sections.unmet ?? []),
    audiences: normalizeTable(sections.audiences ?? [], "人群分类｜特征", 4),
    scenarios: normalizeTable(sections.scenarios ?? [], "场景｜使用率｜典型用法｜用户类型", 4),
    motives: normalizeMotives(sections.motives ?? []),
  };
}
