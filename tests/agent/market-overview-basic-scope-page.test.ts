import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {MarketOverviewMetricsSchema,MarketResearchJobSchema} from '../../shared/market-research-contracts';
import {overviewRun,overviewRunId,overviewDistributionDetails} from './helpers/market-overview-page-fixture';
import {matchesOverviewBasicScope} from '../../app/lib/market-overview-basic-scope';

function job(n:number,nodeQuery='123:456',month='2026-08',headTopN:5|10=10,newProductMonths:3|6=6){
 const scope={marketplace:'US',nodeQuery,month,headTopN,newProductMonths};
 return MarketResearchJobSchema.parse({id:`80000000-0000-4000-8000-${String(n).padStart(12,'0')}`,scope,status:'succeeded',attempts:1,createdAt:'2026-09-12T05:00:00Z',updatedAt:'2026-09-12T05:00:00Z',error:null,report:{schemaVersion:'market-overview/v1',scope,nodeId:nodeQuery.split(':').at(-1),nodeIdPath:nodeQuery,categoryName:`基础记录${n}`,currency:'USD',collectedAt:'2026-09-12T05:00:00Z',metrics:Object.fromEntries(Object.keys(MarketOverviewMetricsSchema.shape).map(k=>[k,null])),evidence:[],issues:[],boundaries:[]}});
}

test('basic scope matches canonical leaves but not different explicit paths, sites or periods',()=>{
 const basic=job(5),scope=basic.scope;
 assert.equal(matchesOverviewBasicScope(basic,{...scope,nodeQuery:'456'}),true);
 assert.equal(matchesOverviewBasicScope(basic,{...scope,nodeQuery:'999:456'}),false);
 assert.equal(matchesOverviewBasicScope(basic,{...scope,marketplace:'CA'}),false);
 assert.equal(matchesOverviewBasicScope(basic,{...scope,month:'last30'}),false);
 assert.equal(matchesOverviewBasicScope(basic,{...scope,headTopN:5}),false);
 assert.equal(matchesOverviewBasicScope(basic,{...scope,newProductMonths:3}),false);
});

test('history overview binds basic scope regardless of response order and preserves explicit history choices',{timeout:90000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-basic-scope-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');const page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(6000);
 let current=overviewRun(),rows=[job(1,'999:888'),job(2,'123:456','2026-07'),job(3,'123:456','2026-08',5),job(4,'123:456','2026-08',10,3),job(5)],failJobs=false,failRun=false,writes=0;
 let release!:()=>void;let gate:Promise<void>|null=new Promise<void>(r=>{release=r;});let jobsGate:Promise<void>|null=null;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-overview-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();if(req.method()!=='GET'){writes++;return route.abort();}
  if(url.pathname.endsWith('/market-research/jobs')){if(jobsGate)await jobsGate;return route.fulfill(failJobs?{status:503,json:{error:{message:'基础历史读取失败'}}}:{json:{jobs:rows}});}
  if(url.pathname.includes('/reports/')){const detail=overviewDistributionDetails();detail.entry.report.scope=current.run.scope;return route.fulfill({json:detail});}
  if(url.pathname.endsWith(`/runs/${overviewRunId}/overview`)){if(gate)await gate;return route.fulfill(failRun?{status:503,json:{error:{message:'历史任务读取失败'}}}:{json:current});}
  return route.fulfill({status:404,json:{}});
 });
 const url=origin+'/?overviewRun='+overviewRunId;
 await page.goto(url);await page.getByText('正在匹配历史报告的基础概览',{exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:'市场总览结果',exact:true}).count(),0,'unrelated newest data must not flash while the report loads');release();gate=null;
 const basic=page.getByRole('region',{name:'市场总览结果',exact:true});await basic.getByRole('heading',{name:'基础记录5',exact:true}).waitFor();assert.equal(writes,0);
 await page.getByText('采集历史与状态',{exact:true}).click();const history=page.locator('.market-research-history');await history.getByRole('button',{name:/基础记录1/}).click();await basic.getByRole('heading',{name:'基础记录1',exact:true}).waitFor();await page.getByText('基础概览与下方总览报告范围不同',{exact:true}).waitFor();
 await history.getByRole('button',{name:'刷新',exact:true}).click();await basic.getByRole('heading',{name:'基础记录1',exact:true}).waitFor();await page.getByRole('button',{name:'返回报告对应概览',exact:true}).click();await basic.getByRole('heading',{name:'基础记录5',exact:true}).waitFor();
 jobsGate=new Promise<void>(r=>{release=r;});await page.goto(url+'&marketNode=999:888&marketMonth=2026-07');await page.getByRole('region',{name:'已保存总览报告'}).getByText('42',{exact:true}).first().waitFor();assert.equal(await basic.count(),0);await page.getByText('正在匹配历史报告的基础概览',{exact:true}).waitFor();release();jobsGate=null;await basic.getByRole('heading',{name:'基础记录5',exact:true}).waitFor();await basic.screenshot({path:'test-results/overview-basic-scope-matched.png'});
 rows=[job(1,'999:888')];await page.reload();await page.getByText('最近30条采集历史中没有与该总览匹配的基础记录',{exact:true}).waitFor();assert.equal(await basic.count(),0);await page.getByRole('region',{name:'已保存总览报告'}).getByText('42',{exact:true}).first().waitFor();
 rows=[];await page.reload();await page.getByText('最近30条采集历史中没有与该总览匹配的基础记录',{exact:true}).waitFor();assert.equal(await basic.count(),0);
 const failed=job(7);failed.status='failed';failed.report=null;failed.error={dataset:'research',code:'timeout',message:'匹配记录采集超时',retryable:true};rows=[job(1,'999:888'),failed];await page.reload();await page.getByText('卖家精灵暂无可用结果',{exact:true}).waitFor();await page.locator('.pending-box').getByText('匹配记录采集超时',{exact:true}).waitFor();assert.equal(await basic.count(),0);
 failJobs=true;await page.reload();await page.getByText('基础历史读取失败',{exact:true}).waitFor();assert.equal(await basic.count(),0);
 failJobs=false;failRun=true;await page.reload();await page.getByText('未能确认历史报告范围',{exact:true}).waitFor();assert.equal(await basic.count(),0);
 failRun=false;current=overviewRun();current.run.scope={...current.run.scope,fromMonth:'2026-08',overviewPeriod:'last30'};for(const entry of [...current.run.history,current.run.currentReport!,current.run.latestSavedReport!])entry.report.scope=current.run.scope;
 rows=[job(5),job(6,'123:456','last30')];await page.reload();await basic.getByRole('heading',{name:'基础记录6',exact:true}).waitFor();assert.equal(writes,0);assert.deepEqual(errors,[]);
});
