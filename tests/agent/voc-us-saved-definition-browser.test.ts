import { persistedResult } from "./helpers/persisted-product-result";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

let server: ViteDevServer, browser: Browser, origin: string;
before(async () => {
  server = await createServer({ configFile: false, cacheDir: join(tmpdir(), `codex-us-saved-vite-${process.pid}`), plugins: [react()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath() : "C:/Program Files/Google/Chrome/Application/chrome.exe" });
});
after(async () => { await browser?.close(); await server?.close(); });

const organizationId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const baseSyncRunId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000009";
const reportId = "10000000-0000-4000-8000-000000000008";
const asin = "B08Z36X6B4";
const now = "2026-09-10T00:00:00.000Z";
const manifest = { schemaVersion: "voc-evidence/v1", organizationId, projectId, baseSyncRunId, marketplace: "US", selectedAsins: [asin], sourcePolicy: "manual-with-review-fallback", fingerprint: "b".repeat(64), sourceMode: "review-fallback", coverage: [{ asin, primary: "review", manualDimensions: [], reviewDimensions: ["positives"], missingDimensions: ["attention"], manual: null, review: { id: "fixture", version: "1", contentHash: "c".repeat(64), capturedAt: now } }], keywords: { state: "ready", source: null } };
const inventory = { manual: { ...manifest, sourcePolicy: "manual-only", fingerprint: "a".repeat(64), sourceMode: "manual" }, fallback: manifest };
const stage = { id: reportId, runId, stage: "product-definition", status: "succeeded", progress: 100, attemptCount: 1, startedAt: now, completedAt: now, lastError: null, createdAt: now, updatedAt: now };
const run = { id: runId, projectId, mode: "existing-data", status: "succeeded", createdBy: organizationId, dataCutoffAt: now, createdAt: now, updatedAt: now };
const report = { schemaVersion: "1.0.0", id: reportId, runId, agentRunId: reportId, version: 1, stage: "product-definition", status: "complete", skill: { id: "define-amazon-product-from-voc-keywords", version: "1.0.0", contentHash: "d".repeat(64) }, snapshotIds: [reportId], model: { model: "fixture", provider: "fixture" }, dataCutoffAt: now, evidence: [{ id: "voc-1", type: "theme", sourceId: "fixture", capturedAt: now }], result: { ...persistedResult, evidenceSelection: manifest, identity: { ...persistedResult.identity, inputFingerprint: manifest.fingerprint } }, createdAt: now };

test("explicit US fixed-source report is current on load and refresh without creating a run", async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  let posts = 0;
  await page.route("**/*", async route => {
    const request = route.request();
    if (!request.url().startsWith(origin)) return route.abort();
    if (!request.url().includes("/api/agent/")) return route.continue();
    if (request.method() === "POST") { posts++; return route.fulfill({ status: 500, json: {} }); }
    if (request.url().includes("voc-inputs")) return route.fulfill({ json: inventory });
    if (request.url().endsWith("/reports")) return route.fulfill({ json: { reports: [report] } });
    if (request.url().includes(`/runs/${runId}`)) return route.fulfill({ json: { run, stages: [stage], evidenceSelection: manifest } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${origin}/tests/agent/helpers/voc-local-browser-harness.html?vocRun=${runId}`);
  await page.getByText("PERSISTED_RESULT_MARKER", { exact: true }).waitFor();
  assert.equal(await page.getByText("当前结果已保存", { exact: true }).count(), 1);
  assert.equal(await page.locator(".voc-status-heading").first().textContent(), "分析已完成");
  assert.equal(await page.getByText("本地规则结果已生成", { exact: false }).count(), 0);
  assert.equal(posts, 0);
  await page.reload();
  await page.getByText("PERSISTED_RESULT_MARKER", { exact: true }).waitFor();
  assert.equal(posts, 0);
  await page.getByRole("checkbox", { name: /B08Z36X6B4/ }).uncheck();
  assert.equal(await page.getByText("当前结果已保存", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Logout" }).click();
  assert.equal(await page.getByText("PERSISTED_RESULT_MARKER", { exact: true }).count(), 0);
});

test("a saved US run from another project scope cannot become the current report", async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route("**/api/agent/**", async route => route.fulfill({ json: route.request().url().endsWith("/reports") ? { reports: [report] } : { run, stages: [stage], evidenceSelection: { ...manifest, projectId: "another-project" } } }));
  await page.goto(`${origin}/tests/agent/helpers/voc-local-browser-harness.html?vocRun=${runId}`);
  await page.getByText("等待手工 VOC", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("PERSISTED_RESULT_MARKER", { exact: true }).count(), 0);
});

test("US manual rule flow stays available without vocRun, including when only vocHistory is present", async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  let posts = 0;
  await page.route("**/api/alexa-voc/pending?**", async route => route.fulfill({ json: { records: [] } }));
  await page.route("**/api/agent/**", async route => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${origin}/tests/agent/helpers/voc-local-browser-harness.html?vocHistory=${runId}`);
  await page.getByRole("button", { name: "生成并保存规则结果" }).waitFor();
  assert.equal(await page.getByText("PERSISTED_RESULT_MARKER", { exact: true }).count(), 0);
  assert.equal(posts, 0);
  await page.getByRole("button", { name: "Save fixture" }).click();
  await page.getByText("本地规则结果已生成", { exact: false }).first().waitFor();
});
