import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let baseUrl = "";

function browserExecutablePath() {
  const defaultPath = chromium.executablePath();
  if (existsSync(defaultPath)) return defaultPath;

  const browsersPath = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(browsersPath)) {
    const chromiumDirectory = readdirSync(browsersPath, { withFileTypes: true })
      .find(entry => entry.isDirectory() && entry.name.startsWith("chromium-"));
    if (chromiumDirectory) {
      const fallbackPath = join(browsersPath, chromiumDirectory.name, "chrome-win64", "chrome.exe");
      if (existsSync(fallbackPath)) return fallbackPath;
    }
  }

  const systemChrome = join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  assert.ok(existsSync(systemChrome), "Playwright Chromium or system Chrome is required for this browser test");
  return systemChrome;
}

before(async () => {
  server = await createServer({
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("non-primary builder interactions replace the hidden diagnostic with visible business notices", async () => {
  const page = await browser.newPage();

  try {
    for (const item of [
      { tab: "overview", action: "开始全自动分析" },
      { tab: "keywords", action: "抓取关键词数据" },
      { tab: "traffic", action: "抓取流量数据" },
    ]) {
      const response = await page.goto(
        `${baseUrl}/tests/agent/helpers/primary-admin-browser-harness.html?tab=${item.tab}`,
        { waitUntil: "domcontentloaded" },
      );
      assert.equal(response?.status(), 200);
      await page.locator(".asin-builder").waitFor();

      const notice = page.locator(".builder-actions .builder-message");
      assert.equal(await notice.count(), 0);

      await page.locator(".market-inline select").selectOption("UK");
      await notice.waitFor({ timeout: 5_000 });
      assert.match(await notice.textContent() ?? "", /已切换至\s*英国站/);
      assert.equal(await notice.evaluate(element => element.className), "builder-message");

      await page.locator(".asin-builder").getByRole("button", { name: item.action }).click();
      await page.waitForFunction(
        () => document.querySelector(".builder-actions .builder-message")?.textContent === "请至少输入 3 个竞品 ASIN",
        undefined,
        { timeout: 5_000 },
      );
      assert.equal(await notice.evaluate(element => element.className), "builder-message error");
    }
  } finally {
    await page.close();
  }
});
