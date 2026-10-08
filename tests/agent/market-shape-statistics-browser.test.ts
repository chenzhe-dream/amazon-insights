import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapeSorftimePageRun} from './helpers/market-shape-sorftime-page-fixture';
import {toShapeReferenceReport} from '../../app/lib/market-shape-reference-adapter';

test('shape statistics render complete and missing states without changing the seven regions',{timeout:60000},async t=>{
 const run=shapeSorftimePageRun().run;
 const report=toShapeReferenceReport({calculationVersion:'shape-all-links/3',scope:run.scope,pool:run.source!.sorftimePool!,productHistory:run.source!.productHistory!,productAmountHistory:run.source!.productAmountHistory!,categoryDashboard:run.categoryDashboard!});
 for(const p of report.products){p.grossProfitMargin=65;p.onlineDate='2024-01-01';p.sales={last3Months:300,last6Months:600,y2024:1200,y2025:1200,monthsAvailable:24};}
 const out='test-results/shape-statistics-browser';await mkdir(out,{recursive:true});
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1500,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());if(url.origin!==origin)return route.abort();if(!r.isNavigationRequest())return route.continue();return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:24px"><div id="root"></div><script type="module" src="/${out}/${url.searchParams.get('case')}.jsx"></script></body></html>`)});});
 for(const mode of ['full','partial','missing-margin']){
   const sample=structuredClone(report);if(mode==='partial')sample.products[1].sales.last6Months=null;if(mode==='missing-margin')sample.products[1].grossProfitMargin=null;
   await writeFile(`${out}/${mode}.jsx`,`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketShapeReferenceView} from '/app/market-shape-reference/view';import '/app/globals.css';import '/app/market-research.css';import '/app/market-shape-reference.css';const report=${JSON.stringify(sample)};createRoot(document.getElementById('root')).render(<MarketShapeReferenceView report={report} assignments={Object.fromEntries(report.products.map(p=>[p.asin,'落地灯']))} selectedAsins={report.products.map(p=>p.asin)} onAssignment={()=>{}} onSelected={()=>{}}/>);`);
   await page.goto(origin+'/?case='+mode);const tables=page.locator('.shape-price-table');await tables.first().waitFor();assert.equal(await tables.count(),4);
   const body=await page.locator('body').innerText();
   assert.match(body,mode==='partial'?/综合结论待补数据/:/规则结论已生成/);
   if(mode==='missing-margin')assert.match(body,/数据缺口提示/);
   if(mode==='partial'){const total=tables.first().locator('.shape-price-total-row');assert.match(await total.innerText(),/已知 600/);assert.equal(await total.locator('td').nth(5).innerText(),'未知');}
   await tables.first().scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${mode}.png`});
 }
 assert.deepEqual(errors,[]);
});
