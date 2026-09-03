import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeAlexaVocSections } from "../../scripts/lib/normalize-alexa-voc-sections.mjs";
import { parseAlexaVocReport } from "../../scripts/lib/parse-alexa-voc-report.mjs";

const fixture = fs.readFileSync(path.resolve("tests/fixtures/alexa-real-report-anonymized.txt"), "utf8");

test("normalizes real Alexa records without changing metric meaning or column ownership", () => {
  const normalized = normalizeAlexaVocSections(parseAlexaVocReport(fixture).sections, { reviewCount: 999 });
  assert.match(normalized.attention.join("\n"), /137次/);
  assert.match(normalized.positives.join("\n"), /【材质】好评率 82%/);
  assert.doesNotMatch(normalized.positives.join("\n"), /82% 评论提及/);
  assert.match(normalized.negatives.join("\n"), /【控制失灵】差评率 7%/);
  assert.match(normalized.negatives.join("\n"), /部分/);
  assert.match(normalized.scenarios.join("\n"), /书房工作｜⭐⭐⭐⭐｜夜间专注｜办公用户/);
  assert.match(normalized.unmet.join("\n"), /现状：最低档仍偏亮.*需求：支持更暗模式/);
  assert.match(normalized.motives.join("\n"), /价格驱动｜⭐⭐⭐⭐⭐｜.*预算内获得核心功能/);
  assert.deepEqual(normalized.audiences, ["人群分类｜特征", "预算型用户｜需求：成本可控且易安装"]);
  assert.deepEqual(normalized.scenarios, ["场景｜使用率｜典型用法｜用户类型", "书房工作｜⭐⭐⭐⭐｜夜间专注｜办公用户"]);
});

test("retains legacy mention formatting and rejects incomplete vertical rows", () => {
  const legacy = normalizeAlexaVocSections({
    positives: ["质量可靠（好评维度10次提及，20%）"],
    negatives: ["包装有待改善（差评维度5次提及，10%）"],
  }, { reviewCount: 100 });
  assert.deepEqual(legacy.positives, ["【质量可靠】约 10.0% 评论提及（10 条）"]);
  assert.deepEqual(legacy.negatives, ["【包装有待改善】约 5.0% 评论提及（5 条）"]);
  const incomplete = normalizeAlexaVocSections({ positives: [{ kind: "table", source: "vertical", text: "", cells: ["错位标签", "82%"], lineStart: 1 }] });
  assert.deepEqual(incomplete.positives, []);
});

test("retains legacy two-column table rows", () => {
  const normalized = normalizeAlexaVocSections({
    audiences: ["人群分类｜特征", "新手用户｜希望快速安装"],
  });
  assert.deepEqual(normalized.audiences, ["人群分类｜特征", "新手用户｜希望快速安装"]);
});

test("preserves numbered positive and negative labels with their explanations", () => {
  const normalized = normalizeAlexaVocSections({
    positives: [{ kind: "text", source: "numbered", text: "材质可靠 · 说明：触感稳定", cells: ["材质可靠", "说明：触感稳定"], lineStart: 1 }],
    negatives: [{ kind: "text", source: "numbered", text: "控制失灵 · 说明：偶发无响应", cells: ["控制失灵", "说明：偶发无响应"], lineStart: 1 }],
  });
  assert.deepEqual(normalized.positives, ["【材质可靠】说明：触感稳定"]);
  assert.deepEqual(normalized.negatives, ["【控制失灵】说明：偶发无响应"]);
});

test("formats numbered audience and scenario records as title plus merged explanation columns", () => {
  const normalized = normalizeAlexaVocSections({
    audiences: [{ kind: "text", source: "numbered", text: "预算型用户 · 需求：成本可控 · 易安装", cells: ["预算型用户", "需求：成本可控", "易安装"], lineStart: 1 }],
    scenarios: [{ kind: "text", source: "numbered", text: "书房工作 · 用法：夜间专注", cells: ["书房工作", "用法：夜间专注"], lineStart: 1 }],
  });
  assert.deepEqual(normalized.audiences, ["人群分类｜特征", "预算型用户｜需求：成本可控 · 易安装"]);
  assert.deepEqual(normalized.scenarios, ["场景｜使用率｜典型用法｜用户类型", "书房工作｜用法：夜间专注"]);
});

