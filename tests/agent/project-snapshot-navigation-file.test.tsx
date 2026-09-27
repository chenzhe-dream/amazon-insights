import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import {
  exportProjectFixture, exportRuntimeFixture, exportSessionFixture,
  exportSourceProjectFixture, exportTranslationFixture, exportVersionFixture,
} from "./helpers/project-export-fixture";

const pages = ["overview", "images", "voc-summary", "voc-insight", "voc-positioning",
  "keyword-analysis", "keyword-insight", "definition", "checklist", "traffic"] as const;
// These are page-body passages produced by the populated fixture, including sibling
// pages that share the VOC or keyword source with a selected page.
const unselectedBodySentinels = {
  overview: "父体订单量份额与12个月趋势",
  "voc-summary": "七个相同维度同屏对齐，直接比较顾客关注与购买决策差异",
  "voc-positioning": "将买家喜爱、差评问题与未满足需求三表合并",
  "keyword-analysis": "当前项目没有可展示的已发布关键词分析。",
  definition: "基于已保存的输入，使用本地规则将",
  checklist: "完整十项清单",
  traffic: "同屏比较流量结构、月趋势，并输出推广能力结论",
} as const;
const modules = "overview,voc,keywords,definition,checklist,traffic";
let server: ViteDevServer, browser: Browser, origin: string;

