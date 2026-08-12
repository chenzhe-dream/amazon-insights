/**
 * 将 Alexa for Shopping 七问报告原文解析为 rufus-voc-data 结构。
 * 支持桌面端 Rufus 报告（含 1️⃣–7️⃣ 分段与表格式人群/场景/动机）。
 */

const SECTIONS = [
  { key: "attention", markers: [/1️⃣\s*顾客关注点/i, /📌\s*1\.\s*顾客关注点/i, /顾客关注点（Top/i] },
  { key: "positives", markers: [/2️⃣\s*好评点/i, /✅\s*2\.\s*好评点/i, /好评点（/i] },
  { key: "negatives", markers: [/3️⃣\s*差评点/i, /❌\s*3\.\s*差评点/i, /差评点（/i] },
  { key: "unmet", markers: [/4️⃣\s*未被满足的需求/i, /4️⃣\s*未被满足/i, /💬\s*4\.\s*未被满足/i] },
  { key: "audiences", markers: [/5️⃣\s*使用人群/i, /👨‍👩‍👧‍👦\s*5\.\s*使用人群/i] },
  { key: "scenarios", markers: [/6️⃣\s*使用场景/i, /🎯\s*6\.\s*使用场景/i] },
  { key: "motives", markers: [/7️⃣\s*核心购买动机/i, /7️⃣\s*购买动机/i, /🛒\s*7\.\s*核心购买动机/i] },
];

const OVERALL_MARKERS = [/8️⃣\s*总体/i, /总体结论/i, /综合结论/i, /📊\s*购买决策/i];
const SECTION_STOP = /^[1-7]️⃣|^📌\s*\d|^✅\s*\d|^❌\s*\d|^💬\s*\d|^👨‍👩‍👧‍👦\s*\d|^🎯\s*\d|^🛒\s*\d|^📊\s|^🎯\s*营销|^Conditions of Use/i;
const SKIP_LINE =
  /^(Alexa is generating|正在生成|来源：|Customer Review|经 Alexa 整理|Ask Alexa|Ask a question)/i;
const TABLE_HEADER =
  /^(关注点|依据来源|数据依据|好评点|差评点|人群分类|特征|场景|说明|动机|重要性)(\t|｜|$)/i;

function normalizeLines(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

function findSectionStart(lines, markers, fromIndex = 0) {
  for (let i = fromIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (markers.some(marker => marker.test(line))) return i;
  }
  return -1;
}

function extractSectionLines(lines, startIndex, nextStartIndex) {
  const end = nextStartIndex >= 0 ? nextStartIndex : lines.length;
  const body = lines.slice(startIndex + 1, end);
  const items = [];

  for (const line of body) {
    if (SECTION_STOP.test(line)) break;
    if (SKIP_LINE.test(line)) continue;
    if (line.length <= 1) continue;
    items.push(line);
  }

  return items;
}

function extractProseItems(lines) {
  return lines.filter(line => {
    if (TABLE_HEADER.test(line)) return false;
    if (/^#{1,3}\s/.test(line)) return false;
    if (/^[1-7]️⃣/.test(line)) return false;
    return line.length > 2;
  });
}

function extractNumberedItems(lines) {
  const numbered = lines.filter(line => /^\d+[\.\)、]/.test(line) || /^[-•]/.test(line));
  if (numbered.length) {
    return numbered.map(line => line.replace(/^[-•]\s*/, ""));
  }
  return extractProseItems(lines);
}

function extractTableItems(lines) {
  const rows = extractProseItems(lines).filter(line => line.includes("｜") || line.includes("\t"));
  if (rows.length) return rows;
  return extractProseItems(lines);
}

function extractHeaderMeta(text, asinHint) {
  const ratingMatch = text.match(/([0-5](?:\.[0-9])?)\s*(?:星|stars?)\s*(?:·|\/|,|\||\s).*?(\d[\d,]*)\s*(?:条)?评论/i);
  const asinMatch = text.match(/（([A-Z0-9]{10})）\s*—\s*顾客洞察完整分析/) ?? text.match(/([A-Z0-9]{10})/);
  const starBreakdown =
    text.match(/5\s*星[^\n]{0,120}/i)?.[0]?.trim() ??
    text.match(/\d\s*星约\s*\d+%[^\n]*/i)?.[0]?.trim() ??
    "";

  return {
    asin: asinMatch?.[1] ?? asinHint ?? "",
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    reviewCount: ratingMatch ? Number(ratingMatch[2].replace(/,/g, "")) : null,
    starBreakdown: starBreakdown || undefined,
  };
}

function extractOverallConclusion(lines) {
  const start = findSectionStart(lines, OVERALL_MARKERS);
  if (start < 0) return "";

  const chunk = [];
  for (let i = start; i < lines.length && chunk.length < 8; i += 1) {
    const line = lines[i];
    if (i > start && /^[1-8]️⃣/.test(line)) break;
    if (/^Conditions of Use|^© /i.test(line)) break;
    chunk.push(line);
  }

  return chunk
    .join(" ")
    .replace(/^8️⃣\s*总体结论[:：]?\s*/i, "")
    .replace(/^总体结论[:：]?\s*/i, "")
    .replace(/^综合结论[:：]?\s*/i, "")
    .trim()
    .slice(0, 600);
}

export function parseAlexaVocReport(rawText, asinHint = "") {
  if (!rawText?.trim()) {
    return { ok: false, error: "empty_report", sections: {} };
  }

  const text = rawText.trim();
  const lines = normalizeLines(text);
  const header = extractHeaderMeta(text, asinHint);
  const sectionStarts = SECTIONS.map(section => ({
    ...section,
    start: findSectionStart(lines, section.markers),
  })).filter(section => section.start >= 0);

  sectionStarts.sort((a, b) => a.start - b.start);

  const sections = {};
  for (let i = 0; i < sectionStarts.length; i += 1) {
    const current = sectionStarts[i];
    const nextStart = sectionStarts[i + 1]?.start ?? -1;
    const bodyLines = extractSectionLines(lines, current.start, nextStart);

    if (current.key === "attention" || current.key === "unmet") {
      sections[current.key] = extractNumberedItems(bodyLines);
      if (!sections[current.key].length) {
        sections[current.key] = extractTableItems(bodyLines).slice(0, 8);
      }
    } else if (current.key === "positives" || current.key === "negatives") {
      sections[current.key] = extractProseItems(bodyLines);
    } else {
      sections[current.key] = extractTableItems(bodyLines);
    }
  }

  const overallConclusion = extractOverallConclusion(lines);
  const missing = SECTIONS.map(section => section.key).filter(key => !sections[key]?.length);

  return {
    ok: missing.length <= 3,
    asin: header.asin || asinHint,
    rating: header.rating,
    reviewCount: header.reviewCount,
    starBreakdown: header.starBreakdown,
    overallConclusion,
    sections,
    missing,
    rawLineCount: lines.length,
  };
}
