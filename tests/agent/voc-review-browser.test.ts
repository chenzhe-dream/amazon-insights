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

test("same-scope VOC tab reentry retains verified data on downgrade and failed refresh", async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  let mode: "initial" | "older" | "failed" | "newer" = "initial";
  let failures = 0;
  await page.route("**/api/agent/**", async route => {
    if (!route.request().url().endsWith("/output")) return route.fulfill({ json: { jobId: "job", jobVersion: 13, asins: ["B0F43M9KWW"], marketplace: "US", scope: { projectId, runId }, stages: [{ id: "reviews", status: "done" }] } });
    if (mode === "failed") { failures++; return route.fulfill({ status: 503, json: { error: "fixture unavailable" } }); }
    const candidate = structuredClone(projection);
    if (mode !== "initial") {
      candidate.outputVersion = candidate.jobVersion = mode === "older" ? 11 : 13;
      candidate.data.analysisByAsin.B0F43M9KWW.blocks[0].rows[0].label = mode === "older" ? "OLD_RESULT" : "NEW_RESULT";
      candidate.contentHash = createHash("sha256").update(JSON.stringify(canonical({ stage: "reviews", data: candidate.data }))).digest("hex");
    }
    return route.fulfill({ json: candidate });
  });
  const reenter = async () => { await page.getByText("Overview", { exact: true }).click(); await page.getByText("VOC", { exact: true }).click(); };
  await page.goto(base);
  await page.locator("#matrix").filter({ hasText: "brightness" }).waitFor();
  mode = "older";
  await reenter();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#matrix").textContent(), "brightness");
  mode = "failed";
  await reenter();
  await page.locator("#read-failure").filter({ hasText: "refresh failed" }).waitFor();
  assert.equal(await page.locator("#matrix").textContent(), "brightness");
  assert.equal(failures, 3);
  await page.waitForTimeout(3200);
  assert.equal(failures, 3);
  mode = "newer";
  await reenter();
  await page.locator("#matrix").filter({ hasText: "NEW_RESULT" }).waitFor();
  assert.equal(await page.locator("#read-failure").textContent(), "");
  await page.getByText("Logout", { exact: true }).click();
  assert.equal(await page.locator("#matrix").textContent(), "");
});
