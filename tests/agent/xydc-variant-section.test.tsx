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
const fixtureImage = "data:,x";

function childFixture(index: number): XydcVariantFamily["children"][number] {
  return {
    asin: `B00000${String(index).padStart(4, "0")}`,
    attributes: [{ dimension: "Color", value: `Color ${index}` }],
    title: `Fixture child ${index}`,
    imageUrl: fixtureImage,
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
  image: fixtureImage,
}));

async function renderSection(families: readonly XydcVariantFamily[], renderedProducts = products) {
  if (!reactServerCondition) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(createElement(XydcVariantSection, { products: renderedProducts, families, market }));
  }
  const source = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { XydcVariantSection } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "app", "xydc-variant-section.tsx")).href)};
    console.log(renderToStaticMarkup(createElement(XydcVariantSection, ${JSON.stringify({ products: renderedProducts, families, market })})));
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
  assert.match(html, /西柚洞察 MCP/);
  assert.match(html, /竞品 1/);
  assert.match(html, /子体总数：28/);
  assert.equal((html.match(/class="xydc-variant-parent-image"/g) ?? []).length, 1);
  assert.equal((html.match(/class="xydc-variant-child-image"/g) ?? []).length, 3);
  assert.match(html, /上架时间：数据源未提供/);
  assert.match(html, /同一商品页的评论数为页面当前口径，不代表每个子体自身的单独沉淀/);
  assert.doesNotMatch(html, /独立评论数|评论占比/);
});

test("merges duplicate children deterministically without letting incomplete cache records overwrite ready data", () => {
  const ready = familyFixture(inputAsins[0]!, {
    sourceUpdatedAt: "2026-09-02T00:00:00.000Z",
    children: [{ ...childFixture(1), title: "Ready child", infoStatus: "ready", price: 12 }],
  });
  const pendingNewer = familyFixture(inputAsins[1]!, {
    sourceUpdatedAt: "2026-09-03T00:00:00.000Z",
    children: [{ ...childFixture(1), title: "Pending child", infoStatus: "pending", price: null }],
  });
  const pendingOlder = familyFixture("B000000003", {
    sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
    children: [{ ...childFixture(2), title: "Old pending child", infoStatus: "pending" }],
  });
  const pendingNewerSameTier = familyFixture("B000000004", {
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
    children: [{ ...childFixture(2), title: "New pending child", infoStatus: "pending" }],
  });

  const forward = groupXydcVariantFamilies([ready, pendingNewer, pendingOlder, pendingNewerSameTier]);
  const reverse = groupXydcVariantFamilies([pendingNewerSameTier, pendingOlder, pendingNewer, ready]);
  const merged = forward[0]!;

  assert.deepEqual(forward, reverse);
  assert.equal(merged.children.find(child => child.asin === childFixture(1).asin)?.title, "Ready child");
  assert.equal(merged.children.find(child => child.asin === childFixture(2).asin)?.title, "New pending child");
});

