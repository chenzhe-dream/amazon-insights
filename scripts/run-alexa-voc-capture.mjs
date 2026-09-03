/**
 * Playwright 自动抓取 Alexa for Shopping 七问 VOC，并写入 app/rufus-voc-data.ts
 *
 * 推荐半自动流程（Alexa 响应快、最稳）：
 *   1. 商品页手动提交七问并展开 See more
 *   2. npm run alexa:import -- ASIN
 *
 * 全自动（可选）：
 *   npm run alexa:sync -- B09V5RW2VK
 *   ALEXA_CDP_URL=http://127.0.0.1:9222 npm run alexa:sync -- B09V5RW2VK
 */
import fs from "node:fs";
import path from "node:path";
import { readAlexaVocReport, submitAlexaVocQuestion } from "./alexa-voc-browser-capture.mjs";
import { coordinateAlexaCapturePublication } from "./lib/alexa-capture-publication.mjs";
import { startAlexaPublicationWorker } from "./lib/alexa-publication-worker.mjs";
import { saveAlexaVocToSystem } from "./lib/alexa-voc-pipeline.mjs";
import { getAsinDataStatus, readCatalogAsins } from "./lib/asin-data-status.mjs";
import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";

const root = resolveFormalWorktreeRoot();
const authFile = path.join(root, "data", "amazon-auth.json");
const prompt =
  "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。";

const QUESTION = process.env.ALEXA_PROMPT ?? prompt;
const HEADLESS = process.env.ALEXA_HEADLESS !== "0";
const CDP_URL = process.env.ALEXA_CDP_URL?.trim();
const MAX_WAIT_MS = Number(process.env.ALEXA_MAX_WAIT_MS ?? (CDP_URL ? 120000 : 240000));
const POLL_MS = Number(process.env.ALEXA_POLL_MS ?? 2500);

function readAsins() {
  const fromEnv = process.env.ALEXA_ASINS?.split(",").map(item => item.trim().toUpperCase()).filter(Boolean) ?? [];
  const fromArgv = process.argv.slice(2).map(item => item.trim().toUpperCase()).filter(item => /^[A-Z0-9]{10}$/.test(item));
  const merged = [...new Set([...fromEnv, ...fromArgv])];
  if (merged.length) return merged;

  return getAsinDataStatus(readCatalogAsins())
    .filter(item => item.voc === "missing")
    .map(item => item.asin);
}

function reportReady(result) {
  const sectionCount = result.sections ? Object.values(result.sections).filter(Boolean).length : 0;
  return (
    result.text &&
    result.text.length > 1200 &&
    result.sections?.positives &&
    result.sections?.negatives &&
    sectionCount >= 4 &&
    !result.generating
  );
}

async function waitForReport(page, asin) {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const result = await page.evaluate(readAlexaVocReport, asin);
    if (reportReady(result)) return result;
    if (result.generating || result.text) process.stdout.write(".");
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`timeout waiting Alexa report for ${asin}`);
}

async function captureOne(page, asin, marketplace = "US") {
  const domain = marketplace === "UK" ? "www.amazon.co.uk" : "www.amazon.com";
  const url = `https://${domain}/dp/${asin}`;
  console.log(`\n[alexa] ${asin} → ${url}`);

  let existing = await page.evaluate(readAlexaVocReport, asin);
  if (!reportReady(existing)) {
    if (!page.url().includes(asin)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(2000);
      existing = await page.evaluate(readAlexaVocReport, asin);
    }
  }

  let report = existing;
  if (!reportReady(report)) {
    const submit = await page.evaluate(submitAlexaVocQuestion, QUESTION);
    if (!submit.ok) {
      throw new Error(submit.error ?? "Alexa input not found · 请确认商品页已加载 Rufus/Alexa 输入框");
    }
    console.log("[alexa] 七问已提交，等待报告生成…");
    report = await waitForReport(page, asin);
  } else {
    console.log("[alexa] 页面已有完整报告，跳过重复提交");
  }

  console.log("\n[alexa] 报告已就绪");
  const processed = saveAlexaVocToSystem(asin, report.text, {
    captureMode: CDP_URL ? "chrome" : "auto",
  });
  console.log(`[ok] ${asin} · 已识别 ${processed.filled}/7 维 · 写入 app/rufus-voc-data.ts`);
  if (processed.missing.length) console.warn(`[warn] 仍缺：${processed.missing.join(", ")}`);
  return { asin, processed };
}

