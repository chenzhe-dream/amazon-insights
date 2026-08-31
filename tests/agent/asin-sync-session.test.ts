import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { after, before } from "node:test";

import { chromium, type Browser } from "playwright";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";

import { createSyncStartGate } from "../../app/lib/asin-sync-session";
import { resolveOverviewRank } from "../../app/lib/competitor-overview-fallback";
import * as session from "../../app/lib/asin-sync-session";
import type { AsinModuleResult } from "../../app/lib/sync-job-display";
import { presentSyncProgress, type SyncJob } from "../../app/lib/sync-progress-presentation";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];
const projectId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000004";
const secondRunId = "10000000-0000-4000-8000-000000000005";
const currentArtifactId = "a".repeat(64);
const nextArtifactId = "b".repeat(64);
const publicationRequestId = "c".repeat(64);
const publicationRequestedAt = "2026-08-25T00:00:00.000Z";
const automaticDataModules = [
  "catalog",
  "keywords",
  "reviews",
  "sales_trend",
  "child_sales",
  "price_strategy",
  "fba",
  "listing",
  "category",
  "traffic",
] as const;
let server: ViteDevServer;
let browser: Browser;
let baseUrl = "";

const overviewAsins = ["B0FA11BA01", "B0FA11BA02", "B0FA11BA03"];
const overviewHarnessEntry = "/tests/agent/task-2-real-overview-harness.tsx";
const overviewHarnessModule = "\0task-2-real-overview-harness";
const overviewCatalogModule = "\0task-2-overview-catalog";
const overviewTrendModule = "\0task-2-overview-trends";
const nextLinkModule = "\0task-2-next-link";
const nextNavigationModule = "\0task-2-next-navigation";

function task2OverviewHarnessPlugin(): Plugin {
  return {
    name: "task-2-real-overview-harness",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === overviewHarnessEntry) return overviewHarnessModule;
      if (id === "next/link") return nextLinkModule;
      if (id === "next/navigation") return nextNavigationModule;
      if (importer?.replace(/\\\\/g, "/").endsWith("/app/page.tsx")) {
        if (id === "./competitor-data") return overviewCatalogModule;
        if (id === "./sorftime-sales-trend-data") return overviewTrendModule;
      }
      return null;
    },
    load(id) {
      if (id === overviewHarnessModule) {
        return `
          import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { AuthenticatedAmazonOpportunityApp } from "/app/page.tsx";

          const authSession = {
            user: {
              id: "10000000-0000-4000-8000-000000000001",
              organizationId: "10000000-0000-4000-8000-000000000001",
              email: "task2@example.com",
              displayName: "Task 2",
              role: "member",
              status: "active",
              createdAt: "2026-08-24T00:00:00.000Z",
              updatedAt: "2026-08-24T00:00:00.000Z",
            },
            logout: async () => undefined,
            logoutPending: false,
            logoutError: null,
          };
          createRoot(document.getElementById("root")).render(
            createElement(AuthenticatedAmazonOpportunityApp, { authSession }),
          );
        `;
      }
      if (id === overviewCatalogModule) {
        return `
          const sellerCatalog = [{
            asin: "${overviewAsins[0]}", brand: "Verified Seller", image: "", title: "Verified Seller catalog record",
            price: 77, sales: 10, rating: 4.5, reviews: 12, rank: 123, subRank: 4,
            rankCategory: "Verified category", subRankCategory: "Verified subcategory",
            buyBoxSeller: "Verified Seller", fulfillment: "Verified FBA",
            packageSize: "Verified package", packageWeight: "Verified weight", specifications: [],
            launch: "2026-01-01", format: "Verified format", variants: "1", history: [], prices: [], ranks: [],
            variantShare: [], variantDetails: [], sellingPoints: [], strengths: [], weaknesses: [], unmet: [],
            scenarios: [], audiences: [], keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 }, synced: true,
          }];
          export const refreshedCatalog = new URLSearchParams(window.location.search).get("catalog") === "seller" ? sellerCatalog : [];
        `;
      }
      if (id === overviewTrendModule) {
        return `
          export const sorftimeSalesTrendMeta = { source: "Sorftime MCP", updatedAt: "2026-08-24", syncCommand: "npm run sales:sync" };
          export const sorftimeSalesTrendData = {
            ${overviewAsins[0]}: {
              asin: "${overviewAsins[0]}", marketplace: "US", fetchedAt: "2026-08-24", status: "ready",
              volume: [], amount: [],
              price: [{ month: "2026-07", value: 59.99 }, { month: "2026-08", value: 61.25 }, { month: "2026-09", value: -1 }],
              rank: [{ month: "2026-07", value: 5021 }, { month: "2026-08", value: 4321 }, { month: "2026-09", value: Number.NaN }],
            },
          };
        `;
      }
      if (id === nextLinkModule) {
        return `
          import { createElement } from "react";
          export default function Link({ href, children, ...props }) {
            return createElement("a", { ...props, href: typeof href === "string" ? href : href.pathname ?? "" }, children);
          }
        `;
      }
      if (id === nextNavigationModule) {
        return `
          export function usePathname() { return window.location.pathname; }
          export function useSearchParams() { return new URLSearchParams(window.location.search); }
          export function useRouter() {
            return {
              push: url => window.history.pushState(null, "", url),
              replace: url => window.history.replaceState(null, "", url),
              prefetch: async () => undefined,
            };
          }
        `;
      }
      return null;
    },
    configureServer(viteServer) {
      viteServer.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname === "/tests/agent/task-2-real-overview-harness.html" || pathname.startsWith("/p/")) {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html");
          response.end('<div id="root"></div><script type="module" src="/tests/agent/task-2-real-overview-harness.tsx"></script>');
          return;
        }
        if (pathname === overviewHarnessEntry) {
          const transformed = await viteServer.transformRequest(overviewHarnessEntry);
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/javascript");
          response.end(transformed?.code ?? "");
          return;
        }
        next();
      });
    },
  };
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

before(async () => {
  server = await createViteServer({
    configFile: false,
    plugins: [task2OverviewHarnessPlugin()],
    server: { host: "127.0.0.1", port: 0 },
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

function syncJob(scope = { projectId, runId }) {
  return {
    jobId: "job-1",
    asins,
    marketplace: "US",
    status: "running",
    message: "Running",
    currentStageId: "queue",
    stages: [],
    asinProgress: {},
    scope,
    queuePosition: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function canonicalizeStageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeStageValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalizeStageValue((value as Record<string, unknown>)[key])]));
}

function stageOutputHash(stage: string, branch: { data: unknown } | { gap: unknown }): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeStageValue({ stage, ...branch }))).digest("hex");
}

function keywordStageData(keyword: string) {
  return { analysisByAsin: { [asins[0]]: {
    asin: asins[0], marketplace: "US", fetchedAt: "2026-08-25", status: "ready",
    totalKeywordsInPeriod: 1, topKeywordsAnalyzed: 1,
    keywords: [{
      keyword, trafficShare: 99, searchVolume: 43210, abaRank: 123,
      cpcMedian: 1, cpcLow: 0.8, cpcHigh: 1.2, naturalRatio: 80,
      trafficDependency: "natural_dominant", organicRank: "p1,1/48", rankEvolution: "rising",
      keywordHealth: "healthy", top3ClickShare: 12, top3ConversionShare: 10, clickConversionRate: 8,
    }],
  } }, enrichmentByKeyword: {} };
}

function scopedStageProjection(stage: "keywords" | "listing", data: Record<string, unknown>, jobVersion = 1) {
  return {
    jobId: "job-1", projectId, runId, stage, stageStatus: "done", jobVersion,
    outputVersion: jobVersion, contentHash: stageOutputHash(stage, { data }),
    updatedAt: "2026-08-25T09:00:00.000Z", data,
  };
}

function moduleResult(status: AsinModuleResult["status"]): AsinModuleResult {
  return {
    status,
    reason: status === "ready" ? null : "fixture gap",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function mixedCompletenessProgress() {
  const progress = Object.fromEntries(asins.map(asin => [
    asin,
    Object.fromEntries(automaticDataModules.map(module => [module, moduleResult("ready")])),
  ])) as SyncJob["asinProgress"];
  progress[asins[2]]!.keywords = moduleResult("connector-failed");
  progress[asins[0]]!.image_remarks = moduleResult("ready");
  progress[asins[0]]!.alexa_voc = moduleResult("manual");
  return progress;
}

async function installFunnelRoute(page: import("playwright").Page, mode: "valid" | "mismatch" | "failed") {
  const calls = { get: 0, post: 0 };
  await page.route("**/api/agent/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      calls.post += 1;
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({}) });
    }
    if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
      calls.get += 1;
      if (mode === "failed") {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(syncJob(mode === "mismatch" ? { projectId: "10000000-0000-4000-8000-000000000099", runId } : undefined)),
      });
    }
    if (path.endsWith(`/v1/runs/${runId}`)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run: { projectId }, stages: [] }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
  return calls;
}

test("a sync funnel session only starts one POST even after an equivalent rerender", () => {
  const startOnce = createSyncStartGate();

  assert.equal(startOnce(), true);
  assert.equal(startOnce(), false);
});

