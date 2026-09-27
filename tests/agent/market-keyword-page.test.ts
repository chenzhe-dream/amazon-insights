import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordPageRun,keywordDiscoveryPageRun,keywordRunId,keywordUserId} from './helpers/market-keyword-page-fixture';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

test('keyword page preserves human drafts, saves whole pool and restores immutable versions without writes',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/keyword-page-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1400,height:1100}});page.setDefaultTimeout(6000);
 let current=keywordDiscoveryPageRun(),readFailure=false;const errors:string[]=[],writes:unknown[]=[],saved=new Map<string,ReturnType<typeof buildMarketKeywordRevision>>();
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:20px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){
   assert.ok(url.pathname.endsWith('/keywords/revisions'));const body=req.postDataJSON();writes.push(body);assert.equal(body.assignments.length,2);assert.equal(body.factsId,current.run.facts!.factsId);
   const catalog=buildMarketKeywordRevision({facts:current.run.facts!,request:body,authorId:keywordUserId,createdAt:`2026-09-13T00:00:0${writes.length}.000Z`});saved.set(catalog.revision.revisionId,catalog);
   const ordinal=writes.length;current.run.history!.push({revisionId:catalog.revision.revisionId,parentRevisionId:catalog.revision.parentRevisionId,ordinal,createdAt:catalog.revision.createdAt,factsId:catalog.facts.factsId});return route.fulfill({status:201,json:{revision:{ordinal,catalog}}});
  }
  if(url.pathname.includes('/keywords/revisions/')){const id=decodeURIComponent(url.pathname.split('/').at(-1)!);return route.fulfill({json:{revision:{ordinal:current.run.history!.find(h=>h.revisionId===id)!.ordinal,catalog:saved.get(id)}}});}
  if(url.pathname.endsWith('/keywords'))return route.fulfill(readFailure?{status:503,json:{error:'暂不可用'}}:{json:current});return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?keywordRun=${keywordRunId}`);await page.getByText('来源范围、覆盖与原始模型证据',{exact:true}).click();
 await page.getByRole('heading',{name:'W1 产品 · 层架灯（此批标签提案）',exact:true}).waitFor();
 await page.getByRole('heading',{name:'W1 产品 · 落地灯（此批标签提案）',exact:true}).waitFor();
 await mkdir('test-results/keyword-page',{recursive:true});await page.screenshot({path:'test-results/keyword-page/discovery-desktop.png',fullPage:true});
 await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByText('任务进度、重试与取消',{exact:true}).click();
 const assignment=page.getByLabel('shelf lamp W1 产品');await assignment.waitFor();assert.deepEqual(await assignment.evaluate(el=>Array.from((el as HTMLSelectElement).selectedOptions).map(o=>o.value)),[]);
 await assignment.selectOption('shelf');await page.getByLabel('修订备注').fill('我的校对');
 await page.getByRole('button',{name:'刷新关键词状态'}).click();assert.equal(await page.getByLabel('修订备注').inputValue(),'我的校对');assert.equal(writes.length,0);
 await page.getByRole('button',{name:'保存分类并重新计算'}).click();await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();assert.equal(writes.length,1);
 const first=current.run.history![0].revisionId;
 await page.reload();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByText('任务进度、重试与取消',{exact:true}).click();await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();assert.equal(writes.length,1);assert.equal(await page.getByLabel('修订备注').inputValue(),'我的校对');
 readFailure=true;await page.getByRole('button',{name:'刷新关键词状态'}).click();await page.getByRole('alert').waitFor();assert.ok(await page.getByRole('button',{name:'保存分类并重新计算'}).isDisabled());await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();
 readFailure=false;const {factsId:_old,...basis}=current.run.facts!;basis.members[0].reference.searchVolume=10;current.run.facts={...basis,factsId:`market-keyword-facts:${digest(basis)}`};
 await page.getByRole('button',{name:'刷新关键词状态'}).click();await page.getByText('词池或分析版本已更新，当前草稿已保留。').waitFor();assert.equal(await page.getByLabel('修订备注').inputValue(),'我的校对');assert.ok(await page.getByRole('button',{name:'保存分类并重新计算'}).isDisabled());
 await page.getByRole('button',{name:'按当前词池重新载入草稿'}).click();await page.getByRole('button',{name:'保存分类并重新计算'}).click();assert.equal(writes.length,2);assert.equal(await page.getByLabel('类目节点或路径',{exact:true}).inputValue(),'1:2:3');
 await page.getByLabel('关键词报告版本').selectOption(first);await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();
 await mkdir('test-results/market-keyword-page',{recursive:true});await page.screenshot({path:'test-results/market-keyword-page/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(el).position!=='absolute').slice(0,12).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})))));await page.screenshot({path:'test-results/market-keyword-page/mobile.png',fullPage:true});
 assert.equal(writes.length,2);assert.equal(await page.getByLabel('类目节点或路径',{exact:true}).inputValue(),'1:2:3');assert.deepEqual(errors,[]);
});

test('keyword start polls real stages, retries only selected failure and ignores late previous-run reads',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/keyword-start-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(6000);
 const stepId='72000000-0000-4000-8000-000000000005',attemptId='72000000-0000-4000-8000-000000000006',otherId='72000000-0000-4000-8000-000000000007';
 let current=keywordPageRun(),studyId='',reads=0,holdNext=false,release:(()=>void)|undefined,started:(()=>void)|undefined;const writes:string[]=[],errors:string[]=[];
 const other=keywordPageRun();other.run.id=otherId;const {factsId:_id,...otherBasis}=other.run.facts!;otherBasis.moduleRunId=otherId;otherBasis.members[0].keyword='new lamp';other.run.facts={...otherBasis,factsId:`market-keyword-facts:${digest(otherBasis)}`};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){
   writes.push(url.pathname);
   if(url.pathname.endsWith('/studies')){studyId=req.headers()['idempotency-key'];return route.fulfill({status:201,json:{study:{id:studyId,scope:{organizationId:keywordUserId,researchId:studyId,...req.postDataJSON(),nodeIdPath:'1:2:3'},createdAt:'2026-09-13T00:00:00.000Z'}}});}
   if(url.pathname.endsWith('/keywords')){assert.equal(url.pathname.includes(studyId),true);assert.equal(req.postDataJSON().catalog.categoryContext,'层架灯');assert.equal(req.postDataJSON().catalog.discoveryMode,'labels-and-clusters/v1');assert.equal(req.postDataJSON().analysisMode,'global-reconciliation/v2');assert.equal(req.postDataJSON().supplementalSources,'sif-aba/v1');assert.equal(req.postDataJSON().catalog.outputProtocol,'explicit-shape/v1');current.run.scope.researchId=studyId;current.run.params=req.postDataJSON();current.run.status='queued';current.run.facts=null;return route.fulfill({status:201,json:current});}
   if(url.pathname.endsWith('/retry')){assert.deepEqual(req.postDataJSON(),{steps:[{stepId,failedAttemptId:attemptId}]});current.run.status='running';current.run.steps[0].status='running';current.run.steps[0].canRetry=false;return route.fulfill({json:{moduleRunId:keywordRunId,stepIds:[stepId]}});}
   assert.fail('Unexpected write');
  }
  if(url.pathname.includes(otherId))return route.fulfill({json:other});
  if(url.pathname.endsWith('/keywords')){reads++;const value=structuredClone(current);if(holdNext){holdNext=false;started?.();await new Promise<void>(resolve=>{release=resolve;});}return route.fulfill({json:value});}
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(origin);await page.getByLabel('类目节点或路径',{exact:true}).fill('3');await page.getByText('类目范围与采集设置',{exact:true}).click();await page.getByLabel('种子词（每行一个）').fill('shelf lamp');await page.getByRole('button',{name:'采集关键词并分析'}).click();assert.equal(writes.length,0,'category description is required before starting a paid collection');assert.equal(await page.getByLabel('类目说明',{exact:true}).evaluate(el=>(el as HTMLTextAreaElement).validity.valueMissing),true);await page.getByLabel('类目说明',{exact:true}).fill('层架灯');await page.getByRole('button',{name:'☆ 收藏',exact:true}).click();await page.getByLabel('产品核心名',{exact:true}).fill('other lamp');await page.locator('.st-product-keyword-favs').getByRole('button',{name:'美国站 · shelf lamp'}).click();assert.equal(await page.getByLabel('产品核心名',{exact:true}).inputValue(),'shelf lamp');assert.equal(writes.length,0,'restoring a favorite only restores input');await page.getByRole('button',{name:'采集关键词并分析'}).click();await page.getByRole('region',{name:'关键词任务状态'}).locator('.market-theme-spinner').waitFor();assert.equal(writes.length,2);assert.equal(await page.getByLabel('类目节点或路径',{exact:true}).inputValue(),'1:2:3');
 current.run.status='failed';current.run.steps=[{id:stepId,kind:'collect-keyword-page',status:'failed',latestAttemptId:attemptId,attemptCount:1,current:true,canRetry:true,asin:null,errorCode:'timeout'}];
 await page.getByText('查看采集与分析步骤',{exact:true}).click();await page.getByRole('button',{name:'重试此步骤'}).waitFor({timeout:10000});assert.ok(reads>=2,'queued state must poll automatically');await page.getByRole('button',{name:'重试此步骤'}).click();await page.getByRole('region',{name:'关键词任务状态'}).getByRole('heading',{name:'处理中',exact:true}).waitFor();assert.equal(writes.length,3);
 holdNext=true;const began=new Promise<void>(resolve=>{started=resolve;});await page.getByRole('button',{name:'刷新关键词状态'}).click();await began;
 await page.getByText('恢复已保存的关键词任务',{exact:true}).click();await page.getByLabel('恢复关键词任务').fill(otherId);await page.getByRole('button',{name:'读取关键词任务'}).click();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByLabel('new lamp W1 产品').waitFor();release?.();if(!await page.getByRole('button',{name:'刷新关键词状态'}).isVisible())await page.getByText('任务进度、重试与取消',{exact:true}).click();await page.getByRole('button',{name:'刷新关键词状态'}).click();await page.getByLabel('new lamp W1 产品').waitFor();assert.equal(await page.getByLabel('shelf lamp W1 产品').count(),0);assert.equal(writes.length,3);assert.deepEqual(errors,[]);
});
