import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

import { CreateProjectRequestSchema, LocalDataSyncStartRequestSchema } from "../../shared/agent-contracts";

let server: ViteDevServer;
let browser: Browser;
let baseUrl = "";

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
  server = await createServer({
    configFile: false,
    define: { "process.env": "{}" },
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
    },
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

function emptyRuntimeSnapshot() {
  return {
    catalog: [],
    keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
    reviews: { analysisByAsin: {}, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} },
    fba: { feeByAsin: {} },
    listing: { contentByAsin: {} },
    category: { trendByNode: {} },
  };
}

test("non-primary builder interactions replace the hidden diagnostic with visible business notices", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];

  try {
    page.on("pageerror", error => pageErrors.push(error.message));
    for (const item of [
      { tab: "overview", action: "开始全自动分析" },
      { tab: "keywords", action: "抓取关键词数据" },
      { tab: "traffic", action: "抓取流量数据" },
    ]) {
      const response = await page.goto(
        `${baseUrl}/tests/agent/helpers/primary-admin-browser-harness.html?tab=${item.tab}`,
        { waitUntil: "domcontentloaded" },
      );
      assert.equal(response?.status(), 200);
      await page.locator(".asin-builder").waitFor();

      const notice = page.locator(".builder-actions .builder-message");
      assert.equal(await notice.count(), 0);

      await page.locator(".market-inline select").selectOption("UK");
      await notice.waitFor({ timeout: 5_000 });
      assert.match(await notice.textContent() ?? "", /已切换至\s*英国站/);
      assert.equal(await notice.evaluate(element => element.className), "builder-message");

      await page.locator(".asin-builder").getByRole("button", { name: item.action }).click();
      const expectedValidation = item.tab === "overview" ? "请修正 ASIN 输入后再开始分析" : "请至少输入 3 个竞品 ASIN";
      await page.waitForFunction(
        expected => document.querySelector(".builder-actions .builder-message")?.textContent === expected,
        expectedValidation,
        { timeout: 5_000 },
      ).catch(async error => {
        throw new Error(`${item.tab}: ${error instanceof Error ? error.message : "notice timeout"}; text=${await notice.textContent()}; pageErrors=${JSON.stringify(pageErrors)}`);
      });
      assert.equal(await notice.evaluate(element => element.className), "builder-message error");
    }
  } finally {
    await page.close();
  }
});

