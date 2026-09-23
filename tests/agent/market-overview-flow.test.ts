import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {createMarketSourceStepHandlers,MARKET_SOURCE_HANDLER_VERSION} from '../../server/runtime/market-source-step-handlers';
import {createMarketOverviewCatalogStep,readMarketOverviewCatalog} from '../../server/runtime/market-overview-catalog-step';
import {MARKET_OVERVIEW_FLOW_VERSION,MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION,marketOverviewFlowInitialSteps,inspectMarketOverviewContinuation} from '../../server/domain/market-research/overview-flow';
import {MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION} from '../../server/domain/market-research/overview-complete-catalog';
import {MARKET_OVERVIEW_CATALOG_VERSION} from '../../server/domain/market-research/overview-source-catalog';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {createAgentService} from '../../server/agent-service';
import {PostgresAgentRepository} from '../../server/db/postgres-repository';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';
import {createMarketOverviewReportStep} from '../../server/runtime/market-overview-report-step';
import {MarketOverviewReportService} from '../../server/services/market-overview-report-service';

test('overview source barrier saves numbers independently and fences retried source generations',{timeout:120000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
  await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
  const calls:string[]=[];let failJuly=true,failAll=false,emptyDistributions=false;
  const connector:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw new Error('unused');},execute:async request=>{
    const q=request.input.request as any;calls.push(`${q.month}/${request.operation}`);
    if(failAll)throw new ConnectorError('sellerSprite','authentication',false);
    if(q.month==='202607'&&request.operation==='market_research_statistics'&&failJuly)throw new ConnectorError('sellerSprite','upstream-permanent',false);
    const row={nodeIdPath:f.scope.nodeIdPath,nodeId:'34',month:q.month,currency:'USD',marketplace:'US',topProducts:100,totalUnits:q.month==='202608'?0:100,totalRevenue:q.month==='202608'?0:2000};
    const data=emptyDistributions&&request.operation==='market_product_demand_trend'?{items:[]}:emptyDistributions&&!['market_research','market_research_statistics'].includes(request.operation)?[]:request.operation==='market_research'?{items:q.month==='202607'?[]:[row]}:row;
    return {data:{code:'OK',data},source:{connectorId:'sellerSprite',operation:request.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
  }};
  const catalog=createMarketOverviewCatalogStep(f.context),handlers={...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:connector,sorftime:connector}}),rules:catalog};
  const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers});t.after(()=>worker.stop());
  const request=()=>({actor:f.actor,scope:f.scope,moduleKind:'overview' as const,params:{flow:MARKET_OVERVIEW_FLOW_VERSION,headTopN:10,newProductMonths:6},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_CATALOG_VERSION,mapping:MARKET_OVERVIEW_CATALOG_VERSION,planner:MARKET_OVERVIEW_FLOW_VERSION,model:null,prompt:null,configuration:null},collectionRevision:randomUUID(),idempotencyKey:randomUUID()});
  const create=async()=>{const r=request();return (await f.stores.steps.createModuleRun({...r,initialSteps:marketOverviewFlowInitialSteps(r)})).run;};
  const view=async(id:string)=>(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:id}))!;
  await t.test('product rules flow finishes after its saved report',async()=>{
    failJuly=false;emptyDistributions=true;
    try{
      const original=request(),r={...original,params:{...original.params,flow:MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION},versions:{...original.versions,rule:MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION,mapping:MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION,planner:MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION}};
      const run=(await f.stores.steps.createModuleRun({...r,initialSteps:marketOverviewFlowInitialSteps(r)})).run;
      for(let i=0;i<marketOverviewFlowInitialSteps(r).length+1;i++)assert.equal(await worker.tick(),true);
      assert.equal((await view(run.id)).steps.find(s=>s.kind==='rules')?.status,'succeeded');
      const claim=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['report'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(claim);
      const work=await createMarketOverviewReportStep(f.context)({claim,signal:new AbortController().signal});assert.equal(work.kind,'settlement');if(work.kind!=='settlement')throw Error('Expected report settlement');
      await f.stores.steps.settleAndEnqueue({...work.value,claim});
      const saved=await view(run.id);assert.equal(saved.run.status,'succeeded',JSON.stringify(saved.steps.filter(s=>s.status==='failed').map(s=>s.stepKey)));assert.equal(saved.steps.find(s=>s.kind==='report')?.status,'succeeded');
    }finally{failJuly=true;emptyDistributions=false;}
  });
  await t.test('all months/endpoints are fixed; omitted or changed initial definitions reject',async()=>{
    const r=request(),initial=marketOverviewFlowInitialSteps(r);assert.equal(initial.length,4);
    await assert.rejects(f.stores.steps.createModuleRun({...r,initialSteps:initial.slice(1)}));
    await assert.rejects(f.stores.steps.createModuleRun({...r,initialSteps:initial.map((s,i)=>i? s:{...s,input:{...(s.input as any),headTopN:20}})}));
  });
  await t.test('numeric snapshot retains failed/empty provenance and a retry preserves prior successful attempts',async()=>{
    const run=await create(),before=calls.length;for(let i=0;i<4;i++)await worker.tick();
    const pending=await view(run.id);assert.equal(pending.steps.filter(s=>s.kind==='rules'&&s.status==='queued').length,1);await worker.tick();
    const first=await view(run.id),rules=first.steps.find(s=>s.kind==='rules')!,a=first.attempts.find(a=>a.id===rules.latestAttemptId)!;assert.equal(a.status,'succeeded');
    const output=a.output as any,old=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:output.numericInputSnapshotId});assert.ok(old);
    assert.equal((old.snapshot.records[0].data as any).metrics.totalUnits.reason,'collection-failed');assert.equal((old.snapshot.records[1].data as any).metrics.totalUnits.value,0);
    assert.equal(output.sourceReceipts.length,4);assert.equal(output.sourceReceipts.filter((r:any)=>r.status==='empty').length,1);assert.equal(output.semanticStatus,'pending');assert.equal(output.ruleBaseline.module,'overview');assert.equal(output.ruleBaseline.metrics.some((metric:any)=>metric.value===0),true);assert.notEqual(first.run.status,'succeeded');
    const previous=digest(old.snapshot),successful=first.steps.filter(s=>s.kind==='collect-overview-month'&&s.status!=='failed'),failed=first.steps.find(s=>s.status==='failed')!;assert.ok(failed);
    failJuly=false;await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}],idempotencyKey:randomUUID()});
    await worker.tick();await worker.tick();const second=await view(run.id),current=new Set(inspectMarketOverviewContinuation(second,new Date().toISOString()).currentStepKeys);
    const latest=second.steps.find(s=>s.kind==='rules'&&current.has(s.stepKey))!;assert.notEqual(latest.id,rules.id);assert.equal(latest.status,'succeeded');
    const newOutput=second.attempts.find(a=>a.id===latest.latestAttemptId)!.output as any,newNumbers=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:newOutput.numericInputSnapshotId});
    assert.equal((newNumbers!.snapshot.records[0].data as any).metrics.totalUnits.value,100);assert.deepEqual(newOutput.failures,[]);
    assert.equal(digest((await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:old.snapshot.snapshotId}))!.snapshot),previous);
    for(const s of successful)assert.equal(second.steps.find(x=>x.id===s.id)!.latestAttemptId,s.latestAttemptId);
    assert.equal(calls.length-before,5);assert.notEqual(second.run.status,'succeeded');
    const historical=await readMarketOverviewCatalog(f.context,second,a.id,new AbortController().signal,'frozen');assert.equal(digest(historical.catalog.numericSnapshot),previous);
    await assert.rejects(readMarketOverviewCatalog(f.context,second,a.id,new AbortController().signal));
  });
  await t.test('late old calculation cannot save snapshots after a failed source is requeued',async()=>{
    failJuly=true;const run=await create();for(let i=0;i<4;i++)await worker.tick();
    const claim=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['rules'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(claim);
    const work=await catalog({claim,signal:new AbortController().signal});assert.equal(work.kind,'settlement');if(work.kind!=='settlement')throw new Error('Expected settlement');
    const pending=await view(run.id),failed=pending.steps.find(s=>s.status==='failed')!;await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}],idempotencyKey:randomUUID()});
    const receipt=await f.stores.steps.settleAndEnqueue({...work.value,claim});assert.deepEqual(receipt.inputIds,[]);assert.deepEqual(receipt.childStepIds,[]);
    assert.equal(((await view(run.id)).attempts.find(a=>a.id===claim.attemptId)!.output as any).superseded,true);
    await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:run.id,idempotencyKey:randomUUID()});
  });
  await t.test('actual no-model Agent Service continues from collected sources to saved numbers',async()=>{
    failJuly=false;const run=await create();const service=await createAgentService({repository:new PostgresAgentRepository(pg.pool),logger:false,connectors:{sellerSprite:connector,sorftime:connector,sif:{...connector,id:'sif'}},env:{AGENT_SERVICE_PROXY_TOKEN:'synthetic-service-token',AGENT_SERVICE_TRUSTED_ORIGINS:'http://127.0.0.1:3001',AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK:'1'}});
    try{await service.start({host:'127.0.0.1',port:0});const deadline=Date.now()+10000;let saved=await view(run.id);
      while(!saved.steps.some(s=>s.kind==='rules'&&s.status==='succeeded')&&Date.now()<deadline){await new Promise(r=>setTimeout(r,25));saved=await view(run.id);}
      assert.ok(saved.steps.some(s=>s.kind==='rules'&&s.status==='succeeded'),JSON.stringify(saved.steps));assert.notEqual(saved.run.status,'succeeded');
    }finally{await service.stop();}
  });
  await t.test('configured combined runtime runs numeric rules without making a model call',async()=>{
    const base=loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-key',AGENT_VOC_MODEL:'synthetic-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',
      AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-worker'});
    let modelCalls=0;const client={responses:{create:async()=>{modelCalls++;throw new Error('Numeric collection cannot call a model');}}} as unknown as OpenAIProviderOptions['client'];
    const runtime=await createMarketModelRuntime(f.context,base,{client,connectors:{sellerSprite:connector,sorftime:connector}});
    try{const original=request(),r={...original,versions:{...original.versions,model:runtime.modelAlias,prompt:runtime.promptVersion,configuration:runtime.configurationVersion}};
      const run=(await f.stores.steps.createModuleRun({...r,initialSteps:marketOverviewFlowInitialSteps(r)})).run;
      for(let i=0;i<5;i++)assert.equal(await runtime.tick(),true);
      const saved=await view(run.id);assert.equal(saved.steps.find(s=>s.kind==='rules')?.status,'succeeded');assert.equal(modelCalls,0);assert.notEqual(saved.run.status,'succeeded');
    }finally{await runtime.stop();}
  });
  await t.test('missing model configuration explicitly fails the explanation plan while keeping numeric facts',async()=>{
    const original=request(),r={...original,params:{...original.params,flow:MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION},versions:{...original.versions,planner:MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION}};
    const run=(await f.stores.steps.createModuleRun({...r,initialSteps:marketOverviewFlowInitialSteps(r)})).run;
    const service=await createAgentService({repository:new PostgresAgentRepository(pg.pool),logger:false,connectors:{sellerSprite:connector,sorftime:connector,sif:{...connector,id:'sif'}},env:{AGENT_SERVICE_PROXY_TOKEN:'synthetic-service-token',AGENT_SERVICE_TRUSTED_ORIGINS:'http://127.0.0.1:3001',AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK:'1'}});
    try{await service.start({host:'127.0.0.1',port:0});const deadline=Date.now()+12000;let saved=await view(run.id);
      while(!saved.attempts.some(a=>(a.output as any)?.reportVersion==='market-overview-report/v1'&&(a.output as any)?.phase==='window-results')&&Date.now()<deadline){await new Promise(r=>setTimeout(r,25));saved=await view(run.id);}
      const window=saved.steps.find(s=>s.kind==='prepare-members');assert.equal(window?.status,'failed');assert.deepEqual(saved.attempts.find(a=>a.id===window!.latestAttemptId)!.error,{code:'governance',retryable:false});
      const rules=saved.steps.find(s=>s.kind==='rules'&&s.status==='succeeded');assert.equal((saved.attempts.find(a=>a.id===rules!.latestAttemptId)!.output as any).ruleBaseline.module,'overview');
      const row=(await pg.pool.query('SELECT diagnostic_json FROM market_analysis_step_attempts WHERE id=$1',[window!.latestAttemptId])).rows[0];assert.equal(row.diagnostic_json.reason,'model-configuration-unavailable');
      assert.ok(await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:row.diagnostic_json.numericInputSnapshotId}));assert.equal(saved.steps.some(s=>s.kind==='model-batch'),false);
      const report=(await new MarketOverviewReportService(f.context).read({actor:f.actor,moduleRunId:run.id}))?.currentReport?.report;
      assert.equal(report?.windowStatus,'partial');assert.equal(report?.dataReady,true);assert.equal(report?.failures[0]?.stage,'planning');
    }finally{await service.stop();}
  });
  await t.test('frozen v2 catalog run still executes and replays under the v3 default',async()=>{
    const original=request(),r={...original,versions:{...original.versions,rule:'market-overview-source-catalog/v2',mapping:'market-overview-source-catalog/v2'}};
    const run=(await f.stores.steps.createModuleRun({...r,initialSteps:marketOverviewFlowInitialSteps(r)})).run;
    for(let i=0;i<5;i++)assert.equal(await worker.tick(),true);
    const saved=await view(run.id),step=saved.steps.find(s=>s.kind==='rules')!;assert.equal(step.status,'succeeded');
    const replay=await readMarketOverviewCatalog(f.context,saved,step.latestAttemptId!,new AbortController().signal);
    assert.equal(replay.catalog.version,'market-overview-source-catalog/v2');
    assert.equal(replay.catalog.numericSnapshot.ruleVersion,'market-overview-source-catalog/v2');
    assert.equal(digest(replay.output),digest(saved.attempts.find(a=>a.id===step.latestAttemptId)!.output));
  });
  await t.test('all endpoints failed still save explicit missing facts and never manufacture semantic input',async()=>{
    failAll=true;try{const run=await create();for(let i=0;i<5;i++)await worker.tick();const saved=await view(run.id),step=saved.steps.find(s=>s.kind==='rules')!;assert.equal(step.status,'empty');
      const output=saved.attempts.find(a=>a.id===step.latestAttemptId)!.output as any;assert.equal(output.failures.length,4);assert.deepEqual(output.sourceRefs,[]);assert.equal(output.semanticInputSnapshotId,null);assert.equal(output.semanticStatus,'no-input');
      const numbers=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:output.numericInputSnapshotId});assert.ok(numbers);
      for(const row of numbers.snapshot.records)for(const metric of Object.values((row.data as any).metrics) as any[]){assert.equal(metric.value,null);assert.equal(metric.reason,'collection-failed');}
      assert.notEqual(saved.run.status,'succeeded');
    }finally{failAll=false;}
  });
  await t.test('numeric report publication rejects forged output and keeps frozen source history after retry',async()=>{
    failJuly=true;const original=request(),r={...original,params:{...original.params,flow:MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION},versions:{...original.versions,planner:MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION}};
    const run=(await f.stores.steps.createModuleRun({...r,initialSteps:marketOverviewFlowInitialSteps(r)})).run;
    for(let i=0;i<5;i++)assert.equal(await worker.tick(),true);
    const claim=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['report'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(claim);
    const result=await createMarketOverviewReportStep(f.context)({claim,signal:new AbortController().signal});assert.equal(result.kind,'settlement');if(result.kind!=='settlement'||result.value.outcome.status==='failed')throw new Error('Expected numeric report');
    const report=result.value.outcome.output as any;
    const {reportHash:ignored,...body}=report;void ignored;const forged={...body,dataReady:false};
    await assert.rejects(f.stores.steps.settleAndEnqueue({claim,outcome:{status:'empty',output:{...forged,reportHash:digest(forged)}}}));
    assert.equal((await view(run.id)).run.latestReportAttemptId,null);
    assert.equal((await f.stores.steps.settleAndEnqueue({claim,...result.value})).status,'committed');
    const reader=new MarketOverviewReportService(f.context),before=await reader.read({actor:f.actor,moduleRunId:run.id});assert.equal(before?.currentReport?.report.windowStatus,'pending');
    const failed=(await view(run.id)).steps.find(s=>s.status==='failed')!;assert.ok(failed);failJuly=false;
    await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}],idempotencyKey:randomUUID()});
    const pending=await reader.read({actor:f.actor,moduleRunId:run.id});assert.equal(pending?.currentReport,null);assert.equal(digest(pending?.latestSavedReport?.report),digest(report));
    await worker.tick();await worker.tick();const after=await reader.read({actor:f.actor,moduleRunId:run.id});assert.equal(digest(after?.history.find(h=>h.attemptId===claim.attemptId)?.report),digest(report));
  });
});
