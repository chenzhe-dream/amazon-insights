import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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
const fixtureImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" fill="#f2f6fa"/><rect x="17" y="12" width="38" height="48" rx="8" fill="#7185a0"/><rect x="23" y="18" width="26" height="28" rx="4" fill="#dbe6ee"/><circle cx="36" cy="53" r="3" fill="#dbe6ee"/></svg>')}`;

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

test("separates ready variant status from placeholder catalog details", async () => {
  const waiting = [{ ...products[0]!, brand: "等待同步", title: "等待卖家精灵与 SIF MCP 返回商品数据" }];
  const html = await renderSection([familyFixture(inputAsins[0]!)], waiting);

  assert.match(html, /变体数据可用/);
  assert.match(html, /品牌资料待补充/);
  assert.match(html, /商品资料待补充，不影响已获取的变体展示/);
  assert.doesNotMatch(html, /等待同步|等待卖家精灵/);

  const catalogHtml = await renderSection(
    [familyFixture(inputAsins[0]!), familyFixture(inputAsins[1]!, { parentAsin: "B000000011" })],
    [{ ...products[0]!, brand: "", title: "" }, products[1]!],
  );
  assert.match(catalogHtml, /品牌资料待补充/);
  assert.match(catalogHtml, /商品资料待补充，不影响已获取的变体展示/);
  assert.match(catalogHtml, /Brand 2/);
  assert.match(catalogHtml, /Fixture product 2/);
});

