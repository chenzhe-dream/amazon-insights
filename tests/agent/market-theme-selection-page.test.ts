import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { themeEntry,themeDetails } from './helpers/market-theme-page-fixture';
import { deriveThemeSelection,projectThemeSample } from '../../server/domain/market-research/customer-theme-selection';
import { aggregateCustomerThemes } from '../../server/domain/market-research/customer-themes';
import { MarketThemeSelectionResponseSchema,type MarketThemeSelectionResponse } from '../../shared/market-theme-selection-contracts';
function base(old=false):MarketThemeSelectionResponse{
 const entry=themeEntry(old),ids=entry.report.selectedAsins;
 const aggregation=aggregateCustomerThemes({selectedAsins:ids,results:ids.map((asin,i)=>({asin,status:'success',source:{sourceRecordId:`s${i}`,fetchedAt:entry.report.dataCutoffAt,sourceUpdatedAt:null},themes:[{sourceThemeId:`t${i}`,keyword:old?'Historical label':'Saved label',content:'Saved summary',mention:i?30:10,positive:10,negative:10}]})),mappings:[]});
 const result=deriveThemeSelection({aggregation,labels:[],decisions:ids.map((_,i)=>({sourceThemeId:`t${i}`,status:'unknown',groupId:null,reason:'unconfirmed',batchId:null}))},[],false);
 const samples=ids.map((asin,i)=>projectThemeSample({asin,sourceIndex:i,product:{asin,title:`Lamp ${i+1}`,sourceRank:i+1},productSource:{ref:`market-source:${'a'.repeat(64)}`,snapshotId:`market-input:${'b'.repeat(64)}`,payload:{data:ids.map((asin,j)=>({asin,title:`Lamp ${j+1}`,ranking:j+1}))}}}));
 return MarketThemeSelectionResponseSchema.parse({version:'market-theme-selection-view/v1',base:entry,samples,baseline:result,latestRevisionId:null,revision:null,history:[]});
}
test('sample UI persists exclusions, restores all, reads history and ignores a late prior-report mutation',{timeout:120000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/theme-selection-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const page=await browser.newPage(),origin=server.resolvedUrls!.local[0].replace(/\/$/,'');page.setDefaultTimeout(10000);
 const current=base(),old=base(true),history=new Map<string,MarketThemeSelectionResponse>(),writes:unknown[]=[],outside:string[]=[],errors:string[]=[];let view=current,delay=false,release:()=>void=()=>{};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());if(url.origin!==origin){outside.push(url.href);return route.abort();}
  if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml(url.pathname,'<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-theme-selection-browser-harness.tsx"></script></body></html>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname.includes('/theme-selection')){
   if(r.method()==='POST'){const req=r.postDataJSON();writes.push(req);assert.equal(req.expectedParentRevisionId,view.latestRevisionId);const ordinal=writes.length;
    const retained=current.baseline.selectedAsins.filter(a=>!req.excludedAsins.includes(a));const totals=retained.length?{mention:retained.length===2?40:retained[0].endsWith('1')?10:30,positive:retained.length*10,negative:retained.length*10,themeCount:retained.length}:null;
    const result={...current.baseline,selectedAsins:retained,excludedAsins:req.excludedAsins,totals,asins:current.baseline.asins.filter(a=>retained.includes(a.asin)),groups:[],evidence:[],status:retained.length?'partial':'no-data'};
    const revision={revisionId:`market-theme-selection-revision:${String(ordinal).repeat(64)}`,parentRevisionId:view.latestRevisionId,ordinal,authorId:'60000000-0000-4000-8000-000000000009',createdAt:'2026-09-16T00:00:00.000Z',baseReportAttemptId:current.base.attemptId,baseReportHash:current.base.report.reportHash,note:'',result,resultHash:'a'.repeat(64)};
    const {revisionId,ordinal:order,createdAt,resultHash}=revision;const header={revisionId,ordinal:order,createdAt,resultHash};view=MarketThemeSelectionResponseSchema.parse({...view,revision,latestRevisionId:revision.revisionId,history:[...view.history,header]});history.set(revision.revisionId,view);const response=view;
    if(delay)await new Promise<void>(resolve=>{release=resolve;});return route.fulfill({json:response}).catch(()=>{});
   }
   if(url.pathname.includes(old.base.attemptId))return route.fulfill({json:old});
   const id=decodeURIComponent(url.pathname.split('/').at(-1)!);return route.fulfill({json:history.has(id)?{...history.get(id),history:view.history,latestRevisionId:view.latestRevisionId}:view});
  }
  if(url.pathname.endsWith('/details'))return route.fulfill({json:themeDetails(url)});return route.fulfill({status:404,json:{}});
 });
 await page.goto(origin);await page.getByText('Lamp 1',{exact:true}).waitFor();assert.equal(writes.length,0);let acceptRemoval=false;const confirmations:string[]=[];page.on('dialog',async dialog=>{confirmations.push(dialog.message());if(acceptRemoval)await dialog.accept();else await dialog.dismiss();});await page.getByRole('button',{name:'移除',exact:true}).first().click();assert.equal(writes.length,0);assert.match(confirmations[0],/B0THEME001/);acceptRemoval=true;await page.getByRole('button',{name:'移除',exact:true}).first().click();await page.getByText('样本 ASIN（1）',{exact:true}).waitFor();
 await page.getByRole('button',{name:'移除',exact:true}).click();await page.getByText('样本 ASIN（0）',{exact:true}).waitFor();
 await page.getByRole('button',{name:'恢复全部移出链接（2）',exact:true}).click();await page.getByText('样本 ASIN（2）',{exact:true}).waitFor();assert.equal(writes.length,3);
 await page.getByLabel('样本版本',{exact:true}).selectOption(`market-theme-selection-revision:${'1'.repeat(64)}`);await page.getByText('样本 ASIN（1）',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'移除',exact:true}).isDisabled(),true);assert.equal(writes.length,3);
 await page.getByLabel('样本版本',{exact:true}).selectOption(`market-theme-selection-revision:${'3'.repeat(64)}`);await page.getByText('样本 ASIN（2）',{exact:true}).waitFor();
 delay=true;await page.getByRole('button',{name:'移除',exact:true}).first().click();await page.waitForFunction(()=>document.body.textContent?.includes('正在保存或读取样本版本'));
 await page.getByRole('button',{name:'切换报告',exact:true}).click();await page.getByText('Historical label',{exact:true}).first().waitFor();release?.();await page.getByText('样本 ASIN（2）',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('样本版本',{exact:true}).inputValue(),'base');assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
 old.baseline.groups=[];old.baseline.evidence=[];old.baseline.previewOmittedGroupCount=2;
 await page.getByRole('button',{name:'重读已存见解',exact:true}).click();await page.getByRole('button',{name:'负面/分歧见解',exact:true}).click();
 await page.getByText('当前标签有 2 个主题，本次受预览预算限制未展示；完整事实和统计仍保留。',{exact:true}).waitFor();
 assert.equal(await page.getByText('暂无显著负面/分歧主题',{exact:true}).count(),0);
});

