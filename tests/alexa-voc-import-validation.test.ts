import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { hasManualAlexaVocText, manualAlexaVocPrimaryAsinAdvisory } from "../app/alexa-voc-import-validation";
import { processAlexaVocText, saveAlexaVocToSystem } from "../scripts/lib/alexa-voc-pipeline.mjs";
import { processAlexaVocText as processPureAlexaVocText } from "../scripts/lib/alexa-voc-processing.mjs";

const selectedAsin = "B07VY9Q95Q";
const cachePath = path.resolve("data/alexa-voc-cache", `${selectedAsin}.txt`);
const generatedPath = path.resolve("app/rufus-voc-data.ts");
const realFixture = fs.readFileSync(path.resolve("tests/fixtures/alexa-real-report-anonymized.txt"), "utf8");
const fixtureAsin = "B0ALEXA001";

function createTemporaryAlexaWorktree() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-import-real-format-"));
  fs.mkdirSync(path.join(worktree, "app"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "package.json"), "{}");
  fs.writeFileSync(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};");
  fs.copyFileSync(generatedPath, path.join(worktree, "app", "rufus-voc-data.ts"));
  fs.copyFileSync(path.resolve("app/competitor-data.ts"), path.join(worktree, "app", "competitor-data.ts"));
  return worktree;
}

function snapshotAlexaTargets(worktree: string, asin: string) {
  const snapshot = (filePath: string) => fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
  const snapshots = path.join(worktree, "data", "alexa-publication-snapshots");
  return {
    cache: snapshot(path.join(worktree, "data", "alexa-voc-cache", `${asin}.txt`)),
    projection: snapshot(path.join(worktree, "app", "rufus-voc-data.ts")),
    snapshots: fs.existsSync(snapshots)
      ? fs.readdirSync(snapshots).sort().map(name => ({ name, content: snapshot(path.join(snapshots, name)) }))
      : undefined,
    state: snapshot(path.join(worktree, "data", "alexa-publication-state.json")),
  };
}

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

test("recognizes a full-width primary title ASIN but excludes comparison ASINs from the advisory", () => {
  assert.equal(
    manualAlexaVocPrimaryAsinAdvisory(
      "Floor lamp（B07VY9Q95Q）— 完整七维顾客分析\n对比 ASIN：B0COMPARE01",
      "B0TARGET001",
    ),
    "报告标题识别为 B07VY9Q95Q；继续导入将写入当前目标 B0TARGET001。",
  );
  assert.equal(
    manualAlexaVocPrimaryAsinAdvisory(
      "Floor lamp 顾客洞察\n竞品 ASIN：B07VY9Q95Q\nComparison ASIN: B0COMPARE01",
      "B0TARGET001",
    ),
    null,
  );
});

