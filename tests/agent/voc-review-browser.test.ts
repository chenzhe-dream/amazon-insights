import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

let server: ViteDevServer;
let browser: Browser;
let base: string;
before(async () => {
  server = await createServer({ configFile: false, cacheDir: ".runtime/voc-review-vite", plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/tests/agent/helpers/voc-review-browser-harness.html`;
  const installed = chromium.executablePath();
  browser = await chromium.launch({ headless: true, executablePath: existsSync(installed) ? installed : "C:/Program Files/Google/Chrome/Application/chrome.exe" });
});
after(async () => { await browser?.close(); await server?.close(); });
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value; }
const projectId = "10000000-0000-4000-8000-000000000002", runId = "10000000-0000-4000-8000-000000000003";
const data = { analysisByAsin: { B0F43M9KWW: { asin: "B0F43M9KWW", marketplace: "US", status: "ready", sampledReviews: 33, fetchedAt: "2026-09-10", blocks: [{ key: "positives", rows: [{ label: "brightness", sharePct: 100 }] }] } }, ratingByAsin: {} };
const projection = { projectId, runId, jobId: "job", jobVersion: 12, outputVersion: 12, updatedAt: "2026-09-10T00:00:00Z", stage: "reviews", stageStatus: "done", data, contentHash: createHash("sha256").update(JSON.stringify(canonical({ stage: "reviews", data }))).digest("hex") };
test("direct / refresh / overview to VOC agree; terminal reads stop; scope and logout clear immediately", async () => {
  const page = await browser.newPage();
  let reads = 0;
  await page.route("**/api/agent/**", async route => {
    assert.equal(route.request().method(), "GET"); reads++;
    await route.fulfill({ json: route.request().url().endsWith("/output") ? projection : { jobId: "job", jobVersion: 12, asins: ["B0F43M9KWW"], marketplace: "US", scope: { projectId, runId }, stages: [{ id: "reviews", status: "done" }] } });
  });
  await page.goto(base);
  await page.locator("#matrix").filter({ hasText: "brightness" }).waitFor();
  assert.ok(await page.locator("#summary").textContent());
  assert.match(await page.locator("#evidence").innerText(), /33/);
  const first = await page.locator("#summary").textContent();
  const count = reads; await page.waitForTimeout(3200); assert.equal(reads, count);
  await page.reload(); await page.locator("#matrix").filter({ hasText: "brightness" }).waitFor();
  assert.equal(await page.locator("#summary").textContent(), first);
  await page.goto(`${base}?tab=overview`); const before = reads;
  await page.waitForTimeout(100); assert.equal(reads, before);
  await page.getByText("VOC", { exact: true }).click(); await page.locator("#matrix").filter({ hasText: "brightness" }).waitFor();
  assert.equal(await page.locator("#summary").textContent(), first);
  await page.getByText("Switch", { exact: true }).click(); assert.equal(await page.locator("#matrix").textContent(), "");
  await page.getByText("Switch", { exact: true }).click(); await page.locator("#matrix").filter({ hasText: "brightness" }).waitFor();
  await page.getByText("Logout", { exact: true }).click(); assert.equal(await page.locator("#matrix").textContent(), "");
  const logoutReads = reads; await page.waitForTimeout(200); assert.equal(reads, logoutReads);
  await page.close();
});
