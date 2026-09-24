import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { themeDetails,themeEntry,themeRun,themeRunId,themeScope } from './helpers/market-theme-page-fixture';
import { aggregateCustomerThemes } from '../../server/domain/market-research/customer-themes';
import { deriveThemeSelection,projectThemeSample } from '../../server/domain/market-research/customer-theme-selection';
import { MarketThemeSelectionResponseSchema } from '../../shared/market-theme-selection-contracts';

// Purely synthetic reference comparison. No provider/model traffic or production inputs.
test('compare supplied Customers Say frontend with governed candidate at identical viewports',{timeout:120000},async t=>{
 const root=process.cwd(),reference=(process.env.MARKET_UI_REFERENCE_ROOT??'C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference').replaceAll('\\','/');
 if(!existsSync(reference+'/app/market-category-review-insight-section.tsx')){t.skip('Set MARKET_UI_REFERENCE_ROOT to the supplied frontend');return;}
 const out=path.resolve('test-results/market-ui-parity-20260914/theme-comparison');await mkdir(out,{recursive:true});
 const fsUrl=(file:string)=>`/@fs/${file.replaceAll('\\','/')}`;
 await writeFile(path.join(out,'reference-entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketCategoryReviewInsightSection} from '${fsUrl(reference+'/app/market-category-review-insight-section.tsx')}';import '${fsUrl(reference+'/app/globals.css')}';import '${fsUrl(reference+'/app/warm-theme.css')}';import '${fsUrl(reference+'/app/comparison-layout.css')}';createRoot(document.getElementById('root')).render(<div style={{display:'grid',gap:20,minWidth:0}}><MarketCategoryReviewInsightSection/></div>);`);
 await writeFile(path.join(out,'candidate-entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketThemeSection} from '${fsUrl(path.join(root,'app/market-theme-section.tsx'))}';import '${fsUrl(path.join(root,'app/globals.css'))}';import '${fsUrl(path.join(root,'app/market-research.css'))}';createRoot(document.getElementById('root')).render(<div className="market-ui-reference"><MarketThemeSection maxMonth="2026-08"/></div>);`);
 const server=await createServer({configFile:false,cacheDir:'test-results/theme-comparison-vite',define:{'process.env':'{}'},plugins:[react()],resolve:{alias:{tailwindcss:path.join(root,'node_modules/tailwindcss/index.css'),react:path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','zod']},server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false,fs:{allow:[root,reference,path.resolve(root,'node_modules')]}}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
 const makeAsin=(asin:string,ready:boolean)=>({asin,title:ready?'合成商品标题 A':'合成商品标题 B',rank:ready?1:2,customerSay:ready?'合成商品总览摘要':null,status:ready?'ready':'error',statusMessage:ready?undefined:'synthetic timeout',details:ready?[{keyword:'新版装配主题',content:'合成原文预览',mention:2,positive:1,negative:0},{keyword:'第二组亮度',content:'合成原文预览',mention:2,positive:1,negative:0}]:[]});
 const topics=['新版装配主题','第二组亮度'].map(keyword=>({keyword,label:keyword,mention:2,sharePct:50,positive:1,negative:0,sentiment:'positive',snippets:['合成原文预览'],asinCount:1,topAsins:[{asin:'B0THEME001',mention:2}]}));
 const originalReport={marketplace:'US',nodeId:themeScope.nodeIdPath,categoryName:themeScope.nodeIdPath,topN:20,fetchedAt:themeEntry().report.dataCutoffAt,source:'synthetic/v1',note:'合成对照数据：选中 2 个 ASIN，1 个取得主题，1 个采集失败；主题提及总数 4。',asins:[makeAsin('B0THEME001',true),makeAsin('B0THEME002',false)],totalMentions:4,topics,positiveTopics:topics,negativeTopics:[]};
 const base=themeEntry(),ids=base.report.selectedAsins;
 const aggregation=aggregateCustomerThemes({selectedAsins:ids,mappings:[],results:[
  {asin:ids[0],status:'success',source:{sourceRecordId:'synthetic-record-1',fetchedAt:base.report.dataCutoffAt,sourceUpdatedAt:null},themes:topics.map((topic,index)=>({sourceThemeId:`synthetic-theme-${index+1}`,keyword:topic.keyword,content:'合成原文预览',mention:2,positive:1,negative:0}))},
  {asin:ids[1],status:'failed',source:null,reason:'synthetic timeout'},
 ]});
 const baseline=deriveThemeSelection({aggregation,labels:[],decisions:topics.map((_,index)=>({sourceThemeId:`synthetic-theme-${index+1}`,status:'unknown' as const,groupId:null,reason:'unconfirmed',batchId:null}))},[],false);
 const samples=ids.map((asin,index)=>projectThemeSample({asin,sourceIndex:index,product:{asin,title:index?'合成商品标题 B':'合成商品标题 A',sourceRank:index+1},productSource:{ref:`market-source:${'a'.repeat(64)}`,snapshotId:`market-input:${'b'.repeat(64)}`,payload:{data:ids.map((id,i)=>({asin:id,title:i?'合成商品标题 B':'合成商品标题 A',ranking:i+1}))}}}));
 const selection=MarketThemeSelectionResponseSchema.parse({version:'market-theme-selection-view/v1',base,samples,baseline,latestRevisionId:null,revision:null,history:[]});
 const errors:string[]=[],external:string[]=[],requests:Array<{side:string;method:string;path:string}>=[];const metrics:Record<string,unknown>={};
 for(const side of ['reference','candidate']){
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(`${side}: ${e.message}`));
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){external.push(req.url());return route.abort();}
   if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml(url.pathname,`<!doctype html><html><body style="margin:24px"><div id="root"></div><script type="module" src="${fsUrl(path.join(out,side+'-entry.jsx'))}"></script></body></html>`)});
   if(!url.pathname.startsWith('/api/'))return route.continue();requests.push({side,method:req.method(),path:url.pathname});
   if(side==='reference'&&url.pathname==='/api/sorftime-category-customers-say')return route.fulfill({json:{report:originalReport,fromCache:false}});
   if(side==='candidate'&&url.pathname.endsWith(`/runs/${themeRunId}`))return route.fulfill({json:themeRun()});
   if(side==='candidate'&&url.pathname.includes('/theme-selection'))return route.fulfill({json:selection});
   if(side==='candidate'&&url.pathname.endsWith('/details')){const value=themeDetails(url);if(value.page.section==='asins'){value.page.items.unshift({kind:'asin',asin:'B0THEME001',status:'success',reason:null,sourceRecordId:'synthetic-record-1',fetchedAt:themeEntry().report.dataCutoffAt,totals:{mention:4,positive:2,negative:0,themeCount:2},memberCount:2});value.page.totalItems=2;}return route.fulfill({json:value});}
   return route.fulfill({status:404,json:{error:'Synthetic route unavailable'}});
  });
  await page.goto(`${origin}/${side}.html${side==='candidate'?`?themeRun=${themeRunId}`:''}`,{timeout:45000});
  if(side==='reference'){await page.getByLabel('亚马逊类目').fill(themeScope.nodeIdPath);await page.getByRole('button',{name:'拉取见解',exact:true}).click();}else await page.getByLabel('类目路径').fill(themeScope.nodeIdPath);
  await page.locator('.category-cs-table').getByText('新版装配主题',{exact:true}).waitFor();await page.locator('.category-cs-table').getByText('合成原文预览',{exact:false}).first().waitFor();await page.locator('.category-cs-asin-table').getByRole('link',{name:'B0THEME001'}).waitFor();
  if(side==='candidate'){await page.getByText('合成商品标题 A',{exact:true}).waitFor();assert.equal(await page.getByText('Synthetic route unavailable',{exact:false}).count(),0);}
  assert.match(await page.locator('.category-cs-table').innerText(),/50.0%/);assert.equal(await page.locator('.ss-market-query-row').first().evaluate(e=>getComputedStyle(e).display),'grid');await page.mouse.move(0,0);
  metrics[side+'-desktop']=await page.evaluate(()=>[...document.querySelectorAll('.ss-market-query,.launch-block')].map(e=>({class:e.className,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width})));
  if(side==='candidate')assert.ok((await page.locator('.ss-market-query').boundingBox())!.height<=230,'Theme query should stay compact above the saved report');
  assert.equal(await page.evaluate(()=>{const blocks=[...document.querySelectorAll('.launch-block')];return Math.round(blocks[1].getBoundingClientRect().top-blocks[0].getBoundingClientRect().bottom);}),20);await page.screenshot({path:path.join(out,side+'-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});metrics[side+'-mobile']={overflow:await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)};assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(side==='candidate')assert.ok((await page.locator('.category-cs-table tbody td:last-child').first().boundingBox())!.width>=200,'Saved summary must remain readable inside a horizontally scrollable table');
  await page.screenshot({path:path.join(out,side+'-mobile.png'),fullPage:true});
  await page.close();
 }
 await writeFile(path.join(out,'comparison-metrics.json'),JSON.stringify({synthetic:true,viewports:[{width:1280,height:900},{width:390,height:844}],metrics,requests,errors,external},null,2));assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