test('saved topN omissions remain explicit in sentiment tabs and never claim missing themes',{timeout:120000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/theme-selection-topn-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const page=await browser.newPage(),origin=server.resolvedUrls!.local[0].replace(/\/$/,'');page.setDefaultTimeout(5000);
 const view=base(),ids=view.base.report.selectedAsins,errors:string[]=[],writes:string[]=[],outside:string[]=[];
 const results=ids.map((asin,i)=>({asin,status:'success' as const,source:{sourceRecordId:`s${i}`,fetchedAt:view.base.report.dataCutoffAt,sourceUpdatedAt:null},themes:[{sourceThemeId:`t${i}`,keyword:i?'Breakage':'Easy assembly',content:'Saved summary',mention:i?40:100,positive:i?0:100,negative:i?40:0}]}));
 const decisions=ids.map((_,i)=>({sourceThemeId:`t${i}`,status:'unknown' as const,groupId:null,reason:'unconfirmed',batchId:null}));
 const selection=(topN?:number)=>deriveThemeSelection({aggregation:aggregateCustomerThemes({selectedAsins:ids,results,mappings:[],topN}),labels:[],decisions},[],false);
 view.baseline=selection(1);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin){outside.push(url.href);return route.abort();}
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml(url.pathname,'<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-theme-selection-browser-harness.tsx"></script></body></html>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()!=='GET')writes.push(url.pathname);
  if(url.pathname.includes('/theme-selection'))return route.fulfill({json:view});
  if(url.pathname.endsWith('/details'))return route.fulfill({json:themeDetails(url)});
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(origin);await page.getByText('Easy assembly',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'负面/分歧见解',exact:true}).click();
 await page.getByText('当前标签有 1 个主题，本次受报告展示上限限制未展示；完整事实和统计仍保留。',{exact:true}).waitFor();
 assert.equal(await page.getByText('暂无显著负面/分歧主题',{exact:true}).count(),0);
 view.baseline=selection(0);await page.getByRole('button',{name:'重读已存见解',exact:true}).click();
 await page.getByText('Lamp 1',{exact:true}).waitFor();await page.getByRole('button',{name:'正面见解',exact:true}).click();
 await page.getByText('当前标签有 1 个主题，本次受报告展示上限限制未展示；完整事实和统计仍保留。',{exact:true}).waitFor();
 assert.equal(await page.getByText('暂无显著正面主题',{exact:true}).count(),0);
 view.baseline=selection();await page.getByRole('button',{name:'重读已存见解',exact:true}).click();
 await page.getByText('Easy assembly',{exact:true}).first().waitFor();await page.getByRole('button',{name:'负面/分歧见解',exact:true}).click();await page.getByText('Breakage',{exact:true}).first().waitFor();
 assert.deepEqual(writes,[]);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
});
