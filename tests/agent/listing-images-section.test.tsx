import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createViteServer } from "vite";

import { ListingImagesSection } from "../../app/listing-images-section";
import { amazonMediaSrc } from "../../app/lib/amazon-image";
import type { SorftimeListingContentRecord } from "../../app/sorftime-listing-content-data";

const market = { label: "美国站", domain: "amazon.com" };
const colors = ["#123456"];
const fixtureAsin = "B07VY9Q95Q";
const sorftimeMainImage = "https://m.media-amazon.com/images/I/81sHDISn2bL.jpg";
const sorftimeSecondaryImage = "https://m.media-amazon.com/images/I/81f6K8vA1LL.jpg";
const sellerSpriteCatalogImage = "https://m.media-amazon.com/images/I/712PF4pUZ9L._AC_SL1500_.jpg";
const persistedZoomImage = "https://m.media-amazon.com/images/I/81sHDISn2bL._AC_SR600,600_.jpg";
const normalizedPersistedZoomImage = "https://m.media-amazon.com/images/I/81sHDISn2bL._AC_US600_.jpg";

function listingFixture(overrides: Partial<SorftimeListingContentRecord> = {}): SorftimeListingContentRecord {
  return {
    asin: fixtureAsin,
    marketplace: "US",
    fetchedAt: "2026-08-11",
    status: "ready",
    mainImage: sorftimeMainImage,
    galleryImages: [sorftimeMainImage, sorftimeSecondaryImage],
    secondaryImages: [sorftimeSecondaryImage],
    imageCount: 2,
    hasAplus: true,
    hasEbc: true,
    hasVideo: false,
    lqs: 100,
    ...overrides,
  };
}

type ListingImagesProps = ComponentProps<typeof ListingImagesSection> & {
  listingByAsin: Readonly<Record<string, SorftimeListingContentRecord>>;
  resolveImageRemark: (asin: string, slotIndex: number) => ReturnType<NonNullable<ComponentProps<typeof ListingImagesSection>["resolveImageRemark"]>>;
};

function renderListingImages(
  product: { asin: string; brand: string; image: string },
  listing: SorftimeListingContentRecord,
  resolveImageOutcome: (asin: string, slotIndex: number) => {
    status: "ready" | "upstream-empty" | "timeout" | "connector-failed";
    reason: string;
  } | null = () => null,
  resolveImageRemark: ListingImagesProps["resolveImageRemark"] = () => null,
) {
  const props: ListingImagesProps & { resolveImageOutcome: typeof resolveImageOutcome } = {
    products: [product],
    market,
    colors,
    listingByAsin: { [product.asin]: listing },
    resolveImageRemark,
    resolveImageOutcome,
  };
  return renderToStaticMarkup(createElement(ListingImagesSection, props));
}

function galleryImageSources(html: string) {
  return [...html.matchAll(/<button[^>]*class="listing-image-frame[^>]*><img src="([^"]+)"/g)].map(match => match[1]!);
}

function productHeaderImageSource(html: string) {
  return html.match(/<img class="listing-images-asin-thumb" src="([^"]+)"/)?.[1] ?? null;
}

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

function browserFixtureEntry() {
  const listing = listingFixture({
    mainImage: persistedZoomImage,
    galleryImages: [persistedZoomImage],
    secondaryImages: [persistedZoomImage],
  });
  return `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ListingImagesSection } from "/app/listing-images-section.tsx";

const product = ${JSON.stringify({ asin: fixtureAsin, brand: "Fixture brand", image: persistedZoomImage })};
const listing = ${JSON.stringify(listing)};
createRoot(document.getElementById("root")).render(createElement(ListingImagesSection, {
  products: [product],
  market: ${JSON.stringify(market)},
  colors: ${JSON.stringify(colors)},
  listingByAsin: { [product.asin]: listing },
  resolveImageRemark: () => null,
}));
`;
}

async function startBrowserFixtureServer() {
  const entry = browserFixtureEntry();
  const server = await createViteServer({
    configFile: false,
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "listing-images-section-browser-fixture",
      resolveId(id) {
        return id === "/__listing-images-test-entry.tsx" ? "\0listing-images-test-entry" : undefined;
      },
      load(id) {
        return id === "\0listing-images-test-entry" ? entry : undefined;
      },
      configureServer(viteServer) {
        viteServer.middlewares.use((request, response, next) => {
          if (request.url === "/__listing-images-test.html") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html");
            response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/__listing-images-test-entry.tsx"></script></body></html>');
            return;
          }
          next();
        });
      },
    }],
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

function isLoopbackHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
}

test("persisted Amazon gallery, product-header, and preview sources stay direct normalized CDN URLs", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: persistedZoomImage },
    listingFixture({
      mainImage: persistedZoomImage,
      galleryImages: [persistedZoomImage],
      secondaryImages: [persistedZoomImage],
    }),
  );
  const gallerySources = galleryImageSources(html);
  const previewSource = amazonMediaSrc(persistedZoomImage);

  assert.equal(productHeaderImageSource(html), normalizedPersistedZoomImage);
  assert.deepEqual(gallerySources, [normalizedPersistedZoomImage]);
  assert.equal(previewSource, normalizedPersistedZoomImage);
  assert.equal(amazonMediaSrc(persistedZoomImage.replace("https://", "http://")), "");
  for (const source of [productHeaderImageSource(html), ...gallerySources, previewSource]) {
    assert.ok(source?.startsWith("https://"));
    assert.doesNotMatch(source ?? "", /\/api\/amazon-image/);
  }
});

