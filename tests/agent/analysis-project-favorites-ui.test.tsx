import { queryProjectLibrary } from "../../server/services/project-library-query";
import { LocalDataProjectListQuerySchema } from "../../shared/agent-contracts";
import type { AnalysisProject } from "../../app/lib/project-server";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
let server: ViteDevServer, browser: Browser, origin: string;
const id = "10000000-0000-4000-8000-000000000001";
const project = { majorCategory: null, categoryLabel: null, note: null, createdBy: null as string | null, latestAnalystName: null as string | null, createdAt: "2026-09-01T00:00:00Z", id, kind: "analysis", name: "历史灯具项目", slug: "test-lamps", marketplace: "US",
  asins: ["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"], updatedAt: "2026-09-01T00:00:00Z" };
before(async () => {
  server = await createServer({ configFile: false, cacheDir: "test-results/favorite-ui-vite", define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t: test.TestContext, kind = "analysis", admin = false, other = false, guard = false, freezeClock = false) {
  const page = await browser.newPage(); t.after(() => page.close());
  if (freezeClock) {
    await page.clock.install({ time: new Date("2026-09-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-09-01T00:00:01Z"));
  }
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const state = { favorite: false, fail: false, writes: [] as string[], hold: false, held: [] as (() => Promise<void>)[], projects: [{ ...project, kind }] };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method !== "GET") state.writes.push(`${method} ${path}`);
    if (path.endsWith("/project-favorites")) {
      const snapshot = { projectIds: state.favorite ? [id] : [] };
      if (state.hold) { state.held.push(() => reply(snapshot).catch(() => {})); return; }
      return reply(snapshot);
    }
    if (path.endsWith("/favorite")) {
      if (state.fail) return reply({ error: { message: "收藏保存失败，请重试" } }, 500);
      state.favorite = method === "PUT";
      return reply({ projectId: id, favorited: state.favorite });
    }
    if (path.endsWith(`/projects/${id}`) && method === "PATCH") {
      return state.fail ? reply({ error: { message: "保存失败" } }, 500) : reply({ project });
    }
    if (path === `/api/projects/${id}` && method === "DELETE") {
      if (state.fail) return reply({ error: { code: "FORBIDDEN", message: "删除失败，请重试" } }, 403);
      state.projects = []; return reply({ ok: true });
    }
    if (path.endsWith("/projects") && method === "GET") {
      const query = LocalDataProjectListQuerySchema.parse(Object.fromEntries(new URL(route.request().url()).searchParams));
      return reply(queryProjectLibrary(state.projects as AnalysisProject[], query, state.favorite ? [id] : []));
    }
    if (path.endsWith("/projects") && method === "POST") {
      const saved = { ...project, kind, id: "10000000-0000-4000-8000-000000000002", name: "新的灯具分析" };
      state.projects.push(saved); return reply({ project: saved });
    }
    return reply({}, 404);
  });
  await page.goto(`${origin}/tests/agent/helpers/analysis-favorites-harness.html?kind=${kind}&admin=${admin}&other=${other}&guard=${guard}`);
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().waitFor();
  return { page, state };
}

test("favorite preparation blocks blank names and failed saves; saves before favorite and permits unfavorite", async t => {
  const { page, state } = await fixture(t, "analysis", false, false, true);
  const favorite = page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first();
  await favorite.click();
  await page.getByText("请先填写细分名称，再收藏项目", { exact: true }).waitFor();
  assert.deepEqual(state.writes, []);
  await page.getByLabel("细分名称", { exact: true }).fill("融蜡灯");
  state.fail = true;
  await favorite.click();
  await page.getByText("保存细分名称失败，请重试", { exact: true }).waitFor();
  assert.equal(state.favorite, false);
  assert.deepEqual(state.writes, [`PATCH /api/agent/v1/local-data/projects/${id}`]);
  state.fail = false; state.writes = [];
  await favorite.click();
  await page.getByRole("button", { name: "★ 已收藏", exact: true }).waitFor();
  assert.deepEqual(state.writes, [`PATCH /api/agent/v1/local-data/projects/${id}`, `PUT /api/agent/v1/local-data/projects/${id}/favorite`]);
  await page.getByLabel("细分名称", { exact: true }).fill("");
  await page.getByRole("button", { name: "★ 已收藏", exact: true }).click();
  await favorite.waitFor();
  assert.equal(state.writes.at(-1), `DELETE /api/agent/v1/local-data/projects/${id}/favorite`);
  assert.equal(state.writes.length, 3);
});

test("history favorite prompts editing when only an automatic name exists", async t => {
  const { page, state } = await fixture(t);
  state.projects[0].name = "竞品分析 · US";
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("竞品分析 · US", { exact: true }).waitFor();
  await page.locator(".project-card").getByRole("button", { name: "☆ 收藏项目", exact: true }).click();
  await page.getByRole("heading", { name: "编辑项目", exact: true }).waitFor();
  await page.getByText("请先填写细分名称（项目名称）并保存，再收藏项目", { exact: true }).waitFor();
  assert.deepEqual(state.writes, []);
});
test("history is not implicitly favorite; explicit add/remove survives reload without deleting projects", async t => {
  const { page, state } = await fixture(t);
  await page.getByText("尚未收藏项目").waitFor();
  assert.equal(await page.locator(".project-card").count(), 0);
  assert.deepEqual(state.writes, []);
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("历史灯具项目", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "删除", exact: true }).count(), 0);
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().click();
  await page.getByRole("button", { name: "★ 已收藏", exact: true }).waitFor();
  await page.reload();
  await page.getByText("历史灯具项目", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消收藏", exact: true }).click();
  await page.getByText("尚未收藏项目").waitFor();
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("历史灯具项目", { exact: true }).waitFor();
  assert.deepEqual(state.writes, [`PUT /api/agent/v1/local-data/projects/${id}/favorite`, `DELETE /api/agent/v1/local-data/projects/${id}/favorite`]);
});

