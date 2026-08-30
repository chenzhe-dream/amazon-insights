/**
 * Parse Alexa for Shopping seven-question reports into structured section records.
 * The parser accepts both the historical emoji layout and the exported report layout.
 */

export const ALEXA_VOC_DIMENSIONS = Object.freeze([
  { key: "attention", label: "顾客关注点", aliases: ["顾客关注点"] },
  { key: "positives", label: "好评点", aliases: ["好评点"] },
  { key: "negatives", label: "差评点", aliases: ["差评点"] },
  { key: "unmet", label: "未被满足的需求", aliases: ["未被满足的需求", "未被满足"] },
  { key: "audiences", label: "使用人群", aliases: ["使用人群"] },
  { key: "scenarios", label: "使用场景", aliases: ["使用场景"] },
  { key: "motives", label: "核心购买动机", aliases: ["核心购买动机", "购买动机"] },
]);

const CONCLUSION_START = /^(?:(?:💡|8️⃣)\s*)?(?:综合结论|总体结论)/i;
const REPORT_FOOTER = /^(?:Conditions of Use|©(?:\s|$)|来源[:：])/i;
const SECTION_END = /^(?:(?:(?:💡|8️⃣)\s*)?(?:综合结论|总体结论)|Conditions of Use|©(?:\s|$)|来源[:：])/i;
const HEADING_PREFIX = /^(?:#{1,6}\s*)?(?:(?:\p{Extended_Pictographic}|\uFE0F|\u20E3|\u200D)+\s*)?(?:(?:[1-7]️⃣|[1-7])\s*[.、)）:：\-—]?\s*)?/u;
const HEADING_SUFFIX = /^(?:\s*(?:[:：\-—])?\s*(?:\([^)]*\)|（[^）]*）)?\s*)$/u;
const SKIP_LINE = /^(Alexa is generating|正在生成|来源：|Customer Review|经 Alexa 整理|Ask Alexa|Ask a question)/i;
const VERTICAL_HEADERS = {
  attention: [["排序", "序号"], ["关注点"], ["提及次数", "数据"], ["为什么重要", "说明"]],
  positives: [["特性", "好评点"], ["好评率", "好评比例"], ["核心评价", "评价"], ["典型评论", "评论示例"]],
  negatives: [["问题", "差评点"], ["差评率", "差评比例"], ["投诉内容", "问题描述"], ["受影响群体", "影响群体"]],
  audiences: [["人群分类", "人群"], ["特征"], ["典型需求", "需求说明"], ["用户类型", "用户"]],
  scenarios: [["场景"], ["使用率", "频率"], ["典型用法", "用法"], ["用户类型", "用户"]],
  motives: [["动机"], ["重要性", "优先级"], ["说明", "原因"]],
};

function normalizeLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n")
    .map((line, index) => ({ text: line.trim(), lineNumber: index + 1 }))
    .filter(line => line.text);
}

function sectionHeading(line) {
  const remainder = line.trim().replace(HEADING_PREFIX, "");
  for (const dimension of ALEXA_VOC_DIMENSIONS) {
    for (const alias of dimension.aliases) {
      if (remainder.startsWith(alias) && HEADING_SUFFIX.test(remainder.slice(alias.length))) return dimension.key;
    }
  }
  return null;
}

function tableCells(line) {
  const source = line.includes("\t") ? "\t" : line.includes("｜") ? "｜" : line.includes("|") ? "|" : null;
  if (!source) return null;
  const cells = (source === "|" ? line.replace(/^\||\|$/g, "").split("|") : line.split(source)).map(value => value.trim());
  return cells.every(value => /^:?-{3,}:?$/.test(value) || value === "") ? null : cells;
}

function record(kind, source, text, cells, lineStart) {
  return { kind, source, text: text.trim(), cells: cells.map(value => value.trim()), lineStart };
}

