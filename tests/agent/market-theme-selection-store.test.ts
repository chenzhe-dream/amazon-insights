import {MarketDevelopmentConclusionService} from '../../server/services/market-development-conclusion-service';
import {categoryProductsFixture} from './helpers/category-products-fixture';
import { buildAgentApp } from '../../server/app';
import { createAgentServiceClient } from '../../app/lib/agent-service-client';
import { proxyAgentRequest } from '../../app/api/agent/[...path]/route';
import type { AuthenticationService } from '../../server/auth/authentication-service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { MarketModuleService } from '../../server/services/market-module-service';
import { MarketModuleStepWorker } from '../../server/runtime/market-module-step-worker';
import { createMarketSourceStepHandlers } from '../../server/runtime/market-source-step-handlers';
import { createMarketSourceProjectionStep } from '../../server/runtime/market-source-projection-step';
import { createMarketThemeRulesStep } from '../../server/runtime/market-theme-rules-step';
import { createMarketThemeReportStep } from '../../server/runtime/market-theme-report-step';
import { MarketThemeSelectionStore } from '../../server/db/postgres/market-theme-selection-store';
import { loadThemeSelectionFacts, restoreThemeSelectionFacts } from '../../server/services/market-theme-selection-facts';
import { deriveThemeSelection } from '../../server/domain/market-research/customer-theme-selection';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { RemoteMcpConnector } from '../../server/connectors/connector-contract';
import { marketThemeFlowInitialSteps } from '../../server/domain/market-research/customer-theme-flow';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { MARKET_THEME_MAPPING_RULE_VERSION } from '../../server/domain/market-research/customer-theme-mapping-rules';

