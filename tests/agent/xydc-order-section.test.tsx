import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { XydcVariantSection } from "../../app/xydc-variant-section";
import type { XydcOrderReason, XydcOrderSnapshot } from "../../shared/xydc-order-contract";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const market = { label: "美国站", domain: "www.amazon.com" };
const months = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const fixtureImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="8" fill="#dbe7f5"/><circle cx="36" cy="36" r="20" fill="#6d83a1"/></svg>')}`;
const primaryAsins = ["B000000001", "B000000002", "B000000003", "B000000004"];
const primaryTotals = [
  [300, 300, 320, 400, 350, 300, 320, 200, 100, 400, 500, 510],
  [100, 100, 100, 120, 110, 100, 100, 80, 50, 90, 100, 100],
  [50, 50, 50, 80, 70, 60, 50, 40, 30, 50, 60, 60],
  [10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5, 10],
];

function childFixture(asin: string, index: number): XydcVariantFamily["children"][number] {
  return {
    asin,
    attributes: [{ dimension: "Color", value: ["Sand Black", "Black", "White", "Silver"][index] ?? `Color ${index + 1}` }],
    title: `Fixture child ${index + 1}`,
    imageUrl: fixtureImage,
    price: index === 0 ? 39.99 : 29.99 + index,
    currency: "USD",
    stars: 4.5,
    productPageRatings: 100 - index,
    listingDate: null,
    infoStatus: "ready",
  };
}

function familyFixture(parentAsin = "B000000010", inputAsin = "B000000001", childAsins = primaryAsins): XydcVariantFamily {
  return {
    inputAsin,
    country: "US",
    parentAsin,
    dimensions: ["Color"],
    children: childAsins.map(childFixture),
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
    fetchedAt: "2026-09-04T01:00:00.000Z",
    status: "ready",
    reasonCode: null,
    cacheState: "fresh",
  };
}

function orderFixture({
  parentAsin = "B000000010",
  childAsins = primaryAsins,
  values = primaryTotals,
  cacheState = "fresh",
  reasonCode = null,
  sourceUpdatedAt = "2026-09-04T00:00:00.000Z",
}: {
  parentAsin?: string;
  childAsins?: string[];
  values?: number[][];
  cacheState?: XydcOrderSnapshot["cacheState"];
  reasonCode?: XydcOrderReason | null;
  sourceUpdatedAt?: string | null;
} = {}): XydcOrderSnapshot {
  return {
    version: 1,
    source: "xydc",
    aggregation: "children",
    country: "US",
    parentAsin,
    childAsins,
    window: { startMonth: months[0]!, endMonth: months.at(-1)!, months },
    children: childAsins.map((asin, index) => ({
      asin,
      trends: (values[index] ?? []).map((orders, monthIndex) => ({ date: months[monthIndex]!, orders })),
      fetchedAt: `2026-09-04T0${Math.min(index + 1, 9)}:00:00.000Z`,
      reasonCode: reasonCode === "PARTIAL_DATA" && index === childAsins.length - 1 ? "PARTIAL_DATA" : null,
    })),
    sourceUpdatedAt,
    fetchedAt: "2026-09-04T12:34:56.000Z",
    cacheState,
    reasonCode,
  };
}

const products = [
  { asin: "B000000001", brand: "LEPOWER", title: "Fixture lamp", image: fixtureImage },
  { asin: "B000000005", brand: "OYEAR", title: "Fixture shade", image: fixtureImage },
];

function renderSection(
  families: readonly XydcVariantFamily[],
  orderFamilies: readonly XydcOrderSnapshot[],
  renderedProducts = products,
) {
  return renderToStaticMarkup(createElement(XydcVariantSection, {
    products: renderedProducts,
    families,
    orderFamilies,
    market,
  }));
}

test("renders fixed-window annual parent cards from the complete family denominator", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  const html = renderSection([familyFixture()], [orderFixture()]);

  assert.match(html, /父体订单量份额与12个月趋势/);
  assert.match(html, /2025-09/);
  assert.match(html, /2026-08/);
  assert.match(html, /西柚洞察/);
  assert.match(html, /子体汇总/);
  assert.match(html, /5,900\+/);
  assert.match(html, /67\.80%/);
  assert.match(html, /19\.49%/);
  assert.match(html, /11\.02%/);
  assert.match(html, /查看全部 4 个子体与月度趋势/);
  assert.equal((html.match(/data-order-preview-row=/g) ?? []).length, 3);
  assert.match(html, /4\/4 个子体返回/);
  assert.match(html, /12\/12 月/);
  assert.doesNotMatch(html, /近30天|评论占比|独立评论数/);

  const link = html.match(/<a[^>]+href="https:\/\/www\.amazon\.com\/dp\/B000000001"[^>]*>/)?.[0] ?? "";
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
});

