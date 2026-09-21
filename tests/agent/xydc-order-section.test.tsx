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
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
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
  missing = {},
}: {
  parentAsin?: string;
  childAsins?: string[];
  values?: number[][];
  cacheState?: XydcOrderSnapshot["cacheState"];
  reasonCode?: XydcOrderReason | null;
  sourceUpdatedAt?: string | null;
  missing?: Readonly<Record<string, readonly string[]>>;
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
      trends: (values[index] ?? [])
        .map((orders, monthIndex) => ({ date: months[monthIndex]!, orders }))
        .filter(trend => !missing[asin]?.includes(trend.date)),
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
  assert.match(html, /title="砂黑色 · 原属性：Sand Black[^"\n]*67\.80%"/);
  assert.match(html, /19\.49%/);
  assert.match(html, /11\.02%/);
  assert.match(html, /查看全部 4 个子体与月度趋势/);
  assert.equal((html.match(/data-order-preview-row=/g) ?? []).length, 3);
  assert.match(html, /输入 ASIN/);
  assert.match(html, /4\/4 个子体返回/);
  assert.match(html, /12\/12 月/);
  assert.doesNotMatch(html, /近30天|评论占比|独立评论数/);

  const link = html.match(/<a[^>]+href="https:\/\/www\.amazon\.com\/dp\/B000000001"[^>]*>/)?.[0] ?? "";
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
});

test("labels every matched input ASIN in input order even when one is outside the annual top three", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  const inputOrder = ["B000000002", "B000000004"];
  const html = renderSection(
    inputOrder.map(asin => familyFixture("B000000010", asin)),
    [orderFixture()],
    inputOrder.map((asin, index) => ({ asin, brand: `INPUT ${index + 1}`, title: `Input ${index + 1}`, image: fixtureImage })),
  );

  assert.ok(html.indexOf(`data-order-input-asin="${inputOrder[0]}"`) < html.indexOf(`data-order-input-asin="${inputOrder[1]}"`));
  assert.match(html, /data-order-input-asin="B000000004"/);
  assert.doesNotMatch(html, /data-order-preview-row="B000000004"/);
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
  const staleFamily = { ...familyFixture("B000000040", "B000000009", ["B000000009"]), cacheState: "stale" as const };
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
  assert.match(html, /缓存数据 · 待更新/);
  assert.match(html, /变体缓存数据/);
  assert.doesNotMatch(html, /近30天/);
});