test("the existing job poll fetches and renders seven scoped stage outputs without navigation or duplicate work", async () => {
  const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(
    pageSource,
    /<TrafficAnalysisConclusionSection products=\{products\} market=\{market\} trafficData=\{stageOutputView\.trafficData\} \/>/,
    "the production conclusion consumes the same accepted traffic overlay as status and charts",
  );
  const page = await browser.newPage();
  const stages = ["keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic"] as const;
  const calls = { jobs: 0, outputs: new Map<string, number>(), posts: 0 };
  const stageData = (stage: typeof stages[number]) => stage === "keywords"
    ? keywordStageData("task4 live overlay")
    : stage === "listing" ? { contentByAsin: { [asins[0]]: {
      asin: asins[0], marketplace: "US", fetchedAt: "2026-08-25", status: "ready",
      mainImage: null, galleryImages: [], secondaryImages: [], imageCount: 0,
      hasAplus: true, hasEbc: false, hasVideo: true, lqs: 97,
    } } }
      : stage === "category" ? { trendByNode: { task4: {
        nodeId: "task4", categoryName: "Task4 category overlay", topCategory: "Task4 top", sourceAsin: asins[0],
        asins: [asins[0]], marketplace: "US", fetchedAt: "2026-08-25", status: "ready",
        volume: [{ month: "2026-07", value: 100 }, { month: "2026-08", value: 120 }],
        avgPrice: [{ month: "2026-07", value: 20 }, { month: "2026-08", value: 21 }],
        amount: [{ month: "2026-07", value: 2000 }, { month: "2026-08", value: 2520 }],
        listingMonopoly: [], brandMonopoly: [], sellerMonopoly: [],
      } } }
        : stage === "traffic" ? {
          listingByAsin: { [asins[0]]: { total: 1000, natural: 700, advertising: 300 } },
          monthlyByAsin: { [asins[0]]: { asin: asins[0], points: [{ month: "2026-08", natural: 700, advertising: 300, total: 1000 }] } },
        }
          : {};
  try {
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        calls.posts += 1;
        return route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: { message: "GET only" } }) });
      }
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        const terminalCount = Math.min(calls.jobs, stages.length);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob(),
            jobVersion: terminalCount,
            currentStageId: stages[Math.min(terminalCount, stages.length - 1)],
            stages: stages.map((id, index) => ({
              id, label: id, kind: "auto",
              status: index < terminalCount
                ? (["reviews", "sales_trend", "fba"].includes(id) || (id === "listing" && terminalCount > 5) ? "partial" : "done")
                : index === terminalCount ? "active" : "pending",
              estimatedSeconds: 1,
            })),
            publication: { status: "pending", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt },
          }),
        });
      }
      const match = path.match(/\/stages\/(keywords|reviews|sales_trend|fba|listing|category|traffic)\/output$/);
      if (match) {
        const stage = match[1] as typeof stages[number];
        const jobVersion = Math.min(calls.jobs, stages.length);
        calls.outputs.set(stage, (calls.outputs.get(stage) ?? 0) + 1);
        const isFixedGap = ["reviews", "sales_trend", "fba"].includes(stage)
          || (stage === "listing" && (calls.outputs.get(stage) ?? 0) > 1);
        if (isFixedGap) {
          const gap = { state: "partial", reasonCode: "UPSTREAM_EMPTY" } as const;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            jobId: "job-1", projectId, runId, stage, stageStatus: "partial", jobVersion,
            outputVersion: jobVersion, contentHash: stageOutputHash(stage, { gap }),
            updatedAt: "2026-08-25T09:00:00.000Z", gap,
          }) });
        }
        const data = stageData(stage);
        const contentHash = stageOutputHash(stage, { data });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          jobId: "job-1", projectId, runId, stage, stageStatus: "done", jobVersion,
          outputVersion: jobVersion, contentHash, updatedAt: "2026-08-25T09:00:00.000Z", data,
        }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });

    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&realStageConsumers=1&run=${runId}&syncJob=job-1`);
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
    await page.getByText("task4 live overlay", { exact: true }).first().waitFor({ timeout: 5_000 });
    await page.locator('[data-stage-output-gap="reviews"]').getByText("评论数据缺口", { exact: true }).waitFor({ timeout: 5_000 });
    await page.locator('[data-stage-output-gap="sales_trend"]').getByText("历史趋势数据缺口", { exact: true }).waitFor({ timeout: 5_000 });
    await page.locator('[data-stage-output-gap="fba"]').getByText("FBA 费用数据缺口", { exact: true }).waitFor({ timeout: 5_000 });
    await page.locator(".listing-aplus-matrix").getByText("97", { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByText(/Task4 top › Task4 category overlay · Node task4/).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages.includes("traffic"), null, { timeout: 5_000 });
    await page.locator(".traffic-fetch-status").getByText("1,000", { exact: true }).first().waitFor({ timeout: 5_000 });
    await page.locator(".traffic-conclusion-table").getByText("1,000", { exact: true }).waitFor({ timeout: 5_000 });
    assert.equal(await page.locator(".listing-aplus-matrix").getByText("97", { exact: true }).count(), 1, "later listing gaps preserve the verified production consumer data");
    assert.equal(await page.locator('[data-stage-output-gap="listing"]').count(), 0, "later listing gaps never cover a verified success");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1, "all seven real consumers render in one navigation");
    assert.equal(calls.posts, 0);
    assert.deepEqual(Object.fromEntries(calls.outputs), {
      keywords: 7, reviews: 6, sales_trend: 5, fba: 4, listing: 3, category: 2, traffic: 1,
    }, "each terminal stage is fetched once for each newly accepted job version");
    const before = await page.evaluate(() => (window as unknown as { stageOutputEvents: { updates: number } }).stageOutputEvents.updates);
    const outputCallsBefore = [...calls.outputs.entries()];
    await page.waitForTimeout(1_700);
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { stageOutputEvents: { updates: number } }).stageOutputEvents.updates), before, "identical poll response does not rerender");
    assert.deepEqual([...calls.outputs.entries()], outputCallsBefore, "identical poll response does not repeat stage GETs");

    await page.evaluate(() => {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}&scopeRevision=2`);
      (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel();
    });
    await page.waitForFunction(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages.length === 0);
    await page.waitForFunction(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages.includes("traffic"), null, { timeout: 5_000 });
    await page.getByText("task4 live overlay", { exact: true }).first().waitFor({ timeout: 5_000 });
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1, "URL scope reset and refetch stay in one navigation");

    await page.evaluate(() => (window as unknown as { logoutStageOutputs(): void }).logoutStageOutputs());
    await page.waitForFunction(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages.length === 0);
    await page.waitForTimeout(100);
    assert.equal(await page.getByText("task4 live overlay", { exact: true }).count(), 0, "logout clears accepted keyword overlay after in-flight work settles");
    assert.equal(await page.getByText(/Task4 top › Task4 category overlay/).count(), 0, "logout clears accepted category overlay");
    assert.equal(await page.getByText("高级 A+ / 富内容对比", { exact: true }).count(), 1, "static production fallback remains mounted without overlays");
    assert.equal(await page.locator(".listing-aplus-matrix").getByText("100", { exact: true }).count(), 1, "static listing data returns after the overlay owner clears");
  } finally {
    await page.close();
  }
});

test("a canonical terminal job retries a transient stage-output failure on the same poll timer before stopping", async () => {
  const page = await browser.newPage();
  const calls = { jobs: 0, outputs: 0, posts: 0 };
  const data = keywordStageData("terminal retry overlay");
  try {
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        calls.posts += 1;
        return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
      }
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "completed", message: "terminal with projected output", jobVersion: 1,
          stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 }],
          publication: { status: "not-required" },
        }) });
      }
      if (path.endsWith("/stages/keywords/output")) {
        calls.outputs += 1;
        if (calls.outputs === 1) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scopedStageProjection("keywords", data)) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&realKeyword=1&run=${runId}&syncJob=job-1`);
    await page.getByText("terminal retry overlay", { exact: true }).first().waitFor({ timeout: 5_000 });
    assert.deepEqual(calls, { jobs: 2, outputs: 2, posts: 0 });
    await page.waitForTimeout(1_700);
    assert.deepEqual(calls, { jobs: 2, outputs: 2, posts: 0 }, "accepted terminal output stops the only job poll without duplicate success GETs");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
  } finally {
    await page.close();
  }
});

test("a legacy terminal job without a canonical output version stops without waiting forever", async () => {
  const page = await browser.newPage();
  const calls = { jobs: 0, outputs: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "completed", message: "legacy terminal", jobVersion: undefined,
          stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 }],
          publication: { status: "not-required" },
        }) });
      }
      if (path.endsWith("/stages/keywords/output")) calls.outputs += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.getByText("legacy terminal", { exact: true }).waitFor({ timeout: 2_000 });
    await page.waitForTimeout(1_700);
    assert.deepEqual(calls, { jobs: 1, outputs: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);

    await page.reload();
    await page.getByText("legacy terminal", { exact: true }).waitFor({ timeout: 2_000 });
    await page.waitForTimeout(1_700);
    assert.deepEqual(calls, { jobs: 2, outputs: 0 }, "legacy 404 output absence never becomes an infinite retry after reload");
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
  } finally {
    await page.close();
  }
});

test("scope cancellation during an in-flight stage output blocks old job and publication side effects", async () => {
  for (const action of ["url", "logout", "job"] as const) {
    const page = await browser.newPage();
    let releaseOutput!: () => void;
    const outputReleased = new Promise<void>(resolve => { releaseOutput = resolve; });
    let outputStarted!: () => void;
    const outputWasStarted = new Promise<void>(resolve => { outputStarted = resolve; });
    try {
      await page.route("**/api/agent/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-2")) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), jobId: "job-2", message: "new job" }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            ...syncJob(), status: "completed", message: "OLD TERMINAL MUST NOT RENDER", jobVersion: 1,
            stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 }],
            publication: { status: "applied", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt, appliedAt: "2026-08-25T00:00:05.000Z" },
          }) });
        }
        if (path.endsWith("/stages/keywords/output")) {
          outputStarted();
          await outputReleased;
          const data = keywordStageData("cancelled old overlay");
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scopedStageProjection("keywords", data)) });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&realKeyword=1&run=${runId}&syncJob=job-1`);
      await Promise.race([
        outputWasStarted,
        page.waitForTimeout(5_000).then(() => { throw new Error(`${action} did not start its stage-output GET`); }),
      ]);
      if (action === "url") {
        await page.evaluate(() => {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}&scopeRevision=cancelled`);
          (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel();
        });
      } else if (action === "logout") {
        await page.evaluate(() => (window as unknown as { logoutStageOutputs(): void }).logoutStageOutputs());
      } else {
        await page.evaluate(() => (window as unknown as { switchStageOutputJob(jobId: string): void }).switchStageOutputJob("job-2"));
      }
      releaseOutput();
      await page.waitForTimeout(250);
      assert.equal(await page.getByText("cancelled old overlay", { exact: true }).count(), 0, `${action} blocks old projection`);
      assert.equal(await page.getByText("OLD TERMINAL MUST NOT RENDER", { exact: true }).count(), 0, `${action} blocks old setJob`);
      const events = await page.evaluate(() => ({
        stage: (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages,
        terminal: (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents,
      }));
      assert.deepEqual(events.stage, [], `${action} leaves the cleared owner empty`);
      assert.deepEqual(events.terminal, { completions: 0, reloads: 0 }, `${action} blocks completion/publication side effects`);
    } finally {
      releaseOutput?.();
      await page.close();
    }
  }
});

test("same-content ASIN arrays do not restart a URL-resumed poll while stage outputs resolve at different delays", async () => {
  const page = await browser.newPage();
  const calls = new Map<string, number>();
  const releases = new Map<string, () => void>();
  const started = new Map<string, Promise<void>>();
  const markStarted = new Map<string, () => void>();
  const released = new Map<string, Promise<void>>();
  for (const stage of ["keywords", "listing"] as const) {
    let mark!: () => void;
    started.set(stage, new Promise<void>(resolve => { mark = resolve; }));
    markStarted.set(stage, mark);
    let release!: () => void;
    released.set(stage, new Promise<void>(resolve => { release = resolve; }));
    releases.set(stage, release);
  }
  try {
    await page.route("**/api/agent/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), jobVersion: 1,
          stages: ["keywords", "listing"].map(id => ({ id, label: id, kind: "auto", status: "done", estimatedSeconds: 1 })),
        }) });
      }
      const stage = path.match(/\/stages\/(keywords|listing)\/output$/)?.[1] as "keywords" | "listing" | undefined;
      if (stage) {
        calls.set(stage, (calls.get(stage) ?? 0) + 1);
        markStarted.get(stage)!();
        await released.get(stage);
        const data = stage === "keywords" ? keywordStageData("stable ASIN overlay") : { contentByAsin: { [asins[0]]: { status: "ready", hasAplus: true, lqs: 97 } } };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scopedStageProjection(stage, data)) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&realKeyword=1&freshAsins=1&run=${runId}&syncJob=job-1`);
    await Promise.all([started.get("keywords")!, started.get("listing")!]);
    releases.get("keywords")!();
    await page.getByText("stable ASIN overlay", { exact: true }).first().waitFor({ timeout: 2_000 });
    await page.evaluate(() => (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel());
    releases.get("listing")!();
    await page.waitForFunction(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages.includes("listing"), null, { timeout: 4_000 });
    await page.waitForTimeout(1_700);
    assert.deepEqual(Object.fromEntries(calls), { keywords: 1, listing: 1 });
  } finally {
    for (const release of releases.values()) release();
    await page.close();
  }
});

test("overview keeps a usable SellerSprite major rank when its sub-rank is unavailable", () => {
  const result = resolveOverviewRank(123, null, {
    asin: overviewAsins[0],
    marketplace: "US",
    fetchedAt: "2026-08-24",
    status: "ready",
    volume: [],
    amount: [],
    price: [],
    rank: [{ month: "2026-08", value: 999 }],
  });

  assert.deepEqual(result, { value: 123, source: "sellerSprite" });
});

