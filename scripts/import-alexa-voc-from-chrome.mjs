/**
 * 从已打开的 CDP Chrome 商品页读取 Alexa 报告并写入 rufus-voc-data.ts
 * 不自动提交七问 — 适合你在浏览器里手动提问、报告已展开后执行。
 *
 * 用法：
 *   $env:ALEXA_CDP_URL="http://127.0.0.1:9222"
 *   npm run alexa:import -- B09V5RW2VK
 */
import { chromium } from "playwright";
import { readAlexaVocReport } from "./alexa-voc-browser-capture.mjs";
import { saveAlexaVocToSystem } from "./lib/alexa-voc-pipeline.mjs";

const cdpUrl = process.env.ALEXA_CDP_URL ?? "http://127.0.0.1:9222";
const asin = (process.argv[2] ?? process.env.ALEXA_ASINS?.split(",")[0] ?? "").trim().toUpperCase();

if (!/^[A-Z0-9]{10}$/.test(asin)) {
  console.error("[error] 请指定 ASIN：npm run alexa:import -- B09V5RW2VK");
  process.exit(1);
}

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page =
  context.pages().find(item => item.url().includes(asin)) ??
  context.pages().find(item => item.url().includes("amazon.com"));

if (!page) {
  console.error("[error] CDP Chrome 中没有 Amazon 标签页。请先打开商品页并提交七问。");
  await browser.close().catch(() => {});
  process.exit(1);
}

if (!page.url().includes(asin)) {
  console.warn(`[warn] 当前页不是 ${asin}，尝试读取页面上的 Alexa 报告…`);
}

const report = await page.evaluate(readAlexaVocReport, asin);
const sectionCount = report.sections ? Object.values(report.sections).filter(Boolean).length : 0;

console.log(`[read] len=${report.text?.length ?? 0} sections=${sectionCount}`, report.sections);

if (!report.text || report.text.length < 600 || sectionCount < 3) {
  console.error("[error] 当前页面没有完整的 Alexa 七问报告。");
  console.error("[hint] 1) 在商品页 Ask Alexa 提交七问  2) 点击 See more 展开全文  3) 再运行本命令");
  await browser.close().catch(() => {});
  process.exit(1);
}

try {
  const processed = saveAlexaVocToSystem(asin, report.text, { captureMode: "chrome" });
  console.log(`[ok] ${asin} · 已识别 ${processed.filled}/7 维 · 写入 app/rufus-voc-data.ts`);
  if (processed.missing.length) console.warn(`[warn] 仍缺：${processed.missing.join(", ")}`);
  console.log("[next] npm run build && 重启团队服务");
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

await browser.close().catch(() => {});
