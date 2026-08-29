import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
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
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-import-success-"));
  const report = reportFor(selectedAsin);
  try {
    fs.mkdirSync(path.join(worktree, "app"), { recursive: true });
    fs.mkdirSync(path.join(worktree, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "package.json"), "{}");
    fs.writeFileSync(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};");
    fs.copyFileSync(generatedPath, path.join(worktree, "app", "rufus-voc-data.ts"));
    fs.copyFileSync(path.resolve("app/competitor-data.ts"), path.join(worktree, "app", "competitor-data.ts"));
    saveAlexaVocToSystem(selectedAsin, report, { capturedAt: "2026-08-29", worktree });
    assert.equal(fs.readFileSync(path.join(worktree, "data", "alexa-voc-cache", `${selectedAsin}.txt`), "utf8"), report);
    const generated = fs.readFileSync(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8");
    assert.match(generated, new RegExp(selectedAsin));
    assert.match(generated, /Task 2 ASIN 验证报告/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("formal worktree import rolls back cache, projection, snapshot, and state when atomic replacement fails", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-import-atomic-"));
  const realProjection = snapshotFile(generatedPath);
  const realCache = snapshotFile(cachePath);
  try {
    fs.mkdirSync(path.join(worktree, "app"), { recursive: true });
    fs.mkdirSync(path.join(worktree, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "package.json"), "{}");
    fs.writeFileSync(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};");
    fs.copyFileSync(generatedPath, path.join(worktree, "app", "rufus-voc-data.ts"));
    fs.copyFileSync(path.resolve("app/competitor-data.ts"), path.join(worktree, "app", "competitor-data.ts"));
    const projection = path.join(worktree, "app", "rufus-voc-data.ts");
    const originalProjection = fs.readFileSync(projection);
    const renameSync = fs.renameSync;
    let injected = false;
    assert.throws(() => saveAlexaVocToSystem(selectedAsin, reportFor(selectedAsin), {
      worktree,
      fileOps: {
        renameSync(source: fs.PathLike, destination: fs.PathLike) {
          if (!injected && path.resolve(String(destination)) === path.resolve(projection)) {
            injected = true;
            const error = new Error("projection replacement failed") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
          return renameSync(source, destination);
        },
      },
    }), /projection replacement failed/);
    assert.deepEqual(fs.readFileSync(projection), originalProjection);
    assert.equal(fs.existsSync(path.join(worktree, "data", "alexa-voc-cache", `${selectedAsin}.txt`)), false);
    assert.equal(fs.existsSync(path.join(worktree, "data", "alexa-publication-state.json")), false);
    const snapshots = path.join(worktree, "data", "alexa-publication-snapshots");
    assert.deepEqual(fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : [], []);
  } finally {
    restoreFile(generatedPath, realProjection);
    restoreFile(cachePath, realCache);
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
