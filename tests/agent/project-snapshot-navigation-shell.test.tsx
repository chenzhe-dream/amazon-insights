import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let browser: Browser, server: ViteDevServer, origin: string;
before(async () => {
  server = await createServer({ configFile: false, cacheDir: 'test-results/page-snapshot-vite', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function sample(pageIds: string[] = ['overview', 'images']) {
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1360, height: 900 } });
  const builder = await browser.newPage();
  await builder.goto(origin + '/tests/agent/helpers/page-snapshot-harness.html');
  const html = await builder.evaluate(async ids => {
    const { serializePageSnapshot } = await import(/* @vite-ignore */ '/app/project-export/' + 'serialize-page-snapshot.ts');
    const root = document.createElement('main');
    root.innerHTML = `<header class="project-header"><h1>测试项目 &amp; 标题</h1><p>US · 2 ASIN · 2026-09-26</p></header>
      <section data-snapshot-page="overview"><section data-snapshot-module="competitor-overview"><h2>参数内容</h2><table><tbody><tr><td>唯一参数甲</td></tr></tbody></table><svg width="80" height="40" viewBox="0 0 20 20" fill="none" stroke="teal"><circle cx="10" cy="10" r="5"/></svg><input name="business-choice" type="checkbox" checked onclick="alert(1)"></section></section>
      <section data-snapshot-page="images"><section data-snapshot-module="listing-images"><h2>图册内容</h2><table><tbody><tr><td>唯一图册乙</td></tr></tbody></table><svg width="80" height="40" viewBox="0 0 20 20" fill="none" stroke="teal"><rect width="10" height="10"/></svg></section></section>`;
    document.body.append(root);
    return serializePageSnapshot({ root, cssText: 'body{margin:0;font:14px sans-serif}.project-header{padding:16px}.compare-matrix{overflow-x:auto}', title: '测试项目', capturedAt: '2026-09-26T08:00:00Z', pageIds: ids });
  }, pageIds);
  await builder.close();
  return { page, html };
}

test('first selected page is visible and a native label switches the only visible page with parent and child highlights', async t => {
  const {page, html} = await sample(); t.after(() => page.close());
  await page.setContent(html);
  assert.equal(await page.locator('[data-snapshot-page="overview"]').isVisible(), true);
  assert.equal(await page.locator('[data-snapshot-page="images"]').isVisible(), false);
  assert.equal(await page.locator('[data-snapshot-page="overview"] table').count(), 1);
  assert.equal(await page.locator('[data-snapshot-page="images"] svg').count(), 1);
  assert.equal(await page.locator('label[for="snapshot-page-overview"] .snapshot-nav-icon').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(26, 159, 99)');
  assert.equal(await page.locator('label[for="snapshot-page-images"] .snapshot-nav-icon').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(232, 145, 45)');
  assert.equal(await page.locator('input[type="checkbox"]').isDisabled(), true);
  assert.equal(await page.locator('input[type="checkbox"]').getAttribute('name'), null);
  assert.doesNotMatch(html, /onclick|<script|fetch\(/);
  await page.locator('label[for="snapshot-page-images"]').click();
  assert.equal(await page.locator('[data-snapshot-page="images"]').isVisible(), true);
  assert.equal(await page.locator('[data-snapshot-page="overview"]').isVisible(), false);
  assert.equal(await page.locator('label[for="snapshot-page-images"]').getAttribute('aria-current'), null);
  assert.match(await page.locator('label[for="snapshot-page-images"]').evaluate(e => getComputedStyle(e).boxShadow), /rgb|rgba/);
  assert.match(await page.locator('.snapshot-nav-group summary').first().evaluate(e => getComputedStyle(e).boxShadow), /rgb|rgba/);
});

test('radio keyboard navigation, narrow menu, file URL and sandbox iframe work without scripts', async t => {
  const {page, html} = await sample(); t.after(() => page.close());
  const path = resolve('test-results/snapshot-navigation-sample.html');
  await mkdir(resolve('test-results'), {recursive:true}); await writeFile(path, html, 'utf8');
  await page.goto(pathToFileURL(path).href);
  await page.locator('#snapshot-page-overview').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#snapshot-page-images').isChecked(), true);
  assert.equal(await page.locator('[data-snapshot-page="images"]').isVisible(), true);
  await page.screenshot({path: resolve('test-results/snapshot-navigation-desktop.png'), fullPage:true});
  await page.setViewportSize({width:390,height:800});
  assert.equal(await page.locator('.snapshot-mobile-menu').isVisible(), true);
  await page.locator('.snapshot-mobile-menu > summary').click();
  assert.equal(await page.locator('label[for="snapshot-page-images"]').isVisible(), false);
  await page.locator('.snapshot-mobile-menu > summary').click();
  assert.equal(await page.locator('label[for="snapshot-page-images"]').isVisible(), true);
  await page.screenshot({path: resolve('test-results/snapshot-navigation-mobile.png'), fullPage:true});
  const framePage = await browser.newPage({javaScriptEnabled:false}); t.after(() => framePage.close());
  await framePage.setContent(`<iframe sandbox="" srcdoc="${html.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></iframe>`);
  const frame = framePage.frameLocator('iframe');
  await frame.locator('label[for="snapshot-page-images"]').click();
  assert.equal(await frame.locator('[data-snapshot-page="images"]').isVisible(), true);
});

test('serializer rejects missing, duplicated and mismatched trusted direct page boundaries', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(origin + '/tests/agent/helpers/page-snapshot-harness.html');
  const messages = await page.evaluate(async () => {
    const { serializePageSnapshot } = await import(/* @vite-ignore */ '/app/project-export/' + 'serialize-page-snapshot.ts');
    const root = document.createElement('main'); document.body.append(root);
    const messages:string[]=[];
    root.innerHTML='<div data-snapshot-page="overview"></div>';
    try { serializePageSnapshot({root,cssText:'',title:'t',capturedAt:'t',pageIds:['images']}); messages.push(''); } catch(e) { messages.push(String(e)); }
    root.innerHTML='<div data-snapshot-page="overview"></div><div data-snapshot-page="overview"></div>';
    try { serializePageSnapshot({root,cssText:'',title:'t',capturedAt:'t',pageIds:['overview']}); messages.push(''); } catch(e) { messages.push(String(e)); }
    root.innerHTML='<div data-snapshot-module="overview"><div data-snapshot-page="overview"></div></div>';
    try { serializePageSnapshot({root,cssText:'',title:'t',capturedAt:'t',pageIds:['overview']}); messages.push(''); } catch(e) { messages.push(String(e)); }
    root.innerHTML='<section data-snapshot-page="overview" data-snapshot-omit onclick="alert(1)"><script>alert(1)</script></section>';
    try { const html=serializePageSnapshot({root,cssText:'',title:'t',capturedAt:'t',pageIds:['overview']}); messages.push(html.includes('onclick') || html.includes('<script') ? '' : 'accepted'); } catch(e) { messages.push(String(e)); }
    return messages;
  });
  assert.equal(messages.every(message => /页面|boundary/i.test(message)), true);
});

test('print stylesheet expands every selected page and hides navigation', async t => {
  const {page, html} = await sample(); t.after(() => page.close());
  await page.setContent(html); await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('[data-snapshot-page="overview"]').isVisible(), true);
  assert.equal(await page.locator('[data-snapshot-page="images"]').isVisible(), true);
  assert.equal(await page.locator('.snapshot-nav').isVisible(), false);
});

test('a closed long second-level menu still shows parent keyboard focus and opens to its selected child', async t => {
  const builder = await browser.newPage(); t.after(() => builder.close());
  await builder.goto(origin + '/tests/agent/helpers/page-snapshot-harness.html');
  const html = await builder.evaluate(async () => {
    const {renderSnapshotNavigation} = await import(/* @vite-ignore */ '/app/project-export/'+'snapshot-navigation-shell.ts');
    return renderSnapshotNavigation([
      {id:'overview',html:'<h2>参数</h2>'},
      {id:'voc-summary',html:'<h2>汇总</h2>'},
      {id:'voc-insight',html:'<h2>洞察</h2>'},
      {id:'voc-positioning',html:'<h2>定义结论</h2>'},
    ]);
  });
  const page = await browser.newPage({javaScriptEnabled:false,viewport:{width:390,height:800}}); t.after(() => page.close());
  await page.setContent(html);
  assert.equal(await page.locator('[data-snapshot-group="voc-group"]').getAttribute('open'),null);
  await page.locator('#snapshot-page-overview').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#snapshot-page-voc-summary').isChecked(),true);
  assert.equal(await page.locator('[data-snapshot-page="voc-summary"]').isVisible(),true);
  assert.equal(await page.locator('[data-snapshot-group="voc-group"] > summary').evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
  await page.locator('[data-snapshot-group="voc-group"] > summary').click();
  assert.equal(await page.locator('label[for="snapshot-page-voc-positioning"]').isVisible(),true);
  assert.equal(await page.locator('label[for="snapshot-page-voc-insight"] .snapshot-nav-icon').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(122, 103, 216)');
  await page.locator('label[for="snapshot-page-voc-positioning"]').click();
  assert.equal(await page.locator('[data-snapshot-page="voc-positioning"]').isVisible(),true);
  assert.equal(await page.locator('[data-snapshot-page="voc-summary"]').isVisible(),false);
});
