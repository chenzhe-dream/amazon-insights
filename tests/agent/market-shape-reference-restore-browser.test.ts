import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapeSorftimePageRun} from './helpers/market-shape-sorftime-page-fixture';
import {openShapeTaskRecovery} from './helpers/open-market-admin-tools';

test('reference drafts guard task switches and pause autosave during target reads',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-reference-restore-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(5000);
 const a=shapeSorftimePageRun(2,2),b=shapeSorftimePageRun(2,2);b.run.id='71000000-0000-4000-8000-000000000005';b.run.scope.nodeIdPath='4:5:6';
 let targetRelease:(()=>void)|undefined,writeRelease:(()=>void)|undefined,targetReads=0,writes=0,missingStatus=404,currentStatus=200;let currentRelease:(()=>void)|undefined;
 const draft={version:0,items:[],catalogLabels:[],updatedAt:null};
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module">import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {MarketResearchSection} from '/app/market-research-section';import {subscribeToAuthenticationRequired} from '/app/lib/local-agent-browser';function Gate(){const[authenticated,setAuthenticated]=useState(true);useEffect(()=>subscribeToAuthenticationRequired(()=>setAuthenticated(false)),[]);return authenticated?React.createElement(MarketResearchSection,{sessionIdentity:'reference-restore-test',showAuditDetails:true}):React.createElement('p',null,'Login required');}createRoot(document.getElementById('root')).render(React.createElement(Gate));</script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname.endsWith('/auth/session'))return route.fulfill({json:{authenticated:true,user:{id:a.run.scope.organizationId,organizationId:a.run.scope.organizationId,email:'test@example.com',displayName:'Fixture',role:'member',status:'active',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'},sessionIdentity:'a'.repeat(43),canViewUserPresence:false}});
  if(url.pathname.endsWith('/shape-price/draft')){if(request.method()!=='GET'){writes++;if(writeRelease)await new Promise<void>(resolve=>{writeRelease=resolve});return route.fulfill({status:503,json:{error:'synthetic draft offline'}});}return route.fulfill({json:{draft}});}
  if(url.pathname.endsWith(`/runs/${a.run.id}/shape-price`)){const status=currentStatus;if(currentRelease)await new Promise<void>(resolve=>{currentRelease=resolve});return route.fulfill({status,json:status===200?a:{error:"current reference permission revoked"}});}
  if(url.pathname.endsWith(`/runs/${b.run.id}/shape-price`)){targetReads++;if(targetRelease)await new Promise<void>(resolve=>{targetRelease=resolve});return route.fulfill({json:b});}
  return route.fulfill({status:missingStatus,json:{error:'synthetic missing target'}});
 });
 await page.goto(origin+'/?themeView=shapes&marketShapeNode=1:2:3&shapeRun='+a.run.id);
 const input=page.getByLabel('B000000001 人工形态',{exact:true});await page.getByText(/草稿：已保存/).waitFor();await openShapeTaskRecovery(page);
 targetRelease=()=>{};await page.getByLabel('形态任务编号').fill(b.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();while(!targetReads)await page.waitForTimeout(10);
 await input.fill('new reference draft');await page.waitForTimeout(700);assert.equal(writes,0,'target read pauses autosave so switch cannot race a write');
 targetRelease!();targetRelease=undefined;await page.getByRole('button',{name:'保留修改',exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('shapeRun'),a.run.id);await page.getByRole('button',{name:'保留修改',exact:true}).click();assert.equal(await input.inputValue(),'new reference draft');
 writeRelease=()=>{};await page.getByRole('button',{name:'重试同步草稿',exact:true}).click();while(!writes)await page.waitForTimeout(10);
 assert.equal(await page.getByRole('button',{name:'读取任务',exact:true}).isDisabled(),true,'reference autosave in flight blocks target GET');
 writeRelease!();writeRelease=undefined;await page.getByText('synthetic draft offline',{exact:true}).waitFor();
 await page.getByRole('button',{name:'读取任务',exact:true}).click();await page.getByRole('button',{name:'放弃修改并切换',exact:true}).click();
 await page.waitForFunction(()=>new URL(location.href).searchParams.get('shapeRun')==='71000000-0000-4000-8000-000000000005');
 assert.equal(writes,1);await page.getByText(/草稿：已保存/).waitFor();assert.equal(await input.inputValue(),'');
 for(const status of [404,403]){
  missingStatus=status;await page.getByLabel('形态任务编号').fill('00000000-0000-4000-8000-000000000999');await page.getByRole('button',{name:'读取任务',exact:true}).click();await page.getByText(/目标任务读取失败/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('shapeRun'),b.run.id);assert.equal(await input.count(),1);
 }
 currentStatus=403;
 await page.getByLabel('形态任务编号').fill(a.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();await page.getByText(/目标任务读取失败/).waitFor();assert.equal(await input.count(),1,'different target 403 retains authorized B');
 currentStatus=200;await page.getByLabel('形态任务编号').fill(a.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.get('shapeRun')==='71000000-0000-4000-8000-000000000001');await input.waitFor();
 currentStatus=403;currentRelease=()=>{};const beforeTarget=targetReads;
 await page.getByRole('button',{name:'刷新形态状态',exact:true}).click();targetRelease=()=>{};await page.getByLabel('形态任务编号').fill(b.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();while(targetReads===beforeTarget)await page.waitForTimeout(10);currentRelease!();currentRelease=undefined;await page.getByText(/current reference permission revoked/).waitFor();targetRelease!();targetRelease=undefined;await page.waitForTimeout(150);
 assert.equal(await input.count(),0,'current 403 unmounts modern reference source and draft panel');
 currentStatus=200;await page.getByLabel('形态任务编号').fill(a.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();await input.waitFor();targetRelease=undefined;
 missingStatus=401;await page.getByLabel('形态任务编号').fill('00000000-0000-4000-8000-000000000999');await page.getByRole('button',{name:'读取任务',exact:true}).click();await page.getByText('Login required',{exact:true}).waitFor();assert.equal(await input.count(),0,'auth-required event clears retained report through auth gate');assert.equal(writes,1);
});
