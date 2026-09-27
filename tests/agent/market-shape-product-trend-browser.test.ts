import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

test('product trend detail uses sparse report months and stays inspectable on desktop and phone', {timeout: 60000}, async t => {
  const out = 'test-results/shape-product-trend';
  await mkdir(out, {recursive: true});
  const product = {
    asin: 'TRENDTEST',
    monthlyTrend: {
      volume: [{month: '2026-04', value: 10}, {month: '2026-05', value: null}, {month: '2026-06', value: 0}, {month: '2026-07', value: 25}, {month: '2026-10', value: 30}],
      amount: [{month: '2026-04', value: 200}, {month: '2026-05', value: 100}, {month: '2026-06', value: 300}, {month: '2026-08', value: 500}, {month: '2026-10', value: 600}],
    },
  };
  await writeFile(`${out}/entry.jsx`, `import React from 'react';import{createRoot}from'react-dom/client';import{ProductTrend}from'/app/market-shape-reference/product-trend';import'/app/market-shape-reference.css';const p=${JSON.stringify(product)},months=Array.from({length:32},(_,i)=>({month:new Date(Date.UTC(2024,0+i,1)).toISOString().slice(0,7),value:i+1}));createRoot(document.getElementById('root')).render(<div style={{margin:'120px auto',width:220}}><ProductTrend product={p} currency="$"/><ProductTrend product={{...p,asin:'SINGLE',monthlyTrend:{volume:[{month:'2026-08',value:4}],amount:[{month:'2026-08',value:80}]}}}/><ProductTrend product={{...p,asin:'EMPTY',monthlyTrend:{volume:[],amount:[]}}}/><ProductTrend product={{...p,asin:'LONG',monthlyTrend:{volume:months,amount:months.map(m=>({...m,value:m.value*20}))}}}/></div>);`);
  const server = await createServer({configFile: false, cacheDir: `${out}/vite`, define: {'process.env': '{}'}, plugins: [react()], server: {host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false}});
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const origin = server.resolvedUrls!.local[0];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {if (!route.request().url().startsWith(origin)) return route.abort(); if (route.request().isNavigationRequest()) return route.fulfill({contentType: 'text/html', body: await server.transformIndexHtml('/', `<html><body><div id="root"></div><script type="module" src="/${out}/entry.jsx"></script></body></html>`)}); return route.continue();});
  await page.goto(origin);
  const trigger = page.getByRole('button', {name: /TRENDTEST 月度销量与销售额趋势/});
  assert.match(await page.locator('.shape-ref-trend-single').innerText(), /客单价\s*\$20\.00[\s\S]*仅1个月数据，暂无法判断趋势/);
  assert.equal(await page.locator('[title="暂无月度数据"]').innerText(), '未知');
  await page.keyboard.press('Tab');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  const panel = page.getByRole('dialog', {name: '月度趋势'});
  await panel.waitFor();
  assert.equal(await panel.getByRole('button', {name: '关闭月度趋势'}).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await panel.getByRole('button', {name: '2026-04 月度数据'}).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.match(await panel.locator('.shape-ref-trend-tooltip').innerText(), /2026-04/);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  await trigger.hover();
  await panel.waitFor();
  assert.equal(await panel.locator('svg g[data-trend-month]').count(), 6);
  assert.equal(await panel.locator('[data-trend-month="2026-05"][data-trend-series="volume"]').count(), 0);
  assert.equal(await panel.locator('[data-trend-month="2026-07"][data-trend-series="amount"]').count(), 0);
  assert.equal(await panel.locator('polyline[stroke="#7a67d8"]').count(), 3, 'revenue line must stop at missing months');
  assert.equal(await panel.locator('.shape-ref-trend-aov-axis').count(), 3);
  await panel.locator('[data-trend-month="2026-04"]').last().hover();
  assert.match(await panel.locator('.shape-ref-trend-tooltip').innerText(), /2026-04[\s\S]*10[\s\S]*200[\s\S]*20/);
  await panel.locator('[data-trend-month="2026-06"]').last().hover();
  assert.match(await panel.locator('.shape-ref-trend-tooltip').innerText(), /客单价\s*未知/);
  await panel.getByRole('button', {name: '2026-05 月度数据'}).focus();
  await page.keyboard.press('Enter');
  assert.match(await panel.locator('.shape-ref-trend-tooltip').innerText(), /2026-05[\s\S]*月销量\s*未知/);
  await trigger.click(); await page.mouse.move(10, 10);
  assert.equal(await panel.isVisible(), true);
  await page.screenshot({path: `${out}/trend-desktop.png`});
  await trigger.click(); assert.equal(await panel.count(), 0, 'a second trigger click closes a pinned detail');
  await trigger.click();
  await page.keyboard.press('Escape'); assert.equal(await panel.count(), 0);
  await page.setViewportSize({width: 390, height: 844}); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  const bounds = await panel.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  await page.screenshot({path: `${out}/trend-mobile.png`});
  await page.keyboard.press('Escape');
  const longTrigger = page.getByRole('button', {name: /LONG 月度销量与销售额趋势/});
  await longTrigger.scrollIntoViewIfNeeded(); await longTrigger.click();
  assert.equal(await panel.locator('svg g[data-trend-month]').count(), 32);
  assert.ok(await panel.locator('.shape-ref-trend-month-axis span').count() <= 9);
  await page.screenshot({path: `${out}/trend-long-mobile.png`});
  assert.deepEqual(errors, []);
});
