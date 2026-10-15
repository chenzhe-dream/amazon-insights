import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {buildDevelopmentConclusion} from '../../server/domain/market-research/development-conclusion';
test('conclusions auto-read, explicitly freeze and retain old content after read failure',{timeout:90000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/development-conclusion-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const page=await browser.newPage(),origin=server.resolvedUrls!.local[0].replace(/\/$/,''),basis={kind:'linked',batchId:'10000000-0000-4000-8000-000000000001'};page.setDefaultTimeout(12000);
 const scope={marketplace:'US',nodeIdPath:'13280971',fromMonth:'2026-08',toMonth:'2026-08'};
 const conclusion=buildDevelopmentConclusion('linked',scope,[{module:'keywords',runId:basis.batchId,identity:'frozen-keywords',scope,status:'partial',facts:['有效关键词 89/100'],findings:['折叠结构需要验证'],gaps:['11词缺少有效趋势'],refs:['keyword-source']}]);
 // Exercise the new view as well as immutable reads and failure retention.
 conclusion.decision!.candidates.push({id:'folding',label:'折叠',dimension:'feature',status:'hold',reason:'相反属性需要核对',keywords:['foldable'],asins:['B000000001'],price:'USD 35',evidence:[{module:'themes',ref:'original-review-A',description:'同商品折叠体验'}],counterevidence:['锁扣失效片段'],missing:['完整成本未知'],next:'复核锁扣样品'});
 conclusion.decision!.conflicts.push({kind:'basis',message:'链接占比与销量占比不能直接比较',refs:['overview','shape']});
 const contentHash='a'.repeat(64),savedAt='2026-10-15T08:00:00.000Z';let writes=0,reads=0,saved=false,fail=false;const outside:string[]=[];
 await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());if(url.origin!==origin){outside.push(url.href);return route.abort();}
  if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/','<div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MarketDevelopmentConclusion} from "/app/market-development-conclusion.tsx";createRoot(document.getElementById("root")).render(React.createElement(MarketDevelopmentConclusion,{basis:'+JSON.stringify(basis)+'}));</script>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  assert.equal(url.pathname,'/api/agent/v1/market-analysis/conclusions');
  if(r.method()==='POST'){writes++;assert.deepEqual(r.postDataJSON(),{basis,expectedHash:contentHash});saved=true;}else {reads++;if(fail)return route.fulfill({status:503,json:{error:{message:'保存报告暂时不可读'}}});}
  return route.fulfill({json:{basis,contentHash,conclusion,savedAt:saved?savedAt:null,history:saved?[{contentHash,savedAt}]:[]}});
 });
 await page.goto(origin);await page.getByText('有效关键词 89/100',{exact:true}).waitFor();assert.equal(writes,0);
 await page.getByRole('heading',{name:'折叠 · 先核实反证或风险',exact:true}).waitFor();
 assert.ok(await page.getByText('锁扣失效片段',{exact:true}).isVisible());
 await page.getByText('关联依据（1）',{exact:true}).click();assert.ok(await page.getByText('来源：original-review-A',{exact:true}).isVisible());
 assert.ok(await page.getByRole('heading',{name:'口径差异与数据冲突',exact:true}).isVisible());
 await page.getByRole('button',{name:'保存当前结论',exact:true}).click();await page.getByText('冻结历史版本',{exact:true}).waitFor();assert.equal(writes,1);
 assert.equal(await page.getByRole('button',{name:'保存当前结论',exact:true}).isDisabled(),true);
 await page.getByLabel('结论版本',{exact:true}).selectOption('');await page.getByText('当前保存数据的规则分析',{exact:true}).waitFor();
 fail=true;await page.getByRole('button',{name:'重读已有报告结论',exact:true}).click();await page.getByRole('alert').filter({hasText:'保留上次读取的结论'}).waitFor();
 assert.ok(await page.getByText('有效关键词 89/100',{exact:true}).isVisible());assert.equal(writes,1);assert.equal(outside.length,0);assert.ok(reads>=3);
});
