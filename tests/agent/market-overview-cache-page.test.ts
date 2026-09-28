import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {overviewRun,overviewRunId,overviewDistributionDetails} from './helpers/market-overview-page-fixture';

test('seven-day lookup also expires an already loaded report while explicit history remains readable',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-cache-ttl-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');const page=await browser.newPage({viewport:{width:1400,height:900}});page.setDefaultTimeout(5000);
 let current=overviewRun(false),lookups=0,writes=0;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.setFixedTime(new Date('2026-09-30T00:00:00Z'));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-cache-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){writes++;return route.abort();}
  if(url.pathname.endsWith('/overview/saved')){lookups++;return route.fulfill({json:{runId:null,fromMonth:null}});}
  if(url.pathname.includes('/reports/'))return route.fulfill({json:overviewDistributionDetails()});
  return route.fulfill({json:current});
 });
 const url=origin+'/?overviewRun='+overviewRunId;
 await page.goto(url);await page.getByLabel('已保存报告与重新采集').waitFor();
 assert.equal(writes,0);assert.equal(lookups,0,'explicit old history does not run automatic lookup');
 await page.getByRole('button',{name:'读取匹配报告'}).click();
 await page.getByText('暂无7天内可复用的报告',{exact:true}).waitFor();assert.equal(lookups,1);assert.equal(writes,0);
 current=overviewRun(false);current.run.createdAt='2026-09-29T00:00:00Z';
 await page.goto(url);await page.getByLabel('已保存报告与重新采集').waitFor();await page.getByRole('button',{name:'读取匹配报告'}).click();await page.getByRole('button',{name:'展开已保存报告',exact:true}).waitFor();assert.equal(lookups,1,'fresh loaded report may toggle without lookup');
 current=overviewRun(true);
 await page.goto(url);await page.getByLabel('已保存报告与重新采集').waitFor();await page.getByRole('button',{name:'读取匹配报告'}).click();await page.getByRole('button',{name:'展开已保存报告',exact:true}).waitFor();assert.equal(lookups,1,'old active work is still resumed');
 assert.equal(writes,0);assert.deepEqual(errors,[]);
});
