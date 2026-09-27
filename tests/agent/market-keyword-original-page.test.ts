import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordPageRun,keywordRunId,keywordUserId} from './helpers/market-keyword-page-fixture';
import {buildKeywordOriginalClassification} from '../../server/domain/market-research/keyword-original-classification';
import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

test('automatic report and draft follow completed collection, preserve edits and restore saved corrections',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/keyword-original-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);
 const current=keywordPageRun(),run=current.run;run.semanticStatus='skipped';run.status='running';
 let revision:ReturnType<typeof buildMarketKeywordRevision>|null=null,writes=0;
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 function recompute(){const facts=run.facts!,{factsId,...basis}=facts;void factsId;facts.factsId=`market-keyword-facts:${digest(basis)}`;run.automaticClassification=buildKeywordOriginalClassification(facts,'floor lamp');run.ruleReport=buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:run.automaticClassification}});}
 recompute();
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){
   assert.ok(url.pathname.endsWith('/keywords/revisions'));writes++;
   revision=buildMarketKeywordRevision({facts:run.facts!,request:req.postDataJSON(),authorId:keywordUserId,createdAt:'2026-09-27T00:00:00.000Z'});
   run.history=[{revisionId:revision.revision.revisionId,parentRevisionId:null,ordinal:1,createdAt:revision.revision.createdAt,factsId:revision.facts.factsId}];
   return route.fulfill({status:201,json:{revision:{ordinal:1,catalog:revision}}});
  }
  if(url.pathname.includes('/keywords/revisions/'))return route.fulfill({json:{revision:{ordinal:1,catalog:revision}}});
  if(url.pathname.endsWith('/keywords'))return route.fulfill({json:current});
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(origin+'/?keywordRun='+keywordRunId);await page.getByText('规则自动分类',{exact:true}).waitFor();
 await page.getByText('人工校对与分类编辑',{exact:true}).click();
 const assignment=page.getByLabel('floor lamp W1 产品',{exact:true});
 assert.equal(await assignment.locator('option:checked').textContent(),'floor lamp');
 // No edits: a completed facts projection must refresh the draft, not leave Save disabled.
 run.status='succeeded';run.facts!.members[0].reference.searchVolume=123;recompute();
 await page.getByRole('button',{name:'刷新关键词状态'}).click();
 await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='保存分类并重新计算');return b&&!b.disabled;});
 // Edited drafts are never replaced by subsequent source refreshes.
 await page.getByText('任务进度、重试与取消',{exact:true}).click();await page.getByLabel('修订备注').fill('保留人工校对');run.facts!.members[0].reference.searchVolume=234;recompute();
 await page.getByRole('button',{name:'刷新关键词状态'}).click();await page.getByText('词池或分析版本已更新，当前草稿已保留。').waitFor();
 assert.equal(await page.getByLabel('修订备注').inputValue(),'保留人工校对');assert.ok(await page.getByRole('button',{name:'保存分类并重新计算'}).isDisabled());
 await page.getByRole('button',{name:'按当前词池重新载入草稿'}).click();await page.getByText('编辑分类目录与需求簇',{exact:true}).click();
 await page.getByLabel('W1 标签 1 名称',{exact:true}).fill('人工校对灯具');await page.getByRole('button',{name:'保存分类并重新计算'}).click();
 await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();assert.equal(writes,1);
 await page.reload();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByText('编辑分类目录与需求簇',{exact:true}).click();
 assert.equal(await page.getByLabel('W1 标签 1 名称',{exact:true}).inputValue(),'人工校对灯具');assert.equal(writes,1);
 await mkdir('test-results/keyword-original-page',{recursive:true});await page.getByRole('heading',{name:'五维综合结论',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/keyword-original-page/desktop.png'});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'test-results/keyword-original-page/mobile.png'});assert.deepEqual(errors,[]);
});
