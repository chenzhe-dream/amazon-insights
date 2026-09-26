import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

let browser: Browser, server: ViteDevServer, origin: string;
before(async () => {
  server = await createServer({ configFile: false, cacheDir: 'test-results/page-snapshot-vite', define: {'process.env':'{}'}, plugins:[react()], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

test('original matrix and downloaded snapshot retain the same business cells and computed styles', async t => {
  const page = await browser.newPage({viewport:{width:1440,height:1000}}); t.after(() => page.close());
  const api: string[] = [];
  await page.route('**/api/**', route => { api.push(route.request().url()); return route.abort(); });
  await page.goto(origin + '/tests/agent/helpers/page-snapshot-harness.html');
  const value = await page.evaluate(async () => {
    for(const file of ['globals.css','warm-theme.css','comparison-layout.css']) await import(/* @vite-ignore */ '/app/'+file);
    document.body.style.setProperty('--font-geist-sans','Arial');
    document.body.style.setProperty('--font-geist-mono','monospace');
    const {CompetitorOverviewMatrix} = await import(/* @vite-ignore */ '/app/project-report-views/'+'competitor-overview.tsx');
    const {renderPageSnapshot} = await import(/* @vite-ignore */ '/app/project-export/'+'page-snapshot-host.tsx');
    const {snapshotProducts} = await import(/* @vite-ignore */ '/app/project-export/'+'read-page-snapshot-sources.ts');
    const {React,createRoot} = await import(/* @vite-ignore */ '/tests/agent/helpers/'+'page-snapshot-react.ts');
    const props = {products:snapshotProducts({asins:['B012345678'],version:{catalog:[{asin:'B012345678',brand:'测试灯具',price:25.99,specifications:['暖光','金属'],synced:true}],stageOutputs:{}}}),
      market:'US',slugParam:null,salesTrendByAsin:{},ratingByAsin:{},fbaFeeByAsin:{},childSalesByAsin:{},priceStrategyByAsin:{},categoryTrendByNode:{},sellingTranslationsByAsin:{}};
    const mount=document.createElement('div');document.body.append(mount);const root=createRoot(mount);
    root.render(React.createElement(CompetitorOverviewMatrix,{...props,presentation:'page',translationProjectId:null,translationKey:'test'}));
    await new Promise(resolve=>setTimeout(resolve,80));
    const rows=[...mount.querySelectorAll('tbody tr')];
    const cells=rows.filter(row=>['当前售价','产品规格'].includes(row.querySelector('th')!.textContent!.split('Features')[0]));
    const original=cells.map(row=>[row.textContent,getComputedStyle(row.querySelector('td')!).fontSize,getComputedStyle(row.querySelector('td')!).borderBottomColor,getComputedStyle(row.querySelector('td')!).fontFamily]);
    const html=await renderPageSnapshot({project:{id:'test',name:'灯具',marketplace:'US',asins:['B012345678']},sourceProjectId:'test',capturedAt:'2026-09-26T08:00:00Z',sourceLabel:'已保存报告',moduleIds:['competitor-overview'],overview:props},new AbortController().signal);
    root.unmount();mount.remove();return {original,html};
  });
  assert.deepEqual(api,[]);
  await page.setContent(value.html);
  const downloaded=await page.locator('table.compare-matrix').first().locator('tbody tr').evaluateAll(rows=>rows.filter(row=>['当前售价','产品规格'].includes(row.querySelector('th')!.textContent!.split('Features')[0])).map(row=>[row.textContent,getComputedStyle(row.querySelector('td')!).fontSize,getComputedStyle(row.querySelector('td')!).borderBottomColor,getComputedStyle(row.querySelector('td')!).fontFamily]));
  assert.equal(downloaded.length,2);assert.deepEqual(downloaded,value.original);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.matrix-wrap').first().evaluate(e=>getComputedStyle(e).overflowX),'auto');
  assert.deepEqual(api,[]);
});

test('DOM snapshot keeps native details, original styles, live form values and charts, without application code', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(origin + '/tests/agent/helpers/page-snapshot-harness.html');
  const html = await page.evaluate(async () => {
    const { serializePageSnapshot } = await import(/* @vite-ignore */ '/app/project-export/' + 'serialize-page-snapshot.ts');
    const root = document.createElement('div');
    root.innerHTML = '<section data-snapshot-module="overview"><h2>竞品参数总览</h2><table class="compare-matrix"><tbody><tr><th>售价</th><td>$25.99</td></tr></tbody></table><details><summary>完整依据</summary><p>隐藏但必须保留的业务原文</p></details><input value="old"><input type="checkbox"><textarea>old</textarea><select><option>A</option><option>B</option></select><svg viewBox="0 0 100 20"><path d="M0 0L100 20"/></svg><canvas width="20" height="10"></canvas><button data-write-action="save">保存</button><script>fetch("/api/secret")</script><a href="javascript:alert(1)" onclick="alert(1)">错误链接</a><img src="/api/amazon-image?u=https%3A%2F%2Fm.media-amazon.com%2Fimages%2FI%2Ftest.jpg"><div data-internal-secret="private">&lt;script&gt;原文&lt;/script&gt;</div></section>';
    document.body.append(root);
    root.querySelector('input')!.value = '已保存输入';
    root.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = true;
    root.querySelector('textarea')!.value = '当前值';
    root.querySelector('select')!.selectedIndex = 1;
    return serializePageSnapshot({ root, cssText: '.compare-matrix{color:rgb(25,50,75);border:1px solid blue}', title: '示例项目', capturedAt: '2026-09-26T08:00:00Z' });
  });
  assert.doesNotMatch(html, /<script|onclick|javascript:|data-internal-secret|data-write-action/);
  assert.match(html, /隐藏但必须保留/); assert.match(html, /已保存输入/); assert.match(html, /当前值/);
  assert.match(html, /https:\/\/m.media-amazon.com/);
  const recipient = await browser.newPage(); t.after(() => recipient.close());
  await recipient.route('https://**', r => r.abort());
  await recipient.setContent(html);
  assert.equal(await recipient.locator('details').getAttribute('open'), null);
  await recipient.locator('summary').click();
  assert.equal(await recipient.getByText('隐藏但必须保留的业务原文').isVisible(), true);
  assert.equal(await recipient.locator('input[type=checkbox]').isChecked(), true);
  assert.equal(await recipient.locator('select').inputValue(), 'B');
  assert.equal(await recipient.locator('svg').count(), 1);
  assert.equal(await recipient.locator('canvas').count(), 0);
  assert.equal(await recipient.locator('img[src^="data:image/png"]').count(), 1);
  assert.equal(await recipient.locator('.compare-matrix').evaluate(e => getComputedStyle(e).color), 'rgb(25, 50, 75)');
});

test('style capture preserves CSS rules and variables and fails rather than ignoring unavailable required styles', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(origin + '/tests/agent/helpers/page-snapshot-harness.html');
  const result = await page.evaluate(async () => {
    const { collectPageSnapshotStyles } = await import(/* @vite-ignore */ '/app/project-export/' + 'page-snapshot-styles.ts');
    const source = document.implementation.createHTMLDocument('styles');
    const style = source.createElement('style'); style.textContent = ':root{--snapshot-color:blue}.compare-matrix{color:var(--snapshot-color)}';
    source.head.append(style);
    const css = await collectPageSnapshotStyles(source, new AbortController().signal);
    const link = source.createElement('link'); link.rel = 'stylesheet'; link.href = 'https://unavailable.invalid/required.css'; source.head.append(link);
    let error = ''; try { await collectPageSnapshotStyles(source, new AbortController().signal); } catch(e) { error = String(e); }
    return {css,error};
  });
  assert.match(result.css, /--snapshot-color/); assert.match(result.error, /样式/);
});
