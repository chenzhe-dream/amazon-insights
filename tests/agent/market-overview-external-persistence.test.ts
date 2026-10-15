import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketOverviewCatalogStep} from '../../server/runtime/market-overview-catalog-step';
import {createMarketOverviewReportStep} from '../../server/runtime/market-overview-report-step';
import {marketOverviewFlowInitialSteps,MARKET_OVERVIEW_EXTERNAL_RULES_FLOW_VERSION as flow} from '../../server/domain/market-research/overview-flow';
import {MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION as rule} from '../../server/domain/market-research/overview-complete-catalog';
import {MARKET_SOURCE_HANDLER_VERSION as source} from '../../shared/market-source-contracts';
import {MarketOverviewReportService} from '../../server/services/market-overview-report-service';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

for(const rolling of [false,true])test(`external pages preserve reports, retries and shared history (${rolling?'last30':'monthly'})`,{timeout:180000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
 await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 if(rolling){f.scope={...f.scope,researchId:randomUUID(),fromMonth:f.scope.toMonth,overviewPeriod:'last30'};await f.stores.snapshots.createStudy({actor:f.actor,scope:f.scope,idempotencyKey:randomUUID(),now:new Date().toISOString()});}
 const calls:Array<{op:string;input:any}>=[];let failPrice=true,failProfit=true;
 const sellerSprite:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('unused');},execute:async r=>{
  calls.push({op:r.operation,input:r.input});let data:unknown;const q=r.input.request as any;
  if(rolling&&r.operation!=='keyword_research'&&r.operation!=='aba_research_trend')assert.equal(Object.hasOwn(q,'month'),false);
  if(r.operation==='competitor_lookup'){
   assert.deepEqual(q.asins,['B000000001','B000000002']);assert.equal(q.returnFields,'asin,price,profit,fba');assert.equal(q.size,2);
   if(q.page===3&&failProfit)throw new ConnectorError('sellerSprite','local-admission',true,{reason:'rolling-window',retryAt:new Date(Date.now()+60000).toISOString()});
   data={page:q.page,pages:3,items:q.page===1?[{asin:'B000000099',price:999,profit:99,fba:9}]:q.page===2?[{asin:'B000000001',price:20,profit:0.45,fba:4}]:[{asin:'B000000002',price:40,profit:0.6,fba:6}]};
  }else if(r.operation==='keyword_research')data={items:[]};
  else if(r.operation==='aba_research_trend')data=[];
  else {
   const basic={marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,...(q.month?{month:q.month}:{}),nodeLabelName:'Floor Lamps',nodeLabelPath:'Home:Lighting:Floor Lamps',topProducts:100,products:100,totalUnits:1000,totalRevenue:20000,avgPrice:20};
   data=r.operation==='market_research'?{items:[basic]}:r.operation==='market_research_statistics'?basic:r.operation==='market_product_demand_trend'?{items:[{date:'2026-07-01',glanceViews:123},{date:'2026-08-01',glanceViews:456},{date:'2026-09-01',glanceViews:999}],returnRatio:null}:r.operation==='market_price_distribution'?[{label:'0-50',asins:['B000000001','B000000002'],products:2,units:100,unitsRatio:1}]:[];
   if(r.operation==='market_product_demand_trend'){assert.equal(q.newProduct,undefined);assert.equal(q.topN,100);}
  }
  return {data:{code:'OK',data},source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('unused');},execute:async r=>{
  calls.push({op:r.operation,input:r.input});
  if(r.operation==='category_keywords'&&!rolling)throw new ConnectorError('sorftime','quota-exhausted',false);
  if(r.operation==='category_trend'&&r.input.trend_index==='AvgPrice'&&failPrice)throw new ConnectorError('sorftime',rolling?'timeout':'quota-exhausted',false);
  return {data:{data:r.operation==='category_keywords'?[]:r.input.trend_index==='SalesCount'?['2026-06=10','2026-07=11','2026-08=12','2026-09=999']:['2026-07=2.25','2026-08=2.75','2026-09=999']},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const request={actor:f.actor,scope:f.scope,moduleKind:'overview' as const,params:{...(rolling?{scoringVersion:'observed-items/2'}:{}),flow,headTopN:10,newProductMonths:6},versions:{source,rule,mapping:rule,planner:flow,model:null,prompt:null,configuration:null},collectionRevision:'external/v1',idempotencyKey:randomUUID()};
 const run=(await f.stores.steps.createModuleRun({...request,initialSteps:marketOverviewFlowInitialSteps(request)})).run;
 const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite,sorftime}}),rules:createMarketOverviewCatalogStep(f.context),report:createMarketOverviewReportStep(f.context)}});t.after(()=>worker.stop());
 const drain=async()=>{for(let i=0;i<120;i++){if(!await worker.tick())return;}assert.fail('Run did not drain');};
 const reports=new MarketOverviewReportService(f.context);await drain();
 const view=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;
 const price=view.steps.find(s=>(s.input as any).kind==='prices')!,profit=view.steps.find(s=>(s.input as any).kind==='profits'&&(s.input as any).page===3)!;
 assert.equal(price.status,'failed');assert.equal(profit.status,'queued');assert.equal((view.attempts.find(a=>a.id===profit.latestAttemptId)!.error as any).code,'local-admission');
 const entry=(await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!;
 const detail=(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId}))!;
 assert.equal(detail.entry.report.scoringVersion,rolling?'observed-items/2':undefined);
 assert.equal(detail.numbers.originalSynthesis!.evaluation!.version,rolling?'observed-items/2':'observed-inputs/1');
 assert.equal(detail.numbers.scoreReview?.evaluation?.version,rolling?undefined:'observed-items/2');
 assert.ok(detail.numbers.basicOverview,'basic table is restored from the same frozen report');
 assert.equal(detail.numbers.basicOverview.nodeIdPath,f.scope.nodeIdPath);
 assert.equal(detail.numbers.basicOverview.scope.month,rolling?'last30':f.scope.toMonth);
 assert.ok(detail.numbers.basicOverview.tableMetrics);
 if(rolling){assert.equal(detail.entry.report.scope.overviewPeriod,'last30');assert.ok(detail.numbers.months.some(m=>Object.values(m.metrics).some(v=>v.state==='known')));assert.ok(detail.numbers.originalSummary);assert.ok(detail.numbers.originalSynthesis);}
 assert.deepEqual(detail.numbers.externalData!.salesTrend.points,[{month:'2026-06',value:10},{month:'2026-07',value:11},{month:'2026-08',value:12}]);
 assert.equal(detail.numbers.externalData!.salesAmountTrend.status,'failed');assert.equal(detail.numbers.externalData!.salesAmountTrend.errorCode,rolling?'timeout':'quota-exhausted');
 if(!rolling){const demand=view.steps.find(s=>(s.input as any).phase==='overview-industry-demand')!;assert.equal(demand.status,'failed');assert.equal((view.attempts.find(a=>a.id===demand.latestAttemptId)!.error as any).code,'quota-exhausted');}
 assert.equal(detail.numbers.externalData!.asinProfits.status,'partial');assert.deepEqual(Object.keys(detail.numbers.externalData!.asinProfits.items),['B000000001']);assert.deepEqual(detail.numbers.externalData!.asinProfits.missingAsins,['B000000002']);
 assert.equal(detail.numbers.productDemand!.status,'ready');assert.equal(detail.numbers.productDemand!.returnRatio,null);assert.equal(detail.numbers.productDemand!.points.length,2);
 const frozen=(d:typeof detail)=>({report:d.entry.report,numbers:d.numbers,semantic:d.semantic}),hash=digest(frozen(detail)),before=calls.length;
 assert.equal(digest(frozen((await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId}))!)),hash);assert.equal(calls.length,before);
 assert.ok((await reports.read({actor:f.actor,moduleRunId:run.id}))!.history.some(r=>!r.report.externalAttemptIds),'numeric report saved before external stages');
 failPrice=false;failProfit=false;
 await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:price.id,failedAttemptId:price.latestAttemptId!}],idempotencyKey:randomUUID()});
 assert.equal((await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!.attemptId,entry.attemptId);
 await pg.pool.query('UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp() WHERE id=$1',[profit.id]);await drain();
 const latest=(await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!,ready=(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:latest.attemptId}))!;
 assert.deepEqual(ready.numbers.externalData!.salesAmountTrend.points,[{month:'2026-07',value:25},{month:'2026-08',value:33}]);assert.equal(ready.numbers.externalData!.salesAmountTrend.status,'partial');
 assert.equal(ready.numbers.externalData!.asinProfits.status,'ready');assert.equal(calls.filter(c=>c.op==='competitor_lookup'&&c.input.request.page===1).length,1);assert.equal(calls.filter(c=>c.op==='category_trend'&&c.input.trend_index==='SalesCount').length,1);
 assert.equal(digest(frozen((await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId}))!)),hash);
 const after=calls.length;await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:run.id,idempotencyKey:randomUUID()});await drain();assert.equal(calls.length,after);assert.ok(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:latest.attemptId}));
 // Organization reports remain readable by another active member after the author is disabled.
 const reader={organizationId:f.actor.organizationId,userId:randomUUID()};
 await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Report reader','member','active',clock_timestamp(),clock_timestamp())",[reader.userId,reader.organizationId,`${reader.userId}@example.com`]);
 await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[f.actor.userId]);
 const beforeShared=calls.length;
 assert.ok((await reports.read({actor:reader,moduleRunId:run.id}))!.latestSavedReport);
 assert.equal(digest(frozen((await reports.details({actor:reader,moduleRunId:run.id,attemptId:entry.attemptId}))!)),hash);
 assert.equal(calls.length,beforeShared);
 assert.equal(await reports.read({actor:f.actor,moduleRunId:run.id}),null);
 assert.equal(await reports.read({actor:{...reader,organizationId:randomUUID()},moduleRunId:run.id}),null);
 await assert.rejects(pg.pool.query("UPDATE market_analysis_step_attempts SET output_json='{}'::jsonb WHERE id=$1",[latest.attemptId]));
});
