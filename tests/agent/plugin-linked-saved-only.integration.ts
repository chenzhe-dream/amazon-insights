import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {PostgresPluginProductSourceStore} from '../../server/db/postgres/plugin-product-source-store';
import {PostgresMarketResearchStore} from '../../server/db/postgres/market-research-store';
import {MarketResearchService} from '../../server/services/market-research-service';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketLinkedService} from '../../server/services/market-linked-service';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketShapeSelectionStep} from '../../server/runtime/market-shape-selection-step';
import {createMarketThemePoolStep} from '../../server/runtime/market-theme-pool-step';
import {createMarketThemeRulesStep} from '../../server/runtime/market-theme-rules-step';
import {createMarketThemeReportStep} from '../../server/runtime/market-theme-report-step';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {newMarketAcquisitionPolicy} from '../../shared/market-acquisition-policy';

test('four sites: linked policy, one immutable pool, saved images/history, gaps and replay without supplier requests',{timeout:240000},async t=>{
 const url=new URL(process.env.AGENT_DATABASE_URL!);
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'64733');
 url.pathname='/plugin_flow_offline_20261029';
 const pool=new Pool({connectionString:url.toString(),max:6});t.after(()=>pool.end());
 await runPostgresMigrations(pool);
 for(const site of ['US','UK','DE','CA'] as const){
  if(process.env.OFFLINE_TEST_SITE&&site!==process.env.OFFLINE_TEST_SITE)continue;
  const f=await createMarketSemanticFixture(pool);await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
  const currency=({US:'USD',UK:'GBP',DE:'EUR',CA:'CAD'} as const)[site],asins=Array.from({length:150},(_,i)=>`B${String(150-i).padStart(9,'0')}`);
  const stamp='2026-10-01T00:00:00.000Z',months=Array.from({length:33},(_,i)=>new Date(Date.UTC(2024,i,1)).toISOString().slice(0,7));
  const sources=new PostgresPluginProductSourceStore(f.context),jobId=randomUUID();
  const saved=await sources.importSnapshot({job:{id:jobId,organizationId:f.actor.organizationId,userId:f.actor.userId,node:'34',site,target:150,status:'succeeded',stage:'complete',products:150,page:1,batch:1,createdAt:stamp,updatedAt:stamp,heartbeatAt:stamp,error:null,result:null,transport:'native-messaging',pageRelayUsed:false},source:{site,node:'34',target:150,asins,collectedAt:stamp,summary:{discovery:{provider:'amazon-page'}},basic:Object.fromEntries(asins.map((asin,i)=>[asin,{asin,currency,title:'Synthetic Darts',price:20,image:`https://m.media-amazon.com/images/I/${asin}.jpg`,profit:88,bsrList:[{id:'34',rank:150-i,label:'Darts'}]}])),history:Object.fromEntries(asins.map(asin=>[asin,{asin,nodes:['sale','amount'].map(type=>({type,data:months.map((m,i)=>[m,type==='sale'?i:i+.5])}))}]))}});
  assert.equal(await sources.findSnapshot({organizationId:f.actor.organizationId,userId:randomUUID(),snapshotId:saved.snapshotId}),null);
  assert.equal(await sources.findCategoryPool({...f.actor,marketplace:site,node:'99',poolSize:100,savedOnly:true}),null);
  const modules=new MarketModuleService({context:f.context,modelIdentity:()=>null});
  const researchStore=new PostgresMarketResearchStore(f.context),research=new MarketResearchService({repository:researchStore,findUser:async()=>({organizationId:f.actor.organizationId,status:'active'})});
  const linked=new MarketLinkedService({context:f.context,research,modules,pluginSources:sources});
  const batchId=randomUUID();await linked.create(f.actor,{...newMarketAcquisitionPolicy,scope:{marketplace:site,nodeQuery:'12:34',month:'2026-09',headTopN:10,newProductMonths:6},fromMonth:'2026-09'},batchId);
  const claim=await researchStore.claim({ownerId:'offline-test',now:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString()});assert.ok(claim);
  await researchStore.finish({claim,now:new Date().toISOString(),error:null,report:{schemaVersion:'market-overview/v1',scope:claim.job.scope,nodeId:'34',nodeIdPath:'12:34',categoryName:'Darts',currency,collectedAt:stamp,metrics:{sampleProducts:100,brands:null,sellers:null,totalUnits:null,totalRevenue:null,avgPrice:null,avgUnits:null,avgRatings:null,avgRating:null,productConcentrationRaw:null,brandConcentrationRaw:null,sellerConcentrationRaw:null,newCount:null,newAvgPrice:null,newAvgUnits:null},evidence:[],issues:[],boundaries:[]}});
  await linked.tick();const batch=(await linked.find(f.actor,batchId)).batch;
  assert.equal(batch.status,'started');assert.equal(batch.pluginSourceSnapshotId,saved.snapshotId);
  for(const module of ['overview','shapes','themes','keywords'] as const){
   const view=await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:batch.modules[module].runId!});assert.ok(view);
   assert.equal((view.run.params as any).mcpFallbackPolicy,'saved-only/v1');assert.equal((view.run.params as any).pluginSourceSnapshotId,saved.snapshotId);
  }
  let localMisses=0;
  const connector=(id:'sorftime'|'sellerSprite'):RemoteMcpConnector=>({id,probe:async()=>{throw Error('No probes allowed');},execute:async request=>{assert.equal(request.savedOnly,true);localMisses++;throw new ConnectorError(id,'saved-source-missing',false);}});
  const sourceHandlers=createMarketSourceStepHandlers({context:f.context,pluginSources:sources,connectors:{sorftime:connector('sorftime'),sellerSprite:connector('sellerSprite')}});
  const shapeSelection=createMarketShapeSelectionStep(f.context),themePool=createMarketThemePoolStep(f.context);
  const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...sourceHandlers,'prepare-members':input=>(input.claim.step.input as any).phase?.includes('shape-members')?shapeSelection(input):themePool(input),rules:createMarketThemeRulesStep(f.context),report:createMarketThemeReportStep(f.context)}});
  try{for(let i=0;i<500&&await worker.tick();i++){} }finally{await worker.stop();}
  const shapes=(await modules.findShapes(f.actor,batch.modules.shapes.runId!)).run;
  assert.ok(shapes.source);assert.equal(shapes.source.products.length,100);
  assert.deepEqual(shapes.source.sorftimePool!.products.map(p=>p.asin),asins.slice(0,100));
  assert.equal(shapes.source.sorftimePool!.provider,'sellerSprite');
  assert.equal(shapes.source.productHistory!.products.filter(p=>p.status==='ready').length,100);
  assert.equal(shapes.source.productAmountHistory!.products.filter(p=>p.status==='ready').length,100);
  assert.equal(shapes.source.productImages!.products.filter(p=>p.imageUrl).length,100);
  assert.ok(shapes.source.sorftimePool!.products.every(p=>p.grossProfitMargin===null));
  assert.equal(shapes.source.productHistory!.provider,'sellerSprite');
  assert.equal(shapes.source.productHistory!.products[0].fetchedAt,stamp);
  const themes=(await modules.findRun(f.actor,batch.modules.themes.runId!)).run;
  assert.ok(themes.currentReport||themes.latestSavedReport,'missing comments still produce an explicit no-data report');
  const before=localMisses;const reloaded=(await modules.findShapes(f.actor,shapes.id)).run;
  assert.deepEqual(reloaded.source,shapes.source);assert.equal(localMisses,before);
  const retry=(await linked.create(f.actor,{...newMarketAcquisitionPolicy,scope:{marketplace:site,nodeQuery:'12:34',month:'2026-09',headTopN:10,newProductMonths:6},fromMonth:'2026-09'},randomUUID())).batch;
  assert.equal(retry.modules.shapes.runId,shapes.id,'validated saved report must not be recollected');
  console.log(JSON.stringify({site,products:100,pluginHistory:200,pluginImages:100,localMisses,externalRequests:0,shapeRun:shapes.id}));
 }
});
