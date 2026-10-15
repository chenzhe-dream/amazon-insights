import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

test('linked mutations reject late session replies and denied reads clear output and stop polling',{timeout:90000},async t=>{
 const server=await createServer({configFile:false,define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(10000);
 let release:()=>void=()=>{},pending=new Promise<void>(resolve=>{release=resolve;}),postCount=0,readCount=0,deny=false;
 const keys:string[]=[];
 const make=(id:string)=>({id,request:{scope:{marketplace:'US',nodeQuery:'34',month:'2026-08',headTopN:10,newProductMonths:6},fromMonth:'2026-08'},basicJobId:randomUUID(),basicRetryable:false,status:'pending',message:'wait',categoryName:null,resolvedNodeIdPath:null,modules:Object.fromEntries(['overview','shapes','keywords','themes'].map(m=>[m,{status:'pending',runId:null,message:null}]))});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/','<div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {useMarketLinkedAnalysis} from "/app/lib/use-market-linked-analysis.ts";const h=React.createElement;function Harness({identity}){const linked=useMarketLinkedAnalysis(identity,()=>{window.accepted=(window.accepted||0)+1});return h(React.Fragment,null,h("button",{onClick:()=>linked.start({scope:{marketplace:"US",nodeQuery:"34",month:"2026-08",headTopN:10,newProductMonths:6},fromMonth:"2026-08"}).catch(()=>{})},"start"),h("output",null,linked.batch?.id||"none"),h("p",{role:"alert"},linked.error));};function App(){const [identity,setIdentity]=React.useState("account-a");return h(React.Fragment,null,h("button",{onClick:()=>{history.replaceState(null,"","/");setIdentity("account-b")}},"switch account"),h(Harness,{key:identity,identity}));};createRoot(document.getElementById("root")).render(h(App));</script>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){postCount++;const id=req.headers()['idempotency-key'];keys.push(id);if(postCount===1)await pending;return route.fulfill({json:{batch:make(id)}}).catch(()=>{});}
  readCount++;if(deny)return route.fulfill({status:403,json:{error:{message:'permission revoked'}}});
  return route.fulfill({status:404,json:{error:{message:'not yet accepted'}}});
 });
 await page.goto(origin);await page.getByRole('button',{name:'start',exact:true}).click();await page.waitForFunction(()=>!!sessionStorage.getItem('market-linked-pending:account-a'));
 await page.waitForTimeout(350);assert.equal(readCount,0,'do not poll an uncommitted create command');assert.equal(await page.getByRole('alert').textContent(),'','no false missing-batch error during submission');
 await page.getByRole('button',{name:'switch account'}).click();release();await page.waitForTimeout(200);
 assert.equal(await page.locator('output').textContent(),'none');assert.equal(new URL(page.url()).searchParams.get('linkedBatch'),null);
 assert.equal(await page.evaluate(()=>(window as unknown as {accepted?:number}).accepted??0),0,'late response must not call parent scope callback');
 await page.getByRole('button',{name:'start',exact:true}).click();await page.waitForFunction(()=>document.querySelector('output')?.textContent!=='none');assert.notEqual(keys[0],keys[1]);
 deny=true;await page.getByRole('alert').filter({hasText:'访问权限已失效'}).waitFor();assert.equal(await page.locator('output').textContent(),'none');const last=readCount;await page.waitForTimeout(3200);assert.equal(readCount,last);
});