test("manual VOC ASINs start one canonical base sync without a local-voc dependency", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const projectA = {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "analysis",
    slug: "workspace-a",
    name: "Workspace A",
    marketplace: "US",
    asins: ["B01EM42B60", "B09ZY6M8XH", "B0CCYMV1T1"],
  };
  const projectB = {
    id: "10000000-0000-4000-8000-000000000002",
    kind: "analysis",
    slug: "workspace-b",
    name: "Workspace B",
    marketplace: "US",
    asins: ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"],
  };
  const projectC = {
    id: "10000000-0000-4000-8000-000000000003",
    kind: "analysis",
    slug: "workspace-c",
    name: "Workspace C",
    marketplace: "US",
    asins: ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"],
  };
  const oldRunId = "20000000-0000-4000-8000-000000000002";
  const oldJobId = "30000000-0000-4000-8000-000000000002";
  const newJobId = "30000000-0000-4000-8000-000000000003";
  const newRunId = "20000000-0000-4000-8000-000000000003";
  const projectPosts: Array<Record<string, unknown>> = [];
  const projectRegistrations: Array<Record<string, unknown>> = [];
  const localVocPosts: Array<Record<string, unknown>> = [];
  const syncPosts: Array<Record<string, unknown>> = [];
  const startRequestOrder: string[] = [];
  let projectCreated = false;
  let projectRegistered = false;
  let canonicalNavigationInjected = false;
  let newJobGets = 0;

  try {
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.route("**/api/runtime-analysis-data**", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyRuntimeSnapshot()),
    }));
    await page.route("**/api/catalog", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }));
    await page.route("**/api/projects?kind=keyword-compare", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [] }),
    }));
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^\/api\/agent/, "");
      if (path === "/v1/projects" && request.method() === "POST") {
        startRequestOrder.push("project-register");
        const body = request.postDataJSON() as Record<string, unknown>;
        projectRegistrations.push(body);
        projectRegistered = CreateProjectRequestSchema.safeParse(body).success;
        return route.fulfill({
          status: projectRegistered ? 201 : 400,
          contentType: "application/json",
          body: JSON.stringify(projectRegistered ? {
            project: {
              id: projectC.id,
              organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
              name: projectC.name,
              marketplace: projectC.marketplace,
              asins: projectC.asins,
              createdBy: "018f1f5c-60f0-4b7a-8000-000000000001",
              currentRunId: null,
              createdAt: "2026-08-23T09:24:13.409Z",
              updatedAt: "2026-08-23T09:24:13.409Z",
            },
          } : { error: { message: "Request body did not match its contract" } }),
        });
      }
      if (path === "/v1/local-data/projects" && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ projects: projectCreated ? [projectC, projectB, projectA] : [projectB, projectA] }),
        });
      }
      if (path === "/v1/local-data/projects" && request.method() === "POST") {
        startRequestOrder.push("project");
        projectPosts.push(request.postDataJSON() as Record<string, unknown>);
        projectCreated = true;
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ project: projectC }),
        });
      }
      if (path.startsWith("/v1/local-data/projects/") && request.method() === "GET") {
        const key = decodeURIComponent(path.split("/").at(-1) ?? "");
        const project = [projectA, projectB, projectC].find(item => item.id === key || item.slug === key);
        return route.fulfill({
          status: project ? 200 : 404,
          contentType: "application/json",
          body: JSON.stringify({ project: project ?? null }),
        });
      }
      if (path === "/v1/local-data/sync-asins" && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ needsSync: true, items: [], vocPending: [] }),
        });
      }
      if (path === "/v1/local-data/sync-asins" && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const isNewScope = JSON.stringify(body.asins) === JSON.stringify(projectC.asins);
        if (isNewScope && !projectRegistered) {
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Sync scope not found" } }),
          });
        }
        startRequestOrder.push("sync");
        syncPosts.push(body);
        if (isNewScope && !canonicalNavigationInjected) {
          canonicalNavigationInjected = true;
          await page.evaluate(
            ({ slug, runId }) => {
              window.navigateAuthenticatedApp?.(`/p/${slug}?run=${runId}`);
              window.dropNextRouterReplace = true;
            },
            { slug: projectC.slug, runId: newRunId },
          );
        }
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: isNewScope ? newJobId : `auto-job-${syncPosts.length}`,
            status: "queued",
            message: "Queued",
            stages: [],
            scope: { projectId: projectC.id, runId: newRunId },
          }),
        });
      }
      if (path === `/v1/runs/${newRunId}` && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ run: { id: newRunId, projectId: projectC.id } }),
        });
      }
      if (path === "/v1/local-voc" && request.method() === "POST") {
        localVocPosts.push(request.postDataJSON() as Record<string, unknown>);
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "VOC data is unavailable for requested ASINs" } }),
        });
      }
      if (path === `/v1/local-data/sync-asins/${oldJobId}`) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: oldJobId,
            status: "running",
            message: "Running old workspace",
            asins: projectB.asins,
            marketplace: "US",
            scope: { projectId: projectB.id, runId: oldRunId },
            stages: [],
            asinProgress: {},
          }),
        });
      }
      if (path === `/v1/local-data/sync-asins/${newJobId}`) {
        newJobGets += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: newJobId,
            status: "running",
            message: "Running new workspace",
            asins: projectC.asins,
            marketplace: "US",
            scope: { projectId: projectC.id, runId: newRunId },
            stages: [],
            asinProgress: {},
          }),
        });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });

    await page.goto(`${baseUrl}/tests/agent/helpers/primary-admin-browser-harness.html?__appPath=/p/workspace-a`);
    await page.locator(".asin-builder").waitFor();
    await page.waitForTimeout(250);
    assert.equal(syncPosts.length, 0, "initial workspace hydration is GET-only");
    await page.evaluate(() => window.navigateAuthenticatedApp?.("/p/workspace-b"));
    await page.getByRole("textbox", { name: "批量输入 ASIN" }).waitFor().catch(async error => {
      throw new Error(`${error instanceof Error ? error.message : "workspace switch timeout"}; appLocation=${await page.evaluate(() => window.appLocation)}; body=${(await page.locator("body").textContent())?.slice(0, 500)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`);
    });
    await page.waitForTimeout(250);
    assert.equal(syncPosts.length, 0, "workspace switching is GET-only");
    await page.evaluate(
      ({ jobId, runId }) => window.navigateAuthenticatedApp?.(`/p/workspace-b?run=${runId}&syncJob=${jobId}`),
      { jobId: oldJobId, runId: oldRunId },
    );
    await page.waitForTimeout(250);
    assert.equal(syncPosts.length, 0, "a nonterminal pointer does not auto-start another scope");

    await page.getByRole("textbox", { name: "批量输入 ASIN" }).fill(projectC.asins.join("\n"));
    await page.getByRole("button", { name: "开始全自动分析" }).dblclick();
    await page.waitForTimeout(1_000);

    assert.equal(localVocPosts.length, 0, "manual VOC does not gate or create the base sync workspace");
    assert.equal(projectPosts.length, 1, "the canonical analysis workspace is created exactly once");
    assert.deepEqual(startRequestOrder, ["project", "project-register", "sync"]);
    assert.equal(projectPosts[0]?.kind, "analysis");
    assert.deepEqual(projectPosts[0]?.asins, projectC.asins);
    assert.deepEqual(projectRegistrations, [{
      id: projectC.id,
      name: projectC.name,
      marketplace: "US",
      asins: projectC.asins,
    }]);
    assert.deepEqual(syncPosts, [{
      asins: projectC.asins,
      marketplace: "US",
      projectId: projectC.id,
    }]);
    await page.waitForFunction(jobId => window.appLocation?.includes(`syncJob=${jobId}`), newJobId, { timeout: 5_000 })
      .catch(async error => {
        const location = await page.evaluate(() => window.appLocation ?? "");
        const replacements = await page.evaluate(() => window.routerReplacements ?? []);
        const notice = await page.locator(".builder-actions .builder-message").textContent().catch(() => null);
        throw new Error(`${error instanceof Error ? error.message : "URL update timed out"}; appLocation=${location}; replacements=${JSON.stringify(replacements)}; notice=${notice ?? ""}`);
      });
    const finalLocation = await page.evaluate(() => window.appLocation ?? "");
    assert.equal(new URL(finalLocation, "http://app.local").pathname, "/p/workspace-c");
    assert.equal(windowLocationJob(finalLocation), newJobId);
    assert.equal(new URL(finalLocation, "http://app.local").searchParams.get("run"), newRunId);
    assert.doesNotMatch(finalLocation, new RegExp(oldJobId));
    assert.doesNotMatch(finalLocation, new RegExp(oldRunId));
    assert.ok((await page.evaluate(() => window.staleRouterDrops ?? [])).length > 0, "the production race invalidates the submitting component router");
    await page.waitForFunction(() => document.body.textContent?.includes("Running new workspace"), undefined, { timeout: 5_000 });
    assert.ok(newJobGets > 0, "the adopted syncJob pointer starts GET-only polling after the workspace remount");
    await page.getByText("基础/MCP同步已启动，3个VOC待手工录入").waitFor({ timeout: 5_000 });

    await page.evaluate(() => window.remountAuthenticatedApp?.());
    await page.waitForTimeout(250);
    assert.equal(syncPosts.length, 1, "refresh is GET-only and does not add a POST");
    assert.equal(projectPosts.length, 1, "refresh does not create another workspace");
    assert.equal(projectRegistrations.length, 1, "refresh does not register another workspace");
    assert.equal(localVocPosts.length, 0, "refresh does not submit local VOC");
    assert.equal(await page.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);

    await page.evaluate(() => {
      const next = new URL(window.appLocation ?? "/", window.location.origin);
      next.searchParams.set("tab", "keyword-compare");
      window.navigateAuthenticatedApp?.(`${next.pathname}${next.search}`);
    });
    await page.waitForTimeout(250);
    assert.equal(syncPosts.length, 1, "tab switching is GET-only and does not add a POST");
  } finally {
    await page.close();
  }
});

