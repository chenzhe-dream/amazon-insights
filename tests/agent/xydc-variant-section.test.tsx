import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";
import { createElement } from "react";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { XydcVariantSection, groupXydcVariantFamilies } from "../../app/xydc-variant-section";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const market = { label: "美国站", domain: "www.amazon.com" };
const inputAsins = ["B000000001", "B000000002"];
const reactServerCondition = process.execArgv.includes("--conditions=react-server");
const execFile = promisify(execFileCallback);

function childFixture(index: number): XydcVariantFamily["children"][number] {
  return {
    asin: `B00000${String(index).padStart(4, "0")}`,
    attributes: [{ dimension: "Color", value: `Color ${index}` }],
    title: `Fixture child ${index}`,
    imageUrl: null,
    price: 10 + index,
    currency: "USD",
    stars: 3 + (index % 3) * 0.5,
    productPageRatings: 100 - index,
    listingDate: null,
    infoStatus: "ready",
  };
}

function familyFixture(inputAsin: string, overrides: Partial<XydcVariantFamily> = {}): XydcVariantFamily {
  return {
    inputAsin,
    country: "US",
    parentAsin: "B000000010",
    dimensions: ["Color"],
    children: Array.from({ length: 28 }, (_, index) => childFixture(index + 1)),
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
    fetchedAt: "2026-09-04T00:00:00.000Z",
    status: "ready",
    reasonCode: null,
    cacheState: "fresh",
    ...overrides,
  };
}

const products = inputAsins.map((asin, index) => ({
  asin,
  brand: `Brand ${index + 1}`,
  title: `Fixture product ${index + 1}`,
  image: "",
}));

async function renderSection(families: readonly XydcVariantFamily[]) {
  if (!reactServerCondition) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(createElement(XydcVariantSection, { products, families, market }));
  }
  const source = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { XydcVariantSection } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "app", "xydc-variant-section.tsx")).href)};
    console.log(renderToStaticMarkup(createElement(XydcVariantSection, ${JSON.stringify({ products, families, market })})));
  `;
  const loader = pathToFileURL(join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;
  const result = await execFile(process.execPath, ["--import", loader, "-e", source], { cwd: process.cwd() });
  return result.stdout.trim();
}

test("groups matching input ASINs into one compact parent row with three child previews", async () => {
  const html = await renderSection([familyFixture(inputAsins[0]!), familyFixture(inputAsins[1]!)]);

  assert.equal(groupXydcVariantFamilies([familyFixture(inputAsins[0]!), familyFixture(inputAsins[1]!)]).length, 1);
  assert.equal((html.match(/class="xydc-variant-row"/g) ?? []).length, 1);
  assert.match(html, /B000000001/);
  assert.match(html, /B000000002/);
  assert.equal((html.match(/class="xydc-variant-child-card/g) ?? []).length, 3);
  assert.match(html, /查看全部 28/);
  assert.match(html, /商品页当前评论数/);
  assert.match(html, /上架时间：数据源未提供/);
  assert.match(html, /同一商品页的评论数为页面当前口径，不代表每个子体自身的单独沉淀/);
  assert.doesNotMatch(html, /独立评论数|评论占比/);
});

test("renders partial, unavailable, stale, and single-product cache states truthfully", async () => {
  const partial = familyFixture(inputAsins[0]!, { status: "partial", reasonCode: "PARTIAL_CHILD_INFO", children: [childFixture(1)] });
  const unavailable = familyFixture(inputAsins[1]!, { parentAsin: "B000000011", status: "unavailable", reasonCode: "TIMEOUT", children: [] });
  const staleSingle = familyFixture("B000000003", { parentAsin: "B000000012", cacheState: "stale", children: [childFixture(2)] });
  const html = await renderSection([partial, unavailable, staleSingle]);

  assert.match(html, /部分子体信息可用；缺口：PARTIAL_CHILD_INFO/);
  assert.match(html, /变体数据不可用：TIMEOUT/);
  assert.match(html, /缓存数据/);
  assert.match(html, /来源更新时间：2026-09-04T00:00:00.000Z/);
  assert.match(html, /单一商品\/未发现其他变体/);
});

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

function isLoopbackHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

async function startBrowserFixtureServer() {
  const families = [familyFixture(inputAsins[0]!), familyFixture(inputAsins[1]!)];
  const entry = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { XydcVariantSection } from "/app/xydc-variant-section.tsx";
createRoot(document.getElementById("root")).render(createElement(XydcVariantSection, {
  products: ${JSON.stringify(products)}, families: ${JSON.stringify(families)}, market: ${JSON.stringify(market)},
}));`;
  const server = await createViteServer({
    configFile: false,
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "xydc-variant-section-browser-fixture",
      resolveId(id) { return id === "/__xydc-variant-test-entry.tsx" ? "\0xydc-variant-test-entry" : undefined; },
      load(id) { return id === "\0xydc-variant-test-entry" ? entry : undefined; },
      configureServer(viteServer) {
        viteServer.middlewares.use((request, response, next) => {
          if (request.url === "/__xydc-variant-test.html") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html");
            response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/__xydc-variant-test-entry.tsx"></script></body></html>');
            return;
          }
          next();
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("drawer expands all children, supports allowed sorts, closes accessibly, and makes no provider request", async () => {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const externalRequests: string[] = [];
  try {
    const fixture = await startBrowserFixtureServer();
    server = fixture.server;
    browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
    page = await browser.newPage();
    await page.route("**/*", async route => {
      const requestUrl = route.request().url();
      if (!isLoopbackHttpUrl(requestUrl)) {
        externalRequests.push(requestUrl);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/__xydc-variant-test.html`);
    await page.getByRole("button", { name: "查看全部 28" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await dialog.locator(".xydc-variant-child-card").count(), 28);
    assert.equal(await dialog.locator(".xydc-variant-child-asin").first().textContent(), "B000000001");
    await page.getByLabel("抽屉排序").selectOption("price");
    assert.equal(await dialog.locator(".xydc-variant-child-asin").first().textContent(), "B000000028");
    assert.equal(await page.getByLabel("抽屉排序").locator("option").allTextContents().then(items => items.some(item => item.includes("上架时间"))), false);
    await page.keyboard.press("Escape");
    await assert.rejects(() => dialog.waitFor({ state: "visible", timeout: 250 }));
    await page.getByRole("button", { name: "查看全部 28" }).click();
    await page.getByRole("button", { name: "关闭变体明细" }).click();
    await assert.rejects(() => dialog.waitFor({ state: "visible", timeout: 250 }));
    assert.deepEqual(externalRequests, []);
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
});