test("manual import UI keeps presence validation while the proxy delegates strict text validation to the shared contract", () => {
  const panel = fs.readFileSync(new URL("../app/alexa-voc-import-panel.tsx", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../app/api/alexa-voc/import/route.ts", import.meta.url), "utf8");

  assert.match(panel, /!hasManualAlexaVocText\(selectedDraft\)/);
  assert.match(route, /ManualAlexaVocImportRequestSchema\.safeParse/);
  assert.doesNotMatch(panel, /length\s*<\s*600/);
  assert.doesNotMatch(route, /length\s*<\s*600/);
});

test("real Alexa fixture processes as a complete seven-dimension report", () => {
  const worktree = createTemporaryAlexaWorktree();
  try {
    const processed = processAlexaVocText(realFixture, fixtureAsin, { worktree });
    assert.equal(processed.ok, true);
    assert.equal(processed.filled, 7);
    assert.deepEqual(processed.missing, []);
    assert.match(processed.sections.positives.join("\n"), /好评率 82%/);
    assert.match(processed.sections.negatives.join("\n"), /差评率 7%/);
    assert.match(processed.sections.attention.join("\n"), /137次/);
    assert.match(processed.sections.scenarios.join("\n"), /｜/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("the pipeline re-exports the pure parser with explicit deterministic metadata", () => {
  assert.equal(processAlexaVocText, processPureAlexaVocText);
  const processed = processPureAlexaVocText(reportFor(selectedAsin), selectedAsin, {
    rating: 4.25,
    reviewCount: 50,
    worktree: "C:\\must-not-be-read",
  });
  assert.equal(processed.rating, 4.25);
  assert.equal(processed.reviewCount, 50);
});

test("real Alexa fixture writes all seven normalized dimensions in a temporary worktree", () => {
  const worktree = createTemporaryAlexaWorktree();
  try {
    const result = saveAlexaVocToSystem(fixtureAsin, realFixture, { worktree, capturedAt: "2026-08-30" });
    assert.equal(result.filled, 7);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.invalid, []);
    assert.deepEqual(result.detected, ["顾客关注点", "好评点", "差评点", "未被满足的需求", "使用人群", "使用场景", "核心购买动机"]);
    assert.equal(fs.readFileSync(path.join(worktree, "data", "alexa-voc-cache", `${fixtureAsin}.txt`), "utf8"), realFixture.trim());
    const projection = fs.readFileSync(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8");
    assert.match(projection, /好评率 82%/);
    assert.match(projection, /差评率 7%/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("incomplete real-format report reports only dimension labels and changes no target", () => {
  const worktree = createTemporaryAlexaWorktree();
  const sentinel = "RAW-REPORT-SECRET-SENTINEL";
  const before = snapshotAlexaTargets(worktree, fixtureAsin);
  try {
    let message = "";
    assert.throws(
      () => saveAlexaVocToSystem(fixtureAsin, `B0ALEXA001 — 完整顾客行为分析\n🎯 顾客关注点\n1. 有效内容\n💡 综合结论\n${sentinel}`, { worktree }),
      (error: unknown) => {
        message = error instanceof Error ? error.message : "";
        return /incomplete_report；检测到：顾客关注点；缺失：好评点、差评点、未被满足的需求、使用人群、使用场景、核心购买动机/.test(message);
      },
    );
    assert.doesNotMatch(message, new RegExp(sentinel));
    assert.deepEqual(snapshotAlexaTargets(worktree, fixtureAsin), before);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("markdown table rows obey the existing 256-row limit before any publication state exists", () => {
  const worktree = createTemporaryAlexaWorktree();
  const before = snapshotAlexaTargets(worktree, fixtureAsin);
  const report = [
    `${fixtureAsin} — 完整顾客行为分析`, "🏠 使用场景", "| 场景 | 说明 |", "| --- | --- |",
    ...Array.from({ length: 257 }, (_, index) => `| 场景${index} | 说明${index} |`),
  ].join("\n");
  try {
    assert.throws(() => saveAlexaVocToSystem(fixtureAsin, report, { worktree }), { message: "report_limits_table_rows" });
    assert.equal(fs.existsSync(path.join(worktree, "data", "alexa-publication-state.json")), false);
    assert.deepEqual(snapshotAlexaTargets(worktree, fixtureAsin), before);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("ordinary prose with one ASCII separator per line does not count toward the table limit", () => {
  const worktree = createTemporaryAlexaWorktree();
  const report = [
    `${fixtureAsin} — 完整顾客行为分析`, "🏠 使用场景",
    ...Array.from({ length: 257 }, () => "说明 | 补充说明"),
  ].join("\n");
  try {
    let message = "";
    assert.throws(() => saveAlexaVocToSystem(fixtureAsin, report, { worktree }), (error: unknown) => {
      message = error instanceof Error ? error.message : "";
      return true;
    });
    assert.notEqual(message, "report_limits_table_rows");
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
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

test("direct pipeline import rejects excessive table rows before changing publication state", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-import-limits-"));
  try {
    fs.mkdirSync(path.join(worktree, "app"), { recursive: true });
    fs.mkdirSync(path.join(worktree, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "package.json"), "{}");
    fs.writeFileSync(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};");
    fs.copyFileSync(generatedPath, path.join(worktree, "app", "rufus-voc-data.ts"));
    fs.copyFileSync(path.resolve("app/competitor-data.ts"), path.join(worktree, "app", "competitor-data.ts"));
    const report = [
      reportFor(selectedAsin),
      "👨‍👩‍👧‍👦 5. 使用人群",
      "人群分类｜特征",
      ...Array.from({ length: 257 }, (_, index) => `人群${index}｜特征${index}`),
    ].join("\n");
    assert.throws(() => saveAlexaVocToSystem(selectedAsin, report, { worktree }), {
      message: "report_limits_table_rows",
    });
    assert.equal(fs.existsSync(path.join(worktree, "data", "alexa-publication-state.json")), false);
    assert.equal(fs.existsSync(path.join(worktree, "data", "alexa-voc-cache", `${selectedAsin}.txt`)), false);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