test("renders complete historical cache against its actual period while the default current period remains pending", t => {
  const currentNow = new Date("2026-10-09T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: currentNow });
  const oldComplete = orderFixture();
  const requested = getXydcOrderWindow(currentNow);
  const currentPartial: XydcOrderSnapshot = {
    ...oldComplete,
    window: requested,
    children: [],
    fetchedAt: "2026-10-09T11:00:00.000Z",
    cacheState: "fresh",
    reasonCode: "PARTIAL_DATA",
  };
  const html = renderSection([familyFixture()], [currentPartial, oldComplete]);

  assert.match(html, /默认统计窗口 · 2025-10 — 2026-09/);
  assert.match(html, /统计窗口：2025-09 — 2026-08/);
  assert.match(html, /历史缓存 · 当前统计区间待补齐/);
  assert.match(html, /5,900\+/);
  assert.doesNotMatch(html, /部分订单数据不可用/);

  const currentComplete: XydcOrderSnapshot = {
    ...currentPartial,
    children: oldComplete.children.map(child => ({
      ...child,
      trends: requested.months.map(date => ({ date, orders: 1 })),
      fetchedAt: "2026-10-09T11:00:00.000Z",
      reasonCode: null,
    })),
    reasonCode: null,
  };
  const refreshedHtml = renderSection([familyFixture()], [oldComplete, currentComplete]);
  assert.match(refreshedHtml, /统计窗口：2025-10 — 2026-09/);
  assert.match(refreshedHtml, />48\+</);
  assert.doesNotMatch(refreshedHtml, /5,900\+|历史缓存/);

  const changedFamily = familyFixture("B000000010", "B000000001", primaryAsins.slice(0, 3));
  const changedHtml = renderSection([changedFamily], [oldComplete]);
  assert.match(changedHtml, /订单数据待采集/);
  assert.doesNotMatch(changedHtml, /5,900\+|历史缓存/);
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
  const zeroAsins = ["B000000011", "B000000012"];
  const pendingAsins = ["B000000013", "B000000014"];
  const families = [
    familyFixture(),
    familyFixture("B000000020", "B000000005", secondAsins),
    familyFixture("B000000030", "B000000007", partialAsins),
    familyFixture("B000000040", "B000000011", zeroAsins),
    familyFixture("B000000050", "B000000013", pendingAsins),
  ];
  const mixedValues = [
    [1, 0, ...months.slice(2).map(() => 80)],
    [0, 0, ...months.slice(2).map(() => 40)],
    [0, 0, ...months.slice(2).map(() => 20)],
  ];
  const orders = [
    orderFixture(),
    orderFixture({ parentAsin: "B000000020", childAsins: secondAsins, values: [months.map(() => 100), months.map(() => 50)] }),
    orderFixture({
      parentAsin: "B000000030",
      childAsins: partialAsins,
      values: mixedValues,
      missing: {
        B000000007: [months[2]!],
        B000000008: [months[2]!],
        B000000009: [months[0]!, months[2]!],
      },
      reasonCode: "PARTIAL_DATA",
    }),
    orderFixture({ parentAsin: "B000000040", childAsins: zeroAsins, values: zeroAsins.map(() => months.map(() => 0)), cacheState: "stale" }),
  ];
  const fixtureProps = { products, families, orderFamilies: orders, market };
  const historicalWindow = getXydcOrderWindow(new Date("2026-08-08T12:00:00.000Z"));
  const historicalFirst = {
    ...orders[0]!,
    window: historicalWindow,
    children: orders[0]!.children.map(child => ({
      ...child,
      trends: child.trends.map((trend, index) => ({ ...trend, date: historicalWindow.months[index]! })),
    })),
  };
  const historicalFixtureProps = { products, families, orderFamilies: [historicalFirst, ...orders.slice(1)], market };
  const updatedFixtureProps = {
    products: products.map((product, index) => index === 0 ? { ...product, brand: "LEPOWER UPDATED" } : product),
    families,
    orderFamilies: orders.map((snapshot, snapshotIndex) => snapshotIndex === 0 ? {
      ...snapshot,
      children: snapshot.children.map((child, childIndex) => childIndex === 0 ? {
        ...child,
        trends: child.trends.map((trend, trendIndex) => trendIndex === 0 ? { ...trend, orders: trend.orders + 1 } : trend),
      } : child),
    } : snapshot),
    market,
  };
  const reorderedFixtureProps = {
    products,
    families: families.map((family, index) => index === 0 ? { ...family, children: [...family.children].reverse() } : family),
    orderFamilies: orders.map((snapshot, index) => index === 0 ? { ...snapshot, childAsins: [...snapshot.childAsins].reverse(), children: [...snapshot.children].reverse() } : snapshot),
    market,
  };
  const changedChildSetFixtureProps = {
    products,
    families: families.map((family, index) => index === 0 ? { ...family, children: family.children.slice(0, 3) } : family),
    orderFamilies: orders.map((snapshot, index) => index === 0 ? { ...snapshot, childAsins: snapshot.childAsins.slice(0, 3), children: snapshot.children.slice(0, 3) } : snapshot),
    market,
  };
  const withoutFirstFixtureProps = { products: products.slice(1), families: families.slice(1), orderFamilies: orders.slice(1), market };
  const serverMarkup = renderToStaticMarkup(createElement(XydcVariantSection, fixtureProps));
  const entry = `
import { createElement } from "react";
import { flushSync } from "react-dom";
import { hydrateRoot } from "react-dom/client";
import { XydcVariantSection } from "/app/xydc-variant-section.tsx";
const root = hydrateRoot(document.getElementById("root"), createElement(XydcVariantSection, ${JSON.stringify(fixtureProps)}));
window.rerenderEquivalentXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(fixtureProps)}));
window.rerenderUpdatedXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(updatedFixtureProps)}));
window.rerenderReorderedXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(reorderedFixtureProps)}));
window.rerenderChangedChildSetXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(changedChildSetFixtureProps)}));
window.rerenderHistoricalXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(historicalFixtureProps)}));
window.removeFirstXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(withoutFirstFixtureProps)}));
window.commitRemoveRestoreAndClickFirstAnnual = async (label) => {
  const findTrigger = () => [...document.querySelectorAll('[data-parent-asin="B000000010"] .xydc-order-legend button')]
    .find(element => element.getAttribute('aria-label') === label);
  const oldTrigger = findTrigger();
  flushSync(() => root.render(createElement(XydcVariantSection, ${JSON.stringify(withoutFirstFixtureProps)})));
  const absentCommitted = document.querySelector('[data-parent-asin="B000000010"]') === null;
  flushSync(() => root.render(createElement(XydcVariantSection, ${JSON.stringify(fixtureProps)})));
  const replacementTrigger = findTrigger();
  const result = {
    absentCommitted,
    oldTriggerDisconnected: Boolean(oldTrigger && !oldTrigger.isConnected),
    replacementIsNew: Boolean(replacementTrigger && replacementTrigger !== oldTrigger),
    expandedBeforeClick: replacementTrigger?.getAttribute('aria-expanded') ?? null,
    regionBeforeClick: Boolean(document.querySelector('.xydc-annual-inspection')),
  };
  replacementTrigger?.click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  return {
    ...result,
    expandedAfterCleanup: replacementTrigger?.getAttribute('aria-expanded') ?? null,
    regionAfterCleanup: Boolean(document.querySelector('.xydc-annual-inspection')),
  };
};
window.removeFirstAndOpenSecondXydcFixture = () => {
  flushSync(() => root.render(createElement(XydcVariantSection, ${JSON.stringify({ products: products.slice(1), families: families.slice(1), orderFamilies: orders.slice(1), market })})));
  document.querySelector('[data-parent-asin="B000000020"] .xydc-order-open-detail').click();
};
window.restoreXydcFixture = () => root.render(createElement(XydcVariantSection, ${JSON.stringify(fixtureProps)}));`;
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

async function withFixture(
  run: (page: Page) => Promise<void>,
  viewport = { width: 1440, height: 1100 },
  options: Readonly<{ hasTouch?: boolean }> = {},
) {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const forbiddenRequests: string[] = [];
  try {
    const fixture = await startBrowserFixtureServer();
    server = fixture.server;
    browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
    page = await browser.newPage({ viewport, hasTouch: options.hasTouch ?? false });
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
    assert.equal(await cards.count(), 5);
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

test("historical detail and annual inspection show the actual source period and pending-current lifecycle", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    await page.evaluate(() => (window as typeof window & { rerenderHistoricalXydcFixture(): void }).rerenderHistoricalXydcFixture());
    const card = page.locator("[data-parent-asin='B000000010']");
    await card.getByText("历史缓存 · 当前统计区间待补齐").waitFor();
    await card.getByRole("button", { name: "查看全部 4 个子体与月度趋势" }).click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.textContent() ?? "", /2025-08 — 2026-07/);
    assert.match(await dialog.textContent() ?? "", /12个月订单量：5,900\+/);
    assert.match(await dialog.textContent() ?? "", /历史缓存 · 当前统计区间待补齐/);

    const annualTrigger = dialog.getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    await annualTrigger.hover();
    const inspection = page.locator(".xydc-annual-inspection");
    await inspection.waitFor();
    assert.match(await inspection.textContent() ?? "", /2025-08 — 2026-07/);
    assert.match(await inspection.textContent() ?? "", /12个月订单量4,000\+/);
    assert.match(await inspection.textContent() ?? "", /历史缓存 · 当前统计区间待补齐/);
  });
});

test("annual inspection exposes derived annual rows for complete, raw-zero, incomplete, and pending children", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    const completeCard = page.locator("[data-parent-asin='B000000010']");
    const zeroCard = page.locator("[data-parent-asin='B000000040']");
    const partialCard = page.locator("[data-parent-asin='B000000030']");
    const pendingCard = page.locator("[data-parent-asin='B000000050']");
    assert.equal(await completeCard.locator(".xydc-order-legend").getByRole("button").count(), 4);
    assert.equal(await completeCard.locator(".xydc-order-share").getByRole("button").count(), 4);
    assert.equal(await zeroCard.locator(".xydc-order-legend").getByRole("button").count(), 2);
    assert.equal(await partialCard.locator(".xydc-order-legend").getByRole("button").count(), 3);
    assert.equal(await pendingCard.locator(".xydc-order-legend").getByRole("button").count(), 2);

    const completeTrigger = completeCard.locator(".xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    await completeTrigger.hover();
    const completeRegion = page.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    assert.match(await completeRegion.textContent() ?? "", /B000000001/);
    assert.match(await completeRegion.textContent() ?? "", /2025-09 — 2026-08/);
    assert.match(await completeRegion.textContent() ?? "", /12个月订单量\s*4,000\+/);
    assert.match(await completeRegion.textContent() ?? "", /年度份额\s*67\.80%/);
    assert.match(await completeRegion.textContent() ?? "", /缺失 \/ 未披露月份\s*0 \/ 0/);
    assert.doesNotMatch(await completeRegion.textContent() ?? "", /510\+/);
    await page.mouse.move(0, 0);
    await completeRegion.waitFor({ state: "detached" });

    await zeroCard.locator(".xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" }).click();
    const zeroRegion = page.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    assert.match(await zeroRegion.textContent() ?? "", /B000000011/);
    assert.match(await zeroRegion.textContent() ?? "", /12个月订单量\s*未披露/);
    assert.match(await zeroRegion.textContent() ?? "", /年度份额\s*—/);
    assert.match(await zeroRegion.textContent() ?? "", /缺失 \/ 未披露月份\s*0 \/ 12/);
    assert.match(await zeroRegion.textContent() ?? "", /缓存数据 · 待更新/);
    assert.match(await zeroRegion.textContent() ?? "", /2026-09-04T12:34:56\.000Z/);

    await partialCard.locator(".xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" }).click();
    const partialRegion = page.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    assert.match(await partialRegion.textContent() ?? "", /B000000007/);
    assert.match(await partialRegion.textContent() ?? "", /12个月订单量\s*—/);
    assert.match(await partialRegion.textContent() ?? "", /年度份额\s*—/);
    assert.match(await partialRegion.textContent() ?? "", /缺失 \/ 未披露月份\s*1 \/ 1/);

    await pendingCard.locator(".xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" }).click();
    const pendingRegion = page.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    assert.match(await pendingRegion.textContent() ?? "", /B000000013/);
    assert.match(await pendingRegion.textContent() ?? "", /12个月订单量\s*—/);
    assert.match(await pendingRegion.textContent() ?? "", /年度份额\s*—/);
    assert.match(await pendingRegion.textContent() ?? "", /缺失 \/ 未披露月份\s*12 \/ 0/);
    assert.match(await pendingRegion.textContent() ?? "", /订单数据待采集/);
  });
});

