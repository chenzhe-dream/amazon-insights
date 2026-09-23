import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { refreshedCatalog } from "../../app/competitor-data";

const realVersion = process.env.DISPLAY_REAL_VERSION_FILE
  ? JSON.parse(readFileSync(process.env.DISPLAY_REAL_VERSION_FILE, "utf8"))
  : null;
const organizationId = realVersion?.organizationId ?? "018f1f5c-60f0-4b7a-8000-000000000002";
const projectId = "75a3f965-07e8-468e-aec7-bce265515023";
const runId = "01674bb8-de2b-4e02-a3d7-d73de3c347b3";
const jobId = "ff4f8ade-e1dd-42fd-a62c-4415ec9a5c87";
const asins = ["B07YGQVKDY", "B00BCX842K", "B09JB8CSXX", "B0DPQGFM8Q",
  "B0CRMDJCF4", "B004FM8WY0", "B0GY86VNQ2", "B0CB9LGMQY"];
const gallery = ["51T6x9KgnAL", "81rNtCtAqtL", "71MEAcmFlrL", "61AJEULM03L",
  "61RR4gzbX2L", "6146A+4Xg4L", "519sfB1U+sL.PKplay-button-mb-image-grid-small_"]
  .map(name => `https://m.media-amazon.com/images/I/${name}.jpg`);
const stages = ["keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks"];
const project = { id: projectId, kind: "analysis", slug: "project-us-20", name: "儿童漂移车",
  majorCategory: null, categoryLabel: null, marketplace: "US", asins, note: null, createdBy: null,
  createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" };

function stage(stage: string, data: Record<string, unknown>) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return { stage, stageStatus: "done", projectId, runId, jobId, jobVersion: 1, outputVersion: 1,
    contentHash: createHash("sha256").update(JSON.stringify(canonical({ stage, data }))).digest("hex"), updatedAt: "2026-09-21T03:12:24.141Z", data };
}
const stageOutputs: Record<string, Record<string, unknown>> = Object.fromEntries(stages.map(name => [name,
  { stage: name, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }]));
const catalog = asins.map((asin, index) => ({
  asin, brand: index < 4 ? `核实品牌 ${index + 1}` : null, image: gallery[0],
  title: index < 4 ? `核实商品 ${index + 1}` : `Sorftime 基础商品 ${index + 1}`,
  price: index < 4 ? 99 : null, sales: null, rating: null, reviews: null, rank: null, subRank: null,
  rankCategory: "—", subRankCategory: "—", buyBoxSeller: "—", fulfillment: "—",
  packageSize: "—", packageWeight: "—", specifications: [], launch: "—", format: "—", variants: "—",
  history: [], prices: [], ranks: [], variantShare: [], variantDetails: [], sellingPoints: [], strengths: [],
  weaknesses: [], unmet: [], scenarios: [], audiences: [], keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 },
  catalogSource: index < 4 ? "sellerSprite" : "sorftime-fallback", synced: index < 4,
}));
stageOutputs.listing = stage("listing", { contentByAsin: { B07YGQVKDY: {
  asin: "B07YGQVKDY", status: "ready", fetchedAt: "2026-09-18", mainImage: gallery[0],
  galleryImages: gallery, secondaryImages: gallery.slice(1), imageCount: 7,
} } });
stageOutputs.image_remarks = stage("image_remarks", { remarksByAsin: {
  B07YGQVKDY: gallery.map((_, index) => ({ remark: `核实图片备注 ${index + 1}`, confidence: "high", image_types: [] })),
}, outcomesByAsin: {} });
const version = realVersion ?? { versionId: "12345678-1234-4234-8234-123456789abc", organizationId, projectId,
  runId, jobId, marketplace: "US", asins, catalog, stageOutputs,
  gaps: asins.slice(4).map(asin => ({ asin, field: "catalog.sellerSprite", reasonCode: "UPSTREAM_EMPTY" })),
  catalogEvidence: { sourceKind: "generated-file", sourceRef: "app/competitor-data.ts#refreshedCatalog",
    sourceSha256: "c".repeat(64), sourceUpdatedAt: "2026-09-23T05:44:00.000Z",
    capturedAt: "2026-09-23T06:00:00.000Z", sourceJobId: "6eea1111-1111-4111-8111-111111111111" },
  contentHash: "b".repeat(64), sourceCompletedAt: "2026-09-21T03:12:47.080Z",
  publishedAt: "2026-09-23T05:00:00.000Z" };