before(async () => {
  server = await createServer({ configFile: false, cacheDir: "test-results/navigation-file-vite",
    define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function openDialog(t: test.TestContext, missing = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(() => page.close());
  page.setDefaultTimeout(30000);
  await page.route("https://m.media-amazon.com/**", route => route.abort());
  const state = { calls: [] as string[], writes: [] as string[] };
  const project = exportProjectFixture();
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/agent", "");
    state.calls.push(path);
    if (route.request().method() !== "GET") state.writes.push(path);
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/auth/session") return reply({ ...exportSessionFixture(), visibleModules: modules.split(",") });
    if (path === "/api/runtime-analysis-data") return reply(exportRuntimeFixture());
    if (path === "/api/alexa-voc") return reply({ records: [] });
    if (path === "/api/local-rule-reports") return reply({ reports: [] });
    if (path.endsWith("/project-favorites")) return reply({ projectIds: [project.id] });
    if (path === "/v1/local-data/projects") return reply({ projects: [project], pagination: {
      page: 1, pageSize: 10, total: 1, totalPages: 1, historyTotal: 1, favoritesTotal: 1, categories: [],
    } });
    if (path === `/v1/local-data/projects/${project.id}`) return reply({ project });
    if (path === `/v1/projects/${project.sourceProjectId}`) return reply({ project: { ...exportSourceProjectFixture(), currentRunId: null } });
    if (path.endsWith("/current-display-version")) return missing
      ? reply({ error: { code: "PROJECT_REPORT_NOT_PUBLISHED", message: "未发布", requestId: "test" } }, 404)
      : reply(exportVersionFixture());
    if (path.includes("/selling-point-translations/")) return reply(exportTranslationFixture(path.split("/").at(-1)!));
    return reply({ error: "Unexpected endpoint" }, 404);
  });
  await page.goto(`${origin}/tests/agent/helpers/analysis-favorites-harness.html?export=true&modules=${modules}`);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const iframe = page.locator('iframe[title="HTML 快照预览"]');
  await iframe.waitFor();
  await assert.doesNotReject(iframe.contentFrame().locator('[data-snapshot-page="overview"]').waitFor());
  return { page, iframe, state };
}

async function assertAllPagesNavigable(page: Page) {
  assert.deepEqual(await page.locator(".snapshot-nav-group > summary").allTextContents(),
    ["竞品概览参数 · 主辅图 · 变体", "VOC原始矩阵 · 洞察立项", "关键词调研竞品词分析 · 洞察"]);
  assert.equal(await page.locator(".snapshot-nav-direct").count(), 3);
  assert.equal(await page.locator(".snapshot-radio").count(), 10);
  assert.equal(await page.locator(".snapshot-radio:checked").getAttribute("id"), "snapshot-page-overview");
  for (const [index, id] of pages.entries()) {
    if (index) {
      await page.locator(`#snapshot-page-${pages[index - 1]}`).focus();
      await page.keyboard.press("ArrowRight");
    }
    assert.equal(await page.locator(`#snapshot-page-${id}`).isChecked(), true, id);
    assert.equal(await page.locator(`[data-snapshot-page="${id}"]`).isVisible(), true, id);
    assert.equal(await page.locator(".snapshot-page:visible").count(), 1, id);
  }
}

test("complete ten-page preview and downloaded file navigate without scripts; browsing keeps original bytes", async t => {
  const { page, iframe, state } = await openDialog(t);
  const html = await iframe.getAttribute("srcdoc"); assert.ok(html);
  assert.equal(await iframe.getAttribute("sandbox"), "");
  for (const id of pages) assert.ok(html.includes(`data-snapshot-page="${id}"`), id);
  assert.equal((html.match(/<section class="snapshot-page" data-snapshot-page=/g) ?? []).length, 10);
  assert.doesNotMatch(html, /<script|data-internal-secret|UPSTREAM_EMPTY/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  const frame = iframe.contentFrame();
  assert.equal(await frame.locator('.snapshot-radio').count(), 10);
  assert.equal(await frame.locator('[data-snapshot-page="overview"]').isVisible(), true);
  const fullBodies = await frame.locator(".snapshot-page").evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [element.getAttribute("data-snapshot-page"), element.textContent])));
  for (const [id, sentinel] of Object.entries(unselectedBodySentinels)) {
    assert.ok(fullBodies[id]?.includes(sentinel), `${id} fixture body must contain its sentinel`);
    for (const other of pages.filter(pageId => pageId !== id)) {
      assert.equal(fullBodies[other]?.includes(sentinel), false, `${id} sentinel must be exclusive to its own body`);
    }
  }
  for (const [index, id] of pages.entries()) {
    if (index) {
      await frame.locator(`#snapshot-page-${pages[index - 1]}`).focus();
      await page.keyboard.press("ArrowRight");
    }
    assert.equal(await frame.locator(`[data-snapshot-page="${id}"]`).isVisible(), true, id);
    assert.equal(await frame.locator('.snapshot-page:visible').count(), 1, id);
  }
  await page.getByRole("dialog").screenshot({ path: "test-results/navigation-populated-modal.png" });
  const beforeBrowse = state.calls.length;
  await frame.locator('label[for="snapshot-page-images"]').evaluate((label: HTMLLabelElement) => label.click());
  await frame.locator('label[for="snapshot-page-traffic"]').evaluate((label: HTMLLabelElement) => label.click());
  assert.equal(state.calls.length, beforeBrowse);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "确认并开始导出" }).click();
  const download = await downloadPromise;
  const path = resolve("test-results/navigation-full-ten-pages.html");
  await download.saveAs(path);
  assert.deepEqual(await readFile(path), Buffer.from(html, "utf8"));
  assert.deepEqual(state.writes, []);

  const recipient = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
  t.after(() => recipient.close());
  const file = await recipient.newPage();
  const requests: string[] = [];
  file.on("request", request => { if (request.url().includes("/api/")) requests.push(request.url()); });
  await file.route("https://m.media-amazon.com/**", route => route.abort());
  await file.goto(pathToFileURL(path).href);
  await assertAllPagesNavigable(file);
  assert.deepEqual(requests, []);
  await file.emulateMedia({ media: "print" });
  assert.equal(await file.locator(".snapshot-page:visible").count(), 10);
  assert.equal(await file.locator(".snapshot-nav").isVisible(), false);
});

