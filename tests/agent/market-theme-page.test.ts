import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { themeDetails, themeEntry, themeRun, themeRunId, themeScope, themeEvidence } from './helpers/market-theme-page-fixture';

test('theme page starts explicitly, restores read-only, preserves denominators and rejects stale report responses',{timeout:60000},async t=>{
  const server=await createServer({configFile:false,cacheDir:'test-results/theme-page-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
  const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(8000);
  let running=true,failStart=true,slowOld=false,failReads=false,noData=false,releaseOld:(()=>void)|undefined;const writes:Array<{path:string,key:string|undefined,body:unknown}>=[],errors:string[]=[],external:string[]=[];
  const emptyEntry=themeEntry();emptyEntry.report.status='no-data';emptyEntry.report.dataReady=false;emptyEntry.report.reportHash='e'.repeat(64);
  Object.assign(emptyEntry.report.counts,{successfulCount:0,emptyCount:2,failedCount:0,expectedMemberCount:0,validatedMemberCount:0,unknownCount:0});emptyEntry.report.reasons=['selection-shortfall','no-theme-data','empty-asins'];
  let markOldRequested!:()=>void;const oldRequested=new Promise<void>(resolve=>{markOldRequested=resolve;});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());if(url.origin!==origin){external.push(r.url());return route.abort();}
    if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml(url.pathname,'<!doctype html><html><body style="margin:24px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-theme-browser-harness.tsx"></script></body></html>')});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const reply=(json:unknown,status=200)=>route.fulfill({status,json});
    if(r.method()==='POST'){writes.push({path:url.pathname,key:r.headers()['idempotency-key'],body:r.postDataJSON()});
      if(url.pathname.endsWith('/studies'))return reply({study:{id:r.headers()['idempotency-key'],scope:{...themeScope,researchId:r.headers()['idempotency-key']},createdAt:'2026-09-12T05:00:00.000Z'}});
      if(url.pathname.endsWith('/customer-themes')){if(failStart){failStart=false;return reply({error:{message:'synthetic start unavailable'}},503);}const value=themeRun(true);value.run.scope.researchId=url.pathname.split('/').at(-2)!;return reply(value);}
      if(url.pathname.endsWith('/retry')){running=true;return reply({moduleRunId:themeRunId,stepIds:['60000000-0000-4000-8000-000000000006']});}
      return reply({},400);
    }
    if(url.pathname.endsWith('/market-research/jobs'))return reply({jobs:[]});
    if(url.pathname.endsWith('/evidence'))return reply(themeEvidence(url));
    if(url.pathname.endsWith(`/runs/${themeRunId}`)){if(failReads)return reply({error:{message:'synthetic read unavailable'}},503);const result=themeRun(running);if(noData){result.run.steps=[];result.run.currentReport=emptyEntry;result.run.latestSavedReport=emptyEntry;result.run.history=[emptyEntry];}return reply(result);}
    if(url.pathname.endsWith('/details')){if(slowOld&&url.pathname.includes(themeEntry(true).attemptId))await new Promise<void>(resolve=>{releaseOld=resolve;markOldRequested();});const result=themeDetails(url);if(noData){result.report=emptyEntry;Object.assign(result.page,{items:[],totalItems:0,nextOffset:null,totals:null,display:{topN:null,totalGroupCount:0,displayedGroupCount:0,omittedGroupCount:0}});}return reply(result).catch(()=>{});}
    return reply({},404);
  });
  await page.goto(origin+'/');await page.getByRole('button',{name:'类目买家评论见解',exact:true}).click();assert.equal(writes.length,0);
  await page.getByLabel('类目路径',{exact:true}).fill(themeScope.nodeIdPath);await page.getByLabel('完整月份',{exact:true}).fill('2026-08');
  await page.getByRole('button',{name:'开始主题分析',exact:true}).click();await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'开始主题分析',exact:true}).click();await page.getByRole('heading',{name:'主题分析中',exact:true}).waitFor();
  assert.equal(writes.length,4);assert.equal(writes[0].key,writes[2].key);assert.equal(writes[1].key,writes[3].key);
  assert.match(page.url(),new RegExp(`themeRun=${themeRunId}`));await page.reload();await page.getByRole('heading',{name:'主题分析中',exact:true}).waitFor();assert.equal(writes.length,4);
  assert.equal(await page.locator('.market-theme-spinner').count()>0,true);
  running=false;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('heading',{name:'新版装配主题',exact:true}).waitFor();
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByRole('heading',{name:'第二组亮度',exact:true}).waitFor();assert.match(await page.getByLabel('主题明细').innerText(),/总数：4/);
  await page.getByRole('button',{name:'原主题证据',exact:true}).click();await page.getByText('合成原文预览',{exact:false}).waitFor();assert.match(await page.getByLabel('主题明细').innerText(),/截断预览/);assert.equal(await page.locator('script').filter({hasText:'不执行'}).count(),0);
  await page.getByRole('button',{name:'查看完整原文与模型解释',exact:true}).click();await page.getByRole('heading',{name:'完整摘要原文',exact:true}).waitFor();
  assert.equal(await page.locator('.market-theme-full-evidence > .market-theme-evidence').nth(1).evaluate(e=>e.textContent?.length),12000);assert.equal(await page.locator('.market-theme-full-evidence blockquote').innerText(),'不执行');assert.equal(await page.locator('.market-theme-full-evidence script').count(),0);
  await page.getByRole('button',{name:'收起完整证据',exact:true}).click();
  slowOld=true;await page.getByLabel('报告版本',{exact:true}).selectOption(themeEntry(true).attemptId);
  await page.waitForFunction(()=>document.querySelector('[aria-label="主题明细"]')?.textContent?.includes('正在读取'));
  await oldRequested;
  await page.getByLabel('报告版本',{exact:true}).selectOption('latest');await page.getByRole('heading',{name:'新版装配主题',exact:true}).waitFor();releaseOld?.();slowOld=false;
  await page.getByRole('button',{name:'商品覆盖',exact:true}).click();await page.getByRole('heading',{name:'B0THEME002 · 采集失败',exact:true}).waitFor();assert.match(await page.getByLabel('主题明细').innerText(),/提及 未知/);
  assert.equal(await page.getByRole('heading',{name:'旧版独有主题',exact:true}).count(),0);
  await page.getByRole('button',{name:'主题分组',exact:true}).click();await page.getByRole('heading',{name:'新版装配主题',exact:true}).waitFor();
  await mkdir('test-results/market-research-goal/T17/theme-page',{recursive:true});await page.screenshot({path:'test-results/market-research-goal/T17/theme-page/source-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:'test-results/market-research-goal/T17/theme-page/source-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'重试 B0THEME002',exact:true}).click();await page.getByRole('heading',{name:'主题分析中',exact:true}).waitFor();assert.equal(writes.length,5);assert.deepEqual(writes[4].body,{steps:[{stepId:'60000000-0000-4000-8000-000000000006',failedAttemptId:'60000000-0000-4000-8000-000000000007'}]});
  failReads=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('heading',{name:'最新状态待确认',exact:true}).waitFor();assert.equal(await page.locator('.market-theme-spinner').count(),0);
  assert.equal(await page.getByLabel('已保存主题报告').count(),1);
  failReads=false;running=false;noData=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('heading',{name:'暂无可用主题',exact:true}).waitFor();await page.getByText('该版本在此视图暂无可展示的明细。',{exact:true}).waitFor();assert.match(await page.getByLabel('主题明细').innerText(),/总数：未知/);assert.equal(writes.length,5);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
