/**
 * 将 Alexa 七问原文解析结果规范化为 rufus-voc-data 矩阵使用的字符串格式。
 */

const TABLE_HEADER =
  /^(关注点|依据来源|数据依据|好评点|差评点|人群分类|特征|场景|说明|动机|重要性)(\t|｜)/i;

function splitCols(line) {
  if (line.includes("｜")) return line.split("｜").map(part => part.trim());
  if (line.includes("\t")) return line.split("\t").map(part => part.trim());
  return [line.trim()];
}

function formatMentions(mentions) {
  const value = Number(String(mentions).replace(/,/g, ""));
  return Number.isFinite(value) ? value.toLocaleString() : String(mentions);
}

function normalizeAttention(lines) {
  const out = [];
  let index = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || TABLE_HEADER.test(line)) continue;
    if (/^#{1,3}\s/.test(line)) break;
    if (/^[2-7]️⃣/.test(line)) break;

    if (/^\d+[\.\)、]/.test(line)) {
      out.push(line);
      continue;
    }

    const cols = splitCols(line);
    if (cols.length >= 2 && !TABLE_HEADER.test(line)) {
      index += 1;
      const title = cols[0];
      const detail = cols.slice(1).join(" · ");
      out.push(`${index}. ${title}：${detail.replace(/[。．]$/, "")}。`);
      continue;
    }

    if (line.length > 6) {
      index += 1;
      out.push(`${index}. ${line}`);
    }
  }

  return out.slice(0, 8);
}

function normalizeBracketLines(lines) {
  return lines
    .map(line => {
      const text = line.trim();
      if (!text || TABLE_HEADER.test(text)) return null;
      if (/^[1-7]️⃣/.test(text)) return null;
      if (/^【.+】/.test(text)) return text;

      const bracketMatch = text.match(/^(.+?)（(\d+)次提及[，,]\s*(\d+(?:\.\d+)?)%([^）]*)/);
      if (bracketMatch) {
        const [, label, mentions, pct, tail] = bracketMatch;
        const mixed = /mixed|褒贬/i.test(`${tail}${text}`);
        const rest = text.slice(bracketMatch[0].length).replace(/^[）)]\s*/, "").trim();
        const suffix = rest ? ` — ${rest.replace(/^—\s*/, "")}` : "";
        if (mixed) {
          return `【${label.trim()}】约 ${pct}% 评论提及（Mixed，${formatMentions(mentions)} 条）${suffix}`;
        }
        return `【${label.trim()}】约 ${pct}% 评论提及（${formatMentions(mentions)} 条）${suffix}`;
      }

      const pctMatch = text.match(/^(.+?)约\s*(\d+(?:\.\d+)?)%[^（]*（(\d[\d,]*)条/);
      if (pctMatch) {
        return `【${pctMatch[1].replace(/[：:\s]+$/, "").trim()}】约 ${pctMatch[2]}% 评论提及（${formatMentions(pctMatch[3])} 条）`;
      }

      const label = text.split("（")[0].trim();
      if (label.length > 1) return `【${label}】${text.includes("（") ? text.slice(text.indexOf("（")) : ""}`;
      return text;
    })
    .filter(Boolean);
}

function normalizeUnmet(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || TABLE_HEADER.test(line)) continue;
    if (/^[2-7]️⃣/.test(line)) break;
    if (/^\d+[\.\)、]/.test(line)) {
      out.push(line);
      continue;
    }
    out.push(`${out.length + 1}. ${line.replace(/^[-•]\s*/, "")}`);
  }
  return out.slice(0, 8);
}

function normalizeTableLines(lines, header) {
  const out = [];
  let hasHeader = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[1-7]️⃣/.test(line)) continue;

    const row = line.includes("\t") ? splitCols(line).join("｜") : line;
    if (TABLE_HEADER.test(row)) {
      out.push(splitCols(line).join("｜"));
      hasHeader = true;
      continue;
    }

    if (row.includes("｜")) {
      if (/^(人群分类|场景|动机)｜/.test(row)) hasHeader = true;
      out.push(row);
    }
  }

  if (!hasHeader && out.length && header) out.unshift(header);
  return out;
}

export function normalizeAlexaVocSections(sections = {}) {
  return {
    attention: normalizeAttention(sections.attention ?? []),
    positives: normalizeBracketLines(sections.positives ?? []),
    negatives: normalizeBracketLines(sections.negatives ?? []),
    unmet: normalizeUnmet(sections.unmet ?? []),
    audiences: normalizeTableLines(sections.audiences ?? [], "人群分类｜特征"),
    scenarios: normalizeTableLines(sections.scenarios ?? [], "场景｜说明与示例"),
    motives: normalizeTableLines(sections.motives ?? [], "动机｜重要性｜说明"),
  };
}
