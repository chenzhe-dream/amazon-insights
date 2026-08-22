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
      .find((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"));
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
    configFile: false,
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

test("panel toggles A to B without network mutation and remains responsive", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/concurrency-admin-browser-harness.html`, {
      waitUntil: "domcontentloaded",
    });

    const region = page.getByRole("region", { name: "并发与额度" });
    const toggle = region.locator(".concurrency-admin-toggle");
    await toggle.waitFor();
    assert.equal(await toggle.textContent(), "展开管理");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await region.getByRole("button", { name: "手动刷新" }).count(), 0);

    await toggle.click();
    assert.equal(await toggle.textContent(), "收起");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await region.locator(".concurrency-admin-metric").count(), 4);
    assert.equal(await region.getByRole("button", { name: "手动刷新" }).count(), 1);
    assert.doesNotMatch(await region.textContent() ?? "", /credential is not configured/);

    const columns = await region.locator(".concurrency-admin-summary").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    assert.equal(columns, 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(await page.evaluate(() => window.__networkMethods), []);

    await toggle.click();
    assert.equal(await toggle.textContent(), "展开管理");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");

    await page.setViewportSize({ width: 900, height: 900 });
    await toggle.click();
    const mediumColumns = await region.locator(".concurrency-admin-summary").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    assert.equal(mediumColumns, 2);
    await toggle.click();

    await page.setViewportSize({ width: 740, height: 900 });
    await toggle.click();
    const mobileColumns = await region.locator(".concurrency-admin-summary").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    assert.equal(mobileColumns, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(await page.evaluate(() => window.__networkMethods), []);
  } finally {
    await page.close();
  }
});
