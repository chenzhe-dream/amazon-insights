import assert from 'node:assert/strict';import test from 'node:test';import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';import {createServer} from 'vite';import react from '@vitejs/plugin-react';
import {overviewRun,overviewRunId,overviewDistributionDetails,overviewScope} from './helpers/market-overview-page-fixture';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {buildItemCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-item-scoring';

test('old report review is explicit and supplementation uses its frozen scope, never edited filters',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-items-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
 const page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(10000);
 const run=overviewRun(false),detail=overviewDistributionDetails();detail.semantic=null;
 for(const entry of [...run.run.history,run.run.currentReport!,run.run.latestSavedReport!,detail.entry]){entry.report.semanticStatus='skipped';entry.report.versions.model=null;}
 const {niche,report}=completeScoreFixture();report.keywordTrends=[];report.salesTrend=[];report.productDemand!.pageViews=[];for(const row of report.prices)for(const p of row.items??[])p.profit=null;
 const wrap=(s:ReturnType<typeof buildCheckedOverviewSynthesis>)=>({version:6 as const,...s,inputGaps:[],sourceRefs:[],originalAssumptions:[]});
 detail.numbers.originalSynthesis=wrap(buildCheckedOverviewSynthesis(niche,report));detail.numbers.scoreReview=wrap(buildItemCheckedOverviewSynthesis(niche,report));
 const writes:Array<{url:string;body:any}>=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){writes.push({url:url.pathname,body:req.postDataJSON()});if(url.pathname.endsWith('/studies'))return route.fulfill({json:{study:{id:req.headers()['idempotency-key'],scope:{...overviewScope,researchId:req.headers()['idempotency-key']},createdAt:'2026-09-12T00:00:00.000Z'}}});return route.fulfill({status:503,json:{error:{message:'测试补采提交失败'}}});}
  if(url.pathname.includes('/reports/'))return route.fulfill({json:detail});
  if(url.pathname.endsWith(`/runs/${overviewRunId}/overview`))return route.fulfill({json:run});
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?overviewRun=${overviewRunId}`);
 const summary=page.getByRole('region',{name:'原版市场概览总结'});await summary.getByText(/新版逐项复算/).first().waitFor();
 assert.equal(await summary.locator('[data-score-point]').count(),6);assert.equal(await summary.locator('[data-score-polygon]').count(),0);
 await summary.getByRole('button',{name:'查看此前逐维校验'}).click();assert.equal(await summary.locator('[data-score-point]').count(),3);
 await summary.getByRole('button',{name:'返回新版逐项复算'}).click();assert.equal(writes.length,0);
 await page.getByLabel('类目节点或路径').fill('99999');
 await summary.scrollIntoViewIfNeeded();await mkdir('test-results/overview-items-browser',{recursive:true});await summary.screenshot({path:'test-results/overview-items-browser/partial.png'});
 await summary.getByRole('button',{name:'按本报告条件补齐采集'}).click();await page.getByText('测试补采提交失败',{exact:true}).waitFor();
 assert.equal(writes.length,2);assert.equal(writes[0].body.nodeIdPath,overviewScope.nodeIdPath);assert.equal(writes[0].body.fromMonth,overviewScope.fromMonth);assert.equal(writes[0].body.toMonth,overviewScope.toMonth);
 assert.deepEqual(writes[1].body,run.run.params);assert.equal(await summary.locator('[data-score-point]').count(),6);assert.deepEqual(errors,[]);
});