test("an existing same-scope workspace still starts exactly one sync without rewriting the local project", async () => {
  const page = await browser.newPage();
  const project = {
    id: "a081d838-ffcb-4e36-b4ad-e38937f7336a",
    kind: "analysis",
    slug: "kick-scooters-3asin-us",
    name: "Kick Scooters 3ASIN 真实验收",
    majorCategory: null,
    categoryLabel: "竞品分析",
    marketplace: "US",
    asins: ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"],
    note: null,
    createdBy: null,
    createdAt: "2026-08-23T09:24:13.409Z",
    updatedAt: "2026-08-23T11:02:29.466Z",
  };
  const newJobId = "30000000-0000-4000-8000-000000000004";
  const newRunId = "20000000-0000-4000-8000-000000000004";
  const requestOrder: string[] = [];
  const projectPosts: Array<Record<string, unknown>> = [];
  const projectPatches: Array<Record<string, unknown>> = [];
  const projectRegistrations: Array<Record<string, unknown>> = [];
  const syncPosts: Array<Record<string, unknown>> = [];
  const localVocPosts: Array<Record<string, unknown>> = [];
  const observedRequests: string[] = [];
  const pageErrors: string[] = [];
  let hydrationComplete = false;
  let projectRegistered = false;

  try {
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/api/runtime-analysis-data**", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyRuntimeSnapshot()),
    }));
    await page.route("**/api/catalog", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }));
    await page.route("**/api/projects?kind=keyword-compare", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [] }),
    }));
    await page.route("**/api/agent/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^\/api\/agent/, "");
      observedRequests.push(`${request.method()} ${path}`);
      if (path === "/v1/projects" && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (!CreateProjectRequestSchema.safeParse(body).success) {
          return route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Request body did not match its contract" } }),
          });
        }
        requestOrder.push("project-register");
        projectRegistrations.push(body);
        projectRegistered = true;
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            project: {
              id: project.id,
              organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
              name: project.name,
              marketplace: project.marketplace,
              asins: project.asins,
              createdBy: "018f1f5c-60f0-4b7a-8000-000000000001",
              currentRunId: null,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            },
          }),
        });
      }
      if (path === "/v1/local-data/projects" && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ projects: [project] }),
        });
      }
      if (path === "/v1/local-data/projects" && request.method() === "POST") {
        projectPosts.push(request.postDataJSON() as Record<string, unknown>);
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ project }),
        });
      }
      if (
        (path === `/v1/local-data/projects/${project.id}` || path === `/v1/local-data/projects/${project.slug}`) &&
        request.method() === "GET"
      ) {
        if (hydrationComplete) requestOrder.push("project-get");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project }),
        });
      }
      if (path === `/v1/local-data/projects/${project.id}` && request.method() === "PATCH") {
        requestOrder.push("project-patch");
        const patch = request.postDataJSON() as Record<string, unknown>;
        projectPatches.push(patch);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            project: {
              ...project,
              ...patch,
              updatedAt: "2026-08-23T11:05:00.000Z",
            },
          }),
        });
      }
      if (path === "/v1/local-data/sync-asins" && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ needsSync: true, items: [], vocPending: [] }),
        });
      }
      if (path === "/v1/local-data/sync-asins" && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (!LocalDataSyncStartRequestSchema.safeParse(body).success || !projectRegistered) {
          return route.fulfill({
            status: projectRegistered ? 400 : 404,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Request body did not match its contract" } }),
          });
        }
        requestOrder.push("sync");
        syncPosts.push(body);
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: newJobId,
            status: "queued",
            message: "Queued",
            stages: [],
            scope: { projectId: project.id, runId: newRunId },
          }),
        });
      }
      if (path === `/v1/local-data/sync-asins/${newJobId}` && request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: newJobId,
            status: "running",
            message: "Running",
            asins: project.asins,
            marketplace: "US",
            scope: { projectId: project.id, runId: newRunId },
            stages: [],
            asinProgress: {},
          }),
        });
      }
      if (path === "/v1/local-voc" && request.method() === "POST") {
        localVocPosts.push(request.postDataJSON() as Record<string, unknown>);
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "VOC data is unavailable for requested ASINs" } }),
        });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });

    await page.goto(`${baseUrl}/tests/agent/helpers/primary-admin-browser-harness.html`);
    await page.locator(".asin-builder").waitFor();
    await page.evaluate(slug => window.navigateAuthenticatedApp?.(`/p/${slug}`), project.slug);
    await page.waitForFunction(
      expected => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="批量输入 ASIN"]')?.value === expected,
      project.asins.join("\n"),
      { timeout: 5_000 },
    ).catch(async error => {
      const input = await page.getByRole("textbox", { name: "批量输入 ASIN" }).inputValue().catch(() => "missing");
      throw new Error(`${error instanceof Error ? error.message : "hydration timeout"}; input=${JSON.stringify(input)}; requests=${JSON.stringify(observedRequests)}; pageErrors=${JSON.stringify(pageErrors)}`);
    });
    hydrationComplete = true;
    assert.equal(syncPosts.length, 0, "existing workspace hydration is GET-only");

    await page.getByRole("button", { name: "开始全自动分析" }).dblclick();
    await page.waitForTimeout(1_000);

    assert.deepEqual(requestOrder.slice(0, 3), ["project-get", "project-register", "sync"]);
    assert.equal(projectPosts.length, 0, "the existing canonical workspace is not recreated");
    assert.deepEqual(projectPatches, []);
    assert.deepEqual(projectRegistrations, [{
      id: project.id,
      name: project.name,
      marketplace: "US",
      asins: project.asins,
    }]);
    assert.deepEqual(syncPosts, [{
      asins: project.asins,
      marketplace: "US",
      projectId: project.id,
    }]);
    assert.equal(localVocPosts.length, 0);
    await page.waitForFunction(jobId => window.appLocation?.includes(`syncJob=${jobId}`), newJobId, { timeout: 5_000 });
    const finalLocation = await page.evaluate(() => window.appLocation ?? "");
    assert.equal(new URL(finalLocation, "http://app.local").pathname, `/p/${project.slug}`);
    assert.equal(windowLocationJob(finalLocation), newJobId);
    assert.equal(new URL(finalLocation, "http://app.local").searchParams.get("run"), newRunId);

    await page.evaluate(() => window.remountAuthenticatedApp?.());
    await page.waitForTimeout(250);
    assert.equal(syncPosts.length, 1, "refresh is GET-only");
    assert.equal(projectPatches.length, 0, "refresh does not PATCH the workspace");
    assert.equal(projectRegistrations.length, 1, "refresh does not register the workspace again");
  } finally {
    await page.close();
  }
});

