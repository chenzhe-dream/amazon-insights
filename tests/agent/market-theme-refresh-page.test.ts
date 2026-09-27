import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {themeDetails,themeRuleRun,themeRunId} from './helpers/market-theme-page-fixture';

test('explicit recollection uses saved scope, fresh keys, retains report and read-only reread', {timeout:120000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/theme-refresh-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(8000);
 const base=themeRuleRun().run, writes:{path:string;key:string;body:any}[]=[],runs=new Map([[base.id,base]]),errors:string[]=[];
 let release:()=>void=()=>{},hold=false,failStart=false;const resolutions:unknown[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml(url.pathname,'<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-theme-refresh-browser-harness.tsx"></script></body></html>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'&&url.pathname.endsWith('/shape-price/resolve-category')){resolutions.push(req.postDataJSON());return route.fulfill({json:{nodeId:'1063294'}});}
  if(req.method()==='POST'){
   const key=req.headers()['idempotency-key'],body=req.postDataJSON();writes.push({path:url.pathname,key,body});
   if(url.pathname.endsWith('/studies'))return route.fulfill({json:{study:{id:key,scope:{...body,organizationId:base.scope.organizationId,researchId:key},createdAt:base.createdAt}}});
   if(url.pathname.endsWith('/customer-themes')){
    if(failStart){failStart=false;return route.fulfill({status:503,json:{error:{message:'synthetic start failure'}}});}
    const studyId=url.pathname.split('/').at(-2)!;
    const next={...base,id:key,scope:{...base.scope,researchId:studyId},params:body,status:'running' as const,currentReport:null,latestSavedReport:null,history:[],steps:[{id:'60000000-0000-4000-8000-000000000021',kind:'collect-customer-themes' as const,status:'running' as const,latestAttemptId:null,attemptCount:1,current:true,canRetry:false,asin:null,errorCode:null}]};
    runs.set(key,next);if(hold)await new Promise<void>(resolve=>{release=resolve;});return route.fulfill({json:{run:next}});
   }
  }
  const id=url.pathname.split('/').at(-1)!;if(runs.has(id))return route.fulfill({json:{run:runs.get(id)}});
  if(url.pathname.endsWith('/details')){const details=themeDetails(url);details.report=base.currentReport!;return route.fulfill({json:details});}
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?themeRun=${themeRunId}`);await page.getByText('新版装配主题',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'重读已存见解',exact:true}).click();await page.getByText('新版装配主题',{exact:true}).first().waitFor();assert.equal(writes.length,0);
 await page.getByLabel('类目路径',{exact:true}).fill('99999');
 failStart=true;await page.getByRole('button',{name:'重新拉取',exact:true}).click();await page.getByRole('alert').filter({hasText:'synthetic start failure'}).waitFor();
 assert.equal(writes.length,2);const initialKeys=writes.map(w=>w.key);
 hold=true;await page.getByRole('button',{name:'重新拉取',exact:true}).click();await page.waitForFunction(()=>document.body.textContent?.includes('提交中'));
 await page.getByText('新版装配主题',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'重新拉取',exact:true}).isDisabled(),true);
 await page.waitForTimeout(100);release();await page.waitForFunction(()=>!document.body.textContent?.includes('提交中'));
 assert.deepEqual(writes.slice(2).map(w=>w.key),initialKeys);assert.equal(new Set(initialKeys).size,2);
 assert.equal(writes[0].body.nodeIdPath,base.scope.nodeIdPath);assert.equal(writes[0].body.fromMonth,base.scope.fromMonth);assert.deepEqual(writes[1].body,base.params);
 await page.getByText('新版装配主题',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'重新拉取',exact:true}).isDisabled(),true);
 const newId=new URL(page.url()).searchParams.get('themeRun')!;assert.notEqual(newId,base.id);
 runs.get(newId)!.status='succeeded';runs.get(newId)!.steps=[];
 await page.getByText('任务进度、重试与历史报告',{exact:true}).click();await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.waitForFunction(()=>!(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重新拉取') as HTMLButtonElement)?.disabled);
 hold=false;await page.getByRole('button',{name:'重新拉取',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('themeRun')!==newId);
 assert.equal(writes.length,6);assert.notEqual(writes[4].key,initialKeys[0]);assert.notEqual(writes[5].key,initialKeys[1]);
 await page.goto(origin);await page.getByRole('button',{name:'英国站',exact:true}).click();await page.getByLabel('类目路径',{exact:true}).fill('Floor Lamps');await page.getByRole('button',{name:'拉取见解',exact:true}).click();await page.waitForURL(url=>!!url.searchParams.get('themeRun'));
 assert.deepEqual(resolutions,[{marketplace:'UK',name:'Floor Lamps'}]);assert.equal(writes[6].body.marketplace,'UK');assert.equal(writes[6].body.nodeIdPath,'1063294');assert.equal(writes[6].body.currency,'GBP');assert.deepEqual(errors,[]);
});
