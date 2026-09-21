import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("Chinese selling points load once, show failure retry, and reuse successful translations", { timeout: 60_000 }, async t => {
  const server = await createServer({ configFile: false, plugins: [react()], define: { "process.env": "{}" }, server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const origin = server.resolvedUrls!.local[0];
  let state = "missing";
  let posts = 0;
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/", `<div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {SellingPointTranslation} from '/app/selling-point-translation.tsx';createRoot(document.getElementById('root')).render(React.createElement(SellingPointTranslation,{projectId:'10000000-0000-4000-8000-000000000001',asin:'B000000001'}));</script>`) });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "POST") { posts++; state = posts === 1 ? "failed" : "ready"; }
    return route.fulfill({ json: { asin: "B000000001", sourceHash: "hash", state, points: state === "ready" ? ["支持 2、4、8 小时定时"] : [],
      original: ["Timer supports 2/4/8 hours"], sourceComplete: false, message: state === "failed" ? "翻译未完成，请重试。" : null } });
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "重新翻译" }).waitFor();
  assert.equal(posts, 1);
  assert.equal(await page.getByText("Timer supports", { exact: false }).count(), 0);
  await page.getByRole("button", { name: "重新翻译" }).click();
  await page.getByText("支持 2、4、8 小时定时", { exact: true }).waitFor();
  assert.equal(posts, 2);
  assert.equal(await page.getByText("Timer supports 2/4/8 hours", { exact: true }).isVisible(), false);
  await page.getByText("查看原文", { exact: true }).click();
  assert.equal(await page.getByText("Timer supports 2/4/8 hours", { exact: true }).isVisible(), true);
  await page.reload();
  await page.getByText("支持 2、4、8 小时定时", { exact: true }).waitFor();
  assert.equal(posts, 2);
});
