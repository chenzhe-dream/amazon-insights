import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("sales trend survives a slow pointer crossing and supports pinned inspection", { timeout: 90000 }, async t => {
  // Mount the real page-local component without loading unrelated page services.
  const source = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const component = source.slice(source.indexOf("function SalesTrendSparkline("), source.indexOf("type ChartHover ="));
  const cache = mkdtempSync(join(tmpdir(), "sales-hover-vite-"));
  const server = await createServer({ configFile: false, cacheDir: cache, plugins: [{
    name: "sales-trend-test-entry",
    resolveId: id => id === "/sales-test.tsx" ? "/sales-test.tsx" : undefined,
    load: id => id === "/sales-test.tsx" ? `
      import React,{useState,useRef,useEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import '/app/comparison-layout.css';
      const sorftimeSalesTrendMeta={source:'Sorftime'};
      ${component}
      const record={status:'ready',fetchedAt:'2026-09-15',volume:[{month:'2026-07',value:40},{month:'2026-08',value:50}],amount:[{month:'2026-07',value:400},{month:'2026-08',value:500}]};
      createRoot(document.getElementById('root')).render(<SalesTrendSparkline asin="TEST" sales30d={50} color="#38f" trendByAsin={{TEST:record}}/>);
    ` : undefined,
  }, react()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); rmSync(cache, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(5000);
  const origin = new URL(server.resolvedUrls!.local[0]!).origin;
  await page.route(`${origin}/`, route => route.fulfill({ contentType: "text/html", body: '<div id="root" style="margin:120px auto;width:300px"></div><script type="module" src="/sales-test.tsx"></script>' }));
  await page.goto(origin);
  const trigger = page.locator(".sales-trend-spark");
  const panel = page.locator(".sales-trend-popover");
  await trigger.hover();
  await panel.waitFor({ state: "visible" });
  const box = await trigger.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 6);
  await page.waitForTimeout(550);
  assert.equal(await panel.isVisible(), true, "panel must survive the thumbnail-to-panel gap");
  await panel.hover();
  await page.waitForTimeout(1100);
  assert.equal(await panel.isVisible(), true);
  await trigger.click();
  await page.mouse.move(20, 20);
  await page.waitForTimeout(1100);
  assert.equal(await panel.isVisible(), true, "click pins the chart");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.waitForFunction(() => !document.querySelector(".sales-trend-popover"));
  await trigger.click();
  await page.mouse.click(20, 20);
  await page.waitForFunction(() => !document.querySelector(".sales-trend-popover"));
  await trigger.hover();
  await page.mouse.move(20, 20);
  await page.waitForFunction(() => !document.querySelector(".sales-trend-popover"));
});