test("annual inspection supports preview, pinning, suppression, replacement, and current identity data", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    const card = page.locator("[data-parent-asin='B000000010']");
    const sandBlack = card.locator(".xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    const black = card.locator(".xydc-order-legend").getByRole("button", { name: "查看 黑色 年度订单明细" });
    await sandBlack.hover();
    const region = page.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    await region.hover();
    assert.equal(await region.count(), 1, "moving from trigger into the region keeps the preview open");
    await page.mouse.move(0, 0);
    await region.waitFor({ state: "detached" });

    await sandBlack.focus();
    await region.waitFor();
    await region.getByRole("button", { name: "关闭年度悬浮明细" }).click();
    assert.equal(await sandBlack.evaluate(element => element === document.activeElement), true);
    assert.equal(await region.count(), 0, "explicit close suppresses focus-driven reopening");
    await sandBlack.click();
    await region.waitFor();
    await page.mouse.move(0, 0);
    assert.equal(await region.count(), 1, "pinned inspection survives pointer leave");
    await sandBlack.hover();
    assert.equal(await region.getAttribute("data-pinned"), "true", "hovering the same trigger does not downgrade a pinned inspection");
    await black.click();
    const blackRegion = page.getByRole("region", { name: "黑色 · 年度订单明细" });
    assert.equal(await region.count(), 0);
    assert.match(await blackRegion.textContent() ?? "", /B000000002/);

    await sandBlack.focus();
    await page.keyboard.press("Enter");
    await region.waitFor();
    await page.keyboard.press("Space");
    await region.waitFor({ state: "detached" });
    await page.keyboard.press("Space");
    await region.waitFor();
    await page.evaluate(() => (window as typeof window & { rerenderReorderedXydcFixture(): void }).rerenderReorderedXydcFixture());
    await page.waitForFunction(() => document.querySelector("[role='region']")?.textContent?.includes("4,000+"));
    assert.equal(await region.count(), 1, "reordered equivalent child sets retain the active member");
    await page.evaluate(() => (window as typeof window & { rerenderUpdatedXydcFixture(): void }).rerenderUpdatedXydcFixture());
    await page.waitForFunction(() => document.querySelector("[role='region']")?.textContent?.includes("4,001+"));
    assert.match(await region.textContent() ?? "", /4,001\+/);

    const bodyOverflowBefore = await page.evaluate(() => document.body.style.overflow);
    await page.getByRole("button", { name: "查看全部 4 个子体与月度趋势" }).click();
    assert.equal(await region.count(), 0, "opening detail closes the external annual inspection");
    assert.equal(await page.evaluate(() => document.body.style.overflow), bodyOverflowBefore);
    await page.getByRole("button", { name: "关闭订单明细" }).click();

    await sandBlack.click();
    await region.waitFor();
    await page.evaluate(() => (window as typeof window & { removeFirstXydcFixture(): void }).removeFirstXydcFixture());
    await region.waitFor({ state: "detached" });
  });
});

