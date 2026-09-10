import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
let server: ViteDevServer, browser: Browser, origin: string;
const id = "10000000-0000-4000-8000-000000000001";
const project = { id, kind: "analysis", name: "历史灯具项目", slug: "test-lamps", marketplace: "US",
  asins: ["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"], updatedAt: "2026-09-01T00:00:00Z" };
before(async () => {
  server = await createServer({ configFile: false, define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t: test.TestContext, kind = "analysis", admin = false, other = false) {
  const page = await browser.newPage(); t.after(() => page.close());
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
    if (path === `/api/projects/${id}` && method === "DELETE") {
      if (state.fail) return reply({ error: { code: "FORBIDDEN", message: "删除失败，请重试" } }, 403);
      state.projects = []; return reply({ ok: true });
    }
    if (path.endsWith("/projects") && method === "GET") return reply({ projects: state.projects });
    if (path.endsWith("/projects") && method === "POST") {
      const saved = { ...project, kind, id: "10000000-0000-4000-8000-000000000002", name: "新的灯具分析" };
      state.projects.push(saved); return reply({ project: saved });
    }
    return reply({}, 404);
  });
  await page.goto(`${origin}/tests/agent/helpers/analysis-favorites-harness.html?kind=${kind}&admin=${admin}&other=${other}`);
  await page.getByRole("button", { name: "☆ 收藏项目", exact: true }).first().waitFor();
  return { page, state };
}
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