test("new ASIN project identity creates a new workspace and switches owner before sync", async () => {
  const page = await browser.newPage();
  const oldProject = {
    id: "old-project-id",
    slug: "old-slug",
    name: "Old project",
    majorCategory: "Home & Kitchen",
    categoryLabel: "Floor lamps",
    marketplace: "US",
    asins: overviewAsins,
    note: null,
    createdBy: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const oldProjectBefore = structuredClone(oldProject);
  const nextAsins = ["B0NEWASIN1", "B0NEWASIN2", "B0NEWASIN3"];
  const newProject = {
    ...oldProject,
    id: "new-project-id",
    slug: "new-slug",
    name: "New project",
    asins: nextAsins,
  };
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let syncInterceptedUrl: string | null = null;
  let registrationIdempotencyKey: string | null = null;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      calls.push({
        method,
        path,
        body: ["PATCH", "POST"].includes(method) ? JSON.parse(request.postData() ?? "{}") as Record<string, unknown> : null,
      });
      if (path.endsWith(`/v1/local-data/projects/${oldProject.id}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: oldProject }) });
      }
      if (path.endsWith("/v1/local-data/projects") && method === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      if (path.endsWith("/v1/local-data/projects") && method === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: newProject }) });
      }
      if (path.endsWith("/v1/projects") && method === "POST") {
        registrationIdempotencyKey = request.headers()["idempotency-key"] ?? null;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project: {
            id: newProject.id,
            organizationId: "10000000-0000-4000-8000-000000000001",
            marketplace: "US",
            asins: nextAsins,
          } }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins") && method === "POST") {
        syncInterceptedUrl = page.url();
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ jobId: "new-job", scope: { projectId: newProject.id, runId: "new-run" } }),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?project=${oldProject.id}`);
    await page.waitForFunction(slug => window.location.pathname === `/p/${slug}`, oldProject.slug);
    await page.getByRole("textbox", { name: "批量输入 ASIN" }).fill(nextAsins.map(asin => asin.toLowerCase()).join("\n"));

    const syncStarted = page.waitForRequest(request =>
      request.method() === "POST" && new URL(request.url()).pathname.endsWith("/v1/local-data/sync-asins"),
    );
    await page.getByRole("button", { name: "开始全自动分析" }).dblclick();
    await syncStarted;
    await page.waitForFunction(slug => window.location.pathname === `/p/${slug}`, newProject.slug);

    assert.equal(calls.filter(call => call.method === "PATCH").length, 0);
    assert.equal(calls.filter(call => call.path === "/api/agent/v1/local-data/projects" && call.method === "POST").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/agent/v1/projects" && call.method === "POST").length, 1);
    assert.equal(registrationIdempotencyKey, `project-register:${newProject.id}`);
    assert.equal(calls.filter(call => call.path === "/api/agent/v1/local-data/sync-asins" && call.method === "POST").length, 1);
    assert.deepEqual(calls.find(call => call.path === "/api/agent/v1/local-data/sync-asins" && call.method === "POST")?.body, {
      projectId: newProject.id,
      marketplace: "US",
      asins: nextAsins,
    });
    assert.equal(new URL(syncInterceptedUrl ?? "http://missing.invalid").pathname, `/p/${newProject.slug}`);
    assert.equal(new URL(page.url()).pathname, `/p/${newProject.slug}`);
    assert.deepEqual(oldProject, oldProjectBefore);
  } finally {
    await page.close();
  }
});

test("project registration failure fails closed for every local-project and registration boundary", async () => {
  for (const scenario of [
    "local-create-failure",
    "conflict",
    "network-error",
    "invalid-json",
    "project-id-mismatch",
    "organization-mismatch",
    "marketplace-mismatch",
    "asin-set-mismatch",
  ] as const) {
    const page = await browser.newPage();
    const oldProject = {
      id: "old-project-id",
      slug: "old-slug",
      name: "Old project",
      majorCategory: "Home & Kitchen",
      categoryLabel: "Floor lamps",
      marketplace: "US",
      asins: overviewAsins,
      note: null,
      createdBy: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const nextAsins = ["B0NEWASIN1", "B0NEWASIN2", "B0NEWASIN3"];
    const newProject = { ...oldProject, id: "new-project-id", slug: "new-slug", asins: nextAsins };
    let oldProjectPatchCalls = 0;
    let syncPosts = 0;
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (path.endsWith(`/v1/local-data/projects/${oldProject.id}`) || path.endsWith(`/v1/local-data/projects/${oldProject.slug}`)) {
          if (method === "PATCH") oldProjectPatchCalls += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: oldProject }) });
        }
        if (path.endsWith("/v1/local-data/projects") && method === "GET") {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
        }
        if (path.endsWith("/v1/local-data/projects") && method === "POST") {
          if (scenario === "local-create-failure") {
            return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "create failed" } }) });
          }
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: newProject }) });
        }
        if (path.endsWith("/v1/projects") && method === "POST") {
          if (scenario === "conflict") {
            return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { message: "duplicate project" } }) });
          }
          if (scenario === "network-error") return route.abort("failed");
          if (scenario === "invalid-json") {
            return route.fulfill({ status: 200, contentType: "application/json", body: "not json" });
          }
          const registrationProject = {
            id: scenario === "project-id-mismatch" ? "other-project-id" : newProject.id,
            organizationId: scenario === "organization-mismatch" ? "other-organization" : "10000000-0000-4000-8000-000000000001",
            marketplace: scenario === "marketplace-mismatch" ? "UK" : "US",
            asins: scenario === "asin-set-mismatch" ? [nextAsins[0], nextAsins[1], "B0MISMATCH"] : nextAsins,
          };
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ project: registrationProject }),
          });
        }
        if (path.endsWith("/v1/local-data/sync-asins") && method === "POST") {
          syncPosts += 1;
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      });
      await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?project=${oldProject.id}`);
      await page.waitForFunction(slug => window.location.pathname === `/p/${slug}`, oldProject.slug);
      await page.getByRole("textbox", { name: "批量输入 ASIN" }).fill(nextAsins.join("\n"));

      await page.getByRole("button", { name: "开始全自动分析" }).click();
      await page.locator(".builder-message").waitFor();

      assert.equal(await page.locator(".builder-message").textContent(), "项目登记失败，未创建分析任务，请重试", scenario);
      assert.equal(await page.getByText("项目登记失败，未创建分析任务，请重试", { exact: true }).count(), 1, scenario);
      assert.equal(syncPosts, 0, scenario);
      assert.equal(oldProjectPatchCalls, 0, scenario);
    } finally {
      await page.close();
    }
  }
});

test("new ASIN project refresh restores the local workspace without registration or sync", async () => {
  const page = await browser.newPage();
  const project = {
    id: "new-project-id",
    slug: "new-slug",
    name: "New project",
    majorCategory: "Home & Kitchen",
    categoryLabel: "Floor lamps",
    marketplace: "UK",
    asins: ["B0NEWASIN1", "B0NEWASIN2", "B0NEWASIN3"],
    note: null,
    createdBy: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const calls = { localCreates: 0, registrations: 0, syncPosts: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path.endsWith(`/v1/local-data/projects/${project.slug}`) && method === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project }) });
      }
      if (path.endsWith("/v1/local-data/projects") && method === "POST") calls.localCreates += 1;
      if (path.endsWith("/v1/projects") && method === "POST") calls.registrations += 1;
      if (path.endsWith("/v1/local-data/sync-asins") && method === "POST") calls.syncPosts += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/p/${project.slug}`);
    const editor = page.getByRole("textbox", { name: "批量输入 ASIN" });
    await editor.waitFor();
    await page.waitForFunction(expected => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="批量输入 ASIN"]');
      return input?.value === expected;
    }, project.asins.join("\n"));

    assert.equal(await page.locator(".market-inline select").inputValue(), project.marketplace);
    assert.equal(await editor.inputValue(), project.asins.join("\n"));
    assert.deepEqual(calls, { localCreates: 0, registrations: 0, syncPosts: 0 });
  } finally {
    await page.close();
  }
});

test("new ASIN project identity reuses only an exactly matching current workspace", async () => {
  const page = await browser.newPage();
  const exactProject = {
    id: "exact-project-id",
    slug: "exact-slug",
    name: "Exact project",
    majorCategory: "Home & Kitchen",
    categoryLabel: "Floor lamps",
    marketplace: "US",
    asins: overviewAsins,
    note: null,
    createdBy: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      calls.push({
        method,
        path,
        body: ["PATCH", "POST"].includes(method) ? JSON.parse(request.postData() ?? "{}") as Record<string, unknown> : null,
      });
      if (path.endsWith(`/v1/local-data/projects/${exactProject.id}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: exactProject }) });
      }
      if (path.endsWith("/v1/projects") && method === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project: {
            id: exactProject.id,
            organizationId: "10000000-0000-4000-8000-000000000001",
            marketplace: "US",
            asins: overviewAsins,
          } }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins") && method === "POST") {
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ jobId: "exact-job", scope: { projectId: exactProject.id, runId: "exact-run" } }),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?project=${exactProject.id}`);
    await page.waitForFunction(slug => window.location.pathname === `/p/${slug}`, exactProject.slug);
    assert.equal(
      await page.getByRole("textbox", { name: "批量输入 ASIN" }).inputValue(),
      overviewAsins.join("\n"),
    );

    await page.getByRole("button", { name: "开始全自动分析" }).dblclick();
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("syncJob") === "exact-job");

    assert.equal(calls.filter(call => call.method === "PATCH").length, 0);
    assert.equal(calls.filter(call => call.path === "/api/agent/v1/local-data/projects" && call.method === "POST").length, 0);
    assert.equal(calls.filter(call => call.path === "/api/agent/v1/projects" && call.method === "POST").length, 1);
    assert.equal(calls.filter(call => call.path === "/api/agent/v1/local-data/sync-asins" && call.method === "POST").length, 1);
    assert.deepEqual(calls.find(call => call.path === "/api/agent/v1/local-data/sync-asins" && call.method === "POST")?.body, {
      projectId: exactProject.id,
      marketplace: "US",
      asins: overviewAsins,
    });
  } finally {
    await page.close();
  }
});

test("overview preserves invalid raw ASIN text and blocks every business POST", async () => {
  const page = await browser.newPage();
  const raw = `${overviewAsins.join("\n")}\nbad-token`;
  let businessPosts = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      if (request.method() === "POST") businessPosts += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html`);
    const editor = page.getByRole("textbox", { name: "批量输入 ASIN" });
    await editor.fill(raw);
    await page.getByRole("button", { name: "开始全自动分析" }).click();

    await page.getByRole("alert").filter({ hasText: "格式错误：BAD-TOKEN" }).waitFor();
    await page.getByText("请修正 ASIN 输入后再开始分析", { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), raw);
    assert.equal(businessPosts, 0);
  } finally {
    await page.close();
  }
});

test("real overview marks placeholder SellerSprite-only fields unavailable when no sync job is active", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/api/agent/**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) }));
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?asins=${overviewAsins.join(",")}`);
    const overview = page.locator(".compare-table-card").filter({ has: page.getByRole("heading", { name: "竞品参数总览", exact: true }) });
    await overview.waitFor();

    const row = (label: string) => overview.locator("tr").filter({ hasText: label });
    assert.equal(await overview.locator(".source-badge").textContent(), "MCP 综合");
    assert.equal(await row("当前售价").locator("td").first().textContent(), "$61.25");
    assert.equal(await row("Best Seller Rank").locator("td").first().getByText("#4,321", { exact: true }).count(), 1);
    assert.equal(await row("Best Seller Rank").locator("td").first().getByText("类目：卖家精灵未返回", { exact: true }).count(), 1);
    assert.equal(await row("购物车卖家").locator("td").first().textContent(), "SellerSprite 暂不可用");
    assert.equal(await row("配送方式").locator("td").first().textContent(), "SellerSprite 暂不可用");
  } finally {
    await page.close();
  }
});

test("real overview marks placeholder SellerSprite-only fields unavailable during a matching active catalog sync", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/api/agent/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob({ projectId, runId }),
            asins: overviewAsins,
            status: "running",
            asinProgress: { [overviewAsins[0]]: { catalog: moduleResult("pending") } },
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?asins=${overviewAsins.join(",")}&run=${runId}&syncJob=job-1`);
    const overview = page.locator(".compare-table-card").filter({ has: page.getByRole("heading", { name: "竞品参数总览", exact: true }) });
    await overview.waitFor();
    const row = (label: string) => overview.locator("tr").filter({ hasText: label });

    await row("购物车卖家").locator("td").first().getByText("SellerSprite 暂不可用", { exact: true }).waitFor();
    assert.equal(await row("配送方式").locator("td").first().textContent(), "SellerSprite 暂不可用");
  } finally {
    await page.close();
  }
});

test("real overview keeps placeholder SellerSprite-only fields unavailable for a stale sync job pointer", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/api/agent/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?asins=${overviewAsins.join(",")}&run=${runId}&syncJob=job-1`);
    const overview = page.locator(".compare-table-card").filter({ has: page.getByRole("heading", { name: "竞品参数总览", exact: true }) });
    await overview.waitFor();
    const row = (label: string) => overview.locator("tr").filter({ hasText: label });

    await row("购物车卖家").locator("td").first().getByText("SellerSprite 暂不可用", { exact: true }).waitFor();
    assert.equal(await row("配送方式").locator("td").first().textContent(), "SellerSprite 暂不可用");
  } finally {
    await page.close();
  }
});