test("committed identity absence invalidates a disconnected trigger before immediate reintroduction", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    const card = page.locator("[data-parent-asin='B000000010']");
    const trigger = card.locator(".xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    const result = await page.evaluate(() => (window as typeof window & {
      commitRemoveRestoreAndClickFirstAnnual(label: string): Promise<{
        absentCommitted: boolean;
        oldTriggerDisconnected: boolean;
        replacementIsNew: boolean;
        expandedBeforeClick: string | null;
        regionBeforeClick: boolean;
        expandedAfterCleanup: string | null;
        regionAfterCleanup: boolean;
      }>;
    }).commitRemoveRestoreAndClickFirstAnnual("查看 砂黑色 年度订单明细"));
    assert.equal(result.absentCommitted, true);
    assert.equal(result.oldTriggerDisconnected, true);
    assert.equal(result.replacementIsNew, true);
    assert.equal(result.regionBeforeClick, false);
    assert.equal(result.expandedBeforeClick, "false", "replacement trigger has no phantom expanded state");
    assert.equal(result.regionAfterCleanup, true, "first click opens the replacement before old cleanup runs");
    assert.equal(result.expandedAfterCleanup, "true", "old cleanup cannot close the new activation");
    assert.equal(await page.getByRole("region", { name: "砂黑色 · 年度订单明细" }).count(), 1);
  });
});

