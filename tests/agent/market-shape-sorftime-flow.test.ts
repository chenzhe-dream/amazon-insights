import {categoryProductsFixture} from './helpers/category-products-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketShapeSelectionStep} from '../../server/runtime/market-shape-selection-step';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
for(const configuredModel of [false,true]) test(`Sorftime shape source persists without model calls (configured=${configuredModel})`,{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 const calls:string[]=[];
 const seller:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('unused')},execute:async()=>{throw Error('Sorftime shape must not call SellerSprite')}};
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('unused')},execute:async r=>{
  calls.push(`${r.operation}:${r.input.type??r.input.trend_index??''}`);
  const data=r.operation==='product_detail'?{data:{asin:r.input.asin,main_image:'https://m.media-amazon.com/images/I/lamp.jpg'}}:(r.operation==='category_report'||r.operation==='category_products')?{data:{category_stats_report:{category_name:'Floor Lamps',top100_monthly_sales_volume:100},top100_products:[{asin:'B000000001',title:'Lamp',brand:'Fixture',price:29.99,monthly_sales_volume:100,monthly_sales_amount:2900,gross_profit_margin:70,category_rank:'Floor Lamps (Rank: 1)',online_date:'2025-01-01'}]}}:{data:r.input.type==='SalesAmount'?['2026-06=10.25','2026-07=0','2026-08=20.75']:['2026-06=10','2026-07=0','2026-08=20']};
  return {data:r.operation==='category_products'?categoryProductsFixture(data,r.input.node_id):data,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null});
 const study=await service.createStudy(f.actor,{marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,fromMonth:'2026-06',toMonth:'2026-08'},randomUUID());
 const started=await service.startShapes(f.actor,study.study.id,{poolSize:1,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'reference/v1',allowedLabels:[]}},randomUUID());
 assert.equal(started.run.steps[0].kind,'collect-shape-pool');
 let modelCalls=0;
 const worker=configuredModel?await createMarketModelRuntime(f.context,loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-market-key',AGENT_VOC_MODEL:'gpt-5.6',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-worker',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2'}),{connectors:{sellerSprite:seller,sorftime},client:{responses:{create:async()=>{modelCalls++;throw Error('Rules must not call a model');}}} as never}):new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:seller,sorftime}}),'prepare-members':createMarketShapeSelectionStep(f.context)}});t.after(()=>worker.stop());
 for(let i=0;i<30&&await worker.tick();i++){}
 const current=(await service.findShapes(f.actor,started.run.id)).run;
 assert.equal(current.status,'succeeded');assert.equal(current.semanticStatus,'skipped');assert.equal(modelCalls,0);
 assert.equal(current.source!.sorftimePool!.period,'recent-30-days');assert.equal(current.source!.sorftimePool!.products[0].grossProfitMargin,70);
 assert.equal(current.source!.productAmountHistory!.products[0].points[2].amount,20.75);
 assert.equal(current.source!.productHistory!.products[0].points[2].units,20);
 assert.equal(current.source!.productImages!.products[0].imageUrl,'https://m.media-amazon.com/images/I/lamp.jpg');
 assert.equal(current.latestRevision,null);const revision=await service.saveShapeRevision(f.actor,current.id,{expectedParentRevisionId:null,selectedAsins:['B000000001'],assignments:[{asin:'B000000001',label:'层架式'}]},randomUUID());assert.ok('data' in revision.revision);assert.equal(revision.revision.data.productImages!.products[0].imageUrl,'https://m.media-amazon.com/images/I/lamp.jpg');const restored=await service.shapeRevision(f.actor,current.id,revision.revision.revisionId);assert.deepEqual(restored.revision,revision.revision);const count=calls.length;await service.findShapes(f.actor,current.id);assert.equal(calls.length,count);
 assert.ok(!current.steps.some(s=>s.kind==='collect-product-month'||s.kind==='model-batch'));
});