test("single and partial choices contain only selected page bodies, with a first selected home page", async t => {
  const { page, iframe } = await openDialog(t);
  const dialog = page.getByRole("dialog");
  for (const input of await dialog.locator('input[data-export-page]').all()) await input.uncheck();
  await dialog.getByText("请至少勾选一个页面。", { exact: true }).waitFor();
  await dialog.getByRole("checkbox", { name: "竞品 VOC 洞察", exact: true }).check();
  await iframe.waitFor();
  const single = await iframe.getAttribute("srcdoc"); assert.ok(single);
  assert.deepEqual([...single.matchAll(/<section class="snapshot-page" data-snapshot-page="([^"]+)"/g)].map(match => match[1]), ["voc-insight"]);
  assert.doesNotMatch(single.split("</head>")[1], /data-snapshot-page="voc-summary"|data-snapshot-page="voc-positioning"|竞品VOC 汇总/);
  assert.equal(await iframe.contentFrame().locator('[data-snapshot-page="voc-summary"], [data-snapshot-page="voc-positioning"]').count(), 0);
  assert.equal(await iframe.contentFrame().locator(".snapshot-radio:checked").getAttribute("id"), "snapshot-page-voc-insight");
  await dialog.getByRole("checkbox", { name: "关键词洞察", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "主辅图", exact: true }).check();
  await page.waitForFunction(() => document.querySelector('iframe[title="HTML 快照预览"]')?.getAttribute("srcdoc")?.includes('data-snapshot-page="images"'));
  const partial = await iframe.getAttribute("srcdoc"); assert.ok(partial);
  assert.deepEqual([...partial.matchAll(/<section class="snapshot-page" data-snapshot-page="([^"]+)"/g)].map(match => match[1]),
    ["images", "voc-insight", "keyword-insight"]);
  assert.equal(await iframe.contentFrame().locator(".snapshot-radio:checked").getAttribute("id"), "snapshot-page-images");
  assert.doesNotMatch(partial.split("</head>")[1], /data-snapshot-page="overview"|data-snapshot-page="keyword-analysis"|竞品参数总览|竞品关键词分析/);
  const previewHtml = await iframe.contentFrame().locator("html").evaluate(element => element.outerHTML);
  for (const [id, sentinel] of Object.entries(unselectedBodySentinels)) {
    assert.equal(partial.includes(sentinel), false, `${id} body leaked into serialized partial HTML`);
    assert.equal(previewHtml.includes(sentinel), false, `${id} body leaked into preview DOM`);
  }
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "确认并开始导出" }).click();
  const download = await downloadPromise;
  const path = resolve("test-results/navigation-partial-three-pages.html");
  await download.saveAs(path);
  assert.deepEqual(await readFile(path), Buffer.from(partial, "utf8"));
  const recipient = await browser.newPage({ javaScriptEnabled: false }); t.after(() => recipient.close());
  await recipient.route("https://m.media-amazon.com/**", route => route.abort());
  await recipient.goto(pathToFileURL(path).href);
  assert.equal(await recipient.locator(".snapshot-radio:checked").getAttribute("id"), "snapshot-page-images");
  assert.equal(await recipient.locator(".snapshot-page:visible").getAttribute("data-snapshot-page"), "images");
  const recipientHtml = await recipient.locator("html").evaluate(element => element.outerHTML);
  for (const [id, sentinel] of Object.entries(unselectedBodySentinels)) {
    assert.equal(recipientHtml.includes(sentinel), false, `${id} body leaked into recipient DOM`);
  }
});

test("selected but missing pages keep their own explanation and navigation", async t => {
  const { page, iframe } = await openDialog(t, true);
  const html = await iframe.getAttribute("srcdoc"); assert.ok(html);
  assert.equal((html.match(/<section class="snapshot-page" data-snapshot-page=/g) ?? []).length, 10);
  assert.match(html, /暂无已发布的竞品结果/);
  assert.match(html, /暂无已有分析输入/);
  assert.doesNotMatch(html, /UPSTREAM_EMPTY|catalog\.sellerSprite|\$0\.00/);
  const frame = iframe.contentFrame();
  await frame.locator('label[for="snapshot-page-voc-positioning"]').evaluate((label: HTMLLabelElement) => label.click());
  assert.equal(await frame.locator('[data-snapshot-page="voc-positioning"]').isVisible(), true);
  assert.deepEqual((await page.getByRole("button", { name: "确认并开始导出" }).isDisabled()), false);
});