function numberedTitle(text) {
  const match = text.match(/^(?:(?:(?:\p{Extended_Pictographic}|\uFE0F|\u20E3|\u200D)+\s*)?#\d+|\d+[.、)）])(?:\s+(.*))?$/u);
  return match ? (match[1]?.trim() ?? "") : null;
}

function isNumberedStart(text) {
  return numberedTitle(text) !== null;
}

function isBullet(text) {
  return /^[•-]\s*/.test(text);
}

function headerEnd(key, lines) {
  const headers = VERTICAL_HEADERS[key];
  if (!headers) return -1;
  for (let index = 0; index <= lines.length - headers.length; index += 1) {
    if (headers.every((aliases, offset) => aliases.includes(lines[index + offset].text))) return index + headers.length;
  }
  return -1;
}

function isTableHeader(key, cells) {
  const headers = VERTICAL_HEADERS[key];
  return Boolean(headers && cells.length >= headers.length && headers.every((aliases, index) => aliases.includes(cells[index])));
}

function isTableDivider(line) {
  const source = line.includes("\t") ? "\t" : line.includes("｜") ? "｜" : line.includes("|") ? "|" : null;
  if (!source) return false;
  const cells = (source === "|" ? line.replace(/^\||\|$/g, "").split("|") : line.split(source)).map(value => value.trim());
  return cells.every(value => /^:?-{3,}:?$/.test(value) || value === "");
}

function parseSectionRecords(key, lines) {
  const minimumColumns = VERTICAL_HEADERS[key]?.length ?? 0;
  const consumed = new Set();
  const records = [];

  for (let index = 0; index < lines.length; index += 1) {
    const cells = tableCells(lines[index].text);
    if (!cells || cells.length < minimumColumns) continue;
    consumed.add(index);
    if (isTableHeader(key, cells)) continue;
    records.push(record("table", "table", cells.join("｜"), cells, lines[index].lineNumber));
  }

  const contentStart = headerEnd(key, lines);
  if (contentStart >= 0 && minimumColumns) {
    for (let index = contentStart; index + minimumColumns <= lines.length; index += minimumColumns) {
      const group = lines.slice(index, index + minimumColumns);
      if (group.some((line, offset) => consumed.has(index + offset) || isBullet(line.text) || (offset > 0 && isNumberedStart(line.text)))) break;
      group.forEach((_, offset) => consumed.add(index + offset));
      const cells = group.map(line => line.text);
      records.push(record("table", "vertical", cells.join("｜"), cells, group[0].lineNumber));
    }
    for (let index = 0; index < contentStart; index += 1) consumed.add(index);
  }

  let numbered = null;
  const flushNumbered = () => {
    if (!numbered?.main) return;
    const cells = [numbered.main, ...numbered.details];
    records.push(record("text", "numbered", cells.join(" · "), cells, numbered.lineStart));
    numbered = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (consumed.has(index)) continue;
    const line = lines[index];
    const { text } = line;
    if (SKIP_LINE.test(text) || /^:?-{3,}:?$/.test(text) || isTableDivider(text)) continue;
    const inlineTitle = numberedTitle(text);
    if (inlineTitle !== null) {
      flushNumbered();
      numbered = { main: inlineTitle, details: [], lineStart: line.lineNumber };
      continue;
    }
    if (isBullet(text) && numbered) {
      numbered.details.push(text.replace(/^[•-]\s*/, ""));
      continue;
    }
    if (numbered && !numbered.main) {
      numbered.main = text;
      continue;
    }
    if (numbered) {
      numbered.details.push(text);
      continue;
    }
    flushNumbered();
    if (text.length > 1) records.push(record("text", "prose", text, [text], line.lineNumber));
  }
  flushNumbered();

  const unique = new Set();
  return records.filter(item => {
    const identity = `${item.kind}|${item.source}|${item.cells.join("\u0000") || item.text}`;
    if (unique.has(identity)) return false;
    unique.add(identity);
    return true;
  });
}

function extractHeaderMeta(text, asinHint) {
  const ratingMatch = text.match(/([0-5](?:\.[0-9])?)\s*(?:星|stars?)\s*(?:·|\/|,|\||\s).*?(\d[\d,]*)\s*(?:条)?评论/i);
  const asinMatch = text.match(/[（(]([A-Z0-9]{10})[）)]\s*[—-]\s*完整顾客行为分析/i) ?? text.match(/([A-Z0-9]{10})/);
  const starBreakdown = text.match(/5\s*星[^\n]{0,120}/i)?.[0]?.trim() ?? text.match(/\d\s*星约\s*\d+%[^\n]*/i)?.[0]?.trim() ?? "";
  return {
    asin: asinMatch?.[1] ?? asinHint ?? "",
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    reviewCount: ratingMatch ? Number(ratingMatch[2].replace(/,/g, "")) : null,
    starBreakdown: starBreakdown || undefined,
  };
}

function extractOverallConclusion(lines) {
  const start = lines.findIndex(line => CONCLUSION_START.test(line.text));
  if (start < 0) return "";
  const conclusionLines = lines.slice(start, start + 8);
  const footer = conclusionLines.findIndex((line, index) => index > 0 && REPORT_FOOTER.test(line.text));
  return conclusionLines.slice(0, footer < 0 ? conclusionLines.length : footer).map(line => line.text).join(" ")
    .replace(/^(?:(?:💡|8️⃣)\s*)?(?:综合结论|总体结论)[:：]?\s*/i, "").trim().slice(0, 600);
}

export function parseAlexaVocReport(rawText, asinHint = "") {
  if (!rawText?.trim()) return { ok: false, error: "empty_report", sections: {} };

  const text = rawText.trim();
  const lines = normalizeLines(text);
  const header = extractHeaderMeta(text, asinHint);
  const headings = lines.map((line, index) => ({ ...line, index, key: sectionHeading(line.text) })).filter(line => line.key);
  const sections = {};

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1]?.index ?? lines.length;
    const body = lines.slice(current.index + 1, next);
    const summaryIndex = body.findIndex(line => SECTION_END.test(line.text));
    const records = parseSectionRecords(current.key, summaryIndex >= 0 ? body.slice(0, summaryIndex) : body);
    sections[current.key] = [...(sections[current.key] ?? []), ...records];
  }

  for (const key of Object.keys(sections)) {
    const unique = new Set();
    sections[key] = sections[key].filter(item => {
      const identity = `${item.kind}|${item.source}|${item.cells.join("\u0000") || item.text}`;
      if (unique.has(identity)) return false;
      unique.add(identity);
      return true;
    });
  }

  const headingKeys = new Set(headings.map(heading => heading.key));
  const detectedKeys = ALEXA_VOC_DIMENSIONS.map(dimension => dimension.key).filter(key => headingKeys.has(key));
  const missing = ALEXA_VOC_DIMENSIONS.map(dimension => dimension.key).filter(key => !sections[key]?.length);
  return {
    ok: missing.length <= 3,
    asin: header.asin || asinHint,
    rating: header.rating,
    reviewCount: header.reviewCount,
    starBreakdown: header.starBreakdown,
    overallConclusion: extractOverallConclusion(lines),
    sections,
    detectedKeys,
    missing,
    rawLineCount: lines.length,
  };
}