test("export is favorite-gated and opens a scoped modal without starting analysis or download", async t => {
  const { page, state } = await fixture(t);
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("历史灯具项目", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "导出", exact: true }).count(), 0);
  await page.locator(".project-card").getByRole("button", { name: "☆ 收藏项目", exact: true }).click();
  const trigger = page.getByRole("button", { name: "导出", exact: true });
  await trigger.waitFor();
  const search = page.getByPlaceholder("搜项目名 / ASIN / 大类 / 品类 / 创建人 / 分析人 / 备注");
  const searchResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith("/projects")
    && new URL(response.url()).searchParams.get("search") === "历史灯具");
  await search.fill("历史灯具");
  await trigger.waitFor();
  const currentUrl = page.url();
  const writes = [...state.writes];
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "导出预览", exact: true });
  await dialog.waitFor();
  await searchResponse;
  await trigger.waitFor();
  assert.equal(await dialog.isVisible(), true, "search refresh must not dismiss the export dialog");
  await page.screenshot({ path: "test-results/favorite-export-modal.png", fullPage: true });
  assert.match(await dialog.innerText(), /历史灯具项目/);
  for (const asin of project.asins) assert.match(await dialog.innerText(), new RegExp(asin));
  await dialog.getByText("报告数据与导出服务尚未接入，暂不能生成 HTML。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "确认并开始导出" }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
  assert.equal(await dialog.getByRole("checkbox").count(), 8);
  await dialog.getByRole("checkbox", { name: "VOC 分析", exact: true }).uncheck();
  assert.equal(await dialog.getByRole("heading", { name: "VOC 分析", exact: true }).count(), 0);
  for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.uncheck();
  await dialog.getByText("请至少勾选一个模块。", { exact: true }).waitFor();
  await dialog.getByRole("checkbox", { name: "竞品参数总览", exact: true }).check();
  const close = dialog.getByRole("button", { name: "关闭导出预览" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("Tab");
  assert.equal(await close.evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden");
  assert.equal(await search.inputValue(), "历史灯具");
  assert.equal(page.url(), currentUrl);
  assert.deepEqual(state.writes, writes);
  assert.equal(downloads, 0);
  await page.getByRole("button", { name: "取消收藏", exact: true }).click();
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "导出", exact: true }).count(), 0);
});

