import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
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
let appServer: ChildProcess;
let appBaseUrl = "";

async function reservePort() {
  const listener = createNetServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Built web test server did not become healthy");
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
  server = await createViteServer({ configFile: false, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
  const port = await reservePort();
  appBaseUrl = `http://127.0.0.1:${port}`;
  appServer = spawn(process.execPath, ["scripts/team-prod-server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  await waitForServer(appBaseUrl);
});

after(async () => {
  await browser?.close();
  if (appServer?.exitCode === null) {
    appServer.kill("SIGTERM");
    await Promise.race([once(appServer, "exit"), new Promise(resolve => setTimeout(resolve, 5_000))]);
  }
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
      if (mode === "mismatch") assert.equal(calls.get, 1, "mismatch must stop polling");
      assert.equal(calls.post, 0, mode);
    } finally {
      await page.close();
    }
  }
});

test("page reconstructs URL project and run scope before validating a resumed sync job", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/catalog", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }));
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/v1/auth/session")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          authenticated: true,
          user: {
            id: "018f1f5c-60f0-4b7a-8000-000000000001",
            organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
            email: "test@example.com", displayName: "Test", role: "admin", status: "active",
            createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
          },
        }) });
      }
      if (request.method() === "POST") calls.post += 1;
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syncJob()) });
      }
      if (path.endsWith(`/v1/local-data/projects/${projectId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: {
          id: projectId, kind: "analysis", slug: "resume", name: "Resume", majorCategory: null, categoryLabel: null,
          marketplace: "US", asins, note: null, createdBy: null,
          createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
        } }) });
      }
      if (path.endsWith("/v1/local-data/projects")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${appBaseUrl}/?asins=${asins.join(",")}&project=${projectId}&run=${runId}&syncJob=job-1`);
    await page.getByRole("button", { name: "修改密码", exact: true }).waitFor();
    await page.waitForTimeout(200);
    assert.ok(calls.get >= 1);
    assert.equal(calls.post, 0);
    assert.equal(await page.getByText("同步任务与当前工作区不匹配，请确认后手动重新发起同步。").count(), 0);
  } finally {
    await page.close();
  }
});
