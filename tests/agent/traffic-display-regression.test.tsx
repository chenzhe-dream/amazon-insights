import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let origin = "";
const asins = ["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"];
const counts = [11, 2, 6];
const totals = [269627.4671988103, 22621.60762491286, 184587.6417731607];
const natural = [128266.49784446, 9381.16564207, 123896.81905171];
const project = { id: "a081d838-ffcb-4e36-b4ad-e38937f73370", kind: "analysis", slug: "traffic-fixture", name: "本地合成夹具", marketplace: "US", asins };
const runId = "20000000-0000-4000-8000-000000000070";
const jobId = "30000000-0000-4000-8000-000000000070";
const nextRun = "20000000-0000-4000-8000-000000000071";
const search = (run = runId) => `tab=traffic&run=${run}&syncJob=${jobId}`;
const distributions = (score: number) => ["SP(常规)", "SP(推荐)", "SB(常规)", "SBV"].map((label, index) => ({ label, score: score * [0.7, 0.15, 0.1, 0.05][index]!, ratio: [70, 15, 10, 5][index]! }));
const fullByAsin = Object.fromEntries(asins.map((asin, index) => [asin, {
  totalScore: totals[index], naturalAd: [{ label: "自然流量", score: natural[index], ratio: natural[index]! / totals[index]! * 100 }, { label: "广告流量", score: totals[index]! - natural[index]!, ratio: 100 - natural[index]! / totals[index]! * 100 }],
  adChannels: distributions(totals[index]! - natural[index]!), recommendationSources: [{ label: "合成相似商品", score: 1350.456, ratio: 66.7 }, { label: "合成相关商品", score: 674.999, ratio: 33.3 }],
  children: Array.from({ length: counts[index]! }, (_, child) => ({ asin: `B${String(index * 100 + child).padStart(9, "0")}`, label: `夹具子体${child + 1}`, image: "", totalScore: 10000.333 / (child + 1), sharePct: 100 / counts[index]!, organic: 100, sp: 70, spRecommend: 15, sb: 10, sbv: 5 })),
  updatedThrough: "2026-09-01",
}]));
const summary = { version: "1", state: "ready", marketplace: "US", asins, source: "sif", collectedAt: "2026-09-09T05:45:03.842Z", traffic: { competitors: asins.map((asin, i) => ({
  asin, brand: ["Brightech", "LEPOWER", "JOOFO"][i], trafficRank: i + 1, trafficVolume: totals[i], naturalVolume: natural[i], naturalShare: natural[i]! / totals[i]! * 100,
  advertisingVolume: totals[i]! - natural[i]!, advertisingShare: 100 - natural[i]! / totals[i]! * 100,
  top1Share: 60, top3Share: 100, hhi: 5200, effectiveChildren: 2, childCount: counts[i], recommendationTraffic: 90,
  maxAdvertisingChannel: "SP(常规)", maxAdvertisingChannelShare: 70, effectiveAdvertisingChannels: 4,
  pullGrade: "中", naturalGrade: "中强", advertisingGrade: "中", recommendationGrade: "中", variantGrade: "中", health: "健康", monthlyTrend: [],
})) } };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}
type DetailMode = "full" | "compact" | "empty" | "invalid";
function stagePayload(mode: DetailMode, run: string) {
  const listingByAsin = mode === "full" ? fullByAsin : Object.fromEntries(asins.map((asin, i) => [asin, mode === "compact"
    ? { total: totals[i], natural: natural[i], advertising: totals[i]! - natural[i]! }
    : { ...fullByAsin[asin], adChannels: mode === "empty" ? [] : [{ label: "SP(常规)", score: -1, ratio: 101 }], recommendationSources: mode === "empty" ? [] : null, children: mode === "empty" ? [] : [null] }]));
  const data = { listingByAsin, monthlyByAsin: {} };
  return { projectId: project.id, runId: run, jobId, jobVersion: 1, outputVersion: 1, stage: "traffic", stageStatus: "done", updatedAt: "2026-09-09T05:48:51.274Z", data,
    contentHash: createHash("sha256").update(JSON.stringify(canonical({ stage: "traffic", data }))).digest("hex") };
}
before(async () => {
  server = await createServer({ configFile: false, define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(mode: DetailMode | "none" = "full", width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: "block" });
  const page = await context.newPage();
  const state = { mode, snapshotStatus: 200, stageStatus: 200, run: runId, completed: false, jobVersion: 1, holdSnapshots: false, holdStages: false, snapshotReads: 0, stageReads: 0, jobReads: 0, taskWrites: 0, externalApis: 0 };
  const pending: Array<() => Promise<void>> = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const reply = (route: Route, payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { if (!/\.(png|jpg|jpeg|svg|webp)(\?|$)/i.test(url.href)) state.externalApis++; return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") { state.taskWrites++; return reply(route, {}, 405); }
    const path = url.pathname.replace(/^\/api\/agent/, "");
    if (path.endsWith("/traffic-snapshot")) {
      state.snapshotReads++;
      const status = state.snapshotStatus;
      const respond = () => reply(route, status === 200 ? summary : {}, status);
      if (state.holdSnapshots) { pending.push(respond); return; }
      return respond();
    }
    if (path.endsWith("/stages/traffic/output")) {
      state.stageReads++;
      const status = state.mode === "none" ? 404 : state.stageStatus;
      const payload = stagePayload(state.mode === "none" ? "compact" : state.mode, state.run);
      const respond = () => reply(route, payload, status);
      if (state.holdStages) { pending.push(respond); return; }
      return respond();
    }
    if (path === "/api/catalog") return reply(route, { items: [] });
    if (path === "/api/runtime-analysis-data") return reply(route, { catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: {}, ratingByAsin: {} }, salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} }, childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} }, imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} } });
    if (path === "/api/alexa-voc") return reply(route, { records: [] });
    if (path.startsWith("/v1/local-data/projects/")) return reply(route, { project });
    if (path === "/v1/local-data/projects") return reply(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return reply(route, { project: { ...project, currentRunId: state.run } });
    if (path === `/v1/runs/${state.run}`) return reply(route, { run: { id: state.run, projectId: project.id, idempotencyKey: jobId }, stages: [] });
    if (path === `/v1/local-data/sync-asins/${jobId}`) {
      state.jobReads++;
      return reply(route, { jobId, jobVersion: state.jobVersion, status: state.completed ? "completed" : "running", publication: { status: "not-required" }, message: "本地夹具", currentStageId: "reviews", asins, marketplace: "US", scope: { projectId: project.id, runId: state.run }, stages: [{ id: "traffic", label: "流量", kind: "auto", status: "done", estimatedSeconds: 10 }], asinProgress: {} });
    }
    return reply(route, {}, 404);
  });
  async function open() { await page.goto(`${origin}/tests/agent/helpers/traffic-display-harness.html?appSearch=${encodeURIComponent(search())}`); await page.locator(".traffic-distribution-row").first().waitFor(); }
  async function close() { await context.close(); assert.deepEqual(errors, []); assert.equal(state.taskWrites, 0, "no task/post/replay requests"); assert.equal(state.externalApis, 0, "no provider requests"); }
  return { page, state, pending, open, close };
}
async function waitForText(page: Page, selector: string, value: string) {
  await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent?.includes(value), { selector, value }, { timeout: 15000 });
}

