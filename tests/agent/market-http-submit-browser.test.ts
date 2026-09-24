import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("market submissions work on insecure HTTP with one node and preserve retry keys", { timeout: 90000 }, async t => {
  const server = await createServer({ configFile: false, define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const upstream = server.resolvedUrls!.local[0];
  const origin = "http://market-http.test";
  for (const view of ["overview", "analysis", "shapes", "keywords", "themes"]) {
    await t.test(view, async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(6000);
      const errors: string[] = [];
      const writes: Array<{ body: Record<string, unknown>; key?: string }> = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin) return route.abort();
          if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/", '<html><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MarketResearchSection} from "/app/market-research-section.tsx";createRoot(document.getElementById("root")).render(React.createElement(MarketResearchSection,{sessionIdentity:"http-test"}));</script></body></html>') });
          if (!url.pathname.startsWith("/api/")) return route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, upstream).href }) });
          if (request.method() === "POST") {
            writes.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
            return route.fulfill({ status: 503, json: { error: { message: "测试来源暂时不可用，请重试" } } });
          }
          if (url.pathname.endsWith("/market-research/jobs")) return route.fulfill({ json: { jobs: [] } });
          return route.fulfill({ status: 404, json: { error: { message: "No saved fixtures" } } });
        });
        await page.goto(`${origin}/?themeView=${view === "analysis" ? "overview" : view}&marketSite=US&marketNode=1069828&marketMonth=2026-08&marketFrom=2026-08`);
        await page.getByRole("navigation", { name: "市场调研模块" }).waitFor();
        assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues })), { secure: false, uuid: "undefined", random: "function" });
        let button = "筛选市场";
        if (view === "analysis") { await page.getByText("分析设置与任务管理", {exact:true}).click(); button = "开始总览分析"; }
        if (view === "keywords") { await page.getByLabel("产品核心名", { exact: true }).fill("gel pens"); await page.getByLabel("类目说明", { exact: true }).fill("中性笔"); button = "采集关键词并分析"; }
        if (view === "themes") button = "拉取见解";
        await page.getByRole("button", { name: button, exact: true }).click();
        await page.waitForTimeout(350);
        assert.deepEqual(errors, [], "no uncaught submission error");
        await page.getByRole("alert").filter({ hasText: "测试来源暂时不可用" }).waitFor();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].body.nodeQuery ?? writes[0].body.nodeIdPath, "1069828");
        assert.match(writes[0].key!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        await page.getByRole("button", { name: view === "overview" ? "搜索" : button, exact: true }).click();
        await page.waitForFunction(() => !!document.querySelector('[role="alert"]'));
        await page.waitForTimeout(200);
        assert.equal(writes.length, 2);
        assert.equal(writes[0].key, writes[1].key, "unchanged input retry reuses the request key");
      } finally { await page.close(); }
    });
  }
});