test("real overview marks SellerSprite-only fields unavailable after a terminal catalog connector gap", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/api/agent/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob({ projectId, runId }),
            asins: overviewAsins,
            status: "completed-with-gaps",
            asinProgress: {
              [overviewAsins[0]]: { catalog: moduleResult("connector-failed") },
              [overviewAsins[1]]: { catalog: moduleResult("ready") },
              [overviewAsins[2]]: { catalog: moduleResult("ready") },
            },
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    });
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?asins=${overviewAsins.join(",")}&run=${runId}&syncJob=job-1`);
    const overview = page.locator(".compare-table-card").filter({ has: page.getByRole("heading", { name: "竞品参数总览", exact: true }) });
    await overview.waitFor();
    const row = (label: string) => overview.locator("tr").filter({ hasText: label });

    await row("购物车卖家").locator("td").first().getByText("SellerSprite 暂不可用", { exact: true }).waitFor();
    assert.equal(await row("购物车卖家").locator("td").first().textContent(), "SellerSprite 暂不可用");
    assert.equal(await row("配送方式").locator("td").first().textContent(), "SellerSprite 暂不可用");
  } finally {
    await page.close();
  }
});

test("real overview preserves actual SellerSprite-only values", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/api/agent/**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) }));
    await page.goto(`${baseUrl}/tests/agent/task-2-real-overview-harness.html?catalog=seller&asins=${overviewAsins.join(",")}`);
    const overview = page.locator(".compare-table-card").filter({ has: page.getByRole("heading", { name: "竞品参数总览", exact: true }) });
    await overview.waitFor();
    const row = (label: string) => overview.locator("tr").filter({ hasText: label });

    assert.equal(await row("购物车卖家").locator("td").first().textContent(), "Verified Seller");
    assert.equal(await row("配送方式").locator("td").first().textContent(), "Verified FBA");
  } finally {
    await page.close();
  }
});

test("data completeness counts ready per-ASIN data modules while excluding lifecycle and manual modules", () => {
  const stages: SyncJob["stages"] = [
    { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 1 },
    { id: "build", label: "Build", kind: "auto", status: "done", estimatedSeconds: 1 },
    ...automaticDataModules.map(module => ({
      id: module,
      label: module,
      kind: "auto" as const,
      status: module === "keywords" ? "partial" : "done",
      estimatedSeconds: 1,
    })),
    { id: "image_remarks", label: "Image remarks", kind: "auto", status: "done", estimatedSeconds: 1 },
    { id: "alexa_voc", label: "Alexa VOC", kind: "manual", status: "manual", estimatedSeconds: 1 },
  ];
  const job: SyncJob = {
    ...syncJob(),
    status: "completed-with-gaps",
    stages,
    asinProgress: mixedCompletenessProgress(),
  };

  const overall = presentSyncProgress(job, Date.parse("2026-08-24T00:00:00.000Z"));
  const keywordsOnly = presentSyncProgress(job, Date.parse("2026-08-24T00:00:00.000Z"), ["keywords"]);

  assert.equal(overall.completenessPercent, 97, "29 of 30 target ASIN/data-module results are ready");
  assert.equal(keywordsOnly.completenessPercent, 67, "a partial stage preserves its two ready ASIN outcomes out of three");
  assert.equal(overall.executionPercent, 100);
  assert.equal(overall.remainingSeconds, 0);
  assert.equal(overall.finishAt, null);
});

test("terminal execution copy does not present 100 percent as completeness", () => {
  const asinProgress = Object.fromEntries(asins.map((asin, asinIndex) => [
    asin,
    Object.fromEntries(automaticDataModules.map((module, moduleIndex) => [
      module,
      moduleResult(asinIndex === 0 && moduleIndex < 6 ? "connector-failed" : "ready"),
    ])),
  ])) as SyncJob["asinProgress"];
  const progress = presentSyncProgress({
    ...syncJob(),
    status: "completed-with-gaps",
    stages: [{ id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 1 }],
    asinProgress,
  }, Date.now());

  assert.equal(progress.terminal, true);
  assert.equal(progress.completenessPercent, 80);
});

test("image remark coverage reduces but never inflates base completeness", () => {
  const asinProgress = Object.fromEntries(asins.map((asin, asinIndex) => [
    asin,
    Object.fromEntries(automaticDataModules.map((module, moduleIndex) => [
      module,
      moduleResult(asinIndex === 0 && moduleIndex < 6 ? "connector-failed" : "ready"),
    ])),
  ])) as SyncJob["asinProgress"];
  const jobWithImageDetail = (detail: string): SyncJob => ({
    ...syncJob(),
    status: "completed-with-gaps",
    stages: [{ id: "image_remarks", label: "Image remarks", kind: "auto", status: "done", estimatedSeconds: 1, detail }],
    asinProgress,
  });

  assert.equal(presentSyncProgress(jobWithImageDetail("已完成 20/20 张 · 就绪 20"), 0).completenessPercent, 80);
  assert.equal(presentSyncProgress(jobWithImageDetail("已完成 20/20 张 · 就绪 15"), 0).completenessPercent, 60);
});

test("scoped keyword and traffic completeness ignores unrelated image remark coverage", () => {
  const asinProgress = Object.fromEntries(asins.map(asin => [
    asin,
    Object.fromEntries(automaticDataModules.map(module => [module, moduleResult("ready")])),
  ])) as SyncJob["asinProgress"];
  const job: SyncJob = {
    ...syncJob(),
    status: "completed",
    stages: [{
      id: "image_remarks",
      label: "Image remarks",
      kind: "auto",
      status: "done",
      estimatedSeconds: 1,
      detail: "已完成 20/20 张 · 就绪 15",
    }],
    asinProgress,
  };

  assert.equal(presentSyncProgress(job, 0, ["keywords"]).completenessPercent, 100);
  assert.equal(presentSyncProgress(job, 0, ["traffic"]).completenessPercent, 100);
  assert.equal(presentSyncProgress(job, 0, ["catalog", "image_remarks"]).completenessPercent, 75);
});

test("data completeness falls back to asinProgress keys and treats every non-ready outcome as unavailable", () => {
  const job: SyncJob = {
    jobId: "job-without-asins",
    marketplace: "US",
    status: "running",
    message: "Running",
    currentStageId: "keywords",
    stages: [],
    asinProgress: {
      ASIN_A: {
        catalog: moduleResult("ready"),
        keywords: moduleResult("upstream-empty"),
        reviews: moduleResult("timeout"),
        sales_trend: moduleResult("connector-failed"),
        child_sales: moduleResult("pending"),
        price_strategy: moduleResult("manual"),
      },
      ASIN_B: {
        catalog: moduleResult("ready"),
        keywords: moduleResult("manual"),
        reviews: moduleResult("pending"),
        sales_trend: moduleResult("connector-failed"),
        child_sales: moduleResult("timeout"),
        price_strategy: moduleResult("upstream-empty"),
      },
    },
  };

  const progress = presentSyncProgress(job, Date.parse("2026-08-24T00:00:00.000Z"), [
    "queue",
    "build",
    "catalog",
    "keywords",
    "reviews",
    "sales_trend",
    "child_sales",
    "price_strategy",
    "image_remarks",
    "alexa_voc",
  ]);

  assert.equal(progress.completenessPercent, 17, "only 2 of 12 mapped ASIN/data-module results are ready");
});

test("terminal progress presentation keeps partial and skipped rows as data gaps", () => {
  const terminalGapJob: SyncJob = {
    ...syncJob(),
    status: "completed-with-gaps",
    stages: [
      { id: "keywords", label: "Keywords", kind: "auto", status: "partial", estimatedSeconds: 10 },
      { id: "traffic", label: "Traffic", kind: "auto", status: "skipped", estimatedSeconds: 10 },
    ],
    asinProgress: mixedCompletenessProgress(),
  };

  const result = presentSyncProgress(terminalGapJob, Date.parse("2026-08-24T00:00:00.000Z"));

  assert.equal(result.executionPercent, 100);
  assert.ok(result.completenessPercent < 100);
  for (const id of ["keywords", "traffic"]) {
    const row = result.rows.find(candidate => candidate.id === id);
    assert.equal(row?.executionPercent, 0);
    assert.equal(row?.statusCopy, "流程已结束 · 数据缺口");
  }
});

test("image remarks automatic stage contributes to the global remaining time", () => {
  const now = Date.parse("2026-08-24T00:01:00.000Z");
  const job: SyncJob = {
    ...syncJob(),
    currentStageId: "image_remarks",
    stages: [
      {
        id: "image_remarks",
        label: "Image remarks",
        kind: "auto",
        status: "active",
        estimatedSeconds: 120,
        startedAt: "2026-08-24T00:00:30.000Z",
        detail: "图片 AI 备注：已完成 3/20 张",
      },
    ],
  };

  const result = presentSyncProgress(job, now);

  assert.equal(result.remainingSeconds, 90);
  assert.equal(result.rows[0]?.mode, "automatic");
  assert.equal(result.rows[0]?.statusCopy, "处理中 · 3/20 张");
  assert.equal(result.rows[0]?.detail, "图片 AI 备注：已完成 3/20 张");
});

test("SIF discovery destinations come only from ready status", () => {
  const destinationLabels = ["查看关键词调研", "查看竞品流量分析"];
  const jobWithSifStatus = (keywords: AsinModuleResult["status"], traffic: AsinModuleResult["status"]): SyncJob => ({
    ...syncJob(),
    asinProgress: {
      [asins[0]!]: {
        keywords: moduleResult(keywords),
        traffic: moduleResult(traffic),
      },
    },
  });

  assert.deepEqual(
    presentSyncProgress(jobWithSifStatus("ready", "pending"), Date.parse("2026-08-24T00:00:00.000Z")).sifDestinations,
    [{ tab: "keywords", label: destinationLabels[0] }],
  );
  assert.deepEqual(
    presentSyncProgress(jobWithSifStatus("pending", "ready"), Date.parse("2026-08-24T00:00:00.000Z")).sifDestinations,
    [{ tab: "traffic", label: destinationLabels[1] }],
  );
  assert.deepEqual(
    presentSyncProgress(jobWithSifStatus("ready", "ready"), Date.parse("2026-08-24T00:00:00.000Z")).sifDestinations,
    [
      { tab: "keywords", label: destinationLabels[0] },
      { tab: "traffic", label: destinationLabels[1] },
    ],
  );
  assert.deepEqual(
    presentSyncProgress(jobWithSifStatus("connector-failed", "skipped"), Date.parse("2026-08-24T00:00:00.000Z")).sifDestinations,
    [],
  );
});

test("terminal execution copy separates finished flow from truthful data completeness", async () => {
  const terminalPage = await browser.newPage();
  try {
    const terminalAsinProgress = Object.fromEntries(asins.map((asin, asinIndex) => [
      asin,
      Object.fromEntries(automaticDataModules.map((module, moduleIndex) => [
        module,
        moduleResult(asinIndex === 0 && moduleIndex < 6 ? "connector-failed" : "ready"),
      ])),
    ])) as SyncJob["asinProgress"];
    await terminalPage.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob(),
            status: "completed-with-gaps",
            message: "gap terminal",
            asinProgress: terminalAsinProgress,
            stages: [
              { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 10, completedAt: "2026-08-24T00:00:00.000Z" },
              { id: "keywords", label: "Keywords", kind: "auto", status: "partial", estimatedSeconds: 10 },
              { id: "image_remarks", label: "Image remarks", kind: "auto", status: "partial", estimatedSeconds: 180, detail: "图片 AI 备注：已完成 20/20 张 · 就绪 20" },
              { id: "alexa_voc", label: "Alexa VOC", kind: "manual", status: "manual", estimatedSeconds: 600, manualNote: "请人工录入" },
            ],
          }),
        });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await terminalPage.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await terminalPage.getByText("gap terminal", { exact: true }).waitFor();
    assert.equal(await terminalPage.getByText("流程 已结束", { exact: true }).count(), 1);
    assert.equal(await terminalPage.getByText("执行进度 100%", { exact: true }).count(), 0);
    assert.equal(await terminalPage.getByText("数据完整度 80%", { exact: true }).count(), 1);
    assert.equal(await terminalPage.locator(".sync-progress-summary").getByText(/剩余|预计/).count(), 0);
    assert.equal(await terminalPage.getByTestId("sync-stage-alexa_voc").getByText("待人工录入").count(), 1);
    assert.equal(await terminalPage.getByTestId("sync-stage-alexa_voc").getByText(/%|剩余|预计/).count(), 0);
    const terminalImageRow = terminalPage.getByTestId("sync-stage-image_remarks");
    assert.equal(await terminalImageRow.getByText("流程已结束 · 数据缺口", { exact: true }).count(), 1);
    assert.equal(await terminalImageRow.getByText("图片 AI 备注：已完成 20/20 张 · 就绪 20", { exact: true }).count(), 1);
    assert.equal(await terminalImageRow.getByText("已停用，待后续分析", { exact: true }).count(), 0);
    assert.equal(await terminalImageRow.getByText(/%|剩余|预计/).count(), 0);
  } finally {
    await terminalPage.close();
  }

  const runningPage = await browser.newPage();
  try {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await runningPage.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob(),
            currentStageId: "image_remarks",
            stages: [
              { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 10 },
              { id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 120 },
              { id: "traffic", label: "Traffic", kind: "auto", status: "done", estimatedSeconds: 120 },
              { id: "image_remarks", label: "Image remarks", kind: "auto", status: "active", estimatedSeconds: 2_400, startedAt, detail: "图片 AI 备注：已完成 3/20 张" },
            ],
          }),
        });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await runningPage.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    const imageRow = runningPage.getByTestId("sync-stage-image_remarks");
    await imageRow.waitFor();
    assert.equal(await imageRow.getByText("图片 AI 备注：已完成 3/20 张", { exact: true }).count(), 1);
    assert.equal(await imageRow.getByText("处理中 · 3/20 张", { exact: true }).count(), 1);
    assert.equal(await imageRow.getByText("已停用，待后续分析", { exact: true }).count(), 0);
  } finally {
    await runningPage.close();
  }
});

test("SIF discovery navigation preserves run job and remains GET-only", async () => {
  for (const [destination, label] of [
    ["keywords", "查看关键词调研"],
    ["traffic", "查看竞品流量分析"],
  ] as const) {
    const page = await browser.newPage();
    const calls = { post: 0 };
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === "POST") {
          calls.post += 1;
          return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({}) });
        }
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...syncJob(),
              status: "completed-with-gaps",
              message: "SIF terminal discovery",
              asinProgress: mixedCompletenessProgress(),
              stages: [
                { id: "keywords", label: "Keywords", kind: "auto", status: "partial", estimatedSeconds: 10 },
                { id: "traffic", label: "Traffic", kind: "auto", status: "skipped", estimatedSeconds: 10 },
              ],
            }),
          });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
      await page.getByText("SIF terminal discovery", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "查看关键词调研", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "查看竞品流量分析", exact: true }).count(), 1);
      for (const id of ["keywords", "traffic"]) {
        const row = page.getByTestId(`sync-stage-${id}`);
        assert.equal(await row.getByText("流程已结束 · 数据缺口", { exact: true }).count(), 1);
        assert.equal(await row.locator(".sync-progress-percent").count(), 0);
        assert.equal(await row.locator(".sync-progress-track").count(), 0);
      }

      await page.getByRole("button", { name: label, exact: true }).click();
      await page.waitForURL(url => new URL(url).searchParams.get("tab") === destination);
      assert.equal(new URL(page.url()).searchParams.get("tab"), destination);
      assert.equal(new URL(page.url()).searchParams.get("run"), runId);
      assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1");
      assert.equal(calls.post, 0);
    } finally {
      await page.close();
    }
  }
});

test("focused keyword progress becomes ready and dismissible before unrelated stages finish", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob(),
            currentStageId: "traffic",
            stages: [
              { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 10 },
              { id: "keywords", label: "Keywords", kind: "auto", status: "skipped", estimatedSeconds: 10 },
              { id: "traffic", label: "Traffic", kind: "auto", status: "active", estimatedSeconds: 120, startedAt: new Date(Date.now() - 30_000).toISOString() },
            ],
          }),
        });
      }
      if (request.method() === "POST") {
        calls.post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({}) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=keywords&run=${runId}&syncJob=job-1`);
    await page.getByText("流量词模块已就绪", { exact: true }).waitFor({ timeout: 5_000 });
    const dismiss = page.getByRole("button", { name: "收起", exact: true });
    assert.equal(await dismiss.count(), 1);
    await dismiss.click();
    await page.waitForTimeout(100);
    assert.equal(calls.post, 0);
    assert.equal(new URL(page.url()).searchParams.has("syncJob"), false);
  } finally {
    await page.close();
  }
});

