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
