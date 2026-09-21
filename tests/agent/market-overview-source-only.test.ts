import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createAgentService} from '../../server/agent-service';
import {PostgresAgentRepository} from '../../server/db/postgres-repository';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {marketOverviewFlowInitialSteps} from '../../server/domain/market-research/overview-flow';
import {MARKET_OVERVIEW_TABLE_CATALOG_VERSION} from '../../server/domain/market-research/overview-complete-catalog';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {MarketOverviewReportService} from '../../server/services/market-overview-report-service';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';

test('production source-only worker finishes complete overview numbers and reports missing semantics', {timeout:240000}, async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);
 await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 let sourceCalls=0;
 const connector:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('unused');},execute:async request=>{
  sourceCalls++;
  const month=(request.input.request as {month:string}).month;
  const identity={marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,month};
  const basic={...identity,topProducts:10,products:10,totalUnits:100,totalRevenue:2000};
  const data=request.operation==='market_research'?{items:[basic]}:request.operation==='market_research_statistics'?basic:[];
  return {data:{code:'OK',...identity,data},source:{connectorId:'sellerSprite',operation:request.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const base=loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-key',AGENT_VOC_MODEL:'synthetic-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'12000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'60000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'1000000',AGENT_VOC_CALL_MAX_COST_MICROS:'10000000',AGENT_VOC_RUN_MAX_TOKENS:'1000000',AGENT_VOC_RUN_MAX_COST_MICROS:'10000000',AGENT_VOC_DAILY_MAX_TOKENS:'1000000',AGENT_VOC_DAILY_MAX_COST_MICROS:'10000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-recovery-worker'});
 let modelCalls=0;
 const client={responses:{create:async()=>{modelCalls++;throw Error('The interrupted setup must stop before model execution');}}} as unknown as OpenAIProviderOptions['client'];
 const cases=[{flow:'market-overview-flow/v4',phase:'sources'},{flow:'market-overview-flow/v5',phase:'sources'},
  {flow:'market-overview-flow/v5',phase:'prepare-model-batches'},{flow:'market-overview-flow/v5',phase:'model-batch'}];
 for(const {flow,phase} of cases)await t.test(`${flow}/${phase}`,async()=>{
  const configured=phase==='sources'?null:await createMarketModelRuntime(f.context,base,{client,connectors:{sellerSprite:connector,sorftime:connector}});
  const request={actor:f.actor,scope:f.scope,moduleKind:'overview' as const,params:{flow,headTopN:10,newProductMonths:6},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_TABLE_CATALOG_VERSION,mapping:MARKET_OVERVIEW_TABLE_CATALOG_VERSION,planner:flow,model:configured?.modelAlias??null,prompt:configured?.overviewSynthesisPromptVersion??null,configuration:configured?.overviewSynthesisConfigurationVersion??null},collectionRevision:`source-only/test-v1/${phase}`,idempotencyKey:randomUUID()};
  const run=(await f.stores.steps.createModuleRun({...request,initialSteps:marketOverviewFlowInitialSteps(request)})).run;
  // Source-only precollection keeps this a production fallback-wiring test, without waiting 26 polling intervals.
  const collector=new MarketModuleStepWorker({steps:f.stores.steps,handlers:createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:connector,sorftime:connector}})});
  try {for(let i=0;i<40&&await collector.tick();i++){} } finally {await collector.stop();}
  if(configured)try {
   for(let i=0;i<90;i++){
    const view=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;
    if(view.steps.some(step=>step.kind===phase&&step.status==='queued'))break;
    assert.equal(await configured.tick(),true,'Configured setup must reach its interrupted phase');
   }
   assert.ok((await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!.steps.some(step=>step.kind===phase&&step.status==='queued'));
  }finally {await configured.stop();}
  const calls=sourceCalls;
  const queuedAtRestart=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!.steps.filter(step=>step.status==='queued').length;
  const service=await createAgentService({repository:new PostgresAgentRepository(pg.pool),logger:false,connectors:{sellerSprite:connector,sorftime:connector,sif:{...connector,id:'sif'}},env:{AGENT_SERVICE_PROXY_TOKEN:'synthetic-service-token',AGENT_SERVICE_TRUSTED_ORIGINS:'http://127.0.0.1:3001',AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK:'1'}});
  try {
   await service.start({host:'127.0.0.1',port:0});
   // Production polling and database settlement both take time; bound the entire restart,
   // including the final report enqueued only after all frozen windows settle.
   const reports=new MarketOverviewReportService(f.context),deadline=Date.now()+60000;
   let current=(await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport;
   while(current?.report.phase!=='window-results'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,250));current=(await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport;}
   assert.ok(current,'The real no-model worker must save a numeric report for the complete flow');
   const recovery=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;
   assert.equal(current.report.phase,'window-results',JSON.stringify({queuedAtRestart,steps:recovery.steps.map(step=>({kind:step.kind,status:step.status})),errors:recovery.attempts.filter(attempt=>attempt.status==='failed').map(attempt=>attempt.error)}));
   assert.equal(current.report.dataReady,true);assert.equal(current.report.windowStatus,'partial');
   assert.ok(current.report.failures.length>0);
   if(phase==='sources')assert.ok(current.report.failures.some(failure=>failure.stage==='planning'));
   const view=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;
   assert.equal(view.steps.some(step=>step.status==='queued'||step.status==='running'),false,'No unsupported semantic work remains stuck');
   assert.equal(view.steps.some(step=>(step.input as {phase?:string}).phase==='prepare-overview-synthesis'),false);
   const unavailable=view.steps.filter(step=>step.status==='failed'&&['prepare-members','prepare-model-batches','model-batch'].includes(step.kind));assert.ok(unavailable.length>0);
   for(const step of unavailable)assert.deepEqual(view.attempts.find(attempt=>attempt.id===step.latestAttemptId)!.error,{code:'governance',retryable:false});
   const saved=await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:current.attemptId});
   assert.deepEqual(await reports.details({actor:f.actor,moduleRunId:run.id,attemptId:current.attemptId}),saved);
   assert.equal(sourceCalls,calls,'History reads and fallback restart must not recollect sources');
   assert.equal(modelCalls,0,'An unavailable runtime must never execute semantic tasks');
  } finally {await service.stop();await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:run.id,idempotencyKey:randomUUID()});}
 });
});
