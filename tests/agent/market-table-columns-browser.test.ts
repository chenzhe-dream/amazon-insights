import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium, type Locator} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun, shapeRevision, shapeRunId} from './helpers/market-shape-page-fixture';
import {keywordReconciledPageRun, keywordRunId} from './helpers/market-keyword-page-fixture';

async function columnIds(table:Locator, selector:string){return table.locator(selector).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-column-id')));}

for(const mode of ['shape','keyword'] as const){
 test(`${mode} table reorders actual headers, cells and widths with mouse and keyboard; reset preserves rows and drafts`,{timeout:60000},async t=>{
  const server=await createServer({configFile:false,cacheDir:`test-results/market-columns-${mode}-vite`,define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
  const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(10000);
  const shape=shapePageRun();shape.run.latestRevision=shapeRevision();
  const sample=mode==='shape'?shape:keywordReconciledPageRun();let writes=0;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-${mode}-browser-harness.tsx"></script></body></html>`)});if(!url.pathname.startsWith('/api/'))return route.continue();if(req.method()!=='GET')writes++;return route.fulfill(url.pathname.endsWith(mode==='shape'?'/shape-price':'/keywords')?{json:sample}:{status:404,json:{}});});
  await page.goto(`${origin}/?${mode==='shape'?`shapeRun=${shapeRunId}`:`keywordRun=${keywordRunId}`}`);
  const region=page.getByRole('region',{name:mode==='shape'?'形态人工确认表':'关键词参考月指标'}),table=region.locator('table');await table.waitFor();
  if(mode==='shape')await table.getByLabel('B000000001 人工形态').fill('层架式');
  const before=await columnIds(table,'thead th'),widths=await table.locator('col').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.getAttribute('data-column-id'),(n as HTMLElement).style.width])));
  const beforeRows=await table.locator('tbody tr').allTextContents();
  const cellValues=await table.locator('tbody tr:first-child > *').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.getAttribute('data-column-id'),node.textContent])));
  const source=mode==='shape'?'品牌':'关键词分类',target=mode==='shape'?'商品形态':'热度趋势',fixed=mode==='shape'?2:1;
  assert.equal(await table.getByRole('button',{name:`移动${source}列`,exact:true}).count(),1,'movable columns expose a drag handle');
  await table.getByRole('button',{name:`移动${source}列`,exact:true}).dragTo(table.getByRole('button',{name:`移动${target}列`,exact:true}));
  const after=await columnIds(table,'thead th');assert.notDeepEqual(after,before);assert.deepEqual(after.slice(0,fixed),before.slice(0,fixed));
  assert.deepEqual(await columnIds(table,'tbody tr:first-child > *'),after);assert.deepEqual(await columnIds(table,'col'),after);
  assert.deepEqual(await table.locator('tbody tr:first-child > *').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.getAttribute('data-column-id'),node.textContent]))),cellValues);
  assert.deepEqual(await table.locator('col').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.getAttribute('data-column-id'),(n as HTMLElement).style.width]))),widths);
  if(mode==='shape')assert.deepEqual(await columnIds(table,'tfoot tr > td'),after);
  const handle=table.getByRole('button',{name:`移动${source}列`,exact:true});await handle.focus();await handle.press('ArrowLeft');
  assert.deepEqual(await columnIds(table,'thead th'),before);await handle.press('ArrowLeft');assert.deepEqual(await columnIds(table,'thead th'),before,'identity columns cannot be displaced');
  await handle.press('ArrowRight');assert.notDeepEqual(await columnIds(table,'thead th'),before);
  if(mode==='keyword')await page.getByText('调整表格列顺序',{exact:true}).click();
  else await page.locator('details.market-shape-table-options > summary').click();
  await page.getByRole('button',{name:mode==='shape'?'重置商品列顺序':'重置关键词列顺序',exact:true}).click();
  assert.deepEqual(await columnIds(table,'thead th'),before);assert.deepEqual(await table.locator('tbody tr').allTextContents(),beforeRows);
  if(mode==='shape')assert.equal(await table.getByLabel('B000000001 人工形态').inputValue(),'层架式');
  await page.setViewportSize({width:390,height:844});
  const geometry=await region.evaluate(el=>{el.scrollLeft=250;return {scroll:el.scrollLeft,document:document.documentElement.scrollWidth,viewport:innerWidth};});
  assert.ok(geometry.scroll>0);assert.ok(geometry.document<=geometry.viewport+1,JSON.stringify(geometry));
  const sticky=await table.locator('tbody tr:first-child > *').nth(mode==='shape'?1:0).evaluate(el=>({left:el.getBoundingClientRect().left,position:getComputedStyle(el).position}));
  if(mode==='shape')assert.equal(sticky.position,'static','the supplied shape layout releases the product column on a phone so all columns remain reachable');
  else {assert.equal(sticky.position,'sticky');assert.ok(sticky.left>=0&&sticky.left<100);}
  const headerLayers=await table.locator('thead th').evaluateAll(nodes=>nodes.map(node=>Number(getComputedStyle(node).zIndex)||0));assert.ok(headerLayers[0]>Math.max(...headerLayers.slice(fixed)),'fixed headers remain above horizontally scrolling headers');
  assert.equal(writes,0);assert.deepEqual(errors,[]);
 });
}