for (const width of [1280, 1920]) test(`actual traffic page formats all rows and fits numeric cells at ${width}px`, async () => {
  const f = await fixture("full", width);
  try {
    await f.open();
    await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    const rows = f.page.locator(".traffic-distribution-row");
    for (let i = 0; i < 3; i++) {
      const naturalCell = rows.nth(i).locator(".traffic-metric-cell").nth(0);
      assert.equal(await naturalCell.locator("strong").first().textContent(), ["128,266", "9,381", "123,897"][i]);
      assert.equal(await naturalCell.locator("em").first().textContent(), ["47.6%", "41.5%", "67.1%"][i]);
      assert.equal(await naturalCell.locator("strong").nth(1).textContent(), ["141,361", "13,240", "60,691"][i]);
      assert.equal(await naturalCell.locator("em").nth(1).textContent(), ["52.4%", "58.5%", "32.9%"][i]);
      assert.equal(await rows.nth(i).locator(".traffic-metric-cell").nth(1).locator(".traffic-dist-bars > div").count(), 4);
      assert.match(await f.page.locator(".child-traffic-card-head > small").nth(i).innerText(), new RegExp(`${counts[i]} 个子体`));
    }
    const geometry = await f.page.locator(".traffic-dist-bars > div").evaluateAll(elements => elements.map(element => {
      const score = element.querySelector("strong")!, pct = element.querySelector("em")!;
      const range = document.createRange(); range.selectNodeContents(score); const scoreRect = range.getBoundingClientRect(); range.selectNodeContents(pct); const percentRect = range.getBoundingClientRect();
      return { overlap: scoreRect.right > percentRect.left + 1, spill: percentRect.right > element.closest(".traffic-metric-cell")!.getBoundingClientRect().right + 1, title: element.getAttribute("title")!, score: score.textContent!, pct: pct.textContent! };
    }));
    for (const item of geometry) { assert.ok(!item.overlap && !item.spill, JSON.stringify(item)); assert.ok(item.title.includes(item.score) && item.title.includes(item.pct)); }
  } finally { await f.close(); }
});

