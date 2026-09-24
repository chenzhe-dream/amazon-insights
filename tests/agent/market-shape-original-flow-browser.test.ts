import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeRevision,shapeRunId} from './helpers/market-shape-page-fixture';

test('original shape flow collects by category before any manual shape name and saves it afterward',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-original-flow-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1280,height:900}}),current=shapePageRun();
 current.run.semanticStatus='skipped';current.run.suggestions={status:'unavailable',items:[]};current.run.latestRevision=null;
 const errors:string[]=[],starts:unknown[]=[],revisions:unknown[]=[];let studies=0;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()==='POST'&&url.pathname.endsWith('/studies')){
   studies++;const id=request.headers()['idempotency-key'],body=request.postDataJSON();
   return route.fulfill({json:{study:{id,scope:{...body,organizationId:current.run.scope.organizationId,researchId:id},createdAt:'2026-09-13T00:00:00Z'}}});
  }
  if(request.method()==='POST'&&url.pathname.endsWith('/shape-price')&&!url.pathname.includes('/runs/')){
   const body=request.postDataJSON();starts.push(body);current.run.params=body;
   current.run.scope.researchId=url.pathname.split('/').at(-2)!;
   return route.fulfill({json:current});
  }
  if(request.method()==='POST'&&url.pathname.endsWith('/shape-price/revisions')){
   const body=request.postDataJSON();revisions.push(body);
   const revision={...shapeRevision(),taxonomyVersion:body.taxonomyVersion,labels:body.labels,assignments:body.assignments,groups:[{...shapeRevision().groups[0],labelId:body.assignments[0].labelId}]};
   current.run.latestRevision=revision;current.run.history=[{revisionId:revision.revisionId,ordinal:1,createdAt:revision.createdAt}];
   return route.fulfill({status:201,json:{revision}});
  }
  if(url.pathname.endsWith(`/runs/${shapeRunId}/shape-price`))return route.fulfill({json:current});
  return route.fulfill({status:404,json:{error:'unexpected test route'}});
 });
 await page.goto(origin+'/');
 assert.equal(await page.getByLabel('本次形态目录（每行：名称|判断依据）').count(),0);
 await page.getByRole('button',{name:'筛选市场',exact:true}).click();
 const row=page.getByLabel('B000000001 人工形态');await row.waitFor();
 assert.equal(studies,1);assert.equal(starts.length,1);assert.deepEqual((starts[0] as {catalog:{allowedLabels:unknown[]}}).catalog.allowedLabels,[]);
 await row.fill('层架式');
 await page.getByRole('button',{name:'确认并重新计算'}).click();
 await page.getByRole('region',{name:'形态价格带版本报告'}).waitFor();
 assert.equal(revisions.length,1);
 const saved=revisions[0] as {labels:Array<{labelId:string;label:string;definition:string}>;assignments:Array<{asin:string;labelId:string}>};
 assert.equal(saved.labels[0].label,'层架式');assert.equal(saved.assignments[0].labelId,saved.labels[0].labelId);
 await mkdir('test-results/market-shape-original-flow',{recursive:true});
 await page.screenshot({path:'test-results/market-shape-original-flow/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:'test-results/market-shape-original-flow/mobile.png',fullPage:true});
 await page.reload();await row.waitFor();assert.equal(await row.inputValue(),'层架式');
 assert.deepEqual(errors,[]);
});
