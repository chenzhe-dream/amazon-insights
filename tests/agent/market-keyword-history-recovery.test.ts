import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordPageRun,keywordRunId,keywordUserId} from './helpers/market-keyword-page-fixture';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';

for(const scenario of ['keyword draft waits for matching latest revision when facts and history arrive together','keyword refresh recovers a transient latest revision read failure']) test(scenario,{timeout:30000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/keyword-review-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(5000);
 const ready=keywordPageRun();
 const catalog=buildMarketKeywordRevision({facts:ready.run.facts!,authorId:keywordUserId,createdAt:'2026-09-13T00:00:01.000Z',request:{factsId:ready.run.facts!.factsId,expectedParentRevisionId:null,labels:ready.run.params.catalog.dimensionLabels,clusters:[],assignments:ready.run.facts!.members.map(m=>({keywordId:m.keywordId,W1:m.keywordId==='keyword:0'?['shelf']:[],W2:[],W3:[],W4:[],clusterId:null})),note:'saved authoritative classification'}});
 ready.run.history=[{revisionId:catalog.revision.revisionId,parentRevisionId:null,ordinal:1,createdAt:catalog.revision.createdAt,factsId:catalog.facts.factsId}];
 let current=scenario==='keyword draft waits for matching latest revision when facts and history arrive together'?keywordPageRun():ready,revisionFailure=scenario==='keyword refresh recovers a transient latest revision read failure',revisionReads=0;
 if(scenario==='keyword draft waits for matching latest revision when facts and history arrive together'){current.run.facts=null;current.run.history=[];}
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});if(!url.pathname.startsWith('/api/'))return route.continue();assert.equal(req.method(),'GET');
 if(url.pathname.includes('/keywords/revisions/')){revisionReads++;return route.fulfill(revisionFailure?{status:503,json:{error:'temporary revision failure'}}:{json:{revision:{ordinal:1,catalog}}});}
 return route.fulfill({json:current});});
 await page.goto(`${origin}/?keywordRun=${keywordRunId}`,{timeout:30000});await page.getByRole('button',{name:'人工校对与历史版本',exact:true}).click();await page.getByRole('button',{name:'任务管理',exact:true}).click();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByText('任务进度、重试与取消',{exact:true}).click();
 if(scenario==='keyword draft waits for matching latest revision when facts and history arrive together'){
  await page.getByText('当前词池尚未就绪，已保存的历史报告仍可查看。').waitFor();
  current=ready;await page.getByRole('button',{name:'刷新关键词状态'}).click();
  await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();
  const selected=await page.getByLabel('shelf lamp W1 产品').evaluate(el=>Array.from((el as HTMLSelectElement).selectedOptions).map(o=>o.value));
  console.log('RACE',JSON.stringify({selected,note:await page.getByLabel('修订备注').inputValue(),saveDisabled:await page.getByRole('button',{name:'保存分类并重新计算'}).isDisabled()}));
  assert.deepEqual(selected,['shelf'],'draft must restore latest saved classification');
 }else{
  await page.getByRole('alert').waitFor();revisionFailure=false;
  await page.getByRole('button',{name:'刷新关键词状态'}).click();
  await page.getByLabel('shelf lamp W1 产品').waitFor();
  console.log('RECOVERY',JSON.stringify({revisionReads,alerts:await page.getByRole('alert').allTextContents(),editors:await page.getByLabel('shelf lamp W1 产品').count()}));
  assert.equal(revisionReads,2,'refresh must recover latest revision GET');
 }
});
