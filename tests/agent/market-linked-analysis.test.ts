import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {MarketLinkedRequestSchema, linkedModuleParams} from '../../shared/market-linked-contracts';
import {MarketLinkedService} from '../../server/services/market-linked-service';
import {findLinkedModuleHistory} from '../../server/services/market-linked-history';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketResearchService} from '../../server/services/market-research-service';
import {PostgresMarketResearchStore} from '../../server/db/postgres/market-research-store';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import type {MarketOverviewReport} from '../../shared/market-research-contracts';

test('simultaneous standalone and linked cold queries share one module start',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool),store=new PostgresMarketResearchStore(f.context);
 const research=new MarketResearchService({repository:store,findUser:async()=>({organizationId:f.actor.organizationId,status:'active'})});
 const modules=new MarketModuleService({context:f.context,modelIdentity:()=>null});
 const linked=new MarketLinkedService({context:f.context,research,modules});
 const request={scope:{marketplace:'US',nodeQuery:'12:34',month:'2026-08',headTopN:10,newProductMonths:6},fromMonth:'2026-07'},key=randomUUID();
 await linked.create(f.actor,request,key);
 const claim=await store.claim({ownerId:'cold-race',now:new Date().toISOString(),leaseUntil:new Date(Date.now()+120000).toISOString()});assert.ok(claim);
 const report:MarketOverviewReport={schemaVersion:'market-overview/v1',scope:claim.job.scope,nodeId:'34',nodeIdPath:'12:34',categoryName:'Floor Lamps',currency:'USD',collectedAt:new Date().toISOString(),metrics:{sampleProducts:100,brands:null,sellers:null,totalUnits:null,totalRevenue:null,avgPrice:null,avgUnits:null,avgRatings:null,avgRating:null,productConcentrationRaw:null,brandConcentrationRaw:null,sellerConcentrationRaw:null,newCount:null,newAvgPrice:null,newAvgUnits:null},evidence:[],issues:[],boundaries:[]};
 await store.finish({claim,now:new Date().toISOString(),report,error:null});
 let entered=()=>{};const entering=new Promise<void>(resolve=>entered=resolve);
 const start=modules.startKeywords.bind(modules);let starts=0;
 modules.startKeywords=async(...args)=>{starts++;entered();await new Promise(resolve=>setTimeout(resolve,150));return start(...args);};
 const standalone=modules.queryKeywords(f.actor,{scope:{marketplace:'US',nodeIdPath:'34',currency:'USD',fromMonth:'2026-07',toMonth:'2026-08'},params:linkedModuleParams('keywords','Floor Lamps',6,10)},randomUUID());
 await entering;const [saved]=await Promise.all([standalone,linked.tick()]);
 const batch=(await linked.find(f.actor,key)).batch;
 assert.equal(batch.modules.keywords.runId,saved.run.id);assert.equal(starts,1);
});

test('linked research requires a complete shared calendar range and never treats a category number as a keyword',()=>{
 const scope={marketplace:'US',nodeQuery:'12:34',month:'2026-08',headTopN:10,newProductMonths:6};
 assert.equal(MarketLinkedRequestSchema.safeParse({scope,fromMonth:'2026-07'}).success,true);
 assert.equal(MarketLinkedRequestSchema.safeParse({scope:{...scope,month:'last30'},fromMonth:'2026-07'}).success,false);
 assert.equal(MarketLinkedRequestSchema.safeParse({scope,fromMonth:'2026-09'}).success,false);
 assert.throws(()=>linkedModuleParams('keywords','12:34',6));
 const params=linkedModuleParams('keywords','Floor Lamps',6) as {plannedPages:{seed:string}[]};
 assert.equal(params.plannedPages[0].seed,'Floor Lamps');assert.equal(params.plannedPages.length,5);
});

