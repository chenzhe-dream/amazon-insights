import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { keywordPageRun,keywordRunId,keywordUserId } from './helpers/market-keyword-page-fixture';
import { buildMarketKeywordRevision } from '../../server/domain/market-research/keyword-revision';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';

test('keyword navigation preserves dirty work on failed/cancelled switches, blocks during saves and ignores superseded reads',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/keyword-draft-navigation-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const page=await browser.newPage(),origin=server.resolvedUrls!.local[0].replace(/\/$/,'');page.setDefaultTimeout(7000);
 const a=keywordPageRun(),b=keywordPageRun();b.run.id='72000000-0000-4000-8000-000000000099';
 const {factsId:oldFactsId,...basis}=b.run.facts!;void oldFactsId;basis.moduleRunId=b.run.id;basis.members[0].keyword='other lamp';b.run.facts={...basis,factsId:`market-keyword-facts:${digest(basis)}`};
 const writes:Array<{key:string;body:unknown}>=[],dialogs:string[]=[],external:string[]=[],errors:string[]=[];
 let failTarget=true,holdTarget=false,holdSave=false,failSave=true,accept=false,releaseTarget=()=>{},releaseSave=()=>{};
 let targetStarted=()=>{};let saved:ReturnType<typeof buildMarketKeywordRevision>|null=null;
 page.on('dialog',d=>{dialogs.push(d.message());void(accept?d.accept():d.dismiss());});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){external.push(url.href);return route.abort();}
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/','<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>')});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){assert.ok(url.pathname.endsWith('/keywords/revisions'),'cancelled new analysis must not send POST');writes.push({key:req.headers()['idempotency-key'],body:req.postDataJSON()});
   if(failSave){failSave=false;return route.fulfill({status:503,json:{error:'synthetic save failure'}});}
   if(holdSave)await new Promise<void>(resolve=>{releaseSave=resolve;});
   saved=buildMarketKeywordRevision({facts:a.run.facts!,request:req.postDataJSON(),authorId:keywordUserId,createdAt:'2026-09-17T00:00:00.000Z'});a.run.history=[{revisionId:saved.revision.revisionId,parentRevisionId:null,ordinal:1,createdAt:saved.revision.createdAt,factsId:saved.facts.factsId}];return route.fulfill({json:{revision:{ordinal:1,catalog:saved}}});}
  if(url.pathname.includes('/keywords/revisions/'))return route.fulfill({json:{revision:{ordinal:1,catalog:saved}}});
  if(url.pathname.endsWith('/keywords')){if(url.pathname.includes(b.run.id)){if(holdTarget){targetStarted();await new Promise<void>(resolve=>{releaseTarget=resolve;});}return route.fulfill(failTarget?{status:503,json:{error:'synthetic target read failure'}}:{json:b}).catch(()=>{});}return route.fulfill({json:a});}
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?keywordRun=${keywordRunId}`);await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByLabel('修订备注').fill('unsaved work');await page.getByLabel('shelf lamp W1 产品').selectOption('shelf');
 await page.getByText('恢复已保存的关键词任务',{exact:true}).click();const restore=page.getByRole('button',{name:'读取关键词任务',exact:true});await page.getByLabel('恢复关键词任务').fill(b.run.id);await restore.click();await page.getByText('synthetic target read failure',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('修订备注').inputValue(),'unsaved work');assert.equal(new URL(page.url()).searchParams.get('keywordRun'),a.run.id);assert.equal(dialogs.length,0);
 failTarget=false;const switchDialog=page.waitForEvent('dialog');await restore.click();await switchDialog;assert.equal(await page.getByLabel('修订备注').inputValue(),'unsaved work');assert.equal(dialogs.length,1);assert.equal(new URL(page.url()).searchParams.get('keywordRun'),a.run.id);
 await page.getByLabel('产品核心名',{exact:true}).fill('new lamp');await page.getByLabel('类目说明',{exact:true}).fill('lamps');const startDialog=page.waitForEvent('dialog');await page.getByRole('button',{name:'查询关键词'}).click();await startDialog;assert.equal(writes.length,0);assert.equal(dialogs.length,2);
 await page.getByRole('button',{name:'保存分类并重新计算',exact:true}).click();await page.getByText('synthetic save failure',{exact:true}).waitFor();assert.equal(await page.getByLabel('修订备注').inputValue(),'unsaved work');
 holdTarget=true;const pendingBeforeSave=new Promise<void>(resolve=>{targetStarted=resolve;});await restore.click();await pendingBeforeSave;
 holdSave=true;await page.getByRole('button',{name:'保存分类并重新计算',exact:true}).click();await page.getByRole('button',{name:'正在保存…',exact:true}).waitFor();assert.equal(await restore.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'查询关键词'}).isDisabled(),true);
 const targetResponse=page.waitForResponse(r=>r.url().includes(b.run.id)&&r.url().endsWith('/keywords'));releaseTarget();holdTarget=false;await targetResponse;assert.equal(new URL(page.url()).searchParams.get('keywordRun'),a.run.id);assert.equal(dialogs.length,2);
 releaseSave();await page.getByRole('region',{name:'关键词人工修订报告'}).waitFor();assert.equal(writes.length,2);assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);
 // A successful save is the clean baseline: switching away now does not confirm.
 await restore.click();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByLabel('other lamp W1 产品').waitFor();assert.equal(dialogs.length,2);
 await page.getByLabel('恢复关键词任务').fill(a.run.id);await restore.click();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByLabel('修订备注').fill('dirty again');
 // An older target response must not overtake a subsequent request to stay on A.
 holdTarget=true;const began=new Promise<void>(resolve=>{targetStarted=resolve;});await page.getByLabel('恢复关键词任务').fill(b.run.id);await restore.click();await began;
 await page.getByLabel('恢复关键词任务').fill(a.run.id);await restore.click();releaseTarget();holdTarget=false;
 await page.getByLabel('shelf lamp W1 产品').waitFor();assert.equal(await page.getByLabel('修订备注').inputValue(),'dirty again');assert.equal(new URL(page.url()).searchParams.get('keywordRun'),a.run.id);assert.equal(dialogs.length,2);
 accept=true;await page.getByLabel('恢复关键词任务').fill(b.run.id);await restore.click();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByLabel('other lamp W1 产品').waitFor();assert.equal(new URL(page.url()).searchParams.get('keywordRun'),b.run.id);assert.equal(dialogs.length,3);
 assert.equal(writes.length,2);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
});
