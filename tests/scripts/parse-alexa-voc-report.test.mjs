import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ALEXA_VOC_DIMENSIONS, parseAlexaVocReport } from "../../scripts/lib/parse-alexa-voc-report.mjs";

const fixture = fs.readFileSync(path.resolve("tests/fixtures/alexa-real-report-anonymized.txt"), "utf8");
const keys = ALEXA_VOC_DIMENSIONS.map(({ key }) => key);

test("real Alexa fixture recognizes seven headings and keeps records inside their sections", () => {
  const parsed = parseAlexaVocReport(fixture);
  assert.equal(parsed.asin, "B0ALEXA001");
  assert.deepEqual(parsed.detectedKeys, keys);
  assert.deepEqual(Object.keys(parsed.sections).sort(), [...keys].sort());
  for (const key of keys) assert.ok(parsed.sections[key].length > 0, key);
  assert.deepEqual(parsed.missing, []);
  assert.ok(parsed.sections.attention.some(record => record.source === "vertical" && record.cells[1] === "耐用表现"));
  assert.ok(parsed.sections.scenarios.some(record => record.source === "table" && record.cells[0] === "书房工作"));
  assert.ok(parsed.sections.unmet.some(record => record.source === "numbered" && record.text.includes("现状：最低档仍偏亮") && record.text.includes("需求：支持更暗模式")));
  assert.ok(!parsed.sections.motives.some(record => record.text.includes("仅用于验证总结")));
});

test("heading matcher accepts real variants but rejects prose and summary headings", () => {
  const text = [
    "B0ALEXA001 — 完整顾客行为分析", "顾客关注点是什么不应是标题", "🎯 顾客关注点 (客户最在乎什么)", "1. 可靠性",
    "✅ 好评点（为什么给好评）", "1. 好用", "❌ 3. 差评点", "1. 偏重", "💭 未被满足", "1. 更轻",
    "## 使用人群：", "1. 新手", "使用场景是什么不应是标题", "## 使用场景：", "1. 家中", "7️⃣ 购买动机", "1. 省时", "综合结论", "好评点包括但不应计数",
  ].join("\n");
  const parsed = parseAlexaVocReport(text);
  assert.deepEqual(parsed.detectedKeys, keys);
  assert.ok(!parsed.sections.motives.some(record => record.text.includes("好评点包括")));
});

test("repeated section blocks append in document order and deduplicate identical records", () => {
  const parsed = parseAlexaVocReport(["B0ALEXA001", "顾客关注点", "1. 可靠性", "顾客关注点", "1. 可靠性", "2. 易安装"].join("\n"));
  assert.deepEqual(parsed.sections.attention.map(record => record.text), ["可靠性", "易安装"]);
});

test("legacy emoji summary stays outside the final section", () => {
  const parsed = parseAlexaVocReport(["7️⃣ 购买动机", "1. 省时", "8️⃣ 总体结论", "不应进入动机"].join("\n"));
  assert.ok(!parsed.sections.motives.some(record => record.text.includes("不应进入动机")));
  assert.equal(parsed.overallConclusion, "不应进入动机");
});
