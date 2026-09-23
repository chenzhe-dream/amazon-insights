import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { overviewRun, overviewDistributionDetails } from './helpers/market-overview-page-fixture';

test('reference result row opens current-backend report inline and reopening is read-only', {timeout:60000}, async t => {
 const server=await createServer({configFile:false,cacheDir:'test-results/market-reference-restored/vite-overview-flow',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}}); await server.listen();
 const browser=await chromium.launch(); t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0],page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
 const writes:Array<{path:string;body:Record<string,unknown>}>=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const run=overviewRun(),details=overviewDistributionDetails();
 run.run.scope.fromMonth='2026-08';for(const entry of [...run.run.history,run.run.currentReport!,run.run.latestSavedReport!])entry.report.scope.fromMonth='2026-08';details.entry.report.scope.fromMonth='2026-08';
 // The legacy collector accepts a bare node and returns its canonical path in
 // the report. Opening the new flow must carry that returned path forward.
 const scope={marketplace:'US',nodeQuery:'456',month:'2026-08',headTopN:10,newProductMonths:6};
 const job={id:'80000000-0000-4000-8000-000000000001',scope,status:'succeeded',attempts:1,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',error:null,report:{schemaVersion:'market-overview/v1',scope,nodeId:'456',nodeIdPath:'123:456',categoryName:'Gel Pens',currency:'USD',collectedAt:'2026-09-12T00:00:00.000Z',metrics:{sampleProducts:20,brands:4,sellers:5,totalUnits:100,totalRevenue:2000,avgPrice:20,avgUnits:5,avgRatings:null,avgRating:4.5,productConcentrationRaw:null,brandConcentrationRaw:null,sellerConcentrationRaw:null,newCount:2,newAvgPrice:null,newAvgUnits:null},evidence:[],issues:[],boundaries:[]}};
 let ready=false,failRead=false,readCount=0;let heldRead:Promise<void>|undefined,releaseRead:(()=>void)|undefined;
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==new URL(origin).origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/', '<html><body style="margin:24px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-browser-harness.tsx"></script></body></html>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){
   writes.push({path:url.pathname,body:req.postDataJSON()});
   if(url.pathname.endsWith('/market-research/jobs')){ready=true;return route.fulfill({json:{job}})}
   if(url.pathname.endsWith('/studies')){const id=req.headers()['idempotency-key'];run.run.scope.researchId=id;for(const entry of [...run.run.history,run.run.currentReport!,run.run.latestSavedReport!])entry.report.scope.researchId=id;details.entry.report.scope.researchId=id;return route.fulfill({json:{study:{id,scope:run.run.scope,createdAt:run.run.createdAt}}});}
   if(url.pathname.endsWith('/overview'))return route.fulfill({json:run});
   throw Error('Unexpected write '+url.pathname);
  }
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:ready?[job]:[]}});
  if(url.pathname.includes('/reports/'))return route.fulfill({json:details});
  if(url.pathname.endsWith('/overview')){readCount++;if(heldRead)await heldRead;if(failRead)return route.fulfill({status:502,json:{error:{message:'Agent Service response exceeded the size limit'}}});return route.fulfill({json:run});}
  return route.fulfill({status:404,json:{error:{message:'no fixture'}}});
 });
 await page.goto(origin+'?marketNode=456&marketMonth=2026-08');
 await page.getByRole('button',{name:'筛选市场',exact:true}).click();
 const open=page.getByRole('button',{name:'查看市场分析报告',exact:true});await open.waitFor();
 assert.equal(await page.getByRole('button',{name:'开始总览分析',exact:true}).isVisible(),false,'auxiliary workflow is initially collapsed');
 await page.getByLabel('类目节点或路径').fill('999:888');
 await open.click();try{await page.getByRole('region',{name:'已保存总览报告'}).waitFor();}catch(error){console.log('reference-flow',writes,errors,await page.locator('body').innerText());throw error;}
 assert.equal(writes.length,3);assert.equal(writes[1].body.nodeIdPath,'123:456','report is bound to selected result, not edited filter');assert.equal(writes[1].body.fromMonth,'2026-08');
 await page.locator('.ss-report-kpis article').first().waitFor();assert.equal(await page.locator('.ss-report-kpis article').count(),3);
 await page.getByText('本报告的分析规则',{exact:true}).click();
 const rules=page.locator('details').filter({has:page.locator('summary').filter({hasText:'本报告的分析规则'})}).last();
 assert.match(await rules.innerText(),/不补零|来源缺失/);assert.match(await rules.innerText(),/历史读取不重新采集/);assert.equal(writes.length,3,'reading rule definitions must not start another analysis');
 await mkdir('test-results/market-reference-restored',{recursive:true});await page.screenshot({path:'test-results/market-reference-restored/overview-result-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'收起报告',exact:true}).click();await page.getByRole('button',{name:'展开已保存报告',exact:true}).click();assert.equal(writes.length,3);
 await page.getByRole('button',{name:'收起报告',exact:true}).click();await page.getByRole('button',{name:'查看市场分析报告',exact:true}).click();assert.equal(writes.length,3);
 heldRead=new Promise(resolve=>{releaseRead=resolve;});await page.reload();await page.getByRole('button',{name:'查看市场分析报告',exact:true}).click();await page.waitForTimeout(200);assert.equal(writes.length,3,'pending restored report never starts another task');releaseRead?.();heldRead=undefined;await page.getByRole('region',{name:'已保存总览报告'}).waitFor();assert.equal(writes.length,3);
 failRead=true;await page.reload();await page.getByRole('alert').filter({hasText:'状态读取失败'}).waitFor();
 const beforeRecovery=readCount;failRead=false;await page.getByRole('button',{name:'查看市场分析报告',exact:true}).click();
 await page.getByRole('region',{name:'已保存总览报告'}).waitFor();
 assert.equal(readCount,beforeRecovery+1,'open retries the failed read exactly once');assert.equal(writes.length,3,'recovering a read must not create another study or analysis');
 assert.equal(await page.getByRole('alert').filter({hasText:'状态读取失败'}).count(),0);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'test-results/market-reference-restored/overview-result-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
});