test("syncJob URL recovery parses, writes, clears, and rejects mismatched scope without starting a replacement job", () => {
  assert.equal(typeof session.syncJobIdFromSearch, "function");
  assert.equal(typeof session.searchWithSyncJobId, "function");
  assert.equal(typeof session.clearSyncJobFromSearch, "function");
  assert.equal(typeof session.isSyncJobScopeMatch, "function");

  const read = session.syncJobIdFromSearch("?run=voc-1&syncJob=job-1");
  assert.equal(read, "job-1");
  assert.equal(session.searchWithSyncJobId("?run=voc-1", "job-1"), "run=voc-1&syncJob=job-1");
  assert.equal(session.clearSyncJobFromSearch("?run=voc-1&syncJob=job-1"), "run=voc-1");
  assert.equal(
    session.isSyncJobScopeMatch(
      {
        asins: ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"],
        marketplace: "US",
        scope: {
          projectId: "10000000-0000-4000-8000-000000000003",
          runId: "10000000-0000-4000-8000-000000000004",
        },
      },
      {
        asins: ["B0BPXRVWYK", "B07DYG1C9B", "B07VY9Q95Q"],
        marketplace: "US",
        projectId: "10000000-0000-4000-8000-000000000003",
        runId: "10000000-0000-4000-8000-000000000004",
      },
    ),
    true,
  );
  assert.equal(
    session.isSyncJobScopeMatch(
      {
        asins: ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"],
        marketplace: "US",
        scope: {
          projectId: "10000000-0000-4000-8000-000000000003",
          runId: "10000000-0000-4000-8000-000000000004",
        },
      },
      {
        asins: ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"],
        marketplace: "US",
        projectId: "10000000-0000-4000-8000-000000000003",
        runId: null,
      },
    ),
    true,
  );
  assert.equal(
    session.isSyncJobScopeMatch(
      { asins, marketplace: "US", scope: { projectId, runId } },
      { asins, marketplace: "US", projectId: "10000000-0000-4000-8000-000000000099", runId: secondRunId },
    ),
    false,
  );
});

test("production page URL composition uses one query marker for sync job writes and clears", () => {
  const workspacePath = "/p/kick-scooters-us";
  const jobId = "7e823a04-a172-418e-9f3a-1a0367bf9b6c";
  const productionPageUrl = (search: { toString(): string }) => {
    const query = search.toString();
    return query ? `${workspacePath}?${query}` : workspacePath;
  };

  const withJob = productionPageUrl(session.searchWithSyncJobId("", jobId));
  assert.equal(withJob, `${workspacePath}?syncJob=${jobId}`);
  assert.doesNotMatch(withJob, /\?\?/);

  const withoutJob = productionPageUrl(session.clearSyncJobFromSearch(`?run=voc-1&syncJob=${jobId}`));
  assert.equal(withoutJob, `${workspacePath}?run=voc-1`);
  assert.doesNotMatch(withoutJob, /\?\?/);
});

test("mounted sync funnel recovers with GET only across rerender and refresh, while mismatch and failed validation never POST", async () => {
  const valid = await browser.newPage();
  try {
    const calls = await installFunnelRoute(valid, "valid");
    await valid.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?syncJob=job-1&project=${projectId}&run=${runId}`);
    await valid.waitForFunction(() => document.querySelector(".asin-sync-progress"));
    await valid.waitForTimeout(100);
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    assert.equal(await valid.getByText("队列 #3", { exact: true }).count(), 1);
    assert.equal(await valid.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);
    await valid.evaluate(() => (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel());
    await valid.waitForTimeout(100);
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    await valid.reload();
    await valid.waitForTimeout(100);
    assert.equal(calls.get, 2);
    assert.equal(calls.post, 0);
  } finally {
    await valid.close();
  }

  for (const mode of ["mismatch", "failed"] as const) {
    const page = await browser.newPage();
    try {
      const calls = await installFunnelRoute(page, mode);
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?syncJob=job-1&project=${projectId}&run=${runId}`);
      await page.waitForTimeout(100);
      assert.equal(calls.get, 1, mode);
      assert.equal(calls.post, 0, mode);
      await page.waitForTimeout(1_650);
      assert.equal(calls.get, 1, `${mode} must stop polling`);
      assert.equal(calls.post, 0, mode);
    } finally {
      await page.close();
    }
  }
});

test("source-backed page resume context uses the canonical run project instead of a slug workspace", async () => {
  const page = await browser.newPage();
  const calls = { canonicalRun: 0, get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") calls.post += 1;
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syncJob()) });
      }
      if (path.endsWith(`/v1/runs/${runId}`)) {
        calls.canonicalRun += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: {
          id: runId, projectId, mode: "existing-data", status: "running",
          createdBy: "10000000-0000-4000-8000-000000000001", dataCutoffAt: "2026-08-20T00:00:00.000Z",
          createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
        }, stages: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?asins=${asins.join(",")}&project=workspace-slug&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(calls.canonicalRun, 1);
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    assert.equal(await page.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);
  } finally {
    await page.close();
  }
});

test("a run-only URL resolves canonical scope before starting a new sync job", async () => {
  const page = await browser.newPage();
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push({
        method: request.method(), path,
        body: request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") as Record<string, unknown> : null,
      });
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (request.method() === "POST") {
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-1" }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syncJob()) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?project=workspace-slug&run=${runId}`);
    await page.waitForTimeout(200);
    assert.deepEqual(calls.slice(0, 2).map(call => [call.method, call.path]), [
      ["GET", `/api/agent/v1/runs/${runId}`],
      ["POST", "/api/agent/v1/local-data/sync-asins"],
    ]);
    assert.deepEqual(calls[1]?.body, { asins, marketplace: "US", projectId, runId });
  } finally {
    await page.close();
  }
});

test("an invalid run URL neither adopts an unscoped job nor starts a replacement", async () => {
  for (const resumeJobId of ["job-1", null] as const) {
    const page = await browser.newPage();
    const calls = { run: 0, job: 0, post: 0 };
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          calls.run += 1;
          return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) calls.job += 1;
        if (request.method() === "POST") calls.post += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syncJob({ projectId: null, runId: null })) });
      });
      const params = new URLSearchParams({ run: runId, ...(resumeJobId ? { syncJob: resumeJobId } : {}) });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?${params}`);
      await page.waitForTimeout(200);
      assert.equal(calls.run, 1, resumeJobId ?? "run-only");
      assert.equal(calls.job, 0, resumeJobId ?? "run-only");
      assert.equal(calls.post, 0, resumeJobId ?? "run-only");
      assert.equal(await page.locator('[data-sync-resume="invalid"]').count(), 1);
    } finally {
      await page.close();
    }
  }
});

test("production keyword, traffic, and library consumers adopt one URL sync job without replacement posts", async () => {
  for (const tab of ["keywords", "traffic", "library"] as const) {
    const page = await browser.newPage();
    const calls = { get: 0, post: 0 };
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
          calls.get += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syncJob()) });
        }
        if (request.method() === "POST") calls.post += 1;
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=${tab}&run=${runId}&syncJob=job-1`);
      await page.waitForTimeout(200);
      assert.equal(calls.get, 1, tab);
      assert.equal(calls.post, 0, tab);
    } finally {
      await page.close();
    }
  }
});

test("a second authorized run in the same project adopts the winner job without a scope mismatch", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${secondRunId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syncJob({ projectId, runId })) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=keywords&run=${secondRunId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    assert.equal(await page.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);
  } finally {
    await page.close();
  }
});

test("production tab start writes syncJob and preserves canonical run scope", async () => {
  for (const tab of ["keywords", "traffic", "library"] as const) {
    const page = await browser.newPage();
    const posts: Record<string, unknown>[] = [];
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (request.method() === "POST") {
          posts.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
          return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-new")) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), jobId: "job-new" }) });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=${tab}&run=${runId}&start=1`);
      await page.waitForTimeout(200);
      assert.deepEqual(posts, [{ asins, marketplace: "US", projectId, runId }], tab);
      assert.match(page.url(), /syncJob=job-new/, tab);
    } finally {
      await page.close();
    }
  }
});

test("degraded provider warning keeps the current start button to one exact ASIN sync POST", async () => {
  const page = await browser.newPage();
  const syncPosts: Array<{ asins?: string[] }> = [];
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/v1/capabilities")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: "1.0.0",
            capabilities: {
              storage: { configured: true, available: true, reason: null },
              openai: { configured: true, available: true, reason: null },
              sif: { configured: true, available: true, reason: null, checkedAt: null },
              sorftime: { configured: true, available: true, reason: null, checkedAt: null },
              sellerSprite: { configured: true, available: false, reason: "provider secret", checkedAt: null },
              manualVoc: { configured: true, available: false, reason: "manual", },
            },
          }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins") && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            needsSync: true,
            vocPending: [],
            items: asins.map(asin => ({
              asin,
              inCatalog: false,
              keywords: "missing",
              reviews: "ready",
              sales: "ready",
              childSales: "ready",
              priceStrategy: "ready",
              fba: "ready",
              listing: "ready",
              imageRemarks: "ready",
              category: "ready",
              traffic: "ready",
              voc: "ready",
            })),
          }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins") && request.method() === "POST") {
        syncPosts.push(JSON.parse(request.postData() ?? "{}") as { asins?: string[] });
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-new")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), jobId: "job-new" }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&wrapper=progress&manualStart=1`);
    await page.getByRole("button", { name: "拉取缺失数据" }).waitFor();
    assert.equal(await page.getByText("部分数据源不可用，仍可继续分析").count(), 1);
    const started = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === "POST" && new URL(request.url()).pathname.endsWith("/v1/local-data/sync-asins");
    });
    await page.getByRole("button", { name: "拉取缺失数据" }).click();
    await started;
    assert.equal(syncPosts.length, 1);
    assert.deepEqual(syncPosts[0]?.asins, asins);
  } finally {
    await page.close();
  }
});