test('300-product pool expands, completes and restores persisted histories without recollecting',{timeout:900000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 const asin=(n:number)=>`B${String(n).padStart(9,'0')}`,row=(n:number)=>({asin:asin(n),title:`Lamp ${n}`,price:30,monthly_sales_volume:10,monthly_sales_amount:300,category_rank:`Floor Lamps (Rank: ${n})`,subcategory:`Floor Lamps (Rank: ${n})`});
 let calls=0;const pages:number[]=[],sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('unused')},execute:async r=>{
  calls++;
  let data:Record<string,unknown>;
  if(r.operation==='category_report'||r.operation==='category_products')data={data:{category_stats_report:{category_name:'Floor Lamps'},top100_products:Array.from({length:100},(_,i)=>row(i+1))}};
  else if(r.operation==='product_search'){const page=Number(r.input.page);pages.push(page);assert.equal(r.input.search_name,'Floor Lamps');assert.equal(r.input.subcategory_sales_volume_rank_max,300);
   const start=101+(page-1)*18;data={data:[row(1),{...row(999),subcategory:'Table Lamps (Rank: 999)'},...Array.from({length:18},(_,i)=>row(start+i))]};
  }else if(r.operation==='product_detail')data={data:{asin:r.input.asin,main_image:'https://m.media-amazon.com/images/I/lamp.jpg'}};
  else data={data:Array.from({length:24},(_,i)=>`${2024+Math.floor((8+i)/12)}-${String((8+i)%12+1).padStart(2,'0')}=${r.input.type==='SalesAmount'?'20.25':'10'}`)};
  return {data:r.operation==='category_products'?categoryProductsFixture(data,r.input.node_id):data,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const seller:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('unused')},execute:async()=>{throw Error('wrong provider')}};
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null}),study=await service.createStudy(f.actor,{marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,fromMonth:'2026-08',toMonth:'2026-08'},randomUUID());
 const key=randomUUID(),params={poolSize:300,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'reference/v1',allowedLabels:[]}},started=await service.startShapes(f.actor,study.study.id,params,key);
 assert.equal((await service.startShapes(f.actor,study.study.id,params,key)).run.id,started.run.id);
 const handlers=createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:seller,sorftime}}),worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{'collect-shape-pool':handlers['collect-shape-pool'],'prepare-members':createMarketShapeSelectionStep(f.context)}});t.after(()=>worker.stop());
 for(let i=0;i<20;i++){await worker.tick();const view=await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:started.run.id});if(view?.steps.some(s=>s.kind==='prepare-members'&&s.status==='succeeded'))break;}
 const run=(await service.findShapes(f.actor,started.run.id)).run;
 assert.equal(pages.length,12,'duplicate rows must not count toward requested capacity');assert.equal(run.source!.sorftimePool!.products.length,300);assert.equal(new Set(run.source!.products.map(p=>p.asin)).size,300);assert.ok(!run.source!.products.some(p=>p.asin===asin(999)));
 assert.equal(run.steps.filter(s=>s.kind==='collect-product-history').length,300);assert.equal(run.steps.filter(s=>s.kind==='collect-product-amount-history').length,300);assert.equal(run.steps.filter(s=>s.kind==='collect-product-image').length,300);
 const before=pages.length;await service.findShapes(f.actor,run.id);assert.equal(pages.length,before);
 const fullWorker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...handlers,'prepare-members':createMarketShapeSelectionStep(f.context)}});t.after(()=>fullWorker.stop());
 for(let i=0;i<920&&await fullWorker.tick();i++){if((i+1)%100===0)console.log('300-product acceptance: completed '+(i+1)+' source steps');}
 const readStart=performance.now(),completed=(await service.findShapes(f.actor,run.id)).run,readMs=performance.now()-readStart;
 assert.equal(completed.status,'succeeded');assert.equal(completed.source!.productHistory!.products.filter(p=>p.status==='ready').length,300);assert.equal(completed.source!.productAmountHistory!.products.filter(p=>p.status==='ready').length,300);assert.equal(completed.source!.productImages!.products.filter(p=>p.imageUrl).length,300);
 const callCount=calls,saveStart=performance.now(),saved=await service.saveShapeRevision(f.actor,run.id,{expectedParentRevisionId:null,selectedAsins:completed.source!.products.map(p=>p.asin),assignments:[]},randomUUID()),saveMs=performance.now()-saveStart;
 const restoreStart=performance.now(),restored=await service.shapeRevision(f.actor,run.id,saved.revision.revisionId),restoreMs=performance.now()-restoreStart;assert.deepEqual(restored.revision,saved.revision);
 const reloadStart=performance.now(),reloaded=(await service.findShapes(f.actor,run.id)).run,reloadMs=performance.now()-reloadStart;assert.equal(reloaded.referenceRevision!.revisionId,saved.revision.revisionId);assert.ok(!('data' in reloaded.referenceRevision!));assert.equal(calls,callCount);
 t.diagnostic(JSON.stringify({products:300,months:24,steps:completed.steps.length,calls,readMs:Math.round(readMs),saveMs:Math.round(saveMs),restoreMs:Math.round(restoreMs),reloadMs:Math.round(reloadMs),responseBytes:Buffer.byteLength(JSON.stringify(reloaded))}));
 for(const elapsed of [readMs,saveMs,restoreMs,reloadMs])assert.ok(elapsed<60000,'must fit bounded report proxy deadline');
});