test("terminal convergence refreshes generated analysis data once without navigating", async () => {
  const page = await browser.newPage();
  const project = {
    id: "a081d838-ffcb-4e36-b4ad-e38937f7336a",
    kind: "analysis",
    slug: "runtime-refresh",
    name: "Runtime refresh",
    marketplace: "US",
    asins: ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"],
  };
  const runId = "20000000-0000-4000-8000-000000000005";
  const jobId = "30000000-0000-4000-8000-000000000005";
  const runningJob = {
    jobId,
    status: "running",
    message: "Running",
    currentStageId: "reviews",
    asins: project.asins,
    marketplace: "US",
    scope: { projectId: project.id, runId },
    stages: [{ id: "reviews", label: "评论数据", kind: "auto", status: "active", estimatedSeconds: 30 }],
    asinProgress: {
      [project.asins[0]!]: { reviews: { status: "ready" } },
      [project.asins[1]!]: { reviews: { status: "ready" } },
      [project.asins[2]!]: {},
    },
  };
  const terminalJob = {
    ...runningJob,
    status: "completed",
    message: "Completed",
    currentStageId: "done",
    publication: { status: "not-required" },
    stages: [{ ...runningJob.stages[0]!, status: "done" }],
  };
  const snapshot = (fbaFee: number) => ({
    catalog: [],
    keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
    reviews: { analysisByAsin: {}, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} },
    fba: { feeByAsin: { [project.asins[0]!]: { status: "ready", fbaFee, source: "sorftime" } } },
    listing: { contentByAsin: {} },
    category: { trendByNode: {} },
  });
  let runtimeSnapshot = snapshot(1.25);
  let runtimeReads = 0;
  let navigations = 0;
  let observedJob = runningJob;

  try {
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations += 1; });
    await page.route("**/api/catalog", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }));
    await page.route("**/api/runtime-analysis-data**", route => {
      runtimeReads += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runtimeSnapshot),
      });
    });
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^\/api\/agent/, "");
      if (path === `/v1/local-data/projects/${project.slug}` || path === `/v1/local-data/projects/${project.id}`) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project }) });
      }
      if (path === `/v1/runs/${runId}`) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { id: runId, projectId: project.id } }) });
      }
      if (path === `/v1/local-data/sync-asins/${jobId}`) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(observedJob) });
      }
      if (path === "/v1/local-data/projects") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [project] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });

    await page.goto(`${baseUrl}/tests/agent/helpers/primary-admin-browser-harness.html?__appPath=/p/${project.slug}&__appSearch=run%3D${runId}%26syncJob%3D${jobId}`);
    await page.locator("[data-testid=sync-stage-reviews]").waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-testid=sync-stage-reviews]")?.textContent?.includes("2/3"));
    await page.waitForFunction(() => document.body.textContent?.includes("$1.25"));
    assert.equal(runtimeReads, 1, "workspace hydration reads one authenticated runtime snapshot");

    runtimeReads = 0;
    runtimeSnapshot = snapshot(4.25);
    const navigationsBeforeTerminal = navigations;
    observedJob = terminalJob;
    await page.waitForFunction(() => document.body.textContent?.includes("$4.25"), undefined, { timeout: 5_000 });
    await page.waitForTimeout(1_750);

    assert.equal(runtimeReads, 1, "terminal convergence reads one runtime snapshot");
    assert.equal(navigations, navigationsBeforeTerminal, "runtime refresh does not navigate or reload the page");
    assert.equal(await page.evaluate(() => window.routerRefreshes), 0, "runtime refresh does not invoke router.refresh");
  } finally {
    await page.close();
  }
});

function windowLocationJob(value: string) {
  return new URL(value, "http://app.local").searchParams.get("syncJob");
}