test("saved report reads never fall back to generated data; first analysis still shows scoped live results", async t => {
  const reservation = createTcpServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== "string");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const server = await createServer({ configFile: false, define: { "process.env": "{}" },
    cacheDir: path.resolve("node_modules/.cache/report-read", String(process.pid)),
    plugins: [{ name: "fixture-css", enforce: "pre", load(id) {
      if (id.endsWith("/app/globals.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', "");
    } }, react()], server: { host: "127.0.0.1", port: reserved.port, strictPort: true } });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (realVersion) await page.addInitScript(value => { window.__fixtureOrganizationId = value; }, organizationId);
  const pageErrors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let mode: "waiting" | "success" | "failure" | "absent" = "waiting";
  let exposeJob = false;
  let jobStatus = "completed";
  const staleImage = "https://m.media-amazon.com/images/I/STALE-CATALOG.jpg";
  const staleProduct = { ...refreshedCatalog[0], asin: asins[0], brand: "旧目录占位", image: staleImage };
  const stageReads: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let releaseHistoricalPointer!: () => void;
  const historicalPointerGate = new Promise<void>(resolve => { releaseHistoricalPointer = resolve; });
  let historicalPointerPending = true;
  await page.route("**/*", async route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    const html = readFileSync("tests/agent/helpers/primary-admin-browser-harness.html", "utf8")
      .replace("primary-admin-browser-harness.tsx", "project-display-version-browser-harness.ts");
    return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml(new URL(route.request().url()).pathname, html) });
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") writes.push(`${request.method()} ${endpoint}`);
    if (endpoint === "/api/amazon-image") {
      if (realVersion) {
        const response = await fetch(`http://127.0.0.1:31900${url.pathname}${url.search}`);
        return route.fulfill({ status: response.status,
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          body: Buffer.from(await response.arrayBuffer()) });
      }
      const index = Math.max(0, gallery.indexOf(url.searchParams.get("u") ?? ""));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="hsl(${index * 42 + 180} 45% 82%)"/><text x="160" y="130" text-anchor="middle" font-size="48">${index + 1}</text></svg>`;
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
    }
    if (endpoint === `/api/agent/v1/local-data/projects/${project.slug}` || endpoint === `/api/agent/v1/local-data/projects/${projectId}`)
      return reply({ project });
    if (endpoint === `/api/agent/v1/projects/${projectId}`) {
      if (historicalPointerPending) await historicalPointerGate;
      return reply({ project: { ...project, organizationId, currentRunId: exposeJob ? runId : null } });
    }
    if (endpoint === `/api/agent/v1/runs/${runId}`)
      return reply({ run: { id: runId, projectId, idempotencyKey: jobId } });
    if (endpoint === `/api/agent/v1/local-data/projects/${projectId}/current-sync-job`)
      return exposeJob ? reply({ jobId, runId }) : reply({}, 404);
    if (endpoint === `/api/agent/v1/local-data/projects/${projectId}/current-display-version`) {
      if (mode === "waiting") await gate;
      return mode === "failure" ? reply({ error: "unavailable" }, 503)
        : mode === "absent" ? reply({ error: "not found" }, 404) : reply(version);
    }
    if (endpoint === `/api/agent/v1/local-data/sync-asins/${jobId}`)
      return reply({ jobId, jobVersion: 1, asins, marketplace: "US", status: jobStatus, message: "fixture job",
        currentStageId: "image_remarks", asinProgress: {}, scope: { projectId, runId }, stages: ["listing", "image_remarks"].map(id => ({
          id, label: id, kind: "auto", status: "done", estimatedSeconds: 1,
        })) });
    const stageMatch = endpoint.match(new RegExp(`/projects/${projectId}/runs/${runId}/sync-jobs/${jobId}/stages/(listing|image_remarks)/output$`));
    if (stageMatch) {
      stageReads.push(stageMatch[1]);
      return reply(stageOutputs[stageMatch[1]]);
    }
    if (endpoint === "/api/catalog") return reply({ items: [staleProduct] });
    if (endpoint === "/api/runtime-analysis-data") return reply({ catalog: [staleProduct], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
      reviews: { analysisByAsin: {}, ratingByAsin: {} }, salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} },
      listing: { contentByAsin: { [asins[0]]: { asin: asins[0], status: "ready", mainImage: staleImage, galleryImages: [staleImage] } } },
      category: { trendByNode: {} }, childSales: { rowsByAsin: {} },
      priceStrategy: { strategyByAsin: {} }, imageRemarks: { remarksByAsin: { [asins[0]]: [{ remark: "旧生成文件备注", image_types: [], confidence: "high" }] }, outcomesByAsin: {} } });
    if (endpoint === "/api/projects" || endpoint === "/api/agent/v1/local-data/projects") return reply({ projects: [project] });
    if (endpoint.endsWith("/project-favorites")) return reply({ projectIds: [projectId] });
    return reply({ error: "fixture endpoint unavailable" }, 404);
  });
  const screenshotRoot = process.env.DISPLAY_SCREENSHOT_ROOT;
  if (screenshotRoot) mkdirSync(screenshotRoot, { recursive: true });
  const capture = async (name: string) => {
    if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, `${name}.png`) });
  };
  await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview-images`, { waitUntil: "domcontentloaded" });
  await page.getByText("正在读取项目当前报告…", { exact: true }).waitFor({ timeout: 15_000 }).catch(async error => {
    throw new Error(`Waiting notice did not render: ${pageErrors.join("; ")}\n${(await page.locator("body").innerText()).slice(0, 1200)}`, { cause: error });
  });
  await capture("waiting");
  assert.ok((await page.locator("body").innerText()).length > 0, `Waiting page did not render: ${pageErrors.join("; ")}`);
  mode = "success";
  release();
  await page.locator('tr:has-text("B07YGQVKDY")').getByText(/Provider 返回 7 张（含 1 个视频位缩略图） · AI 备注 7\/7 张/).waitFor({ timeout: 20_000 })
    .catch(async error => { throw new Error(`Current version did not render: ${pageErrors.join("; ")}\n${(await page.locator("body").innerText()).slice(0, 2200)}`, { cause: error }); });
  await page.getByText("4 个 ASIN 目录未验证（上游空值）").waitFor();
  await page.getByText(realVersion ? /来源任务 6eea5873/ : /来源任务 6eea1111/).waitFor();
  assert.equal(await page.locator('tr:has-text("B07YGQVKDY") .listing-image-frame').count(), 7);
  if (realVersion) {
    assert.equal(await page.locator(".listing-image-frame").count(), 53);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".listing-image-frame img")]
      .filter(image => image.complete && image.naturalWidth > 0).length >= 52, undefined, { timeout: 30_000 });
    if (screenshotRoot) await page.locator('tr:has-text("B07YGQVKDY")').screenshot({
      path: path.join(screenshotRoot, "b07-real-gallery.png"), timeout: 30_000,
    });
  }
  await capture("success");
  historicalPointerPending = false;
  releaseHistoricalPointer();
  mode = "failure";
  await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview-images`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await capture("failure");
  assert.ok((await page.locator("body").innerText()).includes("当前报告读取失败"),
    `failure notice missing: ${(await page.locator("body").innerText()).slice(0, 600)}`);
  assert.equal(await page.locator(".listing-image-frame").count(), 0);
  mode = "absent";
  await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview-images`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  assert.equal(await page.locator(".listing-image-frame").count(), 0, "404 must not restore a catalog main image or generated gallery");
  const missingGalleryText = await page.locator(".listing-images-card").innerText();
  assert.ok(!missingGalleryText.includes("upstream-empty"), "missing report is not evidence of an upstream collection gap");
  assert.ok(!missingGalleryText.includes("Listing 数据采集于"), "missing report must not display a generated file's collection date");
  assert.ok((await page.locator(".comparison-context").innerText()).includes("暂无分析报告"), "missing report must not keep an old catalog date in the page context");
  assert.ok((await page.locator(".sync-status").innerText()).includes("暂无分析报告"), "missing report cannot claim normal data availability");
  await page.getByText("当前项目暂无可读取的分析报告", { exact: false }).waitFor({ timeout: 10_000 });
  assert.ok(!(await page.locator("body").innerText()).includes("旧生成文件备注"));
  await capture("unpublished");
  await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview`, { waitUntil: "domcontentloaded" });
  await page.getByText("当前项目暂无可读取的分析报告", { exact: false }).waitFor();
  assert.equal(await page.locator(".compare-product-head img").count(), 0,
    "a missing report must not show generated listing main images in other report tabs");
  exposeJob = true;
  const openImages = () => page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "overview-images");
    window.navigateAuthenticatedApp?.(`${url.pathname}${url.search}`);
  });
  for (const status of ["completed", "failed"]) {
    jobStatus = status;
    const oldStageResponse = page.waitForResponse(response => response.url().endsWith("/stages/listing/output"));
    await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview`, { waitUntil: "domcontentloaded" });
    await oldStageResponse;
    await openImages();
    await page.getByText("当前项目暂无可读取的分析报告", { exact: false }).waitFor();
    await page.waitForTimeout(500);
    assert.ok(stageReads.includes("listing"), "fixture must actually return old scoped stage data");
    assert.equal(await page.locator(".listing-image-frame").count(), 0, `a ${status} historical job cannot substitute for a missing current report`);
  }
  jobStatus = "running";
  await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview`, { waitUntil: "domcontentloaded" });
  await page.getByText("分析进行中，以下为本次任务已返回的结果", { exact: false }).waitFor({ timeout: 15_000 });
  await openImages();
  await page.getByText(/Provider 返回 7 张.*AI 备注 7\/7 张/).waitFor();
  assert.equal(await page.locator('tr:has-text("B07YGQVKDY") .listing-image-frame').count(), 7);
  assert.ok(!(await page.locator("body").innerText()).includes("旧生成文件备注"));
  await capture("first-analysis");
  // Derived collections have a separate source-project flow; this fix is scoped
  // to saved analysis reports and must not change their existing read contract.
  project.kind = "keyword-compare";
  exposeJob = false;
  await page.goto(`http://127.0.0.1:${reserved.port}/p/${project.slug}?tab=overview-images`, { waitUntil: "domcontentloaded" });
  await page.getByText("旧生成文件备注", { exact: true }).waitFor();
  assert.equal(await page.locator(".listing-image-frame").count(), 1);
  assert.ok(!(await page.locator("body").innerText()).includes("当前项目暂无可读取的分析报告"));
  assert.deepEqual(writes, [], "normal reads must not start collection");
  assert.deepEqual(pageErrors, []);
});
