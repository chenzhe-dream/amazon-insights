import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer as createTcpServer } from "node:net";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

// The helper supplies only Next router context and an authenticated session.
// The production app/page.tsx, deletion callback and all its effects are mounted unchanged.
test("full production page leaves deleted workspace and cannot restore it from delayed requests or storage", async t => {
  const reservation = createTcpServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== "string");
  const port = reserved.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const server = await createServer({ configFile: false, define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port, strictPort: true } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  // Synthetic document fulfillment otherwise makes Chromium block local Vite HMR.
  // This flag affects only the isolated, fixture-only test browser.
  const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
  t.after(async () => { await Promise.all(held.map(release => release())); await browser.close(); await server.close(); });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const project = { id: "10000000-0000-4000-8000-000000000001", kind: "analysis", slug: "delete-lifecycle", name: "删除生命周期项目", majorCategory: null, categoryLabel: null, marketplace: "US", asins: ["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"], note: null, createdBy: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
  const runId = "10000000-0000-4000-8000-000000000002";
  const jobId = "old-sync-job";
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let deleted = false;
  let documents = 0;
  const writes: string[] = [], readsAfterNavigation: string[] = [];
  const held: Array<() => Promise<void>> = [];
  await page.route("**/*", async route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    documents++;
    const html = readFileSync("tests/agent/helpers/primary-admin-browser-harness.html", "utf8");
    return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml(new URL(route.request().url()).pathname, html) });
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (deleted && documents > 1) readsAfterNavigation.push(path);
    if (path === `/api/projects/${project.id}` && method === "DELETE") { deleted = true; return reply({ ok: true }); }
    if (path === "/api/projects" || path === "/api/agent/v1/local-data/projects") return reply({ projects: deleted ? [] : [project], ...(new URL(request.url()).searchParams.has("page") ? { pagination: { page: 1, pageSize: 10, total: deleted ? 0 : 1, totalPages: 1, historyTotal: deleted ? 0 : 1, favoritesTotal: deleted ? 0 : 1, categories: [] } } : {}) });
    if (path === `/api/agent/v1/local-data/projects/${project.slug}` || path === `/api/agent/v1/local-data/projects/${project.id}`) return reply(deleted ? { error: { message: "not found" } } : { project }, deleted ? 404 : 200);
    if (path.endsWith("/project-favorites")) return reply({ projectIds: deleted ? [] : [project.id] });
    if (path === `/api/agent/v1/runs/${runId}` || path === `/api/agent/v1/local-data/sync-asins/${jobId}`) {
      held.push(() => reply({ run: { id: runId, projectId: project.id } }).catch(() => {}));
      return;
    }
    if (path === "/api/catalog") return reply({ items: [] });
    if (path === "/api/runtime-analysis-data") return reply({ catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: {}, ratingByAsin: {} }, salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} }, childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} }, imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} } });
    return reply({ error: { message: "fixture endpoint unavailable" } }, 404);
  });
  await page.goto(`${origin}/p/${project.slug}?tab=projects&run=${runId}&vocRun=${runId}&syncJob=${jobId}`);
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByRole("button", { name: "删除项目", exact: true }).waitFor();
  await page.waitForFunction(() => document.body.textContent?.includes("删除生命周期项目"));
  const oldDocumentToken = await page.evaluate(({ project, jobId }) => {
    const identity = JSON.stringify({ organizationId: "018f1f5c-60f0-4b7a-8000-000000000002", projectId: project.id, marketplace: "US", asins: [...project.asins].sort() });
    sessionStorage.setItem(`amz-lens.sync-terminal.v1:${encodeURIComponent(identity)}`, JSON.stringify({ version: 3, identity, jobId, artifactId: null, reloadClaimedArtifactId: null }));
    localStorage.setItem("amz-lens-project-author", "lifecycle-test");
    const token = crypto.randomUUID();
    (window as unknown as { documentToken: string }).documentToken = token;
    return token;
  }, { project, jobId });
  assert.ok(held.length > 0, "an old run/sync request is genuinely in flight before deletion");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/" && url.searchParams.get("tab") === "projects");
  await page.getByText(/已删除项目，团队历史和收藏列表已更新/).waitFor();
  assert.equal(documents, 2, "production window.location.replace loads a new document");
  assert.notEqual(await page.evaluate(() => (window as unknown as { documentToken?: string }).documentToken), oldDocumentToken);
  await Promise.all(held.map(release => release()));
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText(/暂无历史项目/).waitFor();
  // Allow the previous polling interval to elapse with its stale response released.
  await new Promise(resolve => setTimeout(resolve, 5500));
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(new URL(page.url()).search, "?tab=projects");
  assert.equal(await page.locator(".project-card").count(), 0);
  assert.deepEqual(writes, [`DELETE /api/projects/${project.id}`], "no automatic project/run/sync creation after deletion");
  assert.equal(readsAfterNavigation.some(path => path.includes(project.id) || path.includes(project.slug) || path.includes(runId) || path.includes(jobId)), false, "new document does not resume deleted workspace pointers");
  assert.equal(await page.evaluate(() => localStorage.getItem("amz-lens-project-author")), "lifecycle-test");
  assert.ok(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("amz-lens.sync-terminal.v1:"))), "old terminal storage remains present but cannot resurrect the workspace");
  assert.deepEqual(pageErrors, []);
});
