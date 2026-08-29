import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hasManualAlexaVocText } from "../app/alexa-voc-import-validation";
import { saveAlexaVocToSystem } from "../scripts/lib/alexa-voc-pipeline.mjs";

const selectedAsin = "B07VY9Q95Q";
const cachePath = path.resolve("data/alexa-voc-cache", `${selectedAsin}.txt`);
const generatedPath = path.resolve("app/rufus-voc-data.ts");

function reportFor(asin?: string) {
  return [
    asin ? `${asin} — 顾客洞察完整分析` : "顾客洞察完整分析",
    "📌 1. 顾客关注点",
    "1. 安装简单",
    "✅ 2. 好评点",
    "质量可靠（好评维度10次提及，20%）",
    "❌ 3. 差评点",
    "包装有待改善（差评维度5次提及，10%）",
    "💬 4. 未被满足",
    "1. 功能：希望增加更多配件",
    "总体结论：Task 2 ASIN 验证报告",
  ].join("\n");
}

function snapshotFile(filePath: string) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
}

function restoreFile(filePath: string, original: Buffer | undefined) {
  if (original) fs.writeFileSync(filePath, original);
  else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

test("accepts a non-empty manual report shorter than 600 characters", () => {
  assert.equal(hasManualAlexaVocText("1️⃣ 顾客关注点\n安装简单"), true);
});

test("rejects an empty manual report", () => {
  assert.equal(hasManualAlexaVocText("   \n\t"), false);
  assert.equal(hasManualAlexaVocText(undefined), false);
});

test("manual import consumers use presence validation instead of a length threshold", () => {
  const panel = fs.readFileSync(new URL("../app/alexa-voc-import-panel.tsx", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../app/api/alexa-voc/import/route.ts", import.meta.url), "utf8");

  assert.match(panel, /!hasManualAlexaVocText\(text\)/);
  assert.match(route, /!hasManualAlexaVocText\(text\)/);
  assert.doesNotMatch(panel, /length\s*<\s*600/);
  assert.doesNotMatch(route, /length\s*<\s*600/);
});

test("rejects empty or mismatched report ASIN before changing either target file", () => {
  const originalCache = snapshotFile(cachePath);
  const originalGenerated = snapshotFile(generatedPath);
  try {
    for (const report of [reportFor(), reportFor("B0MISMATCH")]) {
      assert.throws(() => saveAlexaVocToSystem(selectedAsin, report), {
        message: "asin_mismatch_report",
      });
      assert.deepEqual(snapshotFile(cachePath), originalCache);
      assert.deepEqual(snapshotFile(generatedPath), originalGenerated);
    }
  } finally {
    restoreFile(cachePath, originalCache);
    restoreFile(generatedPath, originalGenerated);
  }
});

test("writes matching non-empty report ASIN to both targets", () => {
  const originalCache = snapshotFile(cachePath);
  const originalGenerated = snapshotFile(generatedPath);
  const report = reportFor(selectedAsin);
  try {
    saveAlexaVocToSystem(selectedAsin, report, { capturedAt: "2026-08-29" });
    assert.equal(fs.readFileSync(cachePath, "utf8"), report);
    const generated = fs.readFileSync(generatedPath, "utf8");
    assert.match(generated, new RegExp(selectedAsin));
    assert.match(generated, /Task 2 ASIN 验证报告/);
  } finally {
    restoreFile(cachePath, originalCache);
    restoreFile(generatedPath, originalGenerated);
  }
});