test("historical compact stage retains known summary counts but never invents details", async () => {
  const f = await fixture("compact");
  try { await f.open(); await waitForText(f.page, ".child-traffic-card", "明细待补齐");
    for (let i = 0; i < 3; i++) assert.match(await f.page.locator(".child-traffic-card-head > small").nth(i).innerText(), new RegExp(`已识别 ${counts[i]} 个子体`));
    assert.equal(await f.page.locator(".child-traffic-row").count(), 0);
    assert.equal(await f.page.locator(".traffic-distribution-row .traffic-metric-cell:nth-child(3) .traffic-dist-bars").count(), 0);
  } finally { await f.close(); }
});

for (const mode of ["empty", "invalid"] as const) test(`actual page distinguishes authoritative ${mode} details from missing data`, async () => {
  const f = await fixture(mode);
  try {
    await f.open();
    const message = mode === "empty" ? "已返回，无符合条件的明细" : "数据格式异常，明细待补齐";
    await waitForText(f.page, ".child-traffic-card", message);
    for (let i = 0; i < 3; i++) {
      const parent = f.page.locator(".traffic-distribution-row").nth(i);
      assert.equal(await parent.locator(".traffic-dist-empty").filter({ hasText: message }).count(), 2);
      const child = f.page.locator(".child-traffic-card").nth(i);
      assert.equal(await child.locator(".traffic-dist-empty").innerText(), `—\n${message}`);
      const count = await child.locator(".child-traffic-card-head > small").innerText();
      assert.ok(count.includes(mode === "empty" ? "0 个子体" : `已识别 ${counts[i]} 个子体，明细待补齐`), count);
      assert.equal(await child.locator(".child-traffic-row").count(), 0);
    }
  } finally { await f.close(); }
});

test("both response orders and a browser refresh keep independently accepted full stage details", async () => {
  for (const first of ["stage", "snapshot"] as const) {
    const f = await fixture();
    try {
      f.state.holdSnapshots = first === "stage";
      f.state.holdStages = first === "snapshot";
      await f.open();
      await waitForText(f.page, ".traffic-distribution-grid", "128,266");
      if (first === "stage") await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
      else assert.equal(await f.page.locator(".child-traffic-row").count(), 0);
      f.state.holdStages = false; f.state.holdSnapshots = false;
      for (const release of f.pending.splice(0)) await release();
      await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
      await f.page.reload();
      await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
      assert.equal(await f.page.locator(".child-traffic-row").count(), 8, "default TOP3/2/TOP3");
      await f.page.locator(".child-traffic-card").first().getByRole("button", { name: "展开其余 8 个子体" }).click();
      assert.equal(await f.page.locator(".child-traffic-card").first().locator(".child-traffic-row").count(), 11);
    } finally { await f.close(); }
  }
});

for (const status of [404, 403, 503]) test(`unavailable snapshot ${status} and absent stage do not use compiled global traffic`, async () => {
  const f = await fixture("none");
  try {
    f.state.snapshotStatus = status;
    await f.open();
    await waitForText(f.page, ".child-traffic-card", "子体数据待补齐");
    assert.equal(await f.page.locator(".traffic-dist-bars").count(), 0);
    assert.equal(await f.page.locator(".child-traffic-row").count(), 0);
    assert.ok(!(await f.page.locator(".child-traffic-card-head > small").first().innerText()).includes("0 个子体"));
  } finally { await f.close(); }
});