test("injected Sorftime gallery stays visible without AI remarks and takes priority over the catalog MCP image", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: sellerSpriteCatalogImage },
    listingFixture(),
  );

  assert.deepEqual(galleryImageSources(html), [sorftimeMainImage, sorftimeSecondaryImage].map(amazonMediaSrc));
  assert.equal(galleryImageSources(html).includes(amazonMediaSrc(sellerSpriteCatalogImage)), false);
  assert.match(html, /Sorftime MCP · Provider 返回 2 张 · AI 备注 0\/2 张/);
  assert.match(html, /分析待处理/);
  assert.match(html, /尚无图片分析结果/);
});

test("Sorftime gallery reports the exact count of ready AI remarks", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: sellerSpriteCatalogImage },
    listingFixture(),
    () => null,
    (_asin, slotIndex) => slotIndex === 0
      ? { image_types: ["主图"], remark: "清晰展示产品" }
      : null,
  );

  assert.match(html, /Sorftime MCP · Provider 返回 2 张 · AI 备注 1\/2 张/);
  assert.match(html, /清晰展示产品/);
});

test("missing remarks display their fixed per-slot outcome reason", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: sellerSpriteCatalogImage },
    listingFixture(),
    (_asin, slotIndex) => slotIndex === 1
      ? { status: "timeout", reason: "图片分析超过 120 秒" }
      : { status: "connector-failed", reason: "图片分析连接器失败" },
  );

  assert.match(html, /主图 · 图片分析连接器失败/);
  assert.match(html, /辅图 · 图片分析超过 120 秒/);
  assert.doesNotMatch(html, /AI 备注待后续分析/);
});

test("injected catalog MCP fallback renders with SellerSprite provenance and a non-empty state", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: sellerSpriteCatalogImage },
    listingFixture({
      mainImage: null,
      galleryImages: [],
      secondaryImages: [],
      imageCount: 0,
      hasAplus: false,
    }),
  );

  assert.deepEqual(galleryImageSources(html), [amazonMediaSrc(sellerSpriteCatalogImage)]);
  assert.match(html, /SellerSprite MCP · 商品图 1 张/);
  assert.doesNotMatch(html, /图册已从 Sorftime 拉回/);
  assert.match(html, /尚无图片分析结果/);
});

test("injected empty MCP sources render a truthful no-image state without claiming a pull succeeded", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: "" },
    listingFixture({
      status: "empty",
      mainImage: null,
      galleryImages: [],
      secondaryImages: [],
      imageCount: 0,
      hasAplus: null,
    }),
  );

  assert.deepEqual(galleryImageSources(html), []);
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /MCP 暂未返回商品图/);
  assert.match(html, /upstream-empty/);
  assert.doesNotMatch(html, /已从.+拉回/);
});

test("interactive hover and pinned previews render direct normalized HTTPS CDN sources", async () => {
  let fixture: Awaited<ReturnType<typeof startBrowserFixtureServer>> | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const blockedExternalRequests: string[] = [];
  try {
    fixture = await startBrowserFixtureServer();
    browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
    page = await browser.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("requestfailed", request => failedRequests.push(`${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
    await page.route("**/*", async route => {
      const requestUrl = route.request().url();
      if (!isLoopbackHttpUrl(requestUrl)) {
        blockedExternalRequests.push(requestUrl);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/__listing-images-test.html`);
    const frame = page.locator(".listing-image-frame").first();
    await frame.waitFor({ timeout: 5_000 }).catch(async error => {
      throw new Error(`${error instanceof Error ? error.message : "listing frame did not render"}; pageErrors=${JSON.stringify(pageErrors)}; failedRequests=${JSON.stringify(failedRequests)}; html=${(await page.content()).slice(0, 1_000)}`);
    });

    await frame.hover();
    const hoverPreview = page.locator(".listing-image-hover-float img");
    await hoverPreview.waitFor({ state: "attached" });
    const hoverSource = await hoverPreview.getAttribute("src");
    assert.equal(hoverSource, normalizedPersistedZoomImage);
    assert.match(hoverSource ?? "", /^https:\/\//);
    assert.doesNotMatch(hoverSource ?? "", /\/api\/amazon-image/);

    await frame.click();
    const pinnedPreview = page.locator(".listing-image-focus-body img");
    await pinnedPreview.waitFor({ state: "attached" });
    const pinnedSource = await pinnedPreview.getAttribute("src");
    assert.equal(pinnedSource, normalizedPersistedZoomImage);
    assert.match(pinnedSource ?? "", /^https:\/\//);
    assert.doesNotMatch(pinnedSource ?? "", /\/api\/amazon-image/);
    await page.waitForTimeout(100);
    assert.ok(
      blockedExternalRequests.some(requestUrl => requestUrl.startsWith("https://m.media-amazon.com/")),
      `expected Amazon CDN request to be intercepted, got ${JSON.stringify(blockedExternalRequests)}`,
    );
    assert.ok(
      blockedExternalRequests.every(requestUrl => !isLoopbackHttpUrl(requestUrl)),
      `all intercepted HTTP(S) requests must be non-loopback: ${JSON.stringify(blockedExternalRequests)}`,
    );
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await fixture?.server.close().catch(() => undefined);
  }
});
