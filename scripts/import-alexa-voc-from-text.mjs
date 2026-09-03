/**
 * 从粘贴文本 / 缓存文件导入 Alexa 七问报告，并写入 rufus-voc-data.ts
 *
 * 用法：
 *   npm run alexa:paste -- B09V5RW2VK < report.txt
 *   npm run alexa:paste -- B09V5RW2VK --file data/alexa-voc-cache/B09V5RW2VK.txt
 */
import fs from "node:fs";
import { saveAlexaVocToSystem } from "./lib/alexa-voc-pipeline.mjs";

const args = process.argv.slice(2);
const asin = (args.find(item => /^[A-Z0-9]{10}$/.test(item)) ?? "").trim().toUpperCase();
const fileArgIndex = args.indexOf("--file");
const filePath = fileArgIndex >= 0 ? args[fileArgIndex + 1] : null;

if (!/^[A-Z0-9]{10}$/.test(asin)) {
  console.error("[error] 请指定 ASIN：npm run alexa:paste -- B09V5RW2VK");
  process.exit(1);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const rawText = filePath ? fs.readFileSync(filePath, "utf8") : await readStdin();

if (!rawText?.trim()) {
  console.error("[error] 未收到报告正文。请粘贴 Alexa 回复全文，或使用 --file 指定 txt。");
  process.exit(1);
}

try {
  const processed = saveAlexaVocToSystem(asin, rawText, { captureMode: "paste" });
  console.log(`[ok] ${asin} · 已识别 ${processed.filled}/7 维 · 写入 app/rufus-voc-data.ts`);
  if (processed.missing.length) console.warn(`[warn] 仍缺：${processed.missing.join(", ")}`);
  console.log("[next] 请从 VOC 页面触发正式页面发布，或在同步页刷新");
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
