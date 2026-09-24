import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeRevision,shapeRunId} from './helpers/market-shape-page-fixture';

test('supplied shape table filters and sorts real rows while preserving drafts and mobile containment',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-ui-parity-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1400,height:1100}}),current=shapePageRun();
 current.run.latestRevision=shapeRevision();
 current.run.ruleStatus='complete';current.run.semanticStatus='skipped';
 current.run.source!.products.push({asin:'B000000002',title:'Arc floor light',brand:null,price:null,units:null});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));let writes=0;
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});if(!url.pathname.startsWith('/api/'))return route.continue();if(req.method()==='POST')writes++;return route.fulfill(url.pathname.endsWith('/shape-price')?{json:current}:{status:404,json:{}})});
 await page.goto(`${origin}/?shapeRun=${shapeRunId}`);
 const table=page.getByRole('region',{name:'形态人工确认表'});await table.waitFor();
 assert.match(await table.innerText(),/人工确认与来源/);
 assert.equal(await page.getByText('等待本版本的保存解释').count(),0);
 const classification=page.locator('details').filter({has:page.locator('summary',{hasText:'采集选项'})});
 assert.equal(await classification.count(),1,'saved results keep collection options in a compact disclosure');
 assert.equal(await classification.getAttribute('open'),null);
 await classification.locator('summary').click();
 assert.equal(await page.getByLabel('本次形态目录（每行：名称|判断依据）').count(),0);
 await classification.locator('summary').click();
 const positions=await page.evaluate(()=>({
  dashboard:document.querySelector('.category-node-trend-card')!.getBoundingClientRect().top,
  table:document.querySelector('.top-sales-section')!.getBoundingClientRect().top,
  summary:document.querySelector('.market-shape-report-summary')!.getBoundingClientRect().height,
 }));
 assert.ok(positions.dashboard<positions.table);
 assert.ok(positions.summary<120,'saved report summary should not displace the result tables');
 await page.getByLabel('搜索产品标题',{exact:true}).fill('arc');
 assert.equal(await table.getByLabel('B000000001 人工形态').count(),0);
 assert.match(await table.innerText(),/B000000002[\s\S]*未知/);
 await page.getByLabel('搜索产品标题',{exact:true}).fill('');
 await page.getByLabel('筛选品牌',{exact:true}).selectOption('Fixture');
 assert.equal(await table.getByLabel('B000000002 人工形态').count(),0);
 await page.getByLabel('筛选品牌',{exact:true}).selectOption('');
 await table.getByRole('button',{name:/^销量原值/}).click();
 assert.match(await table.locator('tbody tr').first().innerText(),/B000000001/);
 const advanced=page.locator('details.market-shape-table-options');
 assert.equal(await advanced.getAttribute('open'),null,'bulk editing and column controls stay compact above the table');
 assert.equal(await page.getByLabel('批量形态',{exact:true}).isVisible(),false);
 await advanced.locator('summary').click();
 await page.getByLabel('批量形态',{exact:true}).fill(' 层架式 ');
 await page.getByRole('button',{name:'应用到所选',exact:true}).click();
 assert.equal(await table.getByLabel('B000000001 人工形态').inputValue(),' 层架式 ');
 await page.getByLabel('筛选商品形态',{exact:true}).selectOption('层架式');
 assert.match(await table.locator('tbody').innerText(),/B000000001/,'shape filter uses the same normalized name as the saved revision');
 const output='test-results/market-shape-rule-ui';await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});
 const overflow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,items:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>innerWidth&&getComputedStyle(e).overflowX==='visible'}).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width}))}));
 assert.ok(overflow.width<=overflow.viewport+1,JSON.stringify(overflow));
 await page.screenshot({path:`${output}/mobile.png`,fullPage:true});
 assert.equal(writes,0);assert.deepEqual(errors,[]);
});