test("annual inspection stays inside the usable viewport gutter in an expanded mobile dialog", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    await page.addStyleTag({ content: "html { overflow-y: scroll; scrollbar-gutter: stable; }" });
    const initialViewport = await page.evaluate(() => ({
      clientHeight: document.documentElement.clientHeight,
      clientWidth: (() => {
        const usableWidth = document.documentElement.clientWidth - 15;
        Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: usableWidth });
        return document.documentElement.clientWidth;
      })(),
      innerWidth: window.innerWidth,
    }));
    assert.ok(initialViewport.clientWidth < initialViewport.innerWidth, "fixture reserves a non-overlay scrollbar gutter");
    await page.locator("[data-parent-asin='B000000010']").getByRole("button", { name: "查看全部 4 个子体与月度趋势" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "展开年度明细" }).click();
    const trigger = dialog.locator(".xydc-order-dialog-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const region = dialog.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    const box = await region.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= initialViewport.clientWidth && box.y + box.height <= initialViewport.clientHeight);
    assert.ok(Number.parseFloat(await region.evaluate(element => getComputedStyle(element).fontSize)) >= 12);
    assert.match(await region.textContent() ?? "", /B000000001/);
    assert.match(await region.textContent() ?? "", /4,000\+/);
    assert.equal(await region.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.setViewportSize({ width: 390, height: 260 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>("[role='region'][aria-labelledby]");
      if (!element) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0
        && bounds.top >= 0
        && bounds.right <= document.documentElement.clientWidth
        && bounds.bottom <= document.documentElement.clientHeight;
    });
    await page.evaluate(() => window.scrollBy(0, -40));
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>("[role='region'][aria-labelledby]");
      if (!element) return false;
      const bounds = element.getBoundingClientRect();
      return getComputedStyle(element).overflowY === "auto"
        && bounds.left >= 0
        && bounds.top >= 0
        && bounds.right <= document.documentElement.clientWidth
        && bounds.bottom <= document.documentElement.clientHeight;
    });
    assert.equal(await region.evaluate(element => getComputedStyle(element).overflowY), "auto");
    const screenshot = join(process.cwd(), "test-results", "xydc-orders-annual-mobile.png");
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    await page.screenshot({ path: screenshot });
    await t.test("annual mobile screenshot exists", () => assert.ok(existsSync(screenshot)));
    const fixScreenshot = join(process.cwd(), "test-results", "xydc-v2-annual-fix-mobile.png");
    await page.screenshot({ path: fixScreenshot });
    await t.test("annual gutter screenshot exists", () => assert.ok(existsSync(fixScreenshot)));
    await page.mouse.click(2, 2);
    await region.waitFor({ state: "detached" });
  }, { width: 390, height: 300 }, { hasTouch: false });
});