test("malformed capabilities success response hides the warning without blocking the existing start button", async () => {
  const page = await browser.newPage();
  const syncPosts: Array<{ asins?: string[] }> = [];
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/v1/capabilities")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ schemaVersion: "1.0.0", capabilities: { sellerSprite: {} } }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins") && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            needsSync: true,
            vocPending: [],
            items: asins.map(asin => ({
              asin,
              inCatalog: false,
              keywords: "ready",
              reviews: "ready",
              sales: "ready",
              childSales: "ready",
              priceStrategy: "ready",
              fba: "ready",
              listing: "ready",
              imageRemarks: "ready",
              category: "ready",
              traffic: "ready",
              voc: "ready",
            })),
          }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins") && request.method() === "POST") {
        syncPosts.push(JSON.parse(request.postData() ?? "{}") as { asins?: string[] });
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ jobId: "job-malformed", status: "queued", message: "Queued", stages: [] }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-malformed")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), jobId: "job-malformed" }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&wrapper=progress&manualStart=1`);
    await page.getByRole("button", { name: "拉取缺失数据" }).waitFor();
    assert.equal(await page.locator("[data-provider-warning]").count(), 0);
    const started = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === "POST" && new URL(request.url()).pathname.endsWith("/v1/local-data/sync-asins");
    });
    await page.getByRole("button", { name: "拉取缺失数据" }).click();
    await started;
    assert.equal(syncPosts.length, 1);
    assert.deepEqual(syncPosts[0]?.asins, asins);
  } finally {
    await page.close();
  }
});

test("a failed job stops once, dismisses its URL without posting, and restarts only after an explicit request", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, posts: [] as Record<string, unknown>[] };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "failed", message: "sync failed" }) });
      }
      if (request.method() === "POST") {
        calls.posts.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=keywords&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(1_650);
    assert.equal(calls.get, 1);
    assert.equal(calls.posts.length, 0);
    assert.ok(await page.getByText("sync failed", { exact: true }).count() >= 1);
    await page.getByRole("button", { name: "关闭", exact: true }).click({ timeout: 1_000 });
    await page.waitForTimeout(100);
    assert.doesNotMatch(page.url(), /syncJob=/);
    assert.equal(calls.posts.length, 0);
    await page.getByRole("button", { name: /拉取缺失关键词|强制刷新/ }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(calls.posts, [{ asins, marketplace: "US", projectId, runId }]);
  } finally {
    await page.close();
  }
});

test("a validated failed job keeps automatic restart suppressed across dismiss and a real remount", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "failed", message: "durable failed" }) });
      }
      if (request.method() === "POST") {
        calls.post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(150);
    assert.equal(calls.get, 1);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await page.waitForTimeout(200);
    assert.equal(calls.post, 0, "failed validation must leave no automatic replacement start after remount");
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(120);
    assert.equal(calls.post, 1, "only explicit restart clears failed-job suppression");
  } finally {
    await page.close();
  }
});

test("a restored failed job is folded into history and expands without POST", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "failed", message: "historical EPERM" }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 1);
    assert.equal(await page.locator(".sync-progress-list").count(), 0);
    await page.getByRole("button", { name: "查看详情", exact: true }).click();
    assert.equal(await page.locator('[data-sync-history="expanded"]').count(), 1);
    assert.equal(await page.locator(".sync-progress-list").count(), 1);
    assert.equal(calls.post, 0);
  } finally {
    await page.close();
  }
});

test("a job started in this page stays expanded when it fails immediately", async () => {
  const page = await browser.newPage();
  let post = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (request.method() === "POST") {
        post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-new")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), jobId: "job-new", status: "failed", message: "current failure" }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&manualStart=1&run=${runId}`);
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(1_700);
    assert.equal(post, 1);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 0);
    assert.ok(await page.getByText("current failure", { exact: true }).count() >= 1);
    assert.equal(await page.locator(".sync-progress-list").count(), 1);
  } finally {
    await page.close();
  }
});

test("a restored failed job with pending publication keeps terminal actions gated while folded", async () => {
  const page = await browser.newPage();
  const calls = { post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "failed", message: "historical pending", publication: { status: "pending" },
        }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 1);
    assert.equal(await page.getByRole("button", { name: "查看详情", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "重新发起", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "关闭", exact: true }).count(), 0);
    assert.equal(calls.post, 0);
  } finally {
    await page.close();
  }
});

test("a restored pending-publication failure hides resume actions after expanding history", async () => {
  const page = await browser.newPage();
  let post = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "failed", message: "historical resumable pending", publication: { status: "pending" },
          resumableStages: ["catalog"], stages: [{ id: "catalog", kind: "auto", status: "failed" }],
        }) });
      }
      if (request.method() === "POST") post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&primary=1&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "查看详情", exact: true }).click();
    assert.equal(await page.locator('[data-sync-history="expanded"]').count(), 1);
    assert.equal(await page.getByRole("button", { name: "续跑失败阶段", exact: true }).count(), 0);
    assert.equal(post, 0);
  } finally {
    await page.close();
  }
});

test("a current failed job with pending publication keeps terminal actions visible", async () => {
  const page = await browser.newPage();
  const calls = { post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (request.method() === "POST") {
        calls.post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-new")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), jobId: "job-new", status: "failed", message: "current pending", publication: { status: "pending" },
        }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&manualStart=1&run=${runId}`);
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(1_700);
    assert.equal(calls.post, 1);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: "重新发起", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "关闭", exact: true }).count(), 1);
  } finally {
    await page.close();
  }
});

test("a current failed job stays expanded after switching tabs and remounting", async () => {
  const page = await browser.newPage();
  let post = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (request.method() === "POST") {
        post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-new")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), jobId: "job-new", status: "failed", message: "current remount failure",
        }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&manualStart=1&run=${runId}`);
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(1_700);
    assert.equal(post, 1);
    await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), "keywords");
    await page.waitForTimeout(50);
    await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), "overview");
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 0);
    assert.equal(await page.locator(".sync-progress-list").count(), 1);
  } finally {
    await page.close();
  }
});

test("a restored job observed running stays expanded after remount and later failure", async () => {
  const page = await browser.newPage();
  let get = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        get += 1;
        const status = get === 1 ? "running" : "failed";
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status, message: status === "running" ? "historical running" : "historical later failure",
        }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(100);
    assert.equal(get, 1);
    await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), "keywords");
    await page.waitForTimeout(50);
    await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), "overview");
    await page.waitForTimeout(200);
    assert.ok(get >= 2);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 0);
    assert.equal(await page.locator(".sync-progress-list").count(), 1);
  } finally {
    await page.close();
  }
});

test("storage failure retains completed and failed URL pointers without reload or automatic replacement", async () => {
  for (const status of ["completed", "failed"] as const) {
    const page = await browser.newPage();
    const calls = { get: 0, post: 0 };
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
          calls.get += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status, message: `${status} storage failure`, needsReload: true }) });
        }
        if (request.method() === "POST") {
          calls.post += 1;
          return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&storage=fail&run=${runId}&syncJob=job-1`);
      await page.waitForTimeout(200);
      assert.match(page.url(), /syncJob=job-1/, `${status} keeps its authoritative URL pointer`);
      assert.equal(calls.post, 0);
      assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0, `${status} does not schedule reload without a durable record`);
      await page.evaluate(() => (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel());
      await page.waitForTimeout(100);
      assert.equal(calls.post, 0, `${status} cannot auto-start on rerender`);
      await page.reload();
      await page.waitForTimeout(150);
      assert.equal(calls.post, 0, `${status} cannot auto-start on a fresh mount`);
      if (status === "failed") {
        await page.getByRole("button", { name: "重新发起", exact: true }).click();
        await page.waitForTimeout(120);
        assert.equal(calls.post, 1, "an explicit failed-job restart may clear the retained URL pointer and start once");
      }
    } finally {
      await page.close();
    }
  }
});

test("the production overview progress wrapper preserves a failed-storage completed pointer", async () => {
  for (const status of ["completed", "completed-with-gaps"] as const) {
    const page = await browser.newPage();
    const calls = { get: 0, post: 0 };
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
          calls.get += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status, message: `${status} retained`, needsReload: true }) });
        }
        if (request.method() === "POST") {
          calls.post += 1;
          return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&wrapper=progress&storage=fail&run=${runId}&syncJob=job-1`);
      await page.waitForTimeout(200);
      assert.equal(calls.get, 1, `${status} terminal read once`);
      assert.match(page.url(), /syncJob=job-1/, `${status} keeps authoritative pointer when persistence fails`);
      assert.equal(calls.post, 0);
      assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0);
      await page.reload();
      await page.waitForTimeout(150);
      assert.equal(calls.post, 0, `${status} does not auto-start after remount`);
    } finally {
      await page.close();
    }
  }
});

test("retained completed terminal UI exposes exactly one explicit restart in every production consumer", async () => {
  for (const status of ["completed", "completed-with-gaps"] as const) {
    for (const tab of ["overview", "keywords", "traffic", "library"] as const) {
      const page = await browser.newPage();
      const calls = { get: 0, post: 0 };
      try {
        await page.route("**/api/agent/**", route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path.endsWith(`/v1/runs/${runId}`)) {
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
          }
          if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
            calls.get += 1;
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status, message: `${tab}/${status}`, needsReload: true }) });
          }
          if (request.method() === "POST") {
            calls.post += 1;
            return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
          }
          return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
        });
        const wrapper = tab === "overview" ? "&wrapper=progress" : "";
        await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=${tab}${wrapper}&storage=fail&run=${runId}&syncJob=job-1`);
        await page.waitForTimeout(160);
        assert.equal(await page.getByRole("button", { name: "重新发起", exact: true }).count(), 1, `${tab}/${status} exposes explicit retained-terminal restart`);
        await page.getByRole("button", { name: "重新发起", exact: true }).click();
        await page.waitForTimeout(130);
        assert.equal(calls.get, 1, `${tab}/${status} does not reread the retired terminal job`);
        assert.equal(calls.post, 1, `${tab}/${status} starts exactly one replacement job`);
        assert.match(page.url(), /syncJob=job-new/, `${tab}/${status} writes the replacement pointer`);
      } finally {
        await page.close();
      }
    }
  }
});

test("primary administrator resumes only the original failed category with one POST and polling restarts", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, resumePost: 0, replacementPost: 0 };
  let releaseResume!: () => void;
  const resumeReleased = new Promise<void>((resolve) => { releaseResume = resolve; });
  const terminal = {
    ...syncJob(),
    status: "completed",
    message: "permanent category connect timeout",
    stages: [
      { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "category", label: "Category", kind: "auto", status: "failed", estimatedSeconds: 1 },
      { id: "alexa_voc", label: "Alexa VOC", kind: "manual", status: "manual", estimatedSeconds: 0 },
    ],
    resumableStages: ["category"],
    asinProgress: {
      [asins[0]]: {
        catalog: { status: "ready", reason: null, updatedAt: "2026-08-23T00:00:00.000Z" },
        category: { status: "timeout", reason: "CONNECT_TIMEOUT", updatedAt: "2026-08-23T00:00:00.000Z" },
      },
    },
  };
  try {
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/admin/sync-asins/job-1/resume")) {
        calls.resumePost += 1;
        await resumeReleased;
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            job: { ...terminal, status: "queued", message: "Failed stages queued for explicit resume", resumableStages: [], stages: terminal.stages.map(stage => stage.id === "category" ? { ...stage, status: "pending" } : stage) },
            resumedStages: ["category"],
            reused: false,
          }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        const payload = calls.get === 1
          ? terminal
          : { ...terminal, status: "running", message: "repair running", resumableStages: [], stages: terminal.stages.map(stage => stage.id === "category" ? { ...stage, status: "active" } : stage) };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      }
      if (request.method() === "POST") calls.replacementPost += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&primary=1&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(180);
    const resumeButton = page.getByRole("button", { name: "续跑失败阶段", exact: true });
    assert.equal(await resumeButton.count(), 1);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === "续跑失败阶段") as HTMLButtonElement;
      button.click();
      button.click();
    });
    await page.waitForTimeout(50);
    assert.equal(calls.resumePost, 1, "concurrent clicks share one repair request");
    releaseResume();
    await page.getByText("失败阶段已提交续跑", { exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.match(page.url(), /syncJob=job-1/, "repair keeps the original URL pointer");
    assert.equal(calls.replacementPost, 0, "repair never creates a replacement job");
    assert.ok(calls.get >= 2, "polling restarts for the original job");
  } finally {
    releaseResume?.();
    await page.close();
  }
});

test("explicit resume reopens an exhausted same-version terminal stage before polling", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const calls = { jobs: 0, outputs: 0, resumePosts: 0, replacementPosts: 0 };
  let markResumedOutputStarted!: () => void;
  const resumedOutputStarted = new Promise<void>(resolve => { markResumedOutputStarted = resolve; });
  let releaseResumedOutput!: () => void;
  const resumedOutputReleased = new Promise<void>(resolve => { releaseResumedOutput = resolve; });
  const terminal = {
    ...syncJob(),
    status: "completed",
    jobVersion: 1,
    message: "category output exhausted",
    resumableStages: ["category"],
    stages: [{ id: "category", label: "Category", kind: "auto", status: "failed", estimatedSeconds: 1 }],
  };
  const gap = { state: "failed", reasonCode: "CONNECTOR_FAILED" } as const;
  const resumedProjection = {
    jobId: "job-1", projectId, runId, stage: "category", stageStatus: "failed",
    jobVersion: 1, outputVersion: 1, gap,
    contentHash: stageOutputHash("category", { gap }),
    updatedAt: "2026-08-28T00:00:05.000Z",
  };
  try {
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/admin/sync-asins/job-1/resume")) {
        calls.resumePosts += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({
          job: { ...terminal, message: "same-version terminal resume" },
          resumedStages: ["category"],
          reused: false,
        }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(terminal) });
      }
      if (path.endsWith("/stages/category/output")) {
        calls.outputs += 1;
        if (calls.outputs < 4) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        markResumedOutputStarted();
        await resumedOutputReleased;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resumedProjection) });
      }
      if (request.method() === "POST") calls.replacementPosts += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&primary=1&run=${runId}&syncJob=job-1`);
    await waitForTestCondition(() => calls.outputs === 1);
    await page.clock.fastForward(1_500);
    await waitForTestCondition(() => calls.outputs === 2);
    await page.clock.fastForward(1_500);
    await waitForTestCondition(() => calls.outputs === 3);
    const resumeButton = page.getByRole("button", { name: "续跑失败阶段", exact: true });
    await resumeButton.waitFor();
    await resumeButton.click();
    await Promise.race([
      resumedOutputStarted,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("post-resume terminal output did not restart")), 5_000)),
    ]);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages), []);
    releaseResumedOutput();
    await waitForTestCondition(() => calls.outputs === 4);
    await page.waitForFunction(() => (window as unknown as { stageOutputEvents: { stages: string[] } }).stageOutputEvents.stages.includes("category"));
    assert.deepEqual(calls, { jobs: 4, outputs: 4, resumePosts: 1, replacementPosts: 0 });
  } finally {
    releaseResumedOutput?.();
    await page.close();
  }
});

