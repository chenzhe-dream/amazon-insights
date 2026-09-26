import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { refreshedCatalog } from "../../app/competitor-data";
import { exportVersionFixture } from "./helpers/project-export-fixture";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
}

test("merged full VOC page reads pinned published output on direct entry and reload instead of stale generated reviews", async t => {
  const server = await createServer({ configFile: false, cacheDir: `test-results/voc-review-page-vite-${process.pid}`, define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  t.after(() => server.close());
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const catalog = refreshedCatalog.slice(0, 3);
  assert.equal(catalog.length, 3);
  const asins = catalog.map(product => product.asin);
  const projectId = "10000000-0000-4000-8000-000000000001";
  const organizationId = "018f1f5c-60f0-4b7a-8000-000000000002";
  const runId = "10000000-0000-4000-8000-000000000002";
  const jobId = "10000000-0000-4000-8000-000000000003";
  const project = { id: projectId, sourceProjectId:projectId, kind: "analysis", slug: "merged-voc", name: "VOC集成验证", majorCategory: null, categoryLabel: null, marketplace: "US", asins, note: null, createdBy: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
  const data = { analysisByAsin: { [asins[0]]: { asin: asins[0], marketplace: "US", status: "ready", sampledReviews: 33, mentionTopics: 1, fetchedAt: "2026-09-10T00:00:00Z", blocks: [{ key: "positives", label: "好评点", rows: [{ label: "集成验证稳定光线", sharePct: 24.24, metricKind: "review_sample_incidence", numerator: 8, denominator: 33, reason: "fixture evidence" }] }] } }, ratingByAsin: {} };
  const gap = { state: "partial", reasonCode: "UPSTREAM_EMPTY", items: asins.slice(1).map(asin => ({ asin, causeCode: "UPSTREAM_EMPTY" })) };
  const projection = { projectId, runId, jobId, jobVersion: 12, outputVersion: 2, updatedAt: "2026-09-10T00:00:00Z", stage: "reviews", stageStatus: "partial", data, gap, contentHash: createHash("sha256").update(JSON.stringify(canonical({ stage: "reviews", data, gap }))).digest("hex") };
  const job = { jobId, jobVersion: 12, marketplace: "US", asins, scope: { projectId, runId }, status: "completed", stages: [{ id: "reviews", status: "partial" }] };
  const baseline = exportVersionFixture();
  const version = {...baseline, organizationId, projectId, runId, jobId, asins, catalog,
    stageOutputs:{...baseline.stageOutputs,reviews:projection}};
  let outputs = 0;
  const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml(new URL(route.request().url()).pathname, readFileSync("tests/agent/helpers/primary-admin-browser-harness.html", "utf8")) });
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/projects" || path === "/api/agent/v1/local-data/projects") return reply({ projects: [project] });
    if (path === `/api/agent/v1/local-data/projects/${project.slug}` || path === `/api/agent/v1/local-data/projects/${projectId}`) return reply({ project });
    if (path === `/api/agent/v1/projects/${projectId}`) return reply({project:{...project,organizationId,currentRunId:null}});
    if (path === `/api/agent/v1/local-data/projects/${projectId}/current-display-version`) { outputs++; return reply(version); }
    if (path === `/api/agent/v1/local-data/projects/${projectId}/current-sync-job`) return reply({},404);
    if (path === "/api/alexa-voc") return reply({records:[]});
    if (path === `/api/agent/v1/runs/${runId}`) return reply({ run: { id: runId, projectId } });
    if (path === `/api/agent/v1/local-data/sync-asins/${jobId}`) return reply(job);
    if (path === `/api/agent/v1/projects/${projectId}/runs/${runId}/sync-jobs/${jobId}/stages/reviews/output`) return reply(projection);
    if (path.endsWith("/project-favorites")) return reply({ projectIds: [] });
    if (path === "/api/catalog") return reply({ items: catalog });
    if (path === "/api/runtime-analysis-data") return reply({ catalog, keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: { [asins[0]]: { ...data.analysisByAsin[asins[0]], status: "error", statusMessage: "STALE_ERROR_MUST_NOT_APPEAR" } }, ratingByAsin: {} }, salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} }, childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} }, imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} } });
    return reply({ error: { message: "fixture endpoint unavailable" } }, 404);
  });
  await page.goto(`${origin}/p/${project.slug}?tab=voc`);
  const matrix = page.locator(".ss-review-matrix-card");
  await matrix.getByText("集成验证稳定光线").first().waitFor().catch(async error => {
    t.diagnostic(JSON.stringify({ outputs, url: page.url(), errors, text: await matrix.allTextContents() }));
    throw error;
  });
  assert.match(await matrix.innerText(), /评论样本：33/);
  const metricRow = matrix.locator(".ss-review-theme-row").filter({ hasText: "集成验证稳定光线" }).first();
  assert.match(await metricRow.getAttribute("title") ?? "", /8\/33 条评论.*各行比例可能重叠/);
  assert.equal(await metricRow.locator(".ss-review-theme-bar i b").getAttribute("style"), "width: 24.24%; background: rgb(107, 203, 154);");
  assert.match(await matrix.innerText(), /上游暂无可用评论/);
  assert.match(await page.locator(".voc-seven-dim-card").innerText(), /待 VOC 核心主题或智能评论分析就绪/,
    "summary waits while selected ASINs lack saved evidence instead of borrowing generated reviews");
  assert.equal(await page.getByText("STALE_ERROR_MUST_NOT_APPEAR").count(), 0);
  const before = outputs;
  await page.waitForTimeout(3300);
  assert.equal(outputs, before, "terminal full page does not keep polling reviews");
  // A newer published version completes coverage; reload must adopt this saved source.
  for (const asin of asins.slice(1)) data.analysisByAsin[asin] = {...data.analysisByAsin[asins[0]],asin};
  projection.contentHash = createHash("sha256").update(JSON.stringify(canonical({stage:"reviews",data,gap}))).digest("hex");
  version.versionId = "10000000-0000-4000-8000-000000000004";
  version.contentHash = "d".repeat(64);
  await page.reload();
  await matrix.getByText("集成验证稳定光线").first().waitFor();
  assert.ok(outputs > before);
  assert.ok(await page.locator(".voc-seven-dim-card").getByText(/集成验证稳定光线/).count() >= 1,
    "complete selected-ASIN coverage now renders the original summary from saved reviews");
  assert.deepEqual(writes, [], "read-only VOC entry does not start collection or mutate data");
  assert.deepEqual(errors, []);
});
