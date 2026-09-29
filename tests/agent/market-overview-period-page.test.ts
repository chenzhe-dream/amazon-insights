import {openMarketAdminTools} from './helpers/open-market-admin-tools';
import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {overviewRun,overviewRunId,overviewScope} from './helpers/market-overview-page-fixture';
import {latestCompleteOverviewMonth} from '../../shared/market-overview-period';

test('last30 is selectable, survives URL restoration and creates an explicitly rolling report',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-period-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(8000);const errors:string[]=[],posts:any[]=[];page.on('pageerror',e=>errors.push(e.message));let study:any;let current=overviewRun(false);
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){const body=req.postDataJSON();posts.push({path:url.pathname,body});
   if(url.pathname.endsWith('/studies')){study={id:req.headers()['idempotency-key'],scope:{...overviewScope,...body,researchId:req.headers()['idempotency-key']},createdAt:new Date().toISOString()};return route.fulfill({json:{study}});}
   current={run:{...current.run,id:overviewRunId,scope:study.scope,currentReport:null,latestSavedReport:null,history:[],steps:[]}};return route.fulfill({json:current});
  }
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
  if(url.pathname.endsWith('/overview/saved'))return route.fulfill({json:{runId:null,fromMonth:null}});
  if(url.pathname.endsWith(`/runs/${overviewRunId}/overview`))return route.fulfill({json:current});
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(origin+'/?themeView=overview&marketNode=123:456&marketMonth=last30');
 const chip=page.getByRole('button',{name:'最近30天',exact:true});await chip.waitFor();await page.waitForFunction(()=>document.querySelector('button[aria-pressed="true"]')?.textContent!==null);
 await chip.click();assert.equal(await chip.isEnabled(),true);assert.equal(await chip.getAttribute('aria-pressed'),'true');
 await openMarketAdminTools(page);await page.getByText('分析设置与任务管理',{exact:true}).click();await page.getByRole('button',{name:'开始总览分析',exact:true}).click();
 await page.waitForFunction(()=>location.search.includes('overviewRun='));
 const created=posts.find(p=>p.path.endsWith('/studies')).body;assert.equal(created.overviewPeriod,'last30');assert.equal(created.fromMonth,latestCompleteOverviewMonth());assert.equal(created.toMonth,created.fromMonth);
 assert.equal(await page.getByText('状态读取失败：',{exact:false}).count(),0);assert.deepEqual(errors,[]);
 await page.screenshot({path:'test-results/overview-last30-page.png',fullPage:true});
});
