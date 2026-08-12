/**
 * 一次性登录 Amazon，保存 Cookie 供 Alexa VOC 自动抓取使用。
 *
 * 用法：
 *   npm run alexa:login
 *
 * 浏览器打开后请手动登录 Amazon（含验证码），回到终端按 Enter 保存会话。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const authFile = path.join(root, "data", "amazon-auth.json");

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("[error] 未安装 playwright。请先运行：npm install -D playwright && npx playwright install chromium");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded" });

  console.log("\n[alexa:login] 请在打开的浏览器中登录 Amazon 买家账号。");
  console.log("[alexa:login] 登录完成后回到此窗口，按 Enter 保存 Cookie。\n");

  const rl = readline.createInterface({ input, output });
  await rl.question("已登录？按 Enter 继续…");
  rl.close();

  await context.storageState({ path: authFile });
  await browser.close();
  console.log(`[ok] 会话已保存：${authFile}`);
}

main().catch(error => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