test("orders parent rows, representative products, and hit ASINs by products input order", async () => {
  const reversedProducts = [products[1]!, products[0]!];
  const merged = [
    familyFixture(inputAsins[0]!, { parentAsin: "B000000099" }),
    familyFixture(inputAsins[1]!, { parentAsin: "B000000099" }),
  ];
  const laterInputRow = familyFixture(inputAsins[0]!, { parentAsin: "B000000010" });
  const html = await renderSection([...merged, laterInputRow], reversedProducts);
  const rows = html.match(/<article class="xydc-variant-row">[\s\S]*?<\/article>/g) ?? [];

  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /父体 B000000099/);
  assert.match(rows[0]!, /竞品 1/);
  assert.match(rows[0]!, /Brand 2/);
  assert.match(rows[0]!, /命中 ASIN：[\s\S]*B000000002[\s\S]*B000000001/);
  assert.match(rows[1]!, /父体 B000000010/);
  assert.match(rows[1]!, /竞品 2/);
  assert.match(rows[1]!, /Brand 1/);
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

  assert.match(html, /部分变体数据可用/);
  assert.match(html, /部分子体详情暂未返回/);
  assert.match(unavailableRow, /变体数据暂不可用/);
  assert.match(unavailableRow, /西柚请求超时/);
  assert.match(unavailableRow, /上架时间：数据源未提供/);
  assert.match(html, /来源更新时间：2026-09-01T00:00:00.000Z/);
  assert.match(html, /父体 B000000013[\s\S]*来源更新时间：数据源未提供[\s\S]*本次采集时间：2026-09-02T12:34:56.000Z/);
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

async function captureFixtureScreenshot(page: Page, name: string) {
  const directory = process.env.XYDC_VARIANT_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  if (name === "xydc-drawer") {
    await page.screenshot({ path: join(directory, `${name}.png`) });
  } else {
    await page.locator(".xydc-variant-section").screenshot({ path: join(directory, `${name}.png`) });
  }
}

async function startBrowserFixtureServer() {
  // Keep the app/layout.tsx stylesheet order, including global descendant rules.
  // Serve the CSS directly to avoid invoking a project-wide Tailwind build.
  const stylesheets = ["globals.css", "warm-theme.css", "comparison-layout.css"];
  const stylesheetLinks = stylesheets.map(name => `<link rel="stylesheet" href="/__xydc-css/${name}">`).join("");
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
          const stylesheetName = request.url?.replace("/__xydc-css/", "");
          if (request.url?.startsWith("/__xydc-css/") && stylesheetName && stylesheets.includes(stylesheetName)) {
            const css = readFileSync(join(process.cwd(), "app", stylesheetName), "utf8")
              .replace('@import "tailwindcss";', '@layer theme, base, components, utilities; @import url("/__xydc-tailwind/theme.css") layer(theme); @import url("/__xydc-tailwind/preflight.css") layer(base);');
            response.setHeader("Content-Type", "text/css");
            response.end(css);
            return;
          }
          if (request.url === "/__xydc-tailwind/theme.css" || request.url === "/__xydc-tailwind/preflight.css") {
            response.setHeader("Content-Type", "text/css");
            response.end(readFileSync(join(process.cwd(), "node_modules", "tailwindcss", request.url.split("/").at(-1)!), "utf8"));
            return;
          }
          if (request.url === "/__xydc-variant-test.html") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html");
            response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1">${stylesheetLinks}<style>
              :root { --font-geist-sans: Arial; --font-geist-mono: monospace; }
              .xydc-fixture-workspace { width: calc(100% - 288px); margin-left: 264px; padding: 24px; }
              @media (max-width: 900px) { .xydc-fixture-workspace { width: 100%; margin-left: 0; padding: 16px; } }
            </style></head><body><main id="root" class="page-content compare-page xydc-fixture-workspace"></main><script type="module" src="/__xydc-variant-test-entry.tsx"></script></body></html>`);
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

test("desktop preview remains readable within the workspace beside a sidebar", async t => {
  const fixture = await startBrowserFixtureServer();
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const forbiddenRequests: string[] = [];
  try {
    await page.route("**/*", async route => {
      const request = route.request();
      if (!isLoopbackHttpUrl(request.url()) || !["GET", "HEAD"].includes(request.method())) {
        forbiddenRequests.push(`${request.method()} ${request.url()}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/__xydc-variant-test.html`);
    const row = page.locator(".xydc-variant-row").first();
    await row.waitFor();
    const section = await page.locator(".xydc-variant-section").boundingBox();
    assert.ok(section && section.width >= 1080 && section.width <= 1120, "fixture must reproduce about 1100px of workspace width");
    await captureFixtureScreenshot(page, "xydc-desktop");
    const metrics = await row.evaluate(element => {
      const [summary, content, button] = [".xydc-variant-summary", ".xydc-variant-content", ".xydc-variant-open-drawer"].map(selector => {
        const bounds = element.querySelector(selector)!.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right };
      });
      const cards = [...element.querySelectorAll(".xydc-variant-child-card")];
      return {
        directClasses: [...element.children].map(child => child.className),
        dimensionsInSummary: !!element.querySelector(".xydc-variant-summary .xydc-variant-dimensions"),
        statusFontSize: Number.parseFloat(getComputedStyle(element.querySelector(".xydc-variant-content > p")!).fontSize),
        timeFontSizes: [...element.querySelectorAll(".xydc-variant-summary > span")].map(item => Number.parseFloat(getComputedStyle(item).fontSize)),
        summary: summary!,
        content: content!,
        cards: cards.map(card => ({
          fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
          bodyFontSizes: [...card.querySelectorAll("b, span:not(.xydc-variant-child-image-unavailable)")].map(item => Number.parseFloat(getComputedStyle(item).fontSize)),
          asinFontSize: Number.parseFloat(getComputedStyle(card.querySelector(".xydc-variant-child-asin")!).fontSize),
          x: card.getBoundingClientRect().x,
          y: card.getBoundingClientRect().y,
        })),
        images: [...element.querySelectorAll(".xydc-variant-parent-image, .xydc-variant-child-image")].map(item => {
          const bounds = item.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
        button: { ...button!, text: element.querySelector(".xydc-variant-open-drawer")!.textContent },
      };
    });
    await t.test("groups dimensions into the summary and uses a quarter/three-quarter desktop split", () => {
      assert.deepEqual(metrics.directClasses, ["xydc-variant-summary", "xydc-variant-content"]);
      assert.equal(metrics.dimensionsInSummary, true);
      assert.ok(Math.abs(metrics.summary.y - metrics.content.y) <= 1);
      assert.ok(metrics.content.x >= metrics.summary.right);
      const summaryShare = metrics.summary.width / (metrics.summary.width + metrics.content.width);
      assert.ok(summaryShare >= 0.23 && summaryShare <= 0.27, `summary share: ${summaryShare}`);
    });
    await t.test("keeps three previews with at least 14px body text and 12px ASINs", () => {
      assert.equal(metrics.cards.length, 3);
      assert.ok(metrics.cards.every(card => Math.abs(card.y - metrics.cards[0]!.y) <= 1), "desktop previews should share one row");
      for (const card of metrics.cards) {
        assert.ok(card.fontSize >= 14, `card body is ${card.fontSize}px`);
        assert.ok(card.bodyFontSizes.every(size => size >= 14), `child text sizes: ${card.bodyFontSizes.join(", ")}`);
        assert.ok(card.asinFontSize >= 12, `ASIN is ${card.asinFontSize}px`);
      }
    });
    await t.test("keeps status and time explanations readable", () => {
      assert.ok(metrics.statusFontSize >= 14, `status text is ${metrics.statusFontSize}px`);
      assert.ok(metrics.timeFontSizes.length >= 2);
      assert.ok(metrics.timeFontSizes.every(size => size >= 12), `time text sizes: ${metrics.timeFontSizes.join(", ")}`);
    });
    await t.test("uses readable parent and child thumbnails", () => {
      assert.equal(metrics.images.length, 4);
      for (const size of metrics.images) {
        assert.ok(size.width >= 64 && size.width <= 80 && size.height >= 64 && size.height <= 80, `thumbnail bounds: ${JSON.stringify(size)}`);
      }
    });
    await t.test("offers a clearly labelled control at least 36px high", () => {
      assert.ok(metrics.button.height >= 36, `view-all control is ${metrics.button.height}px high`);
      assert.match(metrics.button.text ?? "", /查看全部 28 个子体/);
    });
    assert.deepEqual(forbiddenRequests, []);
  } finally {
    await page.close();
    await browser.close();
    await fixture.server.close();
  }
});

test("renders every reason and non-ready child status in Chinese", async () => {
  const reasonCases: Array<[XydcVariantFamily["reasonCode"], string]> = [
    ["NOT_CONFIGURED", "西柚数据源未配置"],
    ["AUTH_FAILED", "西柚数据源认证失败"],
    ["TIMEOUT", "西柚请求超时"],
    ["RPC_ERROR", "西柚服务暂不可用"],
    ["SCHEMA_INVALID", "数据源返回格式异常"],
    ["NOT_FOUND", "数据源未返回该商品变体"],
    ["PARTIAL_CHILD_INFO", "部分子体详情暂未返回"],
    [null, "数据源未返回具体原因"],
  ];
  const families = reasonCases.map(([reasonCode], index) => familyFixture(`B${String(10_000_000 + index).padStart(9, "0")}`, {
    parentAsin: `B${String(20_000_000 + index).padStart(9, "0")}`,
    status: "unavailable",
    reasonCode,
    children: [],
  }));
  families.push(familyFixture(inputAsins[0]!, {
    parentAsin: "B300000001",
    children: [
      { ...childFixture(1), infoStatus: "pending" },
      { ...childFixture(2), infoStatus: "unavailable" },
    ],
  }));
  const html = await renderSection(families);

  for (const [, label] of reasonCases) assert.match(html, new RegExp(label));
  assert.match(html, /子体信息：详情待补充/);
  assert.match(html, /子体信息：详情暂不可用/);
});

test("390px mobile preview stacks its cards without horizontal overflow", async t => {
  const fixture = await startBrowserFixtureServer();
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const forbiddenRequests: string[] = [];
  try {
    await page.route("**/*", async route => {
      const request = route.request();
      if (!isLoopbackHttpUrl(request.url()) || !["GET", "HEAD"].includes(request.method())) {
        forbiddenRequests.push(`${request.method()} ${request.url()}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/__xydc-variant-test.html`);
    await page.locator(".xydc-variant-row").first().waitFor();
    await captureFixtureScreenshot(page, "xydc-mobile");
    const metrics = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowingElements: [...document.querySelectorAll(".xydc-variant-section, .xydc-variant-section *")]
        .filter(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < -1 || bounds.right > window.innerWidth + 1);
        }).map(element => element.className || element.tagName),
      rows: [...document.querySelectorAll(".xydc-variant-row")].map(row => {
        const summary = row.querySelector(".xydc-variant-summary")!.getBoundingClientRect();
        const content = row.querySelector(".xydc-variant-content")!.getBoundingClientRect();
        return {
          summary: { x: summary.x, width: summary.width, bottom: summary.bottom },
          content: { x: content.x, width: content.width, y: content.y },
        };
      }),
      cards: [...document.querySelector(".xydc-variant-row")!.querySelectorAll(".xydc-variant-child-card")].map(card => {
        const bounds = card.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, bottom: bounds.bottom };
      }),
    }));
    await t.test("keeps all section content within the mobile viewport", () => {
      assert.ok(metrics.documentWidth <= metrics.viewportWidth, `document is ${metrics.documentWidth}px at ${metrics.viewportWidth}px viewport`);
      assert.deepEqual(metrics.overflowingElements, []);
    });
    await t.test("stacks summary above content and preserves three full-width preview cards", () => {
      for (const row of metrics.rows) {
        assert.ok(row.content.y >= row.summary.bottom, "mobile content should follow the summary vertically");
        assert.ok(Math.abs(row.content.x - row.summary.x) <= 1);
        assert.ok(Math.abs(row.content.width - row.summary.width) <= 1);
      }
      assert.equal(metrics.cards.length, 3);
      for (const [index, card] of metrics.cards.entries()) {
        assert.ok(Math.abs(card.x - metrics.cards[0]!.x) <= 1);
        assert.ok(Math.abs(card.width - metrics.cards[0]!.width) <= 1);
        if (index > 0) assert.ok(card.y >= metrics.cards[index - 1]!.bottom);
      }
    });
    assert.deepEqual(forbiddenRequests, []);
  } finally {
    await page.close();
    await browser.close();
    await fixture.server.close();
  }
});

test("drawer expands all children, supports allowed sorts, closes accessibly, and makes no provider request", async () => {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const forbiddenRequests: string[] = [];
  try {
    const fixture = await startBrowserFixtureServer();
    server = fixture.server;
    browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
    page = await browser.newPage();
    await page.route("**/*", async route => {
      const request = route.request();
      if (!isLoopbackHttpUrl(request.url()) || !["GET", "HEAD"].includes(request.method())) {
        forbiddenRequests.push(`${request.method()} ${request.url()}`);
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
    await captureFixtureScreenshot(page, "xydc-drawer");
    const mainPreviewAsins = await page.locator(".xydc-variant-children .xydc-variant-child-asin").allTextContents();
    assert.equal(await dialog.locator(".xydc-variant-child-card").count(), 28);
    assert.equal(await dialog.locator(".xydc-variant-child-image").count(), 28);
    assert.ok((await dialog.locator(".xydc-variant-child-image").first().getAttribute("src"))?.length);
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /来源更新时间：2026-09-04T00:00:00.000Z/);
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /本次采集时间：2026-09-04T00:00:00.000Z/);
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
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /来源更新时间：数据源未提供/);
    assert.match(await dialog.locator(".xydc-variant-child-card").first().textContent() ?? "", /本次采集时间：2026-09-04T12:34:56.000Z/);
    assert.deepEqual(forbiddenRequests, []);
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
});
