import {createMarketShapeSelectionStep} from '../../server/runtime/market-shape-selection-step';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketSourceProjectionStep} from '../../server/runtime/market-source-projection-step';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {marketShapeFlowInitialSteps} from '../../server/domain/market-research/shape-price-flow';

test('new shape runs persist independent history, retry only failed ASINs and keep legacy reads/replays inert',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 const calls:string[]=[];const categoryCalls:string[]=[];let fail=true;let categoryFail=true;
 const seller:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('unused')},execute:async r=>{
  calls.push('pool');return {data:{code:'OK',data:['B000000001','B000000002'].map((asin,i)=>({asin,title:'Lamp',brand:'Fixture',price:20,totalUnits:100+i,ranking:i+1}))},source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('unused')},execute:async r=>{
  if(r.operation.startsWith('category_')){
   const metric=String(r.input.trend_index??'report');categoryCalls.push(metric);
   if(metric==='AvgPrice'&&categoryFail)throw new ConnectorError('sorftime','upstream-permanent',false);
   return {data:r.operation==='category_report'?{data:{category_stats_report:{node_id:r.input.node_id,top100_monthly_sales_volume:'200',top3_product_sales_volume_share:'17.5%'}}}:{data:['2026-06=10','2026-07=0','2026-08=20']},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
  }
  calls.push(String(r.input.asin));if(fail&&r.input.asin==='B000000002')throw new ConnectorError('sorftime','upstream-permanent',false);
  return {data:{asin:r.input.asin,amz_site:'US',data:['2026-03=1','2026-04=2','2026-05=3','2026-06=10','2026-07=0','2026-08=20']},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:seller,sorftime}}),'prepare-members':input=>(input.claim.step.input as {phase?:string}).phase==='select-shape-members'?createMarketShapeSelectionStep(f.context)(input):createMarketSourceProjectionStep(f.context)(input)}});t.after(()=>worker.stop());
 const drain=async()=>{for(let i=0;i<20&&await worker.tick();i++){}};
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null});
 const study=await service.createStudy(f.actor,{marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,fromMonth:'2026-08',toMonth:'2026-08'},randomUUID());
 const body={poolSize:2,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'history/v1',allowedLabels:[]}},key=randomUUID();
 const started=await service.startShapes(f.actor,study.study.id,body,key);await drain();
 let current=(await service.findShapes(f.actor,started.run.id)).run;
 assert.equal(current.semanticStatus,'skipped');assert.equal(current.latestRevision,null);assert.equal(current.source!.summary!.totalUnits,201);
 assert.equal(current.source!.productHistory!.products[0].periods[0].units,30,'must not use SellerSprite reference 100');
 assert.equal(current.source!.productHistory!.products[0].periods[1].units,36);
 assert.equal(current.source!.productHistory!.products[1].status,'failed');
 assert.equal(current.scope.fromMonth,'2026-08');assert.equal(current.status,'partial');
 const failed=current.steps.find(s=>s.kind==='collect-product-history'&&s.status==='failed')!;
 assert.equal(failed.asin,'B000000002');fail=false;
 await service.retry(f.actor,current.id,{steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}]},randomUUID());await drain();
 current=(await service.findShapes(f.actor,current.id)).run;
 assert.equal(current.status,'partial');assert.equal(current.categoryDashboard!.sources.find(s=>s.metric==='AvgPrice')!.status,'failed');
 const categoryStep=current.steps.find(s=>s.kind==='collect-shape-category'&&s.status==='failed')!;categoryFail=false;
 await service.retry(f.actor,current.id,{steps:[{stepId:categoryStep.id,failedAttemptId:categoryStep.latestAttemptId!}]},randomUUID());await drain();
 current=(await service.findShapes(f.actor,current.id)).run;
 assert.equal(categoryCalls.length,7);assert.equal(categoryCalls.filter(c=>c==='report').length,1);assert.equal(current.categoryDashboard!.sources.length,6);
 assert.equal(current.categoryDashboard!.sources.find(s=>s.metric==='report')!.status,'partial',JSON.stringify(current.categoryDashboard));assert.equal(current.categoryDashboard!.sources.find(s=>s.metric==='report')!.stats!.top100Units,200);
 assert.equal(current.categoryDashboard!.estimatedAmount.at(-1)!.value,400);
 assert.equal(current.status,'succeeded');assert.equal(current.source!.productHistory!.products[1].periods[0].units,30);
 assert.equal(calls.filter(c=>c==='pool').length,1);assert.equal(calls.filter(c=>c==='B000000001').length,1);assert.equal(calls.filter(c=>c==='B000000002').length,2);
 const before=[...calls];await service.findShapes(f.actor,current.id);const replay=await service.startShapes(f.actor,study.study.id,body,key);assert.equal(replay.created,false);await drain();assert.deepEqual(calls,before);assert.equal(categoryCalls.length,7);
 await assert.rejects(service.findShapes({...f.actor,organizationId:randomUUID()},current.id));
 assert.equal((await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:current.id}))!.steps.some(s=>s.kind==='model-batch'),false);
 // New software must preserve old planner definitions and avoid new requests on legacy reads/resumption.
 const legacyRequest={actor:f.actor,scope:study.study.scope,moduleKind:'shape-price' as const,params:{...body,flow:'market-shape-price-flow/rules-v1'},versions:{source:'market-source-handlers/v1',rule:'market-shape-price-catalog/v3',mapping:'history/v1',planner:'market-shape-price-flow/rules-v1',model:null,prompt:null,configuration:null},collectionRevision:'initial/v1',idempotencyKey:randomUUID()};
 const legacy=await f.stores.steps.createModuleRun({...legacyRequest,initialSteps:marketShapeFlowInitialSteps(legacyRequest)});await drain();
 const old=await service.findShapes(f.actor,legacy.run.id);assert.equal(old.run.source!.productHistory,undefined);assert.equal(old.run.steps.some(s=>s.kind==='collect-product-history'),false);
 assert.deepEqual(calls,[...before,'pool']);assert.equal(old.run.categoryDashboard,undefined);assert.equal(categoryCalls.length,7);
 const v2={...legacyRequest,params:{...legacyRequest.params,flow:'market-shape-price-flow/rules-v2'},versions:{...legacyRequest.versions,planner:'market-shape-price-flow/rules-v2'},idempotencyKey:randomUUID()};
 const oldV2=await f.stores.steps.createModuleRun({...v2,initialSteps:marketShapeFlowInitialSteps(v2)});await drain();assert.equal((await service.findShapes(f.actor,oldV2.run.id)).run.categoryDashboard,undefined);assert.equal(categoryCalls.length,7);
});