test("retains legacy two-column motive rows through parser and normalizer", () => {
  const parsed = parseAlexaVocReport(["核心购买动机", "安全可靠｜减少维护"].join("\n"));
  const normalized = normalizeAlexaVocSections(parsed.sections);
  assert.deepEqual(normalized.motives, ["动机｜重要性｜说明", "安全可靠｜减少维护"]);
});

test("maps stars in a numbered motive title to importance and keeps explanations in description", () => {
  const parsed = parseAlexaVocReport([
    "核心购买动机",
    "🔴 #1 价格驱动 ⭐⭐⭐⭐⭐",
    "• 说明：预算内获得核心功能",
    "证据：价格相关评论最集中",
  ].join("\n"));
  const normalized = normalizeAlexaVocSections(parsed.sections);
  assert.deepEqual(normalized.motives, [
    "动机｜重要性｜说明",
    "价格驱动｜⭐⭐⭐⭐⭐｜说明：预算内获得核心功能 · 证据：价格相关评论最集中",
  ]);
});

test("keeps empty optional cells in four-column rows without shifting or dropping the row", () => {
  const parsed = parseAlexaVocReport([
    "好评点",
    "特性｜好评率｜核心评价｜典型评论",
    "材质｜82%｜质感可靠｜",
    "耐用性｜75%｜｜示例好评乙",
  ].join("\n"));
  assert.deepEqual(parsed.sections.positives.map(record => record.cells), [
    ["材质", "82%", "质感可靠", ""],
    ["耐用性", "75%", "", "示例好评乙"],
  ]);
  const normalized = normalizeAlexaVocSections(parsed.sections);
  assert.deepEqual(normalized.positives, [
    "【材质】好评率 82% · 质感可靠",
    "【耐用性】好评率 75% · 示例好评乙",
  ]);
});

test("keeps unprefixed numbered motive continuations in description with empty importance", () => {
  const parsed = parseAlexaVocReport([
    "核心购买动机",
    "1. 安全可靠",
    "减少维护成本",
  ].join("\n"));
  assert.deepEqual(parsed.sections.motives[0].cells, ["安全可靠", "减少维护成本"]);
  const normalized = normalizeAlexaVocSections(parsed.sections);
  assert.deepEqual(normalized.motives, [
    "动机｜重要性｜说明",
    "安全可靠｜｜减少维护成本",
  ]);
});

test("keeps positive and negative four-column rows when rate is empty", () => {
  const parsed = parseAlexaVocReport([
    "好评点",
    "特性｜好评率｜核心评价｜典型评论",
    "材质｜｜质感可靠｜示例好评甲",
    "差评点",
    "问题｜差评率｜投诉内容｜受影响群体",
    "控制失灵｜｜偶发无响应｜部分用户",
  ].join("\n"));
  assert.deepEqual(parsed.sections.positives[0].cells, ["材质", "", "质感可靠", "示例好评甲"]);
  assert.deepEqual(parsed.sections.negatives[0].cells, ["控制失灵", "", "偶发无响应", "部分用户"]);
  const normalized = normalizeAlexaVocSections(parsed.sections);
  assert.deepEqual(normalized.positives, ["【材质】质感可靠 · 示例好评甲"]);
  assert.deepEqual(normalized.negatives, ["【控制失灵】偶发无响应 · 部分用户"]);
});

test("keeps a complete attention row when its reason cell is empty", () => {
  const parsed = parseAlexaVocReport([
    "顾客关注点",
    "排序｜关注点｜提及次数｜为什么重要",
    "1｜耐用表现｜137次｜",
  ].join("\n"));
  assert.deepEqual(parsed.sections.attention[0].cells, ["1", "耐用表现", "137次", ""]);
  const normalized = normalizeAlexaVocSections(parsed.sections);
  assert.deepEqual(normalized.attention, ["1. 耐用表现（提及次数：137次）。"]);
});
