import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import type {MarketLinkedBatch} from '../../shared/market-linked-contracts';

test('one overview submission synchronizes modules; late results preserve edited modules; reload and navigation are read-only',{timeout:90000},async t=>{
 const server=await createServer({configFile:false,define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(12000);
 let batch:MarketLinkedBatch|null=null;let writes=0,reads=0;
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/','<div id="root"></div><script type="module">import "/app/globals.css";import "/app/market-research.css";import React from "react";import {createRoot} from "react-dom/client";import {MarketResearchSection} from "/app/market-research-section.tsx";createRoot(document.getElementById("root")).render(React.createElement(MarketResearchSection,{sessionIdentity:"linked-test"}));</script>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){
   writes++;assert.ok(url.pathname.endsWith('/linked'));const request=req.postDataJSON();
   batch={id:req.headers()['idempotency-key'],request,basicJobId:randomUUID(),basicRetryable:false,status:'pending',message:'正在获取类目基础数据',categoryName:null,resolvedNodeIdPath:null,modules:{overview:{status:'pending',runId:null,message:null},shapes:{status:'pending',runId:null,message:null},keywords:{status:'pending',runId:null,message:null},themes:{status:'pending',runId:null,message:null}}};return route.fulfill({json:{batch}});
  }
  if(url.pathname.includes('/linked/')){reads++;return batch?route.fulfill({json:{batch}}):route.fulfill({status:404,json:{error:{message:'pending submission'}}});}
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
  return route.fulfill({status:404,json:{error:{message:'no report fixture'}}});
 });
 await page.goto(`${origin}/?themeView=overview&marketNode=1063294&marketMonth=2026-08&marketFrom=2026-06&marketSite=US`);
 await page.getByRole('button',{name:'筛选市场',exact:true}).click();await page.getByRole('region',{name:'四模块联动分析'}).waitFor();assert.equal(writes,1);
 const nav=page.getByRole('navigation',{name:'市场调研模块'});
 await nav.getByRole('button',{name:'商品形态及价格带'}).click();
 assert.equal(await page.getByLabel('类目节点',{exact:true}).inputValue(),'1063294');
 assert.equal(await page.getByLabel('起始月',{exact:true}).inputValue(),'2026-06');
 await page.getByLabel('类目节点',{exact:true}).fill('999999');
 const editedNode=await page.getByLabel('类目节点',{exact:true}).elementHandle();
 assert.ok(batch);const ready=batch as MarketLinkedBatch;ready.status='started';ready.categoryName='Floor Lamps';ready.resolvedNodeIdPath='228013:1063294';ready.message='四个分析任务已启动';
 for(const module of ['overview','shapes','keywords','themes'] as const)ready.modules[module]={status:'started',runId:randomUUID(),message:null};
 await page.getByText('四个分析任务已启动',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('类目节点',{exact:true}).inputValue(),'999999','late result does not overwrite independently edited category');
 assert.equal(await editedNode!.evaluate(node=>node.isConnected),true,'completion in other modules must not remount this editor');
 assert.equal(new URL(page.url()).searchParams.get('shapeRun'),null);assert.equal(new URL(page.url()).searchParams.get('keywordRun'),ready.modules.keywords.runId);
 assert.equal(new URL(page.url()).searchParams.get('marketKeywordNode'),'228013:1063294');
 await page.reload();await page.getByRole('region',{name:'四模块联动分析'}).waitFor();assert.equal(await page.getByLabel('类目节点',{exact:true}).inputValue(),'999999');assert.equal(writes,1);
 await nav.getByRole('button',{name:'类目买家评论见解'}).click();assert.equal(await page.getByLabel('类目路径').inputValue(),'228013:1063294');
 assert.equal(new URL(page.url()).searchParams.get('themeRun'),ready.modules.themes.runId);assert.equal(writes,1);assert.ok(reads>=2);
 const card=page.getByRole('region',{name:'四模块联动分析'});await mkdir('test-results/market-linked',{recursive:true});
 await page.setViewportSize({width:1440,height:1000});await card.screenshot({path:'test-results/market-linked/linked-desktop.png'});
 await page.setViewportSize({width:390,height:844});assert.ok(await card.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await card.screenshot({path:'test-results/market-linked/linked-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});
 // An already-open module can contain an annotation or unsaved keyword draft even when its scope did not change.
 await card.getByRole('listitem').filter({hasText:'商品形态及价格带'}).getByRole('button',{name:'查看',exact:true}).click();
 const oldRun=new URL(page.url()).searchParams.get('shapeRun');assert.equal(oldRun,ready.modules.shapes.runId);
 await nav.getByRole('button',{name:'市场总览'}).click();await page.getByRole('button',{name:'筛选市场',exact:true}).click();
 await page.getByText('正在获取类目基础数据',{exact:true}).waitFor();await nav.getByRole('button',{name:'商品形态及价格带'}).click();
 const activeEditor=await page.getByLabel('类目节点',{exact:true}).elementHandle();const second=batch as unknown as MarketLinkedBatch;second.status='started';second.categoryName='Floor Lamps';second.resolvedNodeIdPath='228013:1063294';second.message='第二批已启动';
 for(const module of ['overview','shapes','keywords','themes'] as const)second.modules[module]={status:'started',runId:randomUUID(),message:null};
 await page.getByText('第二批已启动',{exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('shapeRun'),oldRun,'same-scope active report must not be replaced');assert.equal(await activeEditor!.evaluate(node=>node.isConnected),true);assert.equal(writes,2);
});