test("uses a neutral unavailable-image placeholder for a child whose image is absent", async () => {
  const childWithoutImage = { ...childFixture(1), imageUrl: null };
  const sibling = { ...childFixture(2), imageUrl: "data:,sibling-image" };
  const html = await renderSection(
    [familyFixture(inputAsins[0]!, { children: [childWithoutImage, sibling] })],
    [{ ...products[0]!, image: "data:,parent-product-image" }],
  );
  const missingChildCard = html.match(/<article class="xydc-variant-child-card">[\s\S]*?B000000001[\s\S]*?<\/article>/)?.[0] ?? "";

  assert.match(missingChildCard, /主图：数据源未提供/);
  assert.match(missingChildCard, /alt="B000000001 主图数据源未提供"/);
  assert.match(missingChildCard, /src="data:image\/svg\+xml,/);
  assert.doesNotMatch(missingChildCard, /parent-product-image|sibling-image/);
});

test("single-product family explicitly reports that no other variants were found", async () => {
  const html = await renderSection([familyFixture(inputAsins[0]!, { children: [childFixture(1)] })]);

  assert.match(html, /单一商品\/未发现其他变体/);
});

test("renders partial, unavailable, stale, and single-product cache states truthfully", async () => {
  const partial = familyFixture(inputAsins[0]!, { status: "partial", reasonCode: "PARTIAL_CHILD_INFO", children: [childFixture(1)] });
  const unavailable = familyFixture(inputAsins[1]!, { parentAsin: "B000000011", status: "unavailable", reasonCode: "TIMEOUT", children: [] });
  const freshFirst = familyFixture("B000000003", { parentAsin: "B000000012", sourceUpdatedAt: "2026-09-05T00:00:00.000Z" });
  const staleSecond = familyFixture("B000000004", { parentAsin: "B000000012", cacheState: "stale", sourceUpdatedAt: "2026-09-01T00:00:00.000Z", children: [childFixture(2)] });
  const freshBeforeUnknownStale = familyFixture("B000000005", { parentAsin: "B000000013", sourceUpdatedAt: "2026-09-05T00:00:00.000Z" });
  const staleWithoutSourceTime = familyFixture("B000000006", { parentAsin: "B000000013", cacheState: "stale", sourceUpdatedAt: null, fetchedAt: "2026-09-02T12:34:56.000Z" });
  const html = await renderSection([partial, unavailable, freshFirst, staleSecond, freshBeforeUnknownStale, staleWithoutSourceTime]);
  const unavailableRow = html.match(/<article class="xydc-variant-row">[\s\S]*?父体 B000000011[\s\S]*?<\/article>/)?.[0] ?? "";

  assert.match(html, /部分子体信息可用；缺口：PARTIAL_CHILD_INFO/);
  assert.match(unavailableRow, /变体数据不可用：TIMEOUT/);
  assert.match(unavailableRow, /上架时间：数据源未提供/);
  assert.match(html, /缓存数据 · 来源更新时间：2026-09-01T00:00:00.000Z/);
  assert.match(html, /父体 B000000013[\s\S]*缓存数据 · 来源更新时间未提供 · 缓存抓取时间：2026-09-02T12:34:56.000Z/);
  assert.doesNotMatch(html, /父体 B000000013[\s\S]*来源更新时间：2026-09-05T00:00:00.000Z/);
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
  const families = [
    familyFixture(inputAsins[0]!),
    familyFixture(inputAsins[1]!),
    familyFixture("B000000003", { parentAsin: "B000000011", status: "unavailable", reasonCode: "TIMEOUT", children: [] }),
    familyFixture("B000000004", {
      parentAsin: "B000000012",
      sourceUpdatedAt: null,
      fetchedAt: "2026-09-04T12:34:56.000Z",
      children: Array.from({ length: 4 }, (_, index) => childFixture(index + 10)),
    }),
  ];
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
    const rows = page.locator(".xydc-variant-row");
    assert.equal(await rows.count(), 3);
    for (let index = 0; index < await rows.count(); index += 1) {
      assert.equal(await rows.nth(index).locator(":scope > .xydc-variant-content").count(), 1);
    }
    const unavailableRow = rows.filter({ hasText: "父体 B000000011" });
    assert.equal(await unavailableRow.count(), 1);
    assert.equal(await unavailableRow.locator(".xydc-variant-listing-date").textContent(), "上架时间：数据源未提供");
    await page.getByRole("button", { name: "查看全部 28" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const mainPreviewAsins = await page.locator(".xydc-variant-children .xydc-variant-child-asin").allTextContents();
    assert.equal(await dialog.locator(".xydc-variant-child-card").count(), 28);
    assert.equal(await dialog.locator(".xydc-variant-child-image").count(), 28);
    assert.ok((await dialog.locator(".xydc-variant-child-image").first().getAttribute("src"))?.length);
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /更新时间：2026-09-04T00:00:00.000Z/);
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /上架时间：数据源未提供/);
    assert.equal(await dialog.locator(".xydc-variant-child-asin").first().textContent(), "B000000001");
    await page.getByLabel("抽屉排序").selectOption("price");
    assert.equal(await dialog.locator(".xydc-variant-child-asin").first().textContent(), "B000000028");
    assert.deepEqual(await page.locator(".xydc-variant-children .xydc-variant-child-asin").allTextContents(), mainPreviewAsins);
    await page.getByLabel("抽屉排序").selectOption("stars");
    assert.equal(await dialog.locator(".xydc-variant-child-asin").first().textContent(), "B000000002");
    assert.deepEqual(await page.locator(".xydc-variant-children .xydc-variant-child-asin").allTextContents(), mainPreviewAsins);
    await page.getByLabel("抽屉排序").selectOption("ratings");
    assert.equal(await dialog.locator(".xydc-variant-child-asin").first().textContent(), "B000000001");
    assert.deepEqual(await page.locator(".xydc-variant-children .xydc-variant-child-asin").allTextContents(), mainPreviewAsins);
    assert.equal(await page.getByLabel("抽屉排序").locator("option").allTextContents().then(items => items.some(item => item.includes("上架时间"))), false);
    await page.keyboard.press("Escape");
    await assert.rejects(() => dialog.waitFor({ state: "visible", timeout: 250 }));
    await page.getByRole("button", { name: "查看全部 28" }).click();
    await page.getByRole("button", { name: "关闭变体明细" }).click();
    await assert.rejects(() => dialog.waitFor({ state: "visible", timeout: 250 }));
    await page.getByRole("button", { name: "查看全部 4" }).click();
    await dialog.waitFor();
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /更新时间：2026-09-04T12:34:56.000Z/);
    assert.deepEqual(externalRequests, []);
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
});