test("annual inspection pins from touch input", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T12:00:00.000Z") });
  await withFixture(async page => {
    const trigger = page.locator("[data-parent-asin='B000000010'] .xydc-order-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    await trigger.tap();
    const region = page.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    assert.equal(await region.getAttribute("data-pinned"), "true");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  }, { width: 390, height: 844 }, { hasTouch: true });
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
    const dialogAnnualTrigger = dialog.locator(".xydc-order-dialog-legend").getByRole("button", { name: "查看 砂黑色 年度订单明细" });
    await dialogAnnualTrigger.click();
    const dialogAnnualRegion = dialog.getByRole("region", { name: "砂黑色 · 年度订单明细" });
    assert.equal(await dialogAnnualRegion.count(), 1, "the annual region remains in the dialog focus scope");
    await page.keyboard.press("Escape");
    assert.equal(await dialogAnnualRegion.count(), 0);
    assert.equal(await dialog.count(), 1, "Escape closes annual inspection before the outer dialog");
    assert.equal(await dialog.getByLabel("订单明细排序").count(), 0);
    const expandAnnualDetail = dialog.getByRole("button", { name: "展开年度明细" });
    assert.equal(await expandAnnualDetail.getAttribute("aria-expanded"), "false");
    await expandAnnualDetail.click();
    assert.equal(await dialog.getByLabel("订单明细排序").count(), 1);
    await page.getByLabel("订单明细排序").selectOption("asin");
    assert.equal(await dialog.locator("[data-order-asin='B000000001']").first().getAttribute("data-order-color"), await dialog.locator("[data-order-asin='B000000001']").last().getAttribute("data-order-color"));
    const closeDetailButton = page.getByRole("button", { name: "关闭订单明细" });
    await closeDetailButton.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press("Tab");
    assert.equal(await closeDetailButton.evaluate(element => element === document.activeElement), true);

    await page.evaluate(() => (window as typeof window & { rerenderEquivalentXydcFixture(): void }).rerenderEquivalentXydcFixture());
    assert.equal(await page.getByRole("dialog").count(), 1, "equivalent new arrays and objects keep the selected parent open");
    assert.match(await dialog.textContent() ?? "", /5,900/);
    assert.equal(await dialog.getByLabel("订单明细排序").inputValue(), "asin");
    await page.evaluate(() => (window as typeof window & { rerenderReorderedXydcFixture(): void }).rerenderReorderedXydcFixture());
    assert.equal(await dialog.getByLabel("订单明细排序").inputValue(), "asin");
    assert.match(await dialog.locator(".xydc-order-detail-table tbody tr").first().textContent() ?? "", /B000000001/);
    await page.evaluate(() => (window as typeof window & { rerenderUpdatedXydcFixture(): void }).rerenderUpdatedXydcFixture());
    assert.equal(await page.getByRole("dialog").count(), 1, "updated current-parent data keeps the selected parent open");
    await page.waitForFunction(() => document.querySelector("[role='dialog']")?.textContent?.includes("LEPOWER UPDATED"));
    await page.waitForFunction(() => document.querySelector("[role='dialog']")?.textContent?.includes("5,901"));
    assert.equal(await dialog.getByLabel("订单明细排序").inputValue(), "asin");
    const collapseAnnualDetail = dialog.getByRole("button", { name: "收起年度明细" });
    await collapseAnnualDetail.click();
    assert.equal(await dialog.getByLabel("订单明细排序").count(), 0);
    const reexpandAnnualDetail = dialog.getByRole("button", { name: "展开年度明细" });
    assert.equal(await reexpandAnnualDetail.evaluate(element => element === document.activeElement), true);
    await reexpandAnnualDetail.click();
    await page.evaluate(() => (window as typeof window & { rerenderChangedChildSetXydcFixture(): void }).rerenderChangedChildSetXydcFixture());
    await page.waitForFunction(() => document.querySelector("[role='dialog']")?.textContent?.includes("3 个子体"));
    assert.equal(await dialog.getByRole("button", { name: "展开年度明细" }).getAttribute("aria-expanded"), "false", "new child-set identity resets annual expansion");
    assert.equal(await dialog.getByLabel("订单明细排序").count(), 0);
    await page.evaluate(() => (window as typeof window & { restoreXydcFixture(): void }).restoreXydcFixture());
    await page.waitForFunction(() => document.querySelector("[role='dialog']")?.textContent?.includes("4 个子体"));

    const screenshot = join(process.cwd(), "test-results", "xydc-orders-dialog.png");
    await page.screenshot({ path: screenshot });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.waitForFunction(element => element === document.activeElement, await firstButton.elementHandle());

    await firstButton.click();
    await page.evaluate(() => (window as typeof window & { removeFirstAndOpenSecondXydcFixture(): void }).removeFirstAndOpenSecondXydcFixture());
    await page.waitForTimeout(20);
    assert.equal(await page.getByRole("dialog").count(), 1, "delayed absent-parent cleanup does not close a newer explicit selection");
    assert.match(await dialog.textContent() ?? "", /B000000020/);
    await page.getByRole("button", { name: "关闭订单明细" }).click();
    await page.evaluate(() => (window as typeof window & { restoreXydcFixture(): void }).restoreXydcFixture());
    await page.locator("[data-parent-asin='B000000010']").waitFor();

    await firstButton.click();
    await page.evaluate(() => (window as typeof window & { removeFirstXydcFixture(): void }).removeFirstXydcFixture());
    await page.locator("[data-parent-asin='B000000010']").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0);

    await page.evaluate(() => (window as typeof window & { restoreXydcFixture(): void }).restoreXydcFixture());
    await page.locator("[data-parent-asin='B000000010']").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "removed and re-added parent stays closed until explicitly reopened");
    await page.getByRole("button", { name: "查看全部 4 个子体与月度趋势" }).click();
    assert.equal(await page.getByRole("dialog").count(), 1);
    const restoredButton = page.getByRole("button", { name: "查看全部 4 个子体与月度趋势" });
    await page.locator(".xydc-order-dialog-backdrop").click({ position: { x: 1, y: 1 } });
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.waitForFunction(element => element === document.activeElement, await restoredButton.elementHandle());

    await page.evaluate(() => (window as typeof window & { removeFirstXydcFixture(): void }).removeFirstXydcFixture());
    await page.locator("[data-parent-asin='B000000010']").waitFor({ state: "detached" });

    await page.locator("[data-parent-asin='B000000020']").getByRole("button", { name: "查看全部 2 个子体与月度趋势" }).click();
    assert.match(await dialog.textContent() ?? "", /B000000020/);
    assert.match(await dialog.textContent() ?? "", /1,800/);
    assert.doesNotMatch(await dialog.textContent() ?? "", /5,900/);
    assert.equal(await dialog.getByLabel("订单明细排序").count(), 0, "a new parent dialog starts collapsed");
    await page.getByRole("button", { name: "关闭订单明细" }).click();
    assert.equal(await page.getByRole("dialog").count(), 0);

    await page.getByRole("button", { name: "查看全部 3 个子体与月度趋势" }).click();
    const smallPositiveMonth = dialog.locator("[data-order-month='2025-09']");
    const smallBarHeight = Number.parseFloat(await smallPositiveMonth.locator(".xydc-order-month-bar").evaluate(element => (element as HTMLElement).style.height));
    assert.ok(smallBarHeight > 0 && smallBarHeight < 4, `small positive month keeps exact ${smallBarHeight}% height`);
    assert.equal(await smallPositiveMonth.locator(".xydc-order-month-bar > [data-order-asin]").count(), 1);
    assert.equal(await smallPositiveMonth.locator(".xydc-order-month-markers .xydc-order-month-undisclosed").count(), 1);
    assert.equal(await smallPositiveMonth.locator(".xydc-order-month-markers .xydc-order-month-gap").count(), 1);
    assert.equal(await smallPositiveMonth.locator(".xydc-order-month-bar > [data-order-asin]").evaluate(element => getComputedStyle(element).flexShrink), "0");
    assert.equal(await dialog.locator("[data-order-month='2025-10'] .xydc-order-month-bar").count(), 0, "all-undisclosed month has no data bar");
    assert.equal(await dialog.locator("[data-order-month='2025-10'] .xydc-order-month-undisclosed").count(), 3);
    assert.equal(await dialog.locator("[data-order-month='2025-11'] .xydc-order-month-bar").count(), 0, "all-missing month has no data bar");
    assert.equal(await dialog.locator("[data-order-month='2025-11'] .xydc-order-month-gap").count(), 3);
    const accessibleMonthlyData = dialog.getByRole("table", { name: "逐月全部子体订单明细" });
    assert.equal(await accessibleMonthlyData.count(), 1);
    assert.deepEqual(await accessibleMonthlyData.getByRole("columnheader").allTextContents(), ["月份", "B000000007", "B000000008", "B000000009"]);
    assert.deepEqual(await accessibleMonthlyData.getByRole("row", { name: /2025-09/ }).getByRole("cell").allTextContents(), ["1 单", "未披露", "缺失"]);
    assert.deepEqual(await accessibleMonthlyData.getByRole("row", { name: /2025-10/ }).getByRole("cell").allTextContents(), ["未披露", "未披露", "未披露"]);
    assert.deepEqual(await accessibleMonthlyData.getByRole("row", { name: /2025-11/ }).getByRole("cell").allTextContents(), ["缺失", "缺失", "缺失"]);
    assert.doesNotMatch(await accessibleMonthlyData.textContent() ?? "", /B000000008 0 单|B000000009 0 单/);
    assert.equal(await dialog.locator("[data-order-month]").count(), 12);
    await page.getByRole("button", { name: "关闭订单明细" }).click();
  });
});