test("ordinary member cannot see or invoke failed-stage repair", async () => {
  const page = await browser.newPage();
  let resumePosts = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/admin/sync-asins/job-1/resume")) resumePosts += 1;
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...syncJob(),
            status: "completed-with-gaps",
            message: "member gaps",
            stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "failed", estimatedSeconds: 1 }],
          }),
        });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&storage=fail&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(180);
    assert.equal(await page.getByRole("button", { name: "续跑失败阶段", exact: true }).count(), 0);
    assert.equal(resumePosts, 0);
  } finally {
    await page.close();
  }
});

test("missing and mismatched job reads never create a terminal tombstone", async () => {
  for (const mode of ["missing", "mismatch"] as const) {
    const page = await browser.newPage();
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith(`/v1/runs/${runId}`)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        }
        if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
          return route.fulfill(mode === "missing"
            ? { status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) }
            : { status: 200, contentType: "application/json", body: JSON.stringify(syncJob({ projectId: "10000000-0000-4000-8000-000000000099", runId })) });
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("amz-lens.sync-terminal.v1:"))), false, `${mode} never records an unauthorized terminal result`);
    } finally {
      await page.close();
    }
  }
});

test("all production consumers retain terminal progress across refresh and stop terminal polling", async () => {
  for (const tab of ["overview", "keywords", "traffic", "library"] as const) {
    for (const status of ["completed", "completed-with-gaps"] as const) {
      const page = await browser.newPage();
      const calls = { get: 0, post: 0, health: 0 };
      const shouldNotice = tab === "overview" && status === "completed";
      const navigations: string[] = [];
      page.on("framenavigated", frame => {
        if (frame !== page.mainFrame()) return;
        navigations.push(frame.url());
      });
      try {
        await page.route("**/api/health", route => {
          calls.health += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifactId: nextArtifactId }) });
        });
        await page.route("**/api/agent/**", route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path.endsWith(`/v1/runs/${runId}`)) {
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
          }
          if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
            calls.get += 1;
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
              ...syncJob(),
              status,
              message: `${status} result`,
              ...(shouldNotice ? { publication: {
                status: "applied",
                requestId: publicationRequestId,
                artifactId: nextArtifactId,
                requestedAt: publicationRequestedAt,
                appliedAt: "2026-08-25T00:00:05.000Z",
              } } : {}),
              resumableStages: [],
              stages: [
                { id: "catalog", label: "商品底库", kind: "auto", status: "done", estimatedSeconds: 1 },
                { id: "keywords", label: "关键词", kind: "auto", status: status === "completed" ? "done" : "partial", estimatedSeconds: 1 },
                { id: "traffic", label: "流量", kind: "auto", status: status === "completed" ? "done" : "partial", estimatedSeconds: 1 },
              ],
            }) });
          }
          if (request.method() === "POST") calls.post += 1;
          return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
        });
        await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=${tab}&artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
        if (shouldNotice) {
          await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor();
        } else {
          await page.waitForTimeout(200);
        }
        assert.equal(calls.get, 1, `${tab}/${status} terminal read`);
        assert.equal(calls.post, 0, `${tab}/${status} no replacement start`);
        assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1", `${tab}/${status} keeps the terminal pointer`);
        assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
        assert.ok(await page.getByText(`${status} result`, { exact: true }).count() >= 1, `${tab}/${status} retains terminal result`);
        assert.equal(await page.getByText("商品底库", { exact: true }).count(), 1, `${tab}/${status} retains terminal stages`);
        if (status === "completed-with-gaps") {
          assert.equal(await page.getByRole("button", { name: "收起", exact: true }).count(), 1, `${tab} gap result is terminal UI`);
        }
        await page.evaluate(() => (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel());
        await page.waitForTimeout(200);
        assert.equal(calls.get, 1, `${tab}/${status} no terminal poll after rerender`);
        assert.equal(calls.post, 0, `${tab}/${status} no POST after cleanup`);
        assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents.completions), 1);
        if (shouldNotice) {
          assert.equal(await page.getByText("新数据已发布，请手动刷新", { exact: true }).count(), 1);
          assert.equal(new URL(page.url()).searchParams.get("webArtifact"), null);
          assert.equal(navigations.length, 1, "overview/completed never navigates automatically");
          assert.equal(calls.health, 0, "overview/completed starts no artifact health work");
        }
        assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0, `${tab}/${status} does not schedule convergence`);

        await page.reload();
        await page.waitForTimeout(200);
        assert.equal(calls.get, 2, `${tab}/${status} refresh performs one terminal GET`);
        assert.equal(calls.post, 0, `${tab}/${status} refresh remains GET-only`);
        assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1", `${tab}/${status} refresh keeps the same pointer`);
        assert.ok(await page.getByText(`${status} result`, { exact: true }).count() >= 1, `${tab}/${status} refresh restores the terminal message`);
        assert.equal(await page.getByText("商品底库", { exact: true }).count(), 1, `${tab}/${status} refresh restores terminal stages`);
        await page.waitForTimeout(1_650);
        assert.equal(calls.get, 2, `${tab}/${status} restored terminal result does not resume polling`);
        assert.equal(calls.post, 0, `${tab}/${status} restored terminal result never POSTs`);
        assert.equal(calls.health, 0, `${tab}/${status} never probes artifact health`);

        await page.getByRole("button", { name: "收起", exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.get("syncJob"), null, `${tab}/${status} explicit dismiss clears the pointer`);
        await page.reload();
        await page.waitForTimeout(150);
        assert.equal(calls.get, 2, `${tab}/${status} dismissed terminal result is not restored`);
        assert.equal(calls.post, 0, `${tab}/${status} dismiss never POSTs`);
      } finally {
        await page.close();
      }
    }
  }
});

test("slug-shaped workspace hydration gates resume until canonical ASIN and marketplace state is ready", async () => {
  const page = await browser.newPage();
  const calls = { run: 0, get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        calls.run += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), marketplace: "DE" }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=keywords&hydrate=async&hydrationMarket=DE&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(calls.run, 1, "run authorization may resolve first");
    assert.equal(calls.get, 0, "job read waits for workspace hydration");
    assert.equal(calls.post, 0, "workspace hydration cannot start a job");
    await page.evaluate(() => (window as unknown as { hydrateSyncWorkspace(): void }).hydrateSyncWorkspace());
    await page.waitForTimeout(200);
    assert.equal(calls.get, 1, "hydrated canonical workspace adopts once");
    assert.equal(calls.post, 0, "hydrated resume is GET-only");
    assert.equal(await page.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);
  } finally {
    await page.close();
  }
});

test("project-query workspace hydration blocks non-US resume until the authoritative project is ready", async () => {
  const page = await browser.newPage();
  const calls = { run: 0, get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        calls.run += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), marketplace: "DE" }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=traffic&project=workspace-query&hydrate=async&hydrationMarket=DE&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(calls.run, 1);
    assert.equal(calls.get, 0);
    assert.equal(calls.post, 0);
    await page.evaluate(() => (window as unknown as { hydrateSyncWorkspace(): void }).hydrateSyncWorkspace());
    await page.waitForTimeout(200);
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    assert.equal(await page.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);
  } finally {
    await page.close();
  }
});

test("terminal handling survives production consumer remounts and an explicit restart starts one new job", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "completed result" }) });
      }
      if (request.method() === "POST") {
        calls.post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    for (const tab of ["keywords", "traffic", "library"] as const) {
      await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), tab);
      await page.waitForTimeout(100);
    }
    assert.equal(calls.get, 1, "terminal job read once across remounts");
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
    assert.equal(calls.post, 0);
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(150);
    assert.equal(calls.post, 1, "explicit restart creates one replacement job");
    assert.match(page.url(), /syncJob=job-new/);
  } finally {
    await page.close();
  }
});

test("overview automatic readiness no-op retains the completed snapshot until an explicit restart", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "overview complete" }) });
      }
      if (request.method() === "POST") {
        calls.post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as unknown as { runOverviewAutoCheck(): void }).runOverviewAutoCheck());
    await page.waitForTimeout(100);
    assert.equal(calls.post, 0);
    assert.equal(await page.getByText("overview complete", { exact: true }).count(), 1);
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(150);
    assert.equal(calls.post, 1);
  } finally {
    await page.close();
  }
});

test("terminal publication blocks through two pending GETs then shows one manual artifact refresh notice", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0, health: 0 };
  const navigations: string[] = [];
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  try {
    await page.route("**/api/health", route => {
      calls.health += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifactId: nextArtifactId }) });
    });
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        const publication = calls.get < 3
          ? { status: "pending", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt }
          : { status: "applied", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt, appliedAt: "2026-08-25T00:00:05.000Z" };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(),
          status: "completed-with-gaps",
          message: "business progress retained",
          publication,
          resumableStages: ["traffic"],
          stages: [
            { id: "catalog", label: "商品底库", kind: "auto", status: "done", estimatedSeconds: 1 },
            { id: "traffic", label: "流量", kind: "auto", status: "failed", estimatedSeconds: 1 },
          ],
        }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });

    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&primary=1&artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
    await page.getByText("数据已生成，正在发布到页面，请勿重复提交。", { exact: true }).waitFor();
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    assert.deepEqual({
      resume: await page.getByRole("button", { name: "续跑失败阶段", exact: true }).count(),
      restart: await page.getByRole("button", { name: "重新发起", exact: true }).count(),
      dismiss: await page.getByRole("button", { name: "收起", exact: true }).count(),
    }, { resume: 0, restart: 0, dismiss: 0 }, "terminal actions are unavailable while publication is pending");
    assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1", "pending publication cannot dismiss the canonical job pointer");
    assert.deepEqual(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents), { completions: 0, reloads: 0 });

    await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor({ timeout: 6_000 });
    assert.ok(calls.get >= 3, "pending, pending, and applied are all read from the same job");
    assert.equal(calls.post, 0, "publication polling never creates or resumes a job");
    assert.equal(calls.health, 0, "applied publication starts no health probe");
    assert.equal(new URL(page.url()).searchParams.get("run"), runId);
    assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1");
    assert.equal(new URL(page.url()).searchParams.get("webArtifact"), null);
    assert.equal(navigations.length, 1);
    assert.equal(await page.getByRole("button", { name: "续跑失败阶段", exact: true }).count(), 1, "applied publication restores resumable repair");
    assert.equal(await page.getByRole("button", { name: "重新发起", exact: true }).count(), 1, "applied publication restores explicit restart");
    await page.waitForTimeout(1_700);
    assert.equal(calls.post, 0, "the converged page does not create or resume a job");
    assert.deepEqual(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents), { completions: 1, reloads: 0 });
  } finally {
    await page.close();
  }
});

