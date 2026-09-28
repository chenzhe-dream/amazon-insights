import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketOverviewCatalogStep} from '../../server/runtime/market-overview-catalog-step';
import {createMarketOverviewReportStep} from '../../server/runtime/market-overview-report-step';
import {marketOverviewFlowInitialSteps,MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION} from '../../server/domain/market-research/overview-flow';
import {MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION} from '../../server/domain/market-research/overview-complete-catalog';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {MarketOverviewReportService} from '../../server/services/market-overview-report-service';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

test('overview demand partial evidence survives failure, explicit retry, history reads and cancellation',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
 await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 let fail=true,calls=0;let transient:'local-admission'|'timeout'|'upstream-temporary'|null=null;const retryAt=new Date(Date.now()+60000).toISOString();
 const sellerSprite:RemoteMcpConnector={id:'sellerSprite',probe:async()=>({connectorId:'sellerSprite',configured:true,available:true,reason:null,checkedAt:null}),execute:async r=>{
  calls++;let data:unknown;
  if(r.operation==='aba_research_trend'){
   if(r.input.keyword==='floor lamp for bedroom'&&fail)throw new ConnectorError('sellerSprite',transient??'timeout',transient!==null,transient==='local-admission'?{reason:'rolling-window',retryAt}:undefined);
   data=[{label:'202604',searches:120},{label:'202605',searches:0},{label:'202607',searches:180},{label:'202608',searches:220},{label:'202610',searches:9999}];
  }else if(r.operation==='keyword_research')data={items:[]};
  else{const q=r.input.request as {month:string},identity={marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,month:q.month};const basic={...identity,nodeLabelName:'Floor Lamps',nodeLabelPath:'Home:Lighting:Floor Lamps',topProducts:100,products:100,totalUnits:1000,totalRevenue:20000,avgBsr:5820,avgWeight:5,baseAvgWeight:2268,top10ProductSales:600,top10ProductRevenue:12000};data=r.operation==='market_research'?{items:[basic]}:r.operation==='market_research_statistics'?{...basic,hlAvgBsr:754,hlAvgPrice:30}:r.operation==='market_product_demand_trend'?{items:[],asinCount:null}:[];}
  return {data:{code:'OK',data},source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>({connectorId:'sorftime',configured:true,available:true,reason:null,checkedAt:null}),execute:async r=>{calls++;assert.equal(r.operation,'category_keywords');return {data:{data:r.input.page===1?[{keyword:'floor lamp',monthly_search_volume:1000,search_result_count:100},{keyword:'floor lamp for bedroom',monthly_search_volume:900,search_result_count:100}]:[]},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};}};
 const request={actor:f.actor,scope:f.scope,moduleKind:'overview' as const,params:{flow:MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION,headTopN:10,newProductMonths:6},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION,mapping:MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION,planner:MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION,model:null,prompt:null,configuration:null},collectionRevision:'demand-integration/v1',idempotencyKey:randomUUID()};
 const run=(await f.stores.steps.createModuleRun({...request,initialSteps:marketOverviewFlowInitialSteps(request)})).run;
 const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite,sorftime}}),rules:createMarketOverviewCatalogStep(f.context),report:createMarketOverviewReportStep(f.context)}});t.after(()=>worker.stop());
 const drain=async()=>{for(let i=0;i<80;i++){if(!await worker.tick())return;}assert.fail('Run did not drain');};await drain();
 const reports=new MarketOverviewReportService(f.context),view=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;
 const failed=view.steps.find(s=>(s.input as {phase?:string}).phase==='overview-industry-demand')!;assert.equal(failed.status,'failed');assert.ok(view.attempts.find(a=>a.id===failed.latestAttemptId)!.output);
 const initial=(await reports.read({actor:f.actor,moduleRunId:run.id}))!,entry=initial.currentReport!;assert.equal(entry.report.industryDemandAttemptId,failed.latestAttemptId);
 const partial=(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId}))!;assert.equal(partial.numbers.industryDemand!.status,'partial');assert.equal(partial.numbers.industryDemand!.series[0].points.length,4);assert.equal(partial.numbers.industryDemand!.series[1].status,'failed');assert.equal(partial.numbers.originalSummary!.fields.avgBsr.value,5820);assert.equal(partial.numbers.originalSummary!.fields.hlAvgBsr.value,754);
 const frozen=(d:typeof partial|null)=>d&&{report:d.entry.report,numbers:d.numbers,semantic:d.semantic};const partialHash=digest(frozen(partial)),count=calls;assert.equal(digest(frozen(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId}))),partialHash);assert.equal(calls,count);
 const sourceRow=(await pg.pool.query('SELECT output_hash FROM market_analysis_step_attempts WHERE id=$1',[failed.latestAttemptId])).rows[0];assert.match(sourceRow.output_hash,/^[a-f0-9]{64}$/);
 fail=false;await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}],idempotencyKey:randomUUID()});
 assert.equal((await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!.attemptId,entry.attemptId,'partial report remains available during retry');await drain();
 const latest=(await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!;assert.notEqual(latest.attemptId,entry.attemptId);
 const complete=(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:latest.attemptId}))!;assert.equal(complete.numbers.industryDemand!.status,'ready');assert.equal(complete.numbers.industryDemand!.series.length,2);const finished=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;assert.equal(finished.run.status,'succeeded',JSON.stringify(finished.steps.filter(s=>s.status!=='succeeded'&&s.status!=='empty').map(s=>({key:s.stepKey,status:s.status,error:finished.attempts.find(a=>a.id===s.latestAttemptId)?.error}))));
 assert.equal(digest(frozen(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId}))),partialHash,'frozen partial version unchanged after retry');
 await mkdir('test-results/overview-demand-integration',{recursive:true});await writeFile('test-results/overview-demand-integration/partial.json',JSON.stringify(partial));await writeFile('test-results/overview-demand-integration/complete.json',JSON.stringify(complete));
 const finalCalls=calls;await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:run.id,idempotencyKey:randomUUID()});assert.ok(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:latest.attemptId}));assert.equal(calls,finalCalls);
 for(const code of ['local-admission','timeout','upstream-temporary'] as const){await t.test(`partial ${code} evidence survives native automatic retry`,async()=>{
  transient=code;fail=true;const retryRequest={...request,collectionRevision:`demand-auto/${code}`,idempotencyKey:randomUUID()},autoRun=(await f.stores.steps.createModuleRun({...retryRequest,initialSteps:marketOverviewFlowInitialSteps(retryRequest)})).run;
  await drain();const autoView=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:autoRun.id}))!,demand=autoView.steps.find(s=>(s.input as {phase?:string}).phase==='overview-industry-demand')!;
  assert.equal(demand.status,'queued');const failedAttempt=autoView.attempts.find(a=>a.id===demand.latestAttemptId)!;assert.equal(failedAttempt.status,'failed');assert.equal((failedAttempt.error as any).code,code);assert.ok(failedAttempt.output);
  if(code==='local-admission'){assert.deepEqual((failedAttempt.error as any).admission,{reason:'rolling-window',retryAt});assert.ok(Date.parse(demand.nextAttemptAt!)>=Date.parse(retryAt));}
  const partialEntry=(await reports.read({actor:f.actor,moduleRunId:autoRun.id}))!.currentReport!,autoPartial=(await reports.details({actor:f.actor,moduleRunId:autoRun.id,attemptId:partialEntry.attemptId}))!;
  assert.equal(autoPartial.numbers.industryDemand!.status,'partial');assert.equal(autoPartial.numbers.industryDemand!.series[0].points.length,4);assert.equal(autoPartial.numbers.industryDemand!.series[1].errorCode,code);
  const oldHash=digest(frozen(autoPartial));fail=false;await pg.pool.query('UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp() WHERE id=$1',[demand.id]);await drain();
  const ready=(await reports.read({actor:f.actor,moduleRunId:autoRun.id}))!.currentReport!;assert.notEqual(ready.attemptId,partialEntry.attemptId);assert.equal((await reports.details({actor:f.actor,moduleRunId:autoRun.id,attemptId:ready.attemptId}))!.numbers.industryDemand!.status,'ready');
  assert.equal(digest(frozen(await reports.details({actor:f.actor,moduleRunId:autoRun.id,attemptId:partialEntry.attemptId}))),oldHash);
 });}
 await assert.rejects(pg.pool.query("UPDATE market_analysis_step_attempts SET output_json='{}'::jsonb WHERE id=$1",[failed.latestAttemptId]));
});
