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
const secondRunId = "10000000-0000-4000-8000-000000000005";
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
    queuePosition: 3,
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

test("primary administrator resumes the same failed-stage job with one POST and polling restarts", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, resumePost: 0, replacementPost: 0 };
  let releaseResume!: () => void;
  const resumeReleased = new Promise<void>((resolve) => { releaseResume = resolve; });
  const terminal = {
    ...syncJob(),
    status: "completed",
    message: "provider gaps",
    stages: [
      { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "keywords", label: "Keywords", kind: "auto", status: "partial", estimatedSeconds: 1 },
    ],
    asinProgress: {
      [asins[0]]: {
        catalog: { status: "ready", reason: null, updatedAt: "2026-08-23T00:00:00.000Z" },
        keywords: { status: "connector-failed", reason: "DNS_NOT_FOUND", updatedAt: "2026-08-23T00:00:00.000Z" },
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
            job: { ...terminal, status: "queued", message: "Failed stages queued for explicit resume", stages: terminal.stages.map(stage => stage.id === "keywords" ? { ...stage, status: "pending" } : stage) },
            resumedStages: ["keywords"],
            reused: false,
          }),
        });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        const payload = calls.get === 1
          ? terminal
          : { ...terminal, status: "running", message: "repair running", stages: terminal.stages.map(stage => stage.id === "keywords" ? { ...stage, status: "active" } : stage) };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      }
      if (request.method() === "POST") calls.replacementPost += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&primary=1&storage=fail&run=${runId}&syncJob=job-1`);
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

test("all production consumers complete exactly once, clear syncJob, and stop terminal polling", async () => {
  for (const tab of ["overview", "keywords", "traffic", "library"] as const) {
    for (const status of ["completed", "completed-with-gaps"] as const) {
      const page = await browser.newPage();
      const calls = { get: 0, post: 0 };
      const needsReload = tab === "overview" && status === "completed";
      try {
        await page.route("**/api/agent/**", route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path.endsWith(`/v1/runs/${runId}`)) {
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
          }
          if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
            calls.get += 1;
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
              ...syncJob(), status, message: `${status} result`, needsReload,
            }) });
          }
          if (request.method() === "POST") calls.post += 1;
          return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
        });
        await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=${tab}&run=${runId}&syncJob=job-1`);
        await page.waitForTimeout(200);
        assert.equal(calls.get, 1, `${tab}/${status} terminal read`);
        assert.equal(calls.post, 0, `${tab}/${status} no replacement start`);
        assert.doesNotMatch(page.url(), /syncJob=/, `${tab}/${status} URL cleared`);
        assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
        assert.ok(await page.getByText(`${status} result`, { exact: true }).count() >= 1, `${tab}/${status} retains terminal result`);
        if (status === "completed-with-gaps") {
          assert.equal(await page.getByRole("button", { name: "收起", exact: true }).count(), 1, `${tab} gap result is terminal UI`);
        }
        await page.evaluate(() => (window as unknown as { rerenderSyncFunnel(): void }).rerenderSyncFunnel());
        await page.waitForTimeout(200);
        assert.equal(calls.get, 1, `${tab}/${status} no terminal poll after rerender`);
        assert.equal(calls.post, 0, `${tab}/${status} no POST after cleanup`);
        assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents.completions), 1);
        assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), needsReload ? 1 : 0, `${tab}/${status} at most one reload callback`);
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

test("page-owned reload survives terminal funnel tab switches", async () => {
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
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", message: "reload complete", needsReload: true }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    for (const tab of ["keywords", "traffic", "library"] as const) {
      await page.evaluate(nextTab => (window as unknown as { switchSyncFunnelTab(tab: typeof nextTab): void }).switchSyncFunnelTab(nextTab), tab);
    }
    await page.waitForTimeout(200);
    assert.equal(calls.get, 1);
    assert.equal(calls.post, 0);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents.completions), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { reloads: number } }).syncTerminalEvents.reloads), 1);
  } finally {
    await page.close();
  }
});

test("the production terminal owner suppresses readiness after a real browser reload until explicit restart", async () => {
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
    await page.reload();
    await page.waitForTimeout(200);
    assert.equal(calls.get, 1, "the cleared URL is not re-adopted after reload");
    assert.equal(calls.post, 0, "a durable matching tombstone blocks readiness-driven replacement");
    const restartPost = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === "POST" && new URL(request.url()).pathname.endsWith("/v1/local-data/sync-asins");
    });
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await restartPost;
    assert.equal(calls.post, 1, "only the real explicit start clears the production owner tombstone");
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