test("an applied artifact already on the root reports published without reloading", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0, health: 0 };
  const navigations: string[] = [];
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  try {
    await page.route("**/api/health", route => {
      calls.health += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "completed", message: "same artifact", publication: {
            status: "applied", requestId: publicationRequestId, artifactId: currentArtifactId,
            requestedAt: publicationRequestedAt, appliedAt: "2026-08-25T00:00:05.000Z",
          },
        }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
    await page.getByText("数据已发布。", { exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.deepEqual(calls, { get: 1, post: 0, health: 0 });
    assert.equal(await page.getByText("新数据已发布，请手动刷新", { exact: true }).count(), 0);
    assert.equal(navigations.length, 1);
    assert.equal(await page.getByRole("button", { name: "重新发起", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "收起", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0);
  } finally {
    await page.close();
  }
});

test("failed publication preserves business progress, shows fixed copy, and never reloads", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0, health: 0 };
  const navigations: string[] = [];
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  try {
    await page.route("**/api/health", route => {
      calls.health += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "completed-with-gaps", message: "business progress retained",
          stages: [{ id: "catalog", label: "商品底库", kind: "auto", status: "done", estimatedSeconds: 1 }],
          publication: {
            status: "failed", requestId: publicationRequestId, artifactId: nextArtifactId,
            requestedAt: publicationRequestedAt, failedAt: "2026-08-25T00:00:05.000Z", code: "WEB_PUBLICATION_FAILED",
          },
        }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
    await page.getByRole("alert").filter({ hasText: "数据已生成，但页面发布失败。数据不会重新抓取。" }).waitFor();
    assert.equal(await page.getByText("business progress retained", { exact: true }).count(), 1);
    assert.equal(await page.getByText("商品底库", { exact: true }).count(), 1);
    assert.deepEqual(calls, { get: 1, post: 0, health: 0 });
    assert.equal(await page.getByText("新数据已发布，请手动刷新", { exact: true }).count(), 0);
    assert.equal(navigations.length, 1);
    assert.equal(await page.getByRole("button", { name: "重新发起", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "收起", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0);
  } finally {
    await page.close();
  }
});

test("legacy needsReload without publication never schedules the retired fixed-delay reload", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/api/agent/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "legacy terminal", needsReload: true }) });
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
    await page.getByText("legacy terminal", { exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.getByText("MCP 模块已完成，页面将在数秒后自动刷新。", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0);
  } finally {
    await page.close();
  }
});

test("manual artifact refresh notice survives terminal funnel tab switches without artifact work", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0, health: 0 };
  const navigations: string[] = [];
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  try {
    await page.route("**/api/health", route => {
      calls.health += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifactId: nextArtifactId }) });
    });
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "reload complete", publication: {
          status: "applied",
          requestId: publicationRequestId,
          artifactId: nextArtifactId,
          requestedAt: publicationRequestedAt,
          appliedAt: "2026-08-25T00:00:05.000Z",
        } }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
    await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor();
    for (const tab of ["keywords", "traffic", "library"] as const) {
      await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), tab);
      await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor();
    }
    await page.waitForTimeout(1_700);
    assert.deepEqual(calls, { get: 1, post: 0, health: 0 });
    assert.equal(navigations.length, 1);
  } finally {
    await page.close();
  }
});

test("manual artifact refresh shows one notice without health or navigation", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0, health: 0 };
  const navigations: string[] = [];
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  try {
    await page.route("**/api/health", route => {
      calls.health += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifactId: nextArtifactId }) });
    });
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", publication: {
          status: "applied", requestId: publicationRequestId, artifactId: nextArtifactId,
          requestedAt: publicationRequestedAt, appliedAt: "2026-08-25T00:00:05.000Z",
        } }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) });
    });

    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
    await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor();
    await page.waitForTimeout(1_700);
    assert.deepEqual(calls, { get: 1, post: 0, health: 0 });
    assert.equal(navigations.length, 1);
    assert.equal(new URL(page.url()).searchParams.get("webArtifact"), null);
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents),
      { completions: 1, reloads: 0 },
    );
  } finally {
    await page.close();
  }
});

test("the production terminal owner restores progress without a reload loop until explicit restart", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "reload-safe", needsReload: true }) });
      }
      if (request.method() === "POST") {
        calls.post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(100);
    assert.equal(calls.get, 1);
    assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1");
    await page.reload();
    await page.waitForTimeout(200);
    assert.equal(calls.get, 2, "the retained URL restores the terminal snapshot once");
    assert.equal(calls.post, 0, "a durable matching tombstone blocks readiness-driven replacement");
    assert.equal(await page.getByText("reload-safe", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 0, "the restored tombstone does not schedule another needsReload callback");
    await page.waitForTimeout(1_650);
    assert.equal(calls.get, 2, "the restored terminal snapshot does not restart polling");
    const restartPost = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === "POST" && new URL(request.url()).pathname.endsWith("/v1/local-data/sync-asins");
    });
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await restartPost;
    assert.equal(calls.post, 1, "only the real explicit start clears the production owner tombstone");
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("syncJob") === "job-new");
    assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-new");
  } finally {
    await page.close();
  }
});

test("a delayed terminal read never overlaps another poll or duplicates terminal side effects", async () => {
  const page = await browser.newPage();
  let releaseFirst: (() => void) | null = null;
  let firstStarted!: () => void;
  const firstRequest = new Promise<void>(resolve => { firstStarted = resolve; });
  const calls = { get: 0, post: 0, active: 0, maxActive: 0 };
  try {
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        calls.active += 1;
        calls.maxActive = Math.max(calls.maxActive, calls.active);
        if (calls.get === 1) {
          firstStarted();
          await new Promise<void>(resolve => { releaseFirst = resolve; });
        }
        calls.active -= 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "delayed complete", needsReload: true }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await firstRequest;
    await page.waitForTimeout(1_700);
    releaseFirst?.();
    await page.waitForTimeout(200);
    assert.equal(calls.maxActive, 1);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
    assert.equal(calls.post, 0);
  } finally {
    releaseFirst?.();
    await page.close();
  }
});

async function routeClockedJobSequence(page: import("playwright").Page, jobs: Record<string, unknown>[]) {
  const calls = { jobs: 0, posts: 0 };
  await page.route("**/api/agent/**", route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") calls.posts += 1;
    if (pathname.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
    if (pathname.endsWith("/v1/local-data/sync-asins/job-1")) {
      const body = jobs[Math.min(calls.jobs, jobs.length - 1)]!;
      calls.jobs += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  return calls;
}

async function gotoAfterFirstClockedJob(page: import("playwright").Page, url: string) {
  const firstJob = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/v1/local-data/sync-asins/job-1"));
  await page.goto(url);
  await firstJob;
}

async function waitForTestCondition(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("terminal output exhaustion clears the poll and clock exactly once", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const calls = { jobs: 0, outputs: 0, posts: 0 };
  const navigations: string[] = [];
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST") calls.posts += 1;
      if (pathname.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      if (pathname.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "completed", jobVersion: 11, message: "bounded terminal",
          stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 }],
        }) });
      }
      if (pathname.endsWith("/stages/keywords/output")) {
        calls.outputs += 1;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&realStageConsumers=1&run=${runId}&syncJob=job-1`);
    await waitForTestCondition(() => calls.outputs === 1);
    await page.clock.fastForward(1_500);
    await waitForTestCondition(() => calls.outputs === 2);
    await page.clock.fastForward(1_500);
    await waitForTestCondition(() => calls.outputs === 3);
    await page.getByText("阶段结果暂不可用，已停止自动重试。", { exact: true }).waitFor();
    assert.deepEqual(calls, { jobs: 3, outputs: 3, posts: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
    const commits = await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits);
    await page.clock.fastForward(10_000);
    assert.deepEqual(calls, { jobs: 3, outputs: 3, posts: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits), commits);
    assert.equal(navigations.length, 1);
  } finally {
    await page.close();
  }
});

for (const [label, publication] of [
  ["omitted", undefined],
  ["applied", { status: "applied", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt, appliedAt: "2026-08-25T00:00:05.000Z" }],
  ["failed", { status: "failed", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt, failedAt: "2026-08-25T00:00:05.000Z", code: "WEB_PUBLICATION_FAILED" }],
] as const) {
  test(`publication settlement stops both timers: ${label}`, async () => {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
    const calls = { jobs: 0, posts: 0 };
    const navigations: string[] = [];
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "POST") calls.posts += 1;
        if (pathname.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        if (pathname.endsWith("/v1/local-data/sync-asins/job-1")) {
          calls.jobs += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", jobVersion: 4, publication }) });
        }
        return route.fulfill({ status: 404, body: "{}" });
      });
      await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
      await waitForTestCondition(async () => await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions) === 1);
      await page.clock.fastForward(5_000);
      assert.deepEqual(calls, { jobs: 1, posts: 0 });
      assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
      assert.equal(navigations.length, 1);
    } finally { await page.close(); }
  });
}

test("pending publication keeps timers until applied", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const pending = { status: "pending", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt } as const;
  const applied = { ...pending, status: "applied", appliedAt: "2026-08-25T00:00:05.000Z" } as const;
  const calls = await routeClockedJobSequence(page, [
    { ...syncJob(), status: "completed", jobVersion: 4, publication: pending },
    { ...syncJob(), status: "completed", jobVersion: 4, publication: pending },
    { ...syncJob(), status: "completed", jobVersion: 5, publication: applied },
  ]);
  try {
    await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
    await page.clock.fastForward(1_500);
    await waitForTestCondition(() => calls.jobs === 2);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 0);
    await page.clock.fastForward(1_500);
    await waitForTestCondition(async () => calls.jobs === 3 && await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions) === 1);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
    await page.clock.fastForward(10_000);
    assert.deepEqual(calls, { jobs: 3, posts: 0 });
  } finally { await page.close(); }
});

for (const status of ["queued", "running", "base-ready", "enriching"] as const) {
  test(`running sync keeps stream and clock: ${status}`, async () => {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
    const calls = await routeClockedJobSequence(page, [{ ...syncJob(), status, jobVersion: 4 }]);
    try {
      await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
      const before = await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits);
      await page.clock.fastForward(1_500);
      await waitForTestCondition(() => calls.jobs === 2);
      await page.clock.fastForward(1_500);
      await waitForTestCondition(() => calls.jobs === 3);
      assert.equal(calls.jobs, 3);
      assert.equal(calls.posts, 0);
      assert.ok(await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits) > before);
    } finally { await page.close(); }
  });
}

test("legacy observations remain live", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const calls = await routeClockedJobSequence(page, [
    { ...syncJob(), status: "running", jobVersion: undefined, message: "legacy running" },
    { ...syncJob(), status: "completed", jobVersion: undefined, message: "legacy completed" },
  ]);
  try {
    await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
    await page.clock.fastForward(1_500);
    await page.getByText("legacy completed", { exact: true }).waitFor();
    assert.deepEqual(calls, { jobs: 2, posts: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
  } finally { await page.close(); }
});

test("logout scope cancellation clears the active clock for the same job", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const calls = { jobs: 0, posts: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") calls.posts += 1;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "running", jobVersion: 4 }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await gotoAfterFirstClockedJob(page, `${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
    await waitForTestCondition(() => calls.jobs === 1);
    const beforeLogout = await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits);
    await page.evaluate(() => (window as unknown as { logoutStageOutputs(): void }).logoutStageOutputs());
    await waitForTestCondition(async () => await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits) > beforeLogout);
    await new Promise(resolve => setTimeout(resolve, 50));
    const afterScopeCleanup = await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits);
    await page.clock.fastForward(10_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits), afterScopeCleanup);
    assert.deepEqual(calls, { jobs: 1, posts: 0 });
  } finally {
    await page.close();
  }
});