test('durable linked batch survives recreation, deduplicates concurrent commands and isolates failures and actors',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool),store=new PostgresMarketResearchStore(f.context);
 const research=new MarketResearchService({repository:store,findUser:async id=>id===f.actor.userId?{organizationId:f.actor.organizationId,status:'active'}:null});
 let resolves=0;const modules=new MarketModuleService({context:f.context,modelIdentity:()=>null,resolveNodePath:async()=>{resolves++;throw Error('no network resolution inside transaction');}});
 const make=()=>new MarketLinkedService({context:f.context,research,modules});let service=make();
 const request={scope:{marketplace:'US',nodeQuery:'34',month:'2026-08',headTopN:10,newProductMonths:6},fromMonth:'2026-07'},key=randomUUID();
 const [a,b]=await Promise.all([service.create(f.actor,request,key),service.create(f.actor,request,key)]);
 await assert.rejects(service.create(f.actor,{...request,fromMonth:'2020-01'},randomUUID()),/最近24个完整月份/);
 assert.equal((await research.list(f.actor)).length,1,'unsupported ranges are rejected before any collection job');
 assert.equal(a.batch.basicJobId,b.batch.basicJobId);
 await assert.rejects(service.create(f.actor,{...request,fromMonth:'2026-06'},key));
 await assert.rejects(service.find({...f.actor,organizationId:randomUUID()},key));
 await assert.rejects(service.retry({...f.actor,userId:randomUUID()},key,{modules:['keywords']}));
 await service.tick();assert.equal((await service.find(f.actor,key)).batch.modules.overview.status,'pending');
 const claim=await store.claim({ownerId:'linked-test',now:new Date().toISOString(),leaseUntil:new Date(Date.now()+120000).toISOString()});assert.ok(claim);
 const report:MarketOverviewReport={schemaVersion:'market-overview/v1',scope:claim.job.scope,nodeId:'34',nodeIdPath:'12:34',categoryName:'Floor Lamps',currency:'USD',collectedAt:new Date().toISOString(),
 metrics:{sampleProducts:100,brands:null,sellers:null,totalUnits:null,totalRevenue:null,avgPrice:null,avgUnits:null,avgRatings:null,avgRating:null,productConcentrationRaw:null,brandConcentrationRaw:null,sellerConcentrationRaw:null,newCount:null,newAvgPrice:null,newAvgUnits:null},evidence:[],issues:[],boundaries:[]};
 await store.finish({claim,now:new Date().toISOString(),report,error:null});
 const start=modules.startKeywords.bind(modules);modules.startKeywords=async()=>{throw Error('synthetic failure');};
 service=make();await Promise.all([service.tick(),make().tick()]);
 const partial=(await service.find(f.actor,key)).batch;
 assert.equal(partial.modules.keywords.status,'failed');assert.ok(partial.modules.themes.runId);assert.ok(partial.modules.shapes.runId);assert.ok(partial.modules.overview.runId);
 assert.equal(partial.modules.keywords.message?.includes('synthetic'),false);
 const count=async()=>Number((await pg.pool.query('SELECT count(*) AS n FROM market_analysis_module_runs')).rows[0].n);
 const n=await count();await service.find(f.actor,key);await service.tick();await service.create(f.actor,request,key);assert.equal(await count(),n);
 modules.startKeywords=start;await service.retry(f.actor,key,{modules:['keywords']});await service.tick();
 const done=(await service.find(f.actor,key)).batch;assert.equal(done.status,'started');assert.equal(await count(),n+1);
 assert.equal(done.modules.overview.runId,partial.modules.overview.runId);
 const keyword=await modules.findKeywords(f.actor,done.modules.keywords.runId!);assert.equal(keyword.run.params.plannedPages[0].seed,'Floor Lamps');
 assert.equal(keyword.run.scope.fromMonth,'2026-07');assert.equal(keyword.run.scope.toMonth,'2026-08');
 assert.equal(keyword.run.scope.nodeIdPath,'12:34');assert.equal(done.resolvedNodeIdPath,'12:34');
 const reused=await service.create(f.actor,request,randomUUID());
 assert.equal(reused.batch.status,'started','history lookup completes before the scheduler');
 assert.equal(reused.batch.basicJobId,done.basicJobId,'reuse the saved basic report');
 for(const module of ['overview','shapes','keywords','themes'] as const)assert.equal(reused.batch.modules[module].runId,done.modules[module].runId,'same work is not queued again');
 assert.equal(await count(),n+1);
 assert.equal((await research.list(f.actor)).length,1);
 for(const changed of [{...request,fromMonth:'2026-06'},{...request,scope:{...request.scope,marketplace:'DE'}},{...request,scope:{...request.scope,nodeQuery:'99:35'}},{...request,scope:{...request.scope,headTopN:20}}]){
  const parsed=MarketLinkedRequestSchema.parse(changed);
  assert.equal(await findLinkedModuleHistory(f.context,modules,f.actor,parsed,'overview',parsed.scope.nodeQuery==='99:35'?'99:35':'12:34','Floor Lamps'),null,'different site/date/node/analysis parameters cannot reuse a report');
 }
 const single=randomUUID();const forced=await service.create(f.actor,{...request,forceRefresh:true},single);
 assert.equal((await pg.pool.query('SELECT count(*)::int AS n FROM sorftime_source_refresh_scopes WHERE job_id=$1',[forced.batch.basicJobId])).rows[0].n,1);
 const singleClaim=await store.claim({ownerId:'linked-test',now:new Date().toISOString(),leaseUntil:new Date(Date.now()+120000).toISOString()});assert.ok(singleClaim);
 await store.finish({claim:singleClaim,now:new Date().toISOString(),report:{...report,scope:singleClaim.job.scope,nodeIdPath:'34'},error:null});await service.tick();
 assert.equal((await service.find(f.actor,single)).batch.status,'started');assert.equal(resolves,0,'verified single-segment node must not cause a provider call inside dispatcher transaction');
 const forcedRun=(await service.find(f.actor,single)).batch.modules.overview.runId!;
 const readOverview=modules.findOverview.bind(modules);
 modules.findOverview=async(actor,id)=>{if(id===forcedRun)throw new TypeError('Overview report frozen evidence differs');return readOverview(actor,id);};
 assert.equal((await findLinkedModuleHistory(f.context,modules,f.actor,MarketLinkedRequestSchema.parse(request),'overview','12:34','Floor Lamps'))?.id,done.modules.overview.runId);
 modules.findOverview=async()=>{throw new TypeError('Unexpected programming error');};
 await assert.rejects(findLinkedModuleHistory(f.context,modules,f.actor,MarketLinkedRequestSchema.parse(request),'overview','12:34','Floor Lamps'),/Unexpected programming error/);
 modules.findOverview=readOverview;
 // A corrupt recent basic receipt cannot hide an older valid report.
 const readBasic=research.find.bind(research);
 research.find=async(actor,id)=>{if(id===forced.batch.basicJobId)throw new z.ZodError([{code:'custom',path:['report'],message:'Synthetic incompatible historical receipt'}]);return readBasic(actor,id);};
 const recovered=await service.create(f.actor,request,randomUUID());assert.equal(recovered.batch.basicJobId,done.basicJobId);assert.equal(recovered.batch.status,'started');
 research.find=readBasic;
 for(const retryable of [false,true]){
  const failedKey=randomUUID();await service.create(f.actor,{...request,forceRefresh:true},failedKey);
  for(let attempt=1;attempt<=(retryable?3:1);attempt++){
   const failedClaim=await store.claim({ownerId:'linked-test',now:new Date().toISOString(),leaseUntil:new Date(Date.now()+120000).toISOString()});assert.ok(failedClaim);
   await store.finish({claim:failedClaim,now:new Date().toISOString(),report:null,error:{dataset:'research',code:'timeout',message:'Synthetic source unavailable',retryable}});await service.tick();
   const failed=(await service.find(f.actor,failedKey)).batch;assert.equal(failed.status,'failed');assert.equal(failed.basicRetryable,retryable&&attempt<3);
   assert.equal(Object.values(failed.modules).every(module=>module.runId===null),true);
   if(failed.basicRetryable){await Promise.all([service.retry(f.actor,failedKey,{basic:true}),service.retry(f.actor,failedKey,{basic:true})]);assert.equal((await research.find(f.actor,failed.basicJobId)).attempts,attempt);}
   else await assert.rejects(service.retry(f.actor,failedKey,{basic:true}),/无法继续重试/);
  }
 }
});