test('immutable selection revisions isolate actors, replay commands and never create paid work',{timeout:90000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>({configurationVersion:'fixture/v1',promptVersion:'fixture/v1'})});
 const started=await service.startThemes(f.actor,f.scope.researchId,{memberCount:2,poolSize:2},randomUUID());let calls=0;
 const connector=(id:'sellerSprite'|'sorftime'):RemoteMcpConnector=>({id,probe:async()=>{throw new Error('unused');},execute:async r=>{calls++;return {data:r.operation==='category_products'?categoryProductsFixture({data:{top100_products:[1,2].map(n=>({asin:`B00000000${n}`,title:`Lamp ${n}`,category_rank:`Category: Floor Lamps, Rank: ${n+10}`,main_image:`https://m.media-amazon.com/images/I/lamp-${n}.jpg`}))}},r.input.node_id):r.operation==='market_product_concentration'?{code:'OK',data:[1,2].map(n=>({asin:`B00000000${n}`,title:`Lamp ${n}`,ranking:n+10}))}:{data:{customer_say:'Frozen overall summary',details:[{keyword:'Assembly',content:'Simple assembly',mention:10,positive:8,negative:6,update_time:'2026-08-01'}]}},source:{connectorId:id,operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};}});
 const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:connector('sellerSprite'),sorftime:connector('sorftime')}}),'prepare-members':createMarketSourceProjectionStep(f.context),'prepare-model-batches':async()=>({kind:'settlement',value:{outcome:{status:'failed',error:{code:'internal',retryable:false}}}}),rules:createMarketThemeRulesStep(f.context),report:createMarketThemeReportStep(f.context)}});t.after(()=>worker.stop());
 for(let i=0;i<20;i++)if(!await worker.tick())break;
 const saved=await service.findRun(f.actor,started.run.id),base=saved.run.currentReport!;assert.ok(base,JSON.stringify(saved));const before=JSON.stringify(saved),sourceCalls=calls;
 assert.equal(base.report.reportVersion,'market-theme-report/v3');
 assert.equal(base.report.semanticStatus,'skipped');
 const ruleView=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:started.run.id}))!;
 assert.equal(ruleView.run.versions.planner,'market-theme-flow/rules-v3');
 assert.equal(ruleView.run.versions.model,null);
 assert.ok(ruleView.steps.every(s=>!['prepare-model-batches','model-batch'].includes(s.kind)));
 const store=new MarketThemeSelectionStore(f.context),identity={actor:f.actor,moduleRunId:started.run.id,attemptId:base.attemptId};
 const initial=await store.read(identity);assert.ok(initial);assert.equal(initial.samples[0].title.value,'Lamp 1');assert.equal(initial.samples[0].sourceRank.value,11);assert.equal(initial.samples[0].customerSay.value,'Frozen overall summary',JSON.stringify({samples:initial.samples,baseline:initial.baseline,steps:(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:started.run.id}))?.attempts}));
 assert.equal(initial.samples[0].imageUrl.value,'https://m.media-amazon.com/images/I/lamp-1.jpg');
 assert.equal(initial.baseline.groups.length,1);assert.equal(initial.baseline.groups[0].memberCount,2);assert.equal(initial.baseline.groups[0].labelOrigin,'local-rule');
 assert.deepEqual(initial.baseline.sentimentGroupCounts,{positive:1,negative:0});
 const counts=async()=> (await pg.pool.query('SELECT (SELECT count(*) FROM market_analysis_steps) steps,(SELECT count(*) FROM market_agent_runs) models,(SELECT count(*) FROM market_analysis_inputs) inputs')).rows[0];const countBefore=await counts();
 const command={...identity,idempotencyKey:randomUUID(),request:{baseReportHash:base.report.reportHash,expectedParentRevisionId:null,excludedAsins:['B000000002']}};
 const first=await store.save(command);assert.equal(first.created,true);assert.equal(first.view.revision!.result.totals!.mention,10);
 assert.equal((await store.save(command)).created,false);await assert.rejects(store.save({...command,request:{...command.request,excludedAsins:[]}}));
 const parent=first.view.revision!.revisionId;
 await t.test('review development conclusions freeze baseline and manual evidence without paid work',async()=>{
  const conclusions=new MarketDevelopmentConclusionService(f.context,service),basis={kind:'reviews' as const,runId:started.run.id,attemptId:base.attemptId,revisionId:null};
  const initial=await conclusions.read(f.actor,basis);
  assert.match(initial.response.conclusion.evidence[0].facts[0],/所选 2 个商品/);
  assert.equal((await pg.pool.query('SELECT count(*) FROM market_development_conclusions')).rows[0].count,'0');
  await assert.rejects(conclusions.save(f.actor,basis,'0'.repeat(64)));
  const saved=await conclusions.save(f.actor,basis,initial.response.contentHash);assert.ok(saved.savedAt);
  assert.equal((await conclusions.save(f.actor,basis,initial.response.contentHash)).contentHash,saved.contentHash);
  assert.equal((await pg.pool.query('SELECT count(*) FROM market_development_conclusions')).rows[0].count,'1');
  const manual=await conclusions.read(f.actor,{...basis,revisionId:parent});
  assert.match(manual.response.conclusion.evidence[0].facts[0],/所选 1 个商品/);assert.notEqual(manual.response.contentHash,saved.contentHash);
  const spy=t.mock.method(MarketThemeSelectionStore.prototype,'read',async()=>{throw new Error('historical conclusion must not rederive selection');});
  try {const historical=await conclusions.read(f.actor,basis,saved.contentHash);assert.deepEqual(historical.response.conclusion,saved.conclusion);assert.equal(spy.mock.callCount(),0);}finally{spy.mock.restore();}
  await assert.rejects(conclusions.read({...f.actor,organizationId:randomUUID()},basis,saved.contentHash));
  await assert.rejects(pg.pool.query('UPDATE market_development_conclusions SET conclusion_json=conclusion_json'));
  await assert.rejects(pg.pool.query('DELETE FROM market_development_conclusions'));
  assert.equal(calls,sourceCalls);assert.deepEqual(await counts(),countBefore);
 });
 const racing=await Promise.allSettled([[],['B000000001','B000000002']].map(excludedAsins=>store.save({...command,idempotencyKey:randomUUID(),request:{...command.request,expectedParentRevisionId:parent,excludedAsins}})));assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);
 const latest=(await store.read(identity))!;const restored=await store.save({...command,idempotencyKey:randomUUID(),request:{...command.request,expectedParentRevisionId:latest.latestRevisionId,excludedAsins:[]}});assert.equal(restored.view.revision!.result.totals!.mention,20);
 assert.equal((await store.read({...identity,revisionId:parent}))!.revision!.result.totals!.mention,10);
 await assert.rejects(store.save({...command,idempotencyKey:randomUUID(),request:{...command.request,expectedParentRevisionId:restored.view.latestRevisionId,excludedAsins:['B000000003']}}));
 assert.equal(await store.read({...identity,actor:{...f.actor,organizationId:randomUUID()}}),null);
 await assert.rejects(pg.pool.query('UPDATE market_theme_selection_revisions SET ordinal=ordinal WHERE run_id=$1',[started.run.id]));
 assert.equal(JSON.stringify(await service.findRun(f.actor,started.run.id)),before);assert.deepEqual(await counts(),countBefore);assert.equal(calls,sourceCalls);
 await t.test('real secured app and same-origin proxy expose revisions with actor and schema checks',async()=>{
  const token='B'.repeat(43),origin='http://theme-selection.test',proxyToken='synthetic-theme-selection-token';
  let principal:{kind:'user';organizationId:string;userId:string;role:'member';email:string;sessionId:string}|null={kind:'user',...f.actor,role:'member',email:'fixture@example.test',sessionId:randomUUID()};
  const app=buildAgentApp({repository:{marketExecutionContext:f.context} as NonNullable<NonNullable<Parameters<typeof buildAgentApp>[0]>['repository']>,marketModuleService:service,userPresenceAccess:null,
   env:{AGENT_SERVICE_PROXY_TOKEN:proxyToken,AGENT_SERVICE_TRUSTED_ORIGINS:origin},authConfig:{mode:'authenticated',cookie:{name:'agent_session',secure:false,maxAgeSeconds:3600},sessionTtlMs:3600000,loginLimiter:{windowMs:60000,maxFailures:5,maxEntries:100}},authService:{authenticate:async(value:string|null)=>value===token?principal:null} as AuthenticationService});
  t.after(()=>app.close());const address=await app.listen({host:'127.0.0.1',port:0}),client=createAgentServiceClient({env:{AGENT_SERVICE_INTERNAL_URL:address,AGENT_SERVICE_PROXY_TOKEN:proxyToken}});
  const path=`/v1/market-analysis/runs/${identity.moduleRunId}/reports/${identity.attemptId}/theme-selection`;
  async function proxy(method:string,suffix='',payload?:unknown,key=randomUUID(),cookie=true){return proxyAgentRequest(new Request(`${origin}/api/agent${path}${suffix}`,{method,headers:{'content-type':'application/json','idempotency-key':key,...(cookie?{cookie:`agent_session=${token}`}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),{params:Promise.resolve({path:`${path}${suffix}`.slice(1).split('/')})},client);}
  const read=await proxy('GET');assert.equal(read.status,200,await read.clone().text());const body=await read.json();assert.equal(body.latestRevisionId,restored.view.latestRevisionId);
  assert.equal((await proxy('GET',`/${parent}`)).status,200);assert.equal((await proxy('GET','',undefined,randomUUID(),false)).status,401);
  const key=randomUUID(),payload={baseReportHash:base.report.reportHash,expectedParentRevisionId:body.latestRevisionId,excludedAsins:['B000000001','B000000002']};
  const created=await proxy('POST','',payload,key);assert.equal(created.status,201,await created.clone().text());const excluded=await created.json();assert.equal(excluded.revision.result.totals,null);assert.equal(excluded.revision.result.status,'no-data');
  assert.equal((await proxy('POST','',payload,key)).status,200);assert.equal((await proxy('POST','',{...payload,excludedAsins:[]},key)).status,409);
  assert.equal((await proxy('POST','',{...payload,authorId:randomUUID()})).status,400);
  const basis={kind:'reviews',runId:started.run.id,attemptId:base.attemptId,revisionId:null};
  const conclusionPath='/v1/market-analysis/conclusions';
  async function conclusionProxy(method:string,body?:unknown,cookie=true){const query=method==='GET'?'?'+new URLSearchParams({basis:JSON.stringify(basis)}):'';return proxyAgentRequest(new Request(`${origin}/api/agent${conclusionPath}${query}`,{method,headers:{'content-type':'application/json',...(cookie?{cookie:`agent_session=${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})}),{params:Promise.resolve({path:conclusionPath.slice(1).split('/')})},client);}
  const cp=await conclusionProxy('GET');assert.equal(cp.status,200,await cp.clone().text());const cv=await cp.json();assert.equal(cv.conclusion.kind,'reviews');
  assert.equal((await conclusionProxy('POST',{basis,expectedHash:cv.contentHash})).status,200);
  assert.equal((await conclusionProxy('POST',{basis,expectedHash:'0'.repeat(64)})).status,409);
  assert.equal((await conclusionProxy('GET',undefined,false)).status,401);
  principal={...principal!,organizationId:randomUUID()};assert.equal((await proxy('GET')).status,404);
  assert.equal(calls,sourceCalls);assert.deepEqual(await counts(),countBefore);assert.equal(JSON.stringify(await service.findRun(f.actor,started.run.id)),before);
 });
 await t.test('previous rules-only selection revisions remain readable with their frozen v1 status',async()=>{
  // Build an actual old rules-v2 report: a v1 selection revision cannot belong to a new rules-v3 report.
  const catalog={task:'market-customer-theme-mapping' as const,mappingVersion:'theme-groups/unreviewed-v1',groupCatalog:[]};
  const requestRun={actor:f.actor,scope:f.scope,moduleKind:'customer-themes' as const,params:{flow:'market-theme-flow/rules-v2',memberCount:2,poolSize:2,newProductMonths:6,catalog},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_THEME_MAPPING_RULE_VERSION,mapping:catalog.mappingVersion,planner:'market-theme-flow/rules-v2',model:null,prompt:null,configuration:null},collectionRevision:'initial/v1',idempotencyKey:randomUUID()};
  const legacy=await f.stores.steps.createModuleRun({...requestRun,initialSteps:marketThemeFlowInitialSteps(requestRun)});
  for(let i=0;i<20;i++)if(!await worker.tick())break;
  const base=(await service.findRun(f.actor,legacy.run.id)).run.currentReport!;assert.ok(base);assert.equal(base.report.versions.planner,'market-theme-flow/rules-v2');
  const identity={actor:f.actor,moduleRunId:legacy.run.id,attemptId:base.attemptId};
  const previous=await store.read(identity);assert.ok(previous);
  assert.equal(previous.baseline.groups.length,2);assert.deepEqual(previous.baseline.sentimentGroupCounts,{positive:2,negative:2});
  const facts=await loadThemeSelectionFacts(f.context,identity);assert.ok(facts);
  const restored=restoreThemeSelectionFacts(facts).restored;
  const request={baseReportHash:base.report.reportHash,expectedParentRevisionId:previous.latestRevisionId,excludedAsins:['B000000002'],note:''};
  const result=deriveThemeSelection(restored,request.excludedAsins,false,false,false);
  assert.equal(result.status,'partial');
  const createdAt=new Date().toISOString(),body={parentRevisionId:previous.latestRevisionId,ordinal:previous.history.length+1,authorId:f.actor.userId,createdAt,
   baseReportAttemptId:base.attemptId,baseReportHash:request.baseReportHash,note:'',result,resultHash:digest(result)};
  const revisionId=`market-theme-selection-revision:${digest({version:'market-theme-selection-revision/v1',factsHash:digest(facts),...body})}`;
  await pg.pool.query(`INSERT INTO market_theme_selection_revisions(organization_id,study_id,run_id,base_attempt_id,revision_id,parent_revision_id,ordinal,stored_by,stored_at,idempotency_key,request_json,request_hash,facts_json,facts_hash,revision_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15::jsonb)`,
   [f.actor.organizationId,f.scope.researchId,identity.moduleRunId,identity.attemptId,revisionId,body.parentRevisionId,body.ordinal,f.actor.userId,createdAt,randomUUID(),JSON.stringify(request),
    digest({actor:f.actor,moduleRunId:identity.moduleRunId,attemptId:identity.attemptId,request}),JSON.stringify(facts),digest(facts),JSON.stringify({...body,revisionId})]);
  const reread=await store.read(identity);
  assert.equal(reread?.baseline.status,'complete');
  assert.equal(reread?.revision?.result.status,'partial');
  const next=await store.save({...identity,idempotencyKey:randomUUID(),request:{...request,expectedParentRevisionId:revisionId,excludedAsins:[]}});
  assert.equal(next.view.revision?.result.status,'complete');
  assert.equal((await store.read({...identity,revisionId}))?.revision?.result.status,'partial');
 });
});