async function createBrowserPage() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("[error] 未安装 playwright。请先运行：npm install -D playwright && npx playwright install chromium");
    process.exit(1);
  }

  if (CDP_URL) {
    console.log(`[alexa] 连接已有 Chrome：${CDP_URL}`);
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0] ?? (await browser.newContext({ locale: "zh-CN" }));
    const page =
      context.pages().find(item => item.url().includes("amazon.")) ??
      context.pages()[0] ??
      (await context.newPage());
    return { browser, page, detachOnly: true, isPersistent: false };
  }

  if (process.env.ALEXA_CHROME_PROFILE === "1") {
    const userDataDir =
      process.env.ALEXA_CHROME_USER_DATA ??
      path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
    if (!fs.existsSync(userDataDir)) {
      console.error(`[error] Chrome 用户目录不存在：${userDataDir}`);
      process.exit(1);
    }
    console.log(`[alexa] 复用 Chrome Profile：${userDataDir}`);
    console.log("[alexa] 请确保所有 Chrome 窗口已关闭后再继续。");
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      locale: "zh-CN",
      args: ["--profile-directory=Default"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return { browser: context, page, detachOnly: false, isPersistent: true };
  }

  if (!fs.existsSync(authFile)) {
    console.error(`[error] 缺少 Amazon 会话文件：${authFile}`);
    console.error("[hint] 方案 1：npm run alexa:login");
    console.error("[hint] 方案 2：手动七问后 npm run alexa:import -- ASIN");
    console.error("[hint] 方案 3：在 VOC 汇总页粘贴 Alexa 报告全文");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ storageState: authFile, locale: "zh-CN" });
  const page = await context.newPage();
  return { browser, page, detachOnly: false, isPersistent: false };
}

async function verifyAmazonLogin(page) {
  await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  const signedOut = /Hello,\s*sign in/i.test(text);
  if (signedOut) {
    throw new Error("Amazon 当前未登录。请在 Chrome 中确认已登录买家账号，或重新运行 npm run alexa:login");
  }
  console.log("[ok] 检测到 Amazon 已登录");
}

async function captureBatch() {
  const asins = readAsins();
  if (!asins.length) {
    console.error("[error] 未指定 ASIN。示例：npm run alexa:import -- B09V5RW2VK");
    process.exit(1);
  }

  const marketplace = process.env.ALEXA_MARKETPLACE ?? "US";
  const { browser, page, detachOnly } = await createBrowserPage();

  const results = [];
  try {
    if (!CDP_URL) await verifyAmazonLogin(page);
    for (const asin of asins) {
      try {
        results.push(await captureOne(page, asin, marketplace));
      } catch (error) {
        console.error(`[fail] ${asin}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await page.waitForTimeout(1000);
    }
  } finally {
    if (detachOnly) {
      browser.close().catch(() => {});
    } else {
      await browser.close();
    }
  }

  const okCount = results.length;
  console.log(`\n[done] 成功 ${okCount}/${asins.length}`);
  return { okCount, total: asins.length };
}

async function main() {
  const result = await coordinateAlexaCapturePublication({
    capture: captureBatch,
    publishAfterCapture: process.env.ALEXA_PUBLISH_AFTER_CAPTURE === "1",
    publish: () => startAlexaPublicationWorker({ worktree: root, env: process.env }),
  });
  if (result.okCount > 0) {
    console.log(result.publication
      ? "[next] 已请求正式页面发布，完成后在 VOC 汇总页刷新。"
      : "[next] Alexa 数据已写入；请请求正式页面发布，完成后在 VOC 汇总页刷新。");
  }
  process.exitCode = result.okCount === result.total ? 0 : 1;
}

main().catch(error => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
