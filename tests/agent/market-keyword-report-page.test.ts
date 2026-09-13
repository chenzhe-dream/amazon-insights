import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordPageRun,keywordUserId} from './helpers/market-keyword-page-fixture';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

test('facts and saved manual report browse all 45 keywords without changing the 440 search-volume denominator',{timeout:60000},async t=>{
 const facts=keywordPageRun().run.facts!;
 facts.members=Array.from({length:45},(_,i)=>({...structuredClone(facts.members[0]),keywordId:`keyword:${i}`,keyword:`term-${String(i).padStart(2,'0')}`,reference:{...facts.members[0].reference,searchVolume:i===0?0:10}}));
 facts.pool.uniqueObservedMemberCount=45;facts.semantics.unavailableKeywordIds=facts.members.map(m=>m.keywordId);
 const {factsId:_old,...basis}=facts;void _old;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const request={factsId:facts.factsId,expectedParentRevisionId:null,labels:{W1:[],W2:[],W3:[],W4:[]},clusters:[{clusterId:'one',label:'阅读',definition:'阅读照明'},{clusterId:'two',label:'装饰',definition:'装饰照明'}],assignments:facts.members.map((m,i)=>({keywordId:m.keywordId,W1:[],W2:[],W3:[],W4:[],clusterId:i<21?'one':'two'})),note:'45词合成报告'};
 const catalog=buildMarketKeywordRevision({facts,request,authorId:keywordUserId,createdAt:'2026-09-13T00:00:00.000Z'}),before=digest(catalog);
 const server=await createServer({configFile:false,cacheDir:'test-results/keyword-report-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1400,height:1100}}),errors:string[]=[],unexpected:string[]=[];page.setDefaultTimeout(6000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){unexpected.push(req.url());return route.abort();}
  if(req.method()!=='GET'){unexpected.push(`${req.method()} ${url.pathname}`);return route.abort();}
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-report-harness.tsx"></script></body></html>`)});
  if(url.pathname==='/__keyword_report_fixture')return route.fulfill({json:catalog});if(url.pathname.startsWith('/api/')){unexpected.push(url.pathname);return route.abort();}return route.continue();
 });
 await page.goto(origin);
 const source=page.getByRole('region',{name:'关键词来源事实报告',exact:true}),manual=page.getByRole('region',{name:'关键词人工修订报告',exact:true});await source.waitFor();await manual.waitFor();
 const factsRows=source.getByRole('region',{name:'关键词参考月指标'}).locator('tbody > tr'),manualRows=manual.getByRole('region',{name:'人工关键词归属表'}).locator('tbody > tr');
 assert.equal(await factsRows.count(),20);assert.equal(await manualRows.count(),20);
 const denominator=manual.locator('.market-research-metrics > div').filter({has:page.getByText('词池分母（参考月总搜索量）',{exact:true})}).locator('dd');assert.equal(await denominator.innerText(),'440');
 const firstCluster=manual.getByRole('region',{name:'人工需求簇指标'}).locator('tbody > tr').first();assert.match(await firstCluster.innerText(),/45\.5%/);
 for(const index of [20,40]){await source.getByRole('button',{name:'关键词事实明细下一页',exact:true}).click();await source.getByRole('rowheader',{name:`term-${index}`,exact:true}).waitFor();await manual.getByRole('button',{name:'人工关键词归属下一页',exact:true}).click();await manual.getByRole('rowheader',{name:`term-${index}`,exact:true}).waitFor();assert.equal(await denominator.innerText(),'440');assert.match(await firstCluster.innerText(),/45\.5%/);}
 assert.equal(await factsRows.count(),5);assert.equal(await manualRows.count(),5);await source.getByRole('rowheader',{name:'term-44',exact:true}).waitFor();await manual.getByRole('rowheader',{name:'term-44',exact:true}).waitFor();
 assert.ok(await source.getByRole('button',{name:'关键词事实明细下一页',exact:true}).isDisabled());assert.ok(await manual.getByRole('button',{name:'人工关键词归属下一页',exact:true}).isDisabled());
 await source.getByRole('button',{name:'关键词事实明细上一页',exact:true}).click();await source.getByRole('rowheader',{name:'term-20',exact:true}).waitFor();
 await source.getByRole('button',{name:'关键词事实明细首页',exact:true}).click();await source.getByRole('rowheader',{name:'term-00',exact:true}).waitFor();assert.equal(await factsRows.count(),20);
 await manual.getByRole('button',{name:'人工关键词归属首页',exact:true}).click();await manual.getByRole('rowheader',{name:'term-00',exact:true}).waitFor();assert.equal(await denominator.innerText(),'440');
 const output='test-results/market-research-goal/T17';await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/keyword-report-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`${output}/keyword-report-mobile.png`,fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(digest(catalog),before);
});
