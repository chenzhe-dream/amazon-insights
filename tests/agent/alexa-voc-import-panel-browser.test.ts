import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Route } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const PROJECT_B = "10000000-0000-4000-8000-000000000020";
const RUN_B = "10000000-0000-4000-8000-000000000021";
const ASIN_A = "B099WTN2TR";
const ASIN_B = "B0B95XH99V";
const FINGERPRINT = "a".repeat(64);

let server: ViteDevServer;
let browser: Browser;
let baseUrl = "";

function browserExecutablePath() {
  const installed = chromium.executablePath();
  if (existsSync(installed)) return installed;
  const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  const directory = existsSync(root) ? readdirSync(root, { withFileTypes: true }).find(item => item.isDirectory() && item.name.startsWith("chromium-")) : undefined;
  if (directory) return join(root, directory.name, "chrome-win64", "chrome.exe");
  const chrome = join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  assert.ok(existsSync(chrome), "Playwright Chromium or system Chrome is required");
  return chrome;
}

before(async () => {
  server = await createServer({ configFile: false, plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
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

async function openPanel(
  handler: (route: Route) => Promise<void> | void,
  beforeGoto?: (page: import("playwright").Page) => Promise<void>,
) {
  const page = await browser.newPage();
  const requests: Array<{ method: string; path: string }> = [];
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}` });
      return handler(route);
    }
    if (url.origin !== baseUrl) return route.abort();
    return route.continue();
  });
  await beforeGoto?.(page);
  const response = await page.goto(`${baseUrl}/tests/agent/helpers/alexa-voc-import-panel-browser-harness.html`);
  assert.equal(response?.status(), 200);
  await page.getByRole("heading", { name: "Alexa 七问 · 快速录入" }).waitFor();
  return { page, requests };
}

function status(status: "pending" | "success" | "failure", revision: string | null = null) {
  return { asin: ASIN_A, fingerprint: FINGERPRINT, status, revision, error: status === "failure" ? "schema" : null };
}

function record() {
  return {
    asin: ASIN_A, marketplace: "US", revision: "7", contentHash: FINGERPRINT,
    normalizedRecord: {
      asin: ASIN_A, attention: [], positives: [], negatives: [], unmet: [], audiences: [], scenarios: [], motives: [], captureStatus: "dialog",
      alexaReport: { title: "Lamp", asin: ASIN_A, rating: 4.5, reviewCount: 10, prompt: "Seven questions", overallConclusion: "Useful" },
    },
    source: "postgres", generation: null, capturedAt: "2026-09-07T08:00:00.000Z",
  };
}

test("discovery failure is visible and retry remains GET-only before pending appears", async () => {
  let reads = 0;
  const { page, requests } = await openPanel(route => {
    reads += 1;
    return reads === 1
      ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [status("pending")] }) });
  });
  try {
    await page.getByText("状态发现暂时失败，请重试读取").waitFor();
    await page.getByRole("button", { name: "重试状态读取" }).click();
    await page.getByText(new RegExp(`目标 ${ASIN_A}`)).waitFor();
    assert.equal(requests.every(request => request.method === "GET"), true);
    assert.equal(requests.some(request => request.path === "/api/alexa-voc/import"), false);
  } finally { await page.close(); }
});

test("success status stays applying through list lag and completes only after exact record apply", async () => {
  let listReady = false;
  const { page } = await openPanel(route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      path.endsWith("/pending") ? { records: [status("success", "7")] } : { records: listReady ? [record()] : [] },
    ) });
  });
  try {
    await page.getByText("正在应用 revision 7").waitFor({ timeout: 5_000 });
    assert.equal(await page.evaluate(() => window.vocImported?.length ?? 0), 0);
    assert.equal(await page.getByText(/导入成功/).count(), 0);
    const progress = page.locator("progress");
    assert.equal(await progress.getAttribute("value"), null);
    assert.match(await page.locator("body").textContent() ?? "", /当前已有版本：revision 3/);
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    await page.screenshot({ path: join(process.cwd(), "test-results", "voc-client-applying.png") });
    listReady = true;
    await page.getByText("导入成功 · PostgreSQL revision 7").waitFor({ timeout: 5_000 });
    assert.equal(await page.evaluate(() => window.vocImported?.length ?? 0), 1);
  } finally { await page.close(); }
});

test("a deferred old-scope result cannot apply after project and run switch", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let markFulfilled!: () => void;
  const fulfilled = new Promise<void>(resolve => { markFulfilled = resolve; });
  let oldStatusReads = 0;
  const { page } = await openPanel(async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/alexa-voc/pending" && url.searchParams.get("projectId") === PROJECT_B) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [] }) });
    }
    if (url.pathname === "/api/alexa-voc/pending") {
      oldStatusReads += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ records: [status(oldStatusReads === 1 ? "pending" : "success", oldStatusReads === 1 ? null : "7")] }),
      });
    }
    assert.equal(url.pathname, "/api/alexa-voc");
    markStarted();
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [record()] }) });
    markFulfilled();
  }, async page => {
    await page.addInitScript(() => {
      const browserFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
        if (url.pathname === "/api/alexa-voc" && !url.pathname.endsWith("/pending")) {
          const fixtureInit = { ...init };
          delete fixtureInit.signal;
          return browserFetch(input, fixtureInit);
        }
        return browserFetch(input, init);
      };
    });
  });
  try {
    await page.getByText(new RegExp(`目标 ${ASIN_A}`)).waitFor();
    await started;
    await page.evaluate(({ projectId, runId }) => window.switchVocScope?.(projectId, runId), { projectId: PROJECT_B, runId: RUN_B });
    release();
    await fulfilled;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.evaluate(() => window.vocImported?.length ?? 0), 0);
    assert.equal(await page.getByText(/导入成功/).count(), 0);
    assert.equal(await page.getByText(/正在应用 revision 7/).count(), 0);
  } finally { release(); await page.close(); }
});

test("failure ends pending while ASIN switching preserves each target draft without POST", async () => {
  const { page, requests } = await openPanel(route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ records: [status("failure")] }),
  }));
  try {
    await page.getByText(/标准化失败（schema）/).waitFor();
    const report = page.getByRole("textbox", { name: "Alexa 报告全文" });
    await report.fill("A-only draft");
    await page.getByRole("combobox", { name: "目标 ASIN" }).selectOption(ASIN_B);
    await report.fill("B-only draft");
    await page.getByRole("combobox", { name: "目标 ASIN" }).selectOption(ASIN_A);
    assert.equal(await report.inputValue(), "A-only draft");
    assert.equal(requests.some(request => request.method === "POST"), false);
  } finally { await page.close(); }
});