test("export scope respects module visibility and remains usable in a narrow viewport", async t => {
  const { page, state } = await fixture(t);
  state.favorite = true;
  await page.goto(page.url() + "&modules=overview");
  const trigger = page.getByRole("button", { name: "导出", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "导出预览", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 3);
  assert.equal(await dialog.getByRole("checkbox", { name: "VOC 分析", exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 680 });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 680);
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(state.writes, []);
  await page.goto(page.url().replace("modules=overview", "modules="));
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await dialog.getByText("当前没有可选择的导出模块。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "确认并开始导出" }).isDisabled(), true);
});

test("history shows a read-only latest analyst, searches that name, and keeps unknown separate from creator", async t => {
  const { page, state } = await fixture(t);
  state.projects[0].createdBy = "自由填写人";
  state.projects[0].latestAnalystName = "可信分析人";
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("最近分析人：可信分析人", { exact: true }).waitFor();
  const search = page.getByPlaceholder("搜项目名 / ASIN / 大类 / 品类 / 创建人 / 分析人 / 备注");
  await search.fill("可信分析人");
  await page.getByText("历史灯具项目", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 1);
  await page.locator(".project-card").getByRole("button", { name: "编辑", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: /分析人/ }).count(), 0);
  state.projects[0].latestAnalystName = null;
  await search.fill("");
  await page.getByRole("button", { name: "刷新列表" }).click();
  await page.getByText("最近分析人：未记录", { exact: true }).waitFor();
  assert.match(await page.locator(".project-card").innerText(), /创建人：自由填写人/);
  assert.deepEqual(state.writes, []);
});

test("an unchanged initial search cannot reset a history page after the debounce interval", async t => {
  const { page, state } = await fixture(t, "analysis", false, false, false, true);
  state.projects = Array.from({ length: 11 }, (_, i) => ({ ...project, id: `10000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, name: `快速翻页${i}`, updatedAt: new Date(Date.UTC(2026, 8, 23 - i)).toISOString() }));
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("快速翻页0", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("快速翻页10", { exact: true }).waitFor();
  await page.clock.runFor(350);
  assert.equal(await page.getByRole("button", { name: "下一页", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "上一页", exact: true }).isDisabled(), false);
  assert.equal(await page.getByText("快速翻页10", { exact: true }).count(), 1);
});
test("failed favorite mutation remains unstarred with visible retryable error", async t => {
  const { page, state } = await fixture(t); state.fail = true;
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().click();
  await page.getByText("收藏保存失败，请重试").first().waitFor();
  assert.equal(state.favorite, false);
  state.fail = false;
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().click();
  await page.getByRole("button", { name: "★ 已收藏", exact: true }).waitFor();
});
test("late favorite reads from an abandoned session cannot restore the old star", async t => {
  const { page, state } = await fixture(t);
  state.favorite = true; state.hold = true;
  await page.getByRole("button", { name: "刷新列表" }).click();
  await assert.doesNotReject(async () => {
    for (let i = 0; state.held.length === 0 && i < 50; i++) await page.waitForTimeout(20);
    assert.ok(state.held.length);
  });
  state.favorite = false; state.hold = false;
  await page.getByRole("button", { name: "切换会话" }).click();
  for (const release of state.held) await release();
  await page.getByText("尚未收藏项目").waitFor();
  assert.equal(await page.getByRole("button", { name: "★ 已收藏", exact: true }).count(), 0);
});
test("other project kinds retain their existing list and delete workflow", async t => {
  const { page } = await fixture(t, "traffic-promo");
  await page.getByText("历史灯具项目", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^历史项目（/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "删除", exact: true }).count(), 1);
});

test("saving a new analysis creates history only and opens the history view", async t => {
  const { page, state } = await fixture(t);
  await page.getByPlaceholder("如：儿童三轮滑板车 · 美国站").fill("新的灯具分析");
  await page.getByRole("button", { name: "保存为历史项目", exact: true }).click();
  await page.getByText("新的灯具分析", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^历史项目（/ }).getAttribute("aria-pressed"), "true");
  assert.deepEqual(state.writes, ["POST /api/projects"]);
  await page.getByRole("button", { name: /^已收藏（/ }).click();
  await page.getByText("尚未收藏项目").waitFor();
});

test("admin history deletion requires confirmation, preserves failed state and clears current selection on success", async t => {
  const { page, state } = await fixture(t, "analysis", true);
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().click();
  await page.getByRole("button", { name: "取消收藏", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "删除项目", exact: true }).count(), 0);
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  const remove = page.getByRole("button", { name: "删除项目", exact: true });
  page.once("dialog", dialog => dialog.dismiss());
  await remove.click();
  assert.equal(state.writes.some(value => value === `DELETE /api/projects/${id}`), false);
  state.fail = true;
  page.once("dialog", dialog => { assert.match(dialog.message(), /团队/); return dialog.accept(); });
  await remove.click();
  await page.getByText("删除失败，请重试", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 1);
  assert.equal(state.favorite, true);
  assert.equal(await page.getByLabel("当前项目").textContent(), id);
  state.fail = false;
  page.once("dialog", dialog => dialog.accept());
  await remove.click();
  await page.getByText("暂无历史项目", { exact: false }).waitFor();
  assert.equal(await page.getByLabel("当前项目").textContent(), "无");
  await page.getByText(/已删除项目/).waitFor();
});

test("deleting another history project keeps the current project selected", async t => {
  const { page } = await fixture(t, "analysis", true, true);
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.getByText(/已删除项目/).waitFor();
  assert.equal(await page.getByLabel("当前项目").textContent(), "other-project");
  assert.equal(await page.locator(".project-card").count(), 0);
});


test("history pages, search resets page, size changes and last-page deletion remain consistent", async t => {
  const { page, state } = await fixture(t, "analysis", true);
  state.projects = Array.from({ length: 23 }, (_, i) => ({ ...project, id: i === 22 ? id : `10000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`, name: `测试项目${String(i).padStart(2, "0")}`, updatedAt: new Date(Date.UTC(2026, 8, 23 - i)).toISOString() }));
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("测试项目00", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 10);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("测试项目10", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 10);
  await page.getByPlaceholder("搜项目名 / ASIN / 大类 / 品类 / 创建人 / 分析人 / 备注").fill("测试项目22");
  await page.getByText("测试项目22", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 1);
  assert.equal(await page.getByRole("button", { name: "上一页", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByText("测试项目00", { exact: true }).waitFor();
  await page.getByLabel("每页项目数").selectOption("20");
  await page.getByText("测试项目19", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 20);
  await page.getByRole("button", { name: "末页", exact: true }).click();
  await page.getByText("测试项目22", { exact: true }).waitFor();
  assert.equal(await page.locator(".project-card").count(), 3);
  await page.screenshot({ path: ".superpowers/sdd/project-pagination-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".superpowers/sdd/project-pagination-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  state.projects = state.projects.slice(0, 20);
  await page.getByRole("button", { name: "刷新列表" }).click();
  await page.getByText("测试项目00", { exact: true }).waitFor();
  // A clamped response changes the requested page and starts its final refresh.
  await page.waitForFunction(() => document.querySelectorAll(".project-card").length === 20);
  assert.equal(await page.locator(".project-card").count(), 20);
  assert.equal(await page.getByRole("button", { name: "下一页", exact: true }).isDisabled(), true);
});


test("time sorting resets pagination and displays creation and genuine modification separately", async t => {
  const { page, state } = await fixture(t, "analysis");
  state.projects = Array.from({ length: 11 }, (_, i) => ({ ...project,
    id: `10000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
    name: `时间项目${String(i).padStart(2, "0")}`,
    createdAt: new Date(Date.UTC(2026, 8, i + 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 21 - i)).toISOString(),
  }));
  await page.getByRole("button", { name: /^历史项目（/ }).click();
  await page.getByText("时间项目00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("时间项目10", { exact: true }).waitFor();
  const sort = page.getByLabel("时间排序");
  for (const [value, first] of [["created_desc", "10"], ["created_asc", "00"], ["updated_asc", "10"], ["updated_desc", "00"]]) {
    const response = page.waitForResponse(response => response.url().includes(`/local-data/projects?`) && new URL(response.url()).searchParams.get("sort") === value);
    await sort.selectOption(value); await response;
    await page.waitForFunction(expected => document.querySelector(".project-card-title")?.textContent === expected, `时间项目${first}`);
    assert.equal(await page.getByRole("button", { name: "上一页", exact: true }).isDisabled(), true);
  }
  await sort.selectOption("created_desc");
  await page.waitForFunction(() => document.querySelector(".project-card-title")?.textContent === "时间项目10");
  assert.match(await page.locator(".project-card").first().innerText(), /未修改/);
  assert.equal(await page.locator(".project-card").first().locator("time").count(), 1);
  assert.equal(await page.locator(".project-card").nth(1).locator("time").count(), 2);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator(".project-list-card").screenshot({ path: ".superpowers/sdd/project-time-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator(".project-list-card").screenshot({ path: ".superpowers/sdd/project-time-mobile.png" });
});
