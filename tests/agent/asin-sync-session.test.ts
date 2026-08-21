import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { after, before } from "node:test";

import { chromium, type Browser } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { createSyncStartGate } from "../../app/lib/asin-sync-session";
import * as session from "../../app/lib/asin-sync-session";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];
const projectId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000004";
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
  server = await createViteServer({ configFile: false, server: { host: "127.0.0.1", port: 0 } });
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
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
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
        body: JSON.stringify(syncJob(mode === "mismatch" ? { projectId, runId: "10000000-0000-4000-8000-000000000005" } : undefined)),
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

test("syncJob URL recovery parses, writes, clears, and rejects mismatched scope without starting a replacement job", () => {
  assert.equal(typeof session.syncJobIdFromSearch, "function");
  assert.equal(typeof session.searchWithSyncJobId, "function");
  assert.equal(typeof session.clearSyncJobFromSearch, "function");
  assert.equal(typeof session.isSyncJobScopeMatch, "function");

  const read = session.syncJobIdFromSearch("?run=voc-1&syncJob=job-1");
  assert.equal(read, "job-1");
  assert.equal(session.searchWithSyncJobId("?run=voc-1", "job-1"), "?run=voc-1&syncJob=job-1");
  assert.equal(session.clearSyncJobFromSearch("?run=voc-1&syncJob=job-1"), "?run=voc-1");
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
    false,
  );
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