for (const change of ["sessionIdentity", "organizationId", "logoutPending"] as const) test(`actual page clears both data paths before paint on ${change} and rejects late 200`, async () => {
  const f = await fixture();
  try {
    await f.open(); await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    f.state.holdSnapshots = true; f.state.holdStages = true; f.state.jobVersion = 2;
    const deadline = Date.now() + 10000;
    while (f.pending.length < 2 && Date.now() < deadline) await f.page.waitForTimeout(100);
    assert.ok(f.pending.length >= 2, "old snapshot and stage are in flight");
    f.state.snapshotStatus = 403; f.state.stageStatus = 403;
    const reads = f.state.snapshotReads + f.state.stageReads;
    const immediate = await f.page.evaluate(change => {
      window.setTrafficFixtureSession?.(change === "logoutPending" ? { logoutPending: true } : change === "sessionIdentity" ? { sessionIdentity: "B".repeat(43) } : { organizationId: "018f1f5c-60f0-4b7a-8000-000000000099" });
      const text = document.querySelector(".traffic-distribution-grid")?.textContent ?? "";
      return { oldSummary: text.includes("128,266"), oldDetail: text.includes("合成相似商品"), children: document.querySelectorAll(".child-traffic-row").length };
    }, change);
    assert.deepEqual(immediate, { oldSummary: false, oldDetail: false, children: 0 });
    if (change !== "logoutPending") {
      const returnedToOriginal = await f.page.evaluate(change => {
        window.setTrafficFixtureSession?.(change === "sessionIdentity" ? { sessionIdentity: "A".repeat(43) } : { organizationId: "018f1f5c-60f0-4b7a-8000-000000000002" });
        const text = document.querySelector(".traffic-distribution-grid")?.textContent ?? "";
        return { oldSummary: text.includes("128,266"), oldDetail: text.includes("合成相似商品"), children: document.querySelectorAll(".child-traffic-row").length };
      }, change);
      assert.deepEqual(returnedToOriginal, { oldSummary: false, oldDetail: false, children: 0 }, "A -> B -> A must not revive A's previous receipt");
    }
    f.state.holdSnapshots = false; f.state.holdStages = false;
    for (const release of f.pending.splice(0)) await release();
    await f.page.waitForTimeout(change === "logoutPending" ? 5300 : 1800);
    assert.equal(await f.page.locator(".child-traffic-row").count(), 0);
    assert.equal(await f.page.locator(".traffic-dist-bars").count(), 0);
    if (change === "logoutPending") assert.equal(f.state.snapshotReads + f.state.stageReads, reads, "logout issues no new reads");
  } finally { await f.close(); }
});

test("completed same-job run reauthorizes detail reads after a session change without creating a task", async () => {
  const f = await fixture();
  try {
    f.state.completed = true;
    await f.open(); await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    const before = f.state.stageReads;
    await f.page.evaluate(() => window.setTrafficFixtureSession?.({ sessionIdentity: "B".repeat(43) }));
    await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    assert.ok(f.state.stageReads > before, "same completed job refetched through fresh owner");
  } finally { await f.close(); }
});

test("returning to the traffic tab preserves same-owner completed details without rearming the job", async () => {
  const f = await fixture();
  try {
    f.state.completed = true;
    await f.open(); await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    const before = f.state.stageReads;
    const jobReads = f.state.jobReads;
    await f.page.evaluate(search => window.navigateTrafficFixture?.(search.replace("tab=traffic", "tab=overview")), search());
    await f.page.locator(".traffic-distribution-grid").waitFor({ state: "detached" });
    await f.page.evaluate(search => window.navigateTrafficFixture?.(search), search());
    await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    assert.equal(await f.page.locator(".child-traffic-row").count(), 8);
    assert.equal(f.state.stageReads, before, "tab navigation retains accepted detail, not job polling");
    assert.equal(f.state.jobReads, jobReads, "a settled job remains settled across tabs");
    await f.page.evaluate(search => {
      const params = new URLSearchParams(search); params.delete("syncJob");
      window.navigateTrafficFixture?.(params.toString());
    }, search());
    await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    assert.equal(await f.page.locator(".child-traffic-row").count(), 8, "retained terminal job remains the same evidence owner after URL pointer cleanup");
    assert.equal(f.state.jobReads, jobReads);
  } finally { await f.close(); }
});

test("same ASINs in a different run do not retain earlier stage data", async () => {
  const f = await fixture();
  try {
    await f.open(); await waitForText(f.page, ".traffic-distribution-grid", "合成相似商品");
    f.state.run = nextRun; f.state.snapshotStatus = 403; f.state.stageStatus = 403;
    await f.page.evaluate(search => window.navigateTrafficFixture?.(search), search(nextRun));
    await f.page.waitForTimeout(1800);
    assert.equal(await f.page.locator(".traffic-dist-bars").count(), 0);
    assert.equal(await f.page.locator(".child-traffic-row").count(), 0);
  } finally { await f.close(); }
});
