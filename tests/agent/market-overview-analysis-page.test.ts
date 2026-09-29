import {openMarketAdminTools} from './helpers/open-market-admin-tools';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {overviewRun,overviewRunId,overviewEntry,overviewDistributionDetails,overviewAnalysisDetails} from './helpers/market-overview-page-fixture';

test('saved model prose renders bound zero values and limitations while preserving the legacy report',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-analysis-page-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[];let writes=0;
 page.on('pageerror',e=>errors.push(e.message));const detail=overviewAnalysisDetails(),current=overviewRun();current.run.currentReport=detail.entry;current.run.latestSavedReport=detail.entry;current.run.history[1]=detail.entry;
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();if(req.method()!=='GET'){writes++;return route.fulfill({status:500,json:{}});}
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
  if(url.pathname.includes('/reports/'))return route.fulfill({json:url.pathname.includes(overviewEntry(true).attemptId)?overviewDistributionDetails(true):detail});
  if(url.pathname.endsWith(`/runs/${overviewRunId}/overview`))return route.fulfill({json:current});return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?overviewRun=${overviewRunId}`);
 const prose=page.getByRole('region',{name:'已保存分段解释'});await prose.waitFor();
 await prose.getByRole('heading',{name:'样本成交',exact:true}).waitFor();assert.match(await prose.innerText(),/返回样本销量为0/);
 for(const title of ['数据表现','数据含义','结论','限制','待验证'])await prose.getByText(title,{exact:true}).waitFor();
 await prose.getByText('该结果仅反映返回样本，不能推断需求消失',{exact:true}).waitFor();
 await prose.getByText('来源没有确认月份，暂不进行趋势比较',{exact:true}).waitFor();
 await prose.getByText('查看本段依据',{exact:true}).first().click();await prose.getByText('统计周期：来源未确认',{exact:true}).first().waitFor();
 await mkdir('test-results/market-overview-analysis-page',{recursive:true});await prose.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/market-overview-analysis-page/prose-desktop.png'});
 await page.setViewportSize({width:390,height:844});await prose.scrollIntoViewIfNeeded();assert.ok(await prose.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:'test-results/market-overview-analysis-page/prose-mobile.png'});
 await openMarketAdminTools(page);await page.getByText('分析设置与任务管理',{exact:true}).click();
 await page.getByLabel('总览报告版本').selectOption(overviewEntry(true).attemptId);await page.getByRole('region',{name:'已保存总览报告'}).getByText('17',{exact:true}).first().waitFor();assert.equal(await prose.count(),0);
 await page.getByLabel('总览报告版本').selectOption('latest');await prose.waitFor();await page.reload();await prose.waitFor();assert.equal(writes,0);assert.deepEqual(errors,[]);
});
