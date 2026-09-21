import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {MarketOverviewDetailsResponseSchema} from '../../shared/market-overview-report-contracts';
import {overviewRun,overviewRunId,overviewEntry,overviewDistributionDetails,overviewAnalysisDetails} from './helpers/market-overview-page-fixture';
import {synthesisDetails} from './helpers/market-overview-synthesis-page-fixture';

test('overview final report preserves history and source limitations across mobile and refresh without writes',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-synthesis-page-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[];let writes=0;
 page.on('pageerror',error=>errors.push(error.message));const detail=MarketOverviewDetailsResponseSchema.parse(synthesisDetails()),current=overviewRun();current.run.currentReport=detail.entry;current.run.latestSavedReport=detail.entry;current.run.history=[{...overviewAnalysisDetails().entry,current:false},detail.entry,overviewDistributionDetails(true).entry];
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();if(request.method()!=='GET'){writes++;return route.fulfill({status:500,json:{}});}
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
  if(url.pathname.includes('/reports/'))return route.fulfill({json:url.pathname.includes(overviewEntry(true).attemptId)?overviewDistributionDetails(true):url.pathname.includes(overviewEntry().attemptId)?overviewAnalysisDetails():detail});
  if(url.pathname.endsWith(`/runs/${overviewRunId}/overview`))return route.fulfill({json:current});return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?overviewRun=${overviewRunId}`);const synthesis=page.getByRole('region',{name:'已保存综合解释'});await synthesis.waitFor();
 assert.match(await synthesis.innerText(),/返回样本销量为0/);await synthesis.getByText('查看综合依据',{exact:true}).first().click();await synthesis.getByText('缺口：period-missing',{exact:true}).first().waitFor();
 assert.doesNotMatch(await page.getByRole('region',{name:'已保存总览报告'}).innerText(),/完整综合判断仍待/);
 await mkdir('test-results/market-overview-synthesis-page',{recursive:true});await synthesis.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/market-overview-synthesis-page/synthesis-desktop.png'});
 await page.setViewportSize({width:390,height:844});await synthesis.scrollIntoViewIfNeeded();assert.ok(await synthesis.evaluate(element=>element.scrollWidth<=element.clientWidth+1));await page.screenshot({path:'test-results/market-overview-synthesis-page/synthesis-mobile.png'});
 await page.getByText('分析设置与任务管理',{exact:true}).click();
 await page.getByLabel('总览报告版本').selectOption(overviewEntry(true).attemptId);await page.getByRole('region',{name:'已保存总览报告'}).getByText('17',{exact:true}).first().waitFor();assert.equal(await synthesis.count(),0);
 await page.getByLabel('总览报告版本').selectOption(overviewEntry().attemptId);await page.getByRole('region',{name:'已保存分段解释'}).waitFor();assert.equal(await synthesis.count(),0);
 await page.getByLabel('总览报告版本').selectOption('latest');await synthesis.waitFor();await page.reload();await synthesis.waitFor();assert.equal(writes,0);assert.deepEqual(errors,[]);
});