test("keeps variant information while truthfully rendering pending, partial, zero-only, and stale orders", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  const pendingFamily = familyFixture("B000000020", "B000000005", ["B000000005", "B000000006"]);
  const partial = orderFixture({
    values: [primaryTotals[0]!, primaryTotals[1]!, primaryTotals[2]!, primaryTotals[3]!.slice(0, 11)],
    reasonCode: "PARTIAL_DATA",
    sourceUpdatedAt: null,
  });
  const zeroAsins = ["B000000007", "B000000008"];
  const zeroFamily = familyFixture("B000000030", "B000000007", zeroAsins);
  const zeroSnapshot = orderFixture({ parentAsin: "B000000030", childAsins: zeroAsins, values: [months.map(() => 0), months.map(() => 0)] });
  const staleFamily = familyFixture("B000000040", "B000000009", ["B000000009"]);
  const staleSnapshot = orderFixture({ parentAsin: "B000000040", childAsins: ["B000000009"], values: [months.map(() => 10)], cacheState: "stale" });
  const html = renderSection([familyFixture(), pendingFamily, zeroFamily, staleFamily], [partial, zeroSnapshot, staleSnapshot], [
    ...products,
    { asin: "B000000007", brand: "ZERO", title: "Zero fixture", image: fixtureImage },
    { asin: "B000000009", brand: "STALE", title: "Stale fixture", image: fixtureImage },
  ]);

  assert.match(html, /订单数据待采集/);
  assert.match(html, /2025-09 — 2026-08/);
  assert.match(html, /部分订单数据不可用/);
  assert.match(html, /来源更新时间：数据源未提供/);
  assert.match(html, /本次采集时间：2026-09-04T12:34:56.000Z/);
  assert.match(html, /暂无可披露订单数据/);
  assert.match(html, /未披露/);
  assert.match(html, /缓存数据/);
  assert.doesNotMatch(html, /近30天/);
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
  assert.ok(existsSync(systemChrome), "Playwright Chromium or system Chrome is required");
  return systemChrome;
}

function isLoopbackHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

async function startBrowserFixtureServer() {
  const secondAsins = ["B000000005", "B000000006"];
  const partialAsins = ["B000000007", "B000000008", "B000000009"];
  const families = [familyFixture(), familyFixture("B000000020", "B000000005", secondAsins), familyFixture("B000000030", "B000000007", partialAsins)];
  const orders = [
    orderFixture(),
    orderFixture({ parentAsin: "B000000020", childAsins: secondAsins, values: [months.map(() => 100), months.map(() => 50)] }),
    orderFixture({ parentAsin: "B000000030", childAsins: partialAsins, values: [months.map(() => 80), months.map(() => 40), months.slice(0, 11).map(() => 20)], reasonCode: "PARTIAL_DATA" }),
  ];
  const fixtureProps = { products, families, orderFamilies: orders, market };
  const serverMarkup = renderToStaticMarkup(createElement(XydcVariantSection, fixtureProps));
  const entry = `
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { XydcVariantSection } from "/app/xydc-variant-section.tsx";
const root = hydrateRoot(document.getElementById("root"), createElement(XydcVariantSection, ${JSON.stringify(fixtureProps)}));
window.replaceXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify({ products: products.slice(1), families: families.slice(1), orderFamilies: orders.slice(1), market })}));`;
  const stylesheets = ["globals.css", "warm-theme.css", "comparison-layout.css"];
  const server = await createViteServer({
    configFile: false,
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "xydc-order-section-browser-fixture",
      resolveId(id) { return id === "/__xydc-order-test-entry.tsx" ? "\0xydc-order-test-entry" : undefined; },
      load(id) { return id === "\0xydc-order-test-entry" ? entry : undefined; },
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
          if (request.url === "/__xydc-order-test.html") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html");
            response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1">${stylesheets.map(name => `<link rel="stylesheet" href="/__xydc-css/${name}">`).join("")}<style>:root{--font-geist-sans:Arial;--font-geist-mono:monospace}.fixture{width:calc(100% - 288px);margin-left:264px;padding:24px}@media(max-width:900px){.fixture{width:100%;margin:0;padding:16px}}</style></head><body><main id="root" class="page-content compare-page fixture">${serverMarkup}</main><script type="module" src="/__xydc-order-test-entry.tsx"></script></body></html>`);
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

async function withFixture(run: (page: Page) => Promise<void>, viewport = { width: 1440, height: 1100 }) {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const forbiddenRequests: string[] = [];
  try {
    const fixture = await startBrowserFixtureServer();
    server = fixture.server;
    browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
    page = await browser.newPage({ viewport });
    await page.clock.setFixedTime(new Date("2026-09-08T12:00:00.000Z"));
    const hydrationErrors: string[] = [];
    page.on("console", message => {
      if (message.type() === "error" && /hydration|did not match|server rendered/i.test(message.text())) hydrationErrors.push(message.text());
    });
    await page.route("**/*", async route => {
      const request = route.request();
      if (!isLoopbackHttpUrl(request.url()) || !["GET", "HEAD"].includes(request.method())) {
        forbiddenRequests.push(`${request.method()} ${request.url()}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/__xydc-order-test.html`);
    await page.locator(".xydc-order-grid").waitFor();
    await run(page);
    assert.deepEqual(forbiddenRequests, []);
    assert.deepEqual(hydrationErrors, []);
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

test("desktop and 390px layouts keep order cards in-bounds", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    const cards = page.locator(".xydc-order-card");
    assert.equal(await cards.count(), 3);
    const boxes = await cards.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    }));
    assert.ok(Math.abs(boxes[0]!.y - boxes[1]!.y) <= 1);
    assert.ok(boxes[1]!.x > boxes[0]!.x + boxes[0]!.width);
    const screenshot = join(process.cwd(), "test-results", "xydc-orders-desktop.png");
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    await page.locator(".xydc-variant-section").screenshot({ path: screenshot });
    await t.test("desktop screenshot exists", () => assert.ok(existsSync(screenshot)));
  });
  await withFixture(async page => {
    const cards = page.locator(".xydc-order-card");
    const boxes = await cards.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, bottom: box.bottom };
    }));
    assert.ok(boxes[1]!.y >= boxes[0]!.bottom);
    assert.ok(Math.abs(boxes[0]!.x - boxes[1]!.x) <= 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `document overflow is ${overflow}px`);
    const screenshot = join(process.cwd(), "test-results", "xydc-orders-mobile.png");
    await page.locator(".xydc-variant-section").screenshot({ path: screenshot });
    await t.test("mobile screenshot exists", () => assert.ok(existsSync(screenshot)));
  }, { width: 390, height: 844 });
});

