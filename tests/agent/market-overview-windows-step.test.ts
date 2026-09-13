import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,marketOverviewFlowInitialSteps,inspectMarketOverviewContinuation} from '../../server/domain/market-research/overview-flow';
import {MARKET_OVERVIEW_CATALOG_VERSION} from '../../server/domain/market-research/overview-source-catalog';
import {MarketOverviewWindowPlanSchema} from '../../server/domain/market-research/overview-window-plan';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {MarketOverviewReportService} from '../../server/services/market-overview-report-service';
import Fastify from 'fastify';
import {registerMarketModuleRoutes} from '../../server/routes/market-modules';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketOverviewRunResponseSchema,MarketOverviewDetailsResponseSchema} from '../../shared/market-overview-report-contracts';

const base=loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-key',AGENT_VOC_MODEL:'synthetic-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',
  AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-worker'});

test('native overview windows preserve every fact through restart and isolated model retry',{timeout:120000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
  await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
  let sourceCalls=0,modelCalls=0,failOne=true,failedDigest:string|null=null;
  const connector:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw new Error('unused');},execute:async request=>{
    sourceCalls++;const q=request.input.request as any,row={nodeIdPath:f.scope.nodeIdPath,nodeId:'34',month:q.month,marketplace:'US',currency:'USD',topProducts:100,totalUnits:q.month==='202607'?1000:200,totalRevenue:q.month==='202607'?20000:4000,
      brands:12,sellers:15,avgPrice:20,avgUnits:q.month==='202607'?10:2,avgRatings:125,avgRating:4.5,top10ProductCrn:0.42,top10BrandCrn:0.5,top10SellerCrn:0.6,l6NewCount:10,l6NewAvgPrice:18,l6NewAvgSales:3,newCount:10,newAvgPrice:18,newAvgUnits:3};
    return {data:{code:'OK',data:request.operation==='market_research'?{items:[row]}:row},source:{connectorId:'sellerSprite',operation:request.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
  }};
  const seen=new Set<string>();const client={responses:{create:async(body:{input:string})=>{
    modelCalls++;const input=JSON.parse(body.input);assert.equal(input.task,'market-overview-explanation');failedDigest??=input.inputDigest;
    for(const fact of input.facts)seen.add(fact.factId);
    const output={schemaVersion:failOne&&input.inputDigest===failedDigest?'invalid-synthetic':'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,
      findings:[{findingId:'observed',mode:'observed',factIds:input.facts.map((x:any)=>x.factId),evidenceRefs:[...new Set(input.facts.flatMap((x:any)=>x.sourceRefs))]}],risks:[],validationTasks:[]};
    return {id:'synthetic-overview-window',status:'completed',usage:{input_tokens:100,output_tokens:50,total_tokens:150},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output)}]}]};
  }}} as unknown as OpenAIProviderOptions['client'];
  const makeRuntime=()=>createMarketModelRuntime(f.context,base,{client,connectors:{sellerSprite:connector,sorftime:connector}});
  let runtime=await makeRuntime();t.after(()=>runtime.stop());
  const request={actor:f.actor,scope:f.scope,moduleKind:'overview' as const,params:{flow:MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,headTopN:10,newProductMonths:6},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_CATALOG_VERSION,mapping:MARKET_OVERVIEW_CATALOG_VERSION,planner:MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,model:runtime.modelAlias,prompt:runtime.promptVersion,configuration:runtime.configurationVersion},collectionRevision:randomUUID(),idempotencyKey:randomUUID()};
  const run=(await f.stores.steps.createModuleRun({...request,initialSteps:marketOverviewFlowInitialSteps(request)})).run,view=async()=>(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!;
  for(let i=0;i<5;i++)assert.equal(await runtime.tick(),true);
  const before=await view(),catalog=before.steps.find(s=>s.kind==='rules')!,catalogOutput=before.attempts.find(a=>a.id===catalog.latestAttemptId)!.output as any;
  assert.equal(catalog.status,'succeeded');assert.equal(modelCalls,0);const numbers=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:catalogOutput.numericInputSnapshotId});assert.ok(numbers);const numericHash=digest(numbers.snapshot);
  await runtime.stop();runtime=await makeRuntime();
  for(let i=0;i<5&&!(await view()).steps.some(s=>s.kind==='prepare-members'&&s.status==='succeeded');i++)assert.equal(await runtime.tick(),true,JSON.stringify((await view()).attempts.map(a=>({status:a.status,error:a.error,output:a.output}))));
  const planned=await view(),window=planned.steps.find(s=>s.kind==='prepare-members')!;assert.equal(window.status,'succeeded',JSON.stringify(planned.attempts));
  const manifest=MarketOverviewWindowPlanSchema.parse(planned.attempts.find(a=>a.id===window.latestAttemptId)!.output);
  assert.deepEqual(manifest.rejected,[]);assert.ok(manifest.windows.length>1);assert.equal(modelCalls,0);
  const full=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:manifest.basisSnapshotId}),semantic=(full!.snapshot.records[0].data as any).semantic;
  assert.deepEqual(manifest.windows.flatMap(w=>w.primaryFactIds).sort(),semantic.facts.map((v:any)=>v.factId).sort());assert.deepEqual(manifest.windows.flatMap(w=>w.gapIds).sort(),semantic.gaps.map((v:any)=>v.gapId).sort());
  for(let i=0;i<50&&await runtime.tick();i++){}
  const first=await view(),models=first.steps.filter(s=>s.kind==='model-batch');assert.equal(models.length,manifest.windows.length);const failed=models.filter(s=>s.status==='failed');assert.equal(failed.length,1);assert.equal(models.filter(s=>s.status==='succeeded').length,models.length-1);
  assert.equal(sourceCalls,4);assert.deepEqual([...seen].sort(),semantic.facts.map((v:any)=>v.factId).sort());
  const reports=new MarketOverviewReportService(f.context),firstReports=await reports.read({actor:f.actor,moduleRunId:run.id});assert.ok(firstReports?.currentReport);
  assert.equal(firstReports.currentReport.report.windowStatus,'partial');assert.equal(firstReports.currentReport.report.modelResults.length,manifest.windows.length);
  const oldReport=firstReports.currentReport,oldHash=digest(oldReport.report);
  assert.equal(oldReport.report.analysisStatus,'partial');assert.ok(oldReport.report.coverage.some(c=>c.dimension==='search-demand'&&c.status==='not-integrated'));
  const successful=models.filter(s=>s.status==='succeeded'),calls=modelCalls;failOne=false;
  await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed[0].id,failedAttemptId:failed[0].latestAttemptId!}],idempotencyKey:randomUUID()});
  await runtime.stop();runtime=await makeRuntime();assert.equal(await runtime.tick(),true);const recovered=await view();
  assert.equal(recovered.steps.find(s=>s.id===failed[0].id)!.status,'succeeded');assert.equal(modelCalls,calls+1);assert.equal(sourceCalls,4);for(const s of successful)assert.equal(recovered.steps.find(x=>x.id===s.id)!.latestAttemptId,s.latestAttemptId);
  assert.equal(digest((await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:numbers.snapshot.snapshotId}))!.snapshot),numericHash);
  const audits=await f.stores.audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:run.id});assert.equal(audits.filter(a=>a.terminalStatus==='succeeded').length,manifest.windows.length);assert.equal(audits.filter(a=>a.terminalStatus!=='succeeded').length,1);
  for(let i=0;i<5&&await runtime.tick();i++){}
  const finalReports=await reports.read({actor:f.actor,moduleRunId:run.id});assert.ok(finalReports?.currentReport);
  assert.equal(finalReports.currentReport.report.windowStatus,'complete');assert.equal(finalReports.currentReport.report.analysisStatus,'partial');
  const historical=finalReports.history.find(r=>r.attemptId===oldReport.attemptId);assert.ok(historical);assert.equal(historical.current,false);assert.equal(digest(historical.report),oldHash);
  const app=Fastify();t.after(()=>app.close());app.decorateRequest('authPrincipal',null);
  let organizationId=f.actor.organizationId;app.addHook('preHandler',async req=>{req.authPrincipal={kind:'user',...f.actor,organizationId,role:'member',email:'test@example.test',sessionId:randomUUID()};});
  // History remains readable after the model service is unavailable.
  registerMarketModuleRoutes(app,new MarketModuleService({context:f.context,modelIdentity:()=>null}));
  const get=await app.inject({method:'GET',url:`/v1/market-analysis/runs/${run.id}/overview`});assert.equal(get.statusCode,200,get.body);
  assert.equal(MarketOverviewRunResponseSchema.parse(get.json()).run.currentReport?.report.windowStatus,'complete');
  const details=await app.inject({method:'GET',url:`/v1/market-analysis/runs/${run.id}/reports/${oldReport.attemptId}/overview`});assert.equal(details.statusCode,200,details.body);
  const detail=MarketOverviewDetailsResponseSchema.parse(details.json());assert.equal(digest(detail.entry.report),oldHash);assert.equal(detail.numbers.months.length,2);
  const url=`/v1/market-analysis/studies/${f.scope.researchId}/overview`,headers={'idempotency-key':randomUUID()};
  const start=await app.inject({method:'POST',url,payload:{headTopN:10,newProductMonths:6},headers});assert.equal(start.statusCode,201,start.body);
  assert.equal((await app.inject({method:'POST',url,payload:{headTopN:10,newProductMonths:6},headers})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url,payload:{headTopN:10,model:'caller-override'},headers})).statusCode,400);
  organizationId=randomUUID();assert.equal((await app.inject({method:'GET',url:`/v1/market-analysis/runs/${run.id}/overview`})).statusCode,404);
  assert.equal((await app.inject({method:'GET',url:`/v1/market-analysis/runs/${run.id}/reports/${oldReport.attemptId}/overview`})).statusCode,404);
  organizationId=f.actor.organizationId;assert.equal(sourceCalls,4);assert.equal(modelCalls,calls+1);
  const current=new Set(inspectMarketOverviewContinuation(await view(),new Date().toISOString()).currentStepKeys);for(const s of recovered.steps.filter(s=>s.kind!=='report'))assert.ok(current.has(s.stepKey));
  await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:run.id,idempotencyKey:randomUUID()});
  const cancelled=await reports.read({actor:f.actor,moduleRunId:run.id});assert.equal(cancelled?.currentReport,null);assert.equal(digest(cancelled?.history.find(h=>h.attemptId===oldReport.attemptId)?.report),oldHash);
  assert.notEqual(recovered.run.status,'succeeded');t.diagnostic(JSON.stringify({windows:manifest.windows.length,facts:semantic.facts.length,gaps:semantic.gaps.length,sourceCalls,modelCalls}));
});
