import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

test('each market module keeps its own category through navigation and refresh', { timeout: 90_000 }, async t => {
  const server = await createServer({ configFile: false, define: { 'process.env': '{}' }, plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MarketResearchSection} from "/app/market-research-section.tsx";createRoot(document.getElementById("root")).render(React.createElement(MarketResearchSection,{sessionIdentity:"independent-input-test"}));</script></body></html>') });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() === 'POST') {
      writes.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 503, json: { error: { message: 'test source unavailable' } } });
    }
    if (url.pathname.endsWith('/market-research/jobs')) return route.fulfill({ json: { jobs: [] } });
    return route.fulfill({ status: 404, json: { error: { message: 'no saved fixture' } } });
  });

  await page.goto(origin);
  const nav = page.getByRole('navigation', { name: '市场调研模块' });
  await nav.waitFor();
  const overviewMonth = await page.getByLabel('月份').inputValue();
  const [year, month] = overviewMonth.split('-').map(Number);
  const shapeMonth = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
  await page.getByRole('region', { name: '市场总览查询条件' }).getByLabel('类目节点或路径').fill('111111');

  await nav.getByRole('button', { name: '商品形态及价格带' }).click();
  const shape = page.getByLabel('类目节点', { exact: true });
  assert.equal(await shape.inputValue(), '', 'shape must not inherit the overview draft');
  await page.getByRole('button', { name: '日本站' }).click();
  await page.getByLabel('结束月').fill(shapeMonth);
  await shape.fill('222222');

  await nav.getByRole('button', { name: '类目关键词洞察' }).click();
  await page.getByText('类目范围与采集设置', { exact: true }).click();
  const keyword = page.getByLabel('类目节点或路径', { exact: true });
  assert.equal(await keyword.inputValue(), '', 'keywords must not inherit the shape draft');
  assert.equal(await page.getByRole('button', { name: '美国站' }).getAttribute('aria-pressed'), 'true');
  await keyword.fill('333333');

  await nav.getByRole('button', { name: '类目买家评论见解' }).click();
  const theme = page.getByLabel('类目路径');
  assert.equal(await theme.inputValue(), '', 'themes must not inherit the keyword draft');
  await theme.fill('444444');
  assert.equal(writes.length, 0, 'switching drafts must not start collection');

  await page.reload();
  await page.getByLabel('类目路径').waitFor();
  assert.equal(await page.getByLabel('类目路径').inputValue(), '444444');
  await nav.getByRole('button', { name: '商品形态及价格带' }).click();
  assert.equal(await page.getByLabel('类目节点', { exact: true }).inputValue(), '222222');
  assert.equal(await page.getByRole('button', { name: '日本站' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('结束月').inputValue(), shapeMonth);
  await nav.getByRole('button', { name: '类目关键词洞察' }).click();
  await page.getByText('类目范围与采集设置', { exact: true }).click();
  assert.equal(await page.getByLabel('类目节点或路径', { exact: true }).inputValue(), '333333');
  await nav.getByRole('button', { name: '市场总览' }).click();
  assert.equal(await page.getByRole('region', { name: '市场总览查询条件' }).getByLabel('类目节点或路径').inputValue(), '111111');
  assert.equal(await page.getByLabel('月份').inputValue(), overviewMonth);
  assert.equal(await page.getByRole('button', { name: '美国站' }).getAttribute('aria-pressed'), 'true');
  assert.equal(writes.length, 0);

  await page.getByRole('button', { name: '筛选市场' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.at(-1)?.body.nodeQuery, '111111');
  await nav.getByRole('button', { name: '商品形态及价格带' }).click();
  await page.getByText('形态目录与采集选项', { exact: true }).click();
  await page.getByLabel('本次形态目录（每行：名称|判断依据）').fill('层架式|带有置物层架');
  await page.getByRole('button', { name: '采集商品并生成形态建议' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.at(-1)?.body.nodeIdPath, '222222');
  await nav.getByRole('button', { name: '类目关键词洞察' }).click();
  await page.getByLabel('产品核心名').fill('floor lamp');
  await page.getByLabel('类目说明').fill('落地灯');
  await page.getByRole('button', { name: '采集关键词并分析' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.at(-1)?.body.nodeIdPath, '333333');
  await nav.getByRole('button', { name: '类目买家评论见解' }).click();
  await page.getByRole('button', { name: '拉取见解' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.at(-1)?.body.nodeIdPath, '444444');
  assert.equal(writes.length, 4, 'each module starts only its own study');

  await page.goto(`${origin}/?themeView=shapes&marketNode=777777&marketMonth=2026-08&marketFrom=2026-08`);
  await page.getByLabel('类目节点', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('类目节点', { exact: true }).inputValue(), '777777', 'old shape deep link remains readable');
  await nav.getByRole('button', { name: '市场总览' }).click();
  assert.equal(await page.getByRole('region', { name: '市场总览查询条件' }).getByLabel('类目节点或路径').inputValue(), '', 'legacy shape link must not become overview input');
});

test('controlled sidebar navigation also keeps overview and shape inputs separate', { timeout: 60_000 }, async t => {
  const server = await createServer({ configFile: false, define: { 'process.env': '{}' }, plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MarketResearchSection} from "/app/market-research-section.tsx";import {marketNavigation,marketViewFromParam,marketViewHref} from "/app/lib/market-navigation.ts";function App(){const [view,setView]=React.useState(marketViewFromParam(new URLSearchParams(location.search).get("themeView")));const change=next=>{history.pushState(history.state,"",marketViewHref(next,new URLSearchParams(location.search)));setView(next)};return React.createElement(React.Fragment,null,React.createElement("nav",{"aria-label":"市场侧栏"},marketNavigation.map(item=>React.createElement("button",{key:item.view,onClick:()=>change(item.view)},item.label))),React.createElement(MarketResearchSection,{sessionIdentity:"controlled-input-test",view,onViewChange:change}))}createRoot(document.getElementById("root")).render(React.createElement(App));</script></body></html>') });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.endsWith('/market-research/jobs')) return route.fulfill({ json: { jobs: [] } });
    return route.fulfill({ status: 404, json: { error: { message: 'no saved fixture' } } });
  });
  await page.goto(origin);
  const sidebar = page.getByRole('navigation', { name: '市场侧栏' });
  await page.getByRole('region', { name: '市场总览查询条件' }).getByLabel('类目节点或路径').fill('123123');
  await sidebar.getByRole('button', { name: '商品形态及价格带' }).click();
  assert.equal(await page.getByLabel('类目节点', { exact: true }).inputValue(), '');
  await page.getByLabel('类目节点', { exact: true }).fill('456456');
  await sidebar.getByRole('button', { name: '市场总览' }).click();
  assert.equal(await page.getByRole('region', { name: '市场总览查询条件' }).getByLabel('类目节点或路径').inputValue(), '123123');
  await sidebar.getByRole('button', { name: '商品形态及价格带' }).click();
  assert.equal(await page.getByLabel('类目节点', { exact: true }).inputValue(), '456456');
});