test("opens only the selected parent's accessible detail dialog and restores focus", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    assert.equal(await page.getByRole("dialog").count(), 0);
    const firstButton = page.getByRole("button", { name: "查看全部 4 个子体与月度趋势" });
    await firstButton.click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.count(), 1);
    assert.match(await dialog.textContent() ?? "", /B000000010/);
    assert.match(await dialog.textContent() ?? "", /5,900/);
    assert.doesNotMatch(await dialog.textContent() ?? "", /1,800/);
    assert.equal(await dialog.locator("[data-order-month]").count(), 12);
    assert.equal(await dialog.locator("[data-order-asin='B000000001']").first().getAttribute("data-order-color"), await dialog.locator("[data-order-asin='B000000001']").last().getAttribute("data-order-color"));
    const plottedHeights = await dialog.locator(".xydc-order-month-bar").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.ok(plottedHeights[3]! > plottedHeights[8]!, `December ${plottedHeights[3]} should exceed May ${plottedHeights[8]}`);
    await page.getByLabel("订单明细排序").selectOption("asin");
    assert.equal(await dialog.locator("[data-order-asin='B000000001']").first().getAttribute("data-order-color"), await dialog.locator("[data-order-asin='B000000001']").last().getAttribute("data-order-color"));
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "关闭订单明细" }).evaluate(element => element === document.activeElement), true);
    const screenshot = join(process.cwd(), "test-results", "xydc-orders-dialog.png");
    await page.screenshot({ path: screenshot });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await firstButton.evaluate(element => element === document.activeElement), true);

    await firstButton.click();
    await page.evaluate(() => (window as typeof window & { replaceXydcFixture(): void }).replaceXydcFixture());
    await page.locator("[data-parent-asin='B000000010']").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0);

    await page.getByRole("button", { name: "查看全部 2 个子体与月度趋势" }).click();
    assert.match(await dialog.textContent() ?? "", /B000000020/);
    assert.match(await dialog.textContent() ?? "", /1,800/);
    assert.doesNotMatch(await dialog.textContent() ?? "", /5,900/);
    await page.getByRole("button", { name: "关闭订单明细" }).click();
    assert.equal(await page.getByRole("dialog").count(), 0);

    await page.getByRole("button", { name: "查看全部 3 个子体与月度趋势" }).click();
    assert.ok(await dialog.locator(".xydc-order-month-gap").count() > 0);
    assert.equal(await dialog.locator("[data-order-month]").count(), 12);
    await page.getByRole("button", { name: "关闭订单明细" }).click();
  });
});
