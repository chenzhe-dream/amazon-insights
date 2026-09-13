import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeRevision,shapeRunId,shapeRevisionId,shapeStructureRevision,shapeRequestBoundRevision} from './helpers/market-shape-page-fixture';
import {explanationPageRun,explanationLink,explanationId,explanationStepId,explanationAttemptId} from './helpers/market-shape-explanation-page-fixture';

test('manual save exposes analysis, retry and history without triggering work on reads',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-explanation-page-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);
 await page.clock.install();
 const current=shapePageRun(),writes:{path:string;body:any}[]=[],errors:string[]=[];let state=explanationPageRun(),readFailure=false;
 const olderId='72000000-0000-4000-8000-000000000004';let links=[explanationLink()];
 let offlineSave=false;
 let gate:{entered:()=>void;wait:Promise<void>;finished:()=>void}|null=null;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){
   writes.push({path:url.pathname,body:req.postDataJSON()});
   if(url.pathname.endsWith('/shape-price/revisions')){const revision=offlineSave?shapeRequestBoundRevision():shapeRevision();current.run.latestRevision=revision;current.run.history=[{revisionId:revision.revisionId,ordinal:revision.ordinal,createdAt:revision.createdAt}];return route.fulfill({status:201,json:{revision,explanation:offlineSave?null:{moduleRunId:explanationId,status:'running'},...(offlineSave?{explanationUnavailableReason:'模型配置暂不可用，人工修订已保存'}:{})}});}
   if(url.pathname.endsWith('/retry')){assert.deepEqual(req.postDataJSON(),{steps:[{stepId:explanationStepId,failedAttemptId:explanationAttemptId}]});state=explanationPageRun('succeeded');return route.fulfill({json:{moduleRunId:explanationId,stepIds:[explanationStepId]}});}
   if(url.pathname.endsWith('/cancel')){state=explanationPageRun('cancelled');return route.fulfill({json:{moduleRunId:explanationId,cancelled:true}});}
   return route.fulfill({status:500,json:{}});
  }
  if(url.pathname.endsWith(`/runs/${olderId}/shape-explanation`)){const old=structuredClone(explanationPageRun('succeeded'));old.run.id=olderId;old.run.report!.moduleRunId=olderId;old.run.presentation!.synthesis.summary={...old.run.presentation!.synthesis.summary,text:'较早分析的保存结论'};return route.fulfill({json:old});}
  if(url.pathname.endsWith('/shape-explanation')){if(gate){const pending=gate,captured=structuredClone(state);gate=null;pending.entered();await pending.wait;try{await route.fulfill({json:captured})}catch{/* Aborted on version switch. */}finally{pending.finished()}return;}return route.fulfill(readFailure?{status:503,json:{}}:{json:state});}
  if(url.pathname.includes('/shape-price/revisions/')){const historic=decodeURIComponent(url.pathname).endsWith(shapeRevisionId);return route.fulfill({json:{revision:historic?shapeRevision():offlineSave?shapeRequestBoundRevision():shapeStructureRevision(),explanations:historic?links:[]}});}
  if(url.pathname.endsWith('/shape-price'))return route.fulfill({json:current});return route.fulfill({status:404,json:{}});
 });
 const revisionId=shapeRevisionId;
 await page.goto(`${origin}/?shapeRun=${shapeRunId}`);await page.getByLabel('B000000001 人工形态').selectOption('shelf');await page.getByRole('button',{name:'确认并重新计算'}).click();
 const analysis=page.getByRole('region',{name:'形态解释分析状态'});await analysis.waitFor();await analysis.getByText('已完成分片 6 / 12',{exact:true}).waitFor();assert.equal(await analysis.locator('.market-theme-spinner').count(),1);assert.equal(writes.length,1);
 await mkdir('test-results/market-shape-explanation-page',{recursive:true});await analysis.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/market-shape-explanation-page/waiting-desktop.png'});
 state=explanationPageRun('failed');await page.clock.runFor(4100);await analysis.getByText('分析失败',{exact:true}).waitFor();
 await mkdir('test-results/market-shape-explanation-page',{recursive:true});await analysis.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/market-shape-explanation-page/failed-desktop.png'});
 await analysis.getByRole('button',{name:'重试此分析步骤'}).click();
 const prose=page.getByRole('region',{name:'形态结构解释报告'});await prose.waitFor();assert.equal(writes.length,2);
 await prose.getByText('测试来源证据不足，不能据此判断市场机会。',{exact:false}).first().waitFor();
 await page.reload();await prose.waitFor();assert.equal(writes.length,2,'reload is read only');
 readFailure=true;await analysis.getByRole('button',{name:'刷新解释状态'}).click();await analysis.getByRole('alert').waitFor();await prose.waitFor();assert.equal(writes.length,2);
 readFailure=false;await analysis.getByRole('button',{name:'刷新解释状态'}).click();await analysis.getByRole('alert').waitFor({state:'detached'});
 links=[explanationLink(),{...explanationLink(),moduleRunId:olderId,createdAt:'2026-09-12T01:00:00Z'}];await analysis.getByRole('button',{name:'刷新解释状态'}).click();await analysis.getByLabel('形态解释分析记录').selectOption(olderId);await prose.getByText('较早分析的保存结论',{exact:false}).waitFor();await analysis.getByLabel('形态解释分析记录').selectOption(explanationId);await prose.getByText('较早分析的保存结论',{exact:false}).waitFor({state:'detached'});assert.equal(writes.length,2);
 await prose.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/market-shape-explanation-page/success-desktop.png'});await page.setViewportSize({width:390,height:844});await prose.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:'test-results/market-shape-explanation-page/success-mobile.png'});
 const next=shapeStructureRevision();current.run.latestRevision=next;current.run.history.unshift({revisionId:next.revisionId,ordinal:2,createdAt:next.createdAt});await page.getByRole('button',{name:'刷新形态状态'}).click();await analysis.getByText('此版本尚未创建解释分析，已保存统计仍可查看。',{exact:true}).waitFor();assert.equal(await prose.count(),0,'another revision cannot reuse the previous prose');
 await page.getByLabel('形态报告版本').selectOption(shapeRevisionId);await prose.waitFor();assert.equal(writes.length,2,'history selection is read only');
 state=explanationPageRun('running');await analysis.getByRole('button',{name:'刷新解释状态'}).click();await analysis.getByRole('button',{name:'取消解释分析'}).click();await analysis.getByText('已取消',{exact:true}).waitFor();await prose.waitFor();assert.equal(writes.length,3);assert.equal(await analysis.locator('.market-theme-spinner').count(),0);
 state=explanationPageRun('succeeded',next.revisionId);await analysis.getByRole('button',{name:'刷新解释状态'}).click();await analysis.getByRole('alert').filter({hasText:'版本'}).waitFor();
 state=explanationPageRun('succeeded');let entered!:()=>void,release!:()=>void,finished!:()=>void;
 const arrived=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve}),returned=new Promise<void>(resolve=>{finished=resolve});gate={entered,wait,finished};t.after(()=>release());
 await analysis.getByRole('button',{name:'刷新解释状态'}).click();await arrived;await page.getByLabel('形态报告版本').selectOption('latest');await analysis.getByText('此版本尚未创建解释分析，已保存统计仍可查看。',{exact:true}).waitFor();release();await returned;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await prose.count(),0,'a late response cannot replace the selected revision');assert.equal(writes.length,3);
 offlineSave=true;await page.getByRole('button',{name:'重新载入最新草稿'}).click();await page.getByRole('button',{name:'确认并重新计算'}).click();await analysis.getByText('模型配置暂不可用，人工修订已保存',{exact:true}).waitFor();assert.equal(writes.length,4);await page.getByRole('region',{name:'形态价格带版本报告'}).waitFor();assert.equal(await prose.count(),0);
 assert.deepEqual(errors,[]);
});
