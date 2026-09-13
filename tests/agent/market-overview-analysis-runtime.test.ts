import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';
import {MarketOverviewExplanationOutputSchema} from '../../shared/market-semantic-contracts';

test('A1 analysis mode uses its exact wire contract and saves model prose with immutable metric references',{timeout:120000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
  await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
  const base=loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-key',AGENT_VOC_MODEL:'synthetic-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'12000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'60000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-worker'});
  let calls=0;const client={responses:{create:async(body:any)=>{
    calls++;const input=JSON.parse(body.input);assert.ok(body.text.format.schema.properties.analysis);assert.equal(input.analysisBrief.mode,'synthesis');assert.equal(input.facts[0].factId,'f0');assert.equal(input.metricColumns[0],'metricId');
    const statement={parts:[{kind:'text',text:'该返回样本有可核对的成交记录，仍需验证其代表性'}],factIds:[input.facts[0].factId],gapIds:[]};
    const output={schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,findings:[],risks:[],validationTasks:[],analysis:{dimensions:[{dimensionId:input.analysisBrief.dimensions[0].id,data:{...statement,parts:[{kind:'metric',metricId:input.metrics[0][0]},{kind:'fact-label',factId:input.facts[0].factId}]},meaning:statement,conclusion:statement,limitations:[],verification:[statement]}],summary:{decision:'insufficient-evidence',statement}}};
    return {id:'synthetic-overview-prose',status:'completed',usage:{input_tokens:300,output_tokens:200,total_tokens:500},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output)}]}]};
  }}} as unknown as OpenAIProviderOptions['client'];
  const runtime=await createMarketModelRuntime(f.context,base,{client});t.after(()=>runtime.stop());
  const semantic={task:'market-overview-explanation',metrics:[{metricId:'units',state:'known',value:0,unit:{status:'known',unit:'count',rawUnit:'units'},period:{kind:'unknown',reason:'Request-bound response; month not echoed'},sourceRefs:[f.source.id],formulaVersion:'synthetic-source-value/v1',numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}}],gaps:[],facts:[{factId:'sales',kind:'value',metricRefs:['units'],sourceRefs:[f.source.id],statementTemplateId:'sample-units/v1'}],interpretationOptions:[],validationOptions:[],analysisBrief:{mode:'synthesis',referenceEncoding:'metric-table/v1',scopeStatement:'仅为返回样本，来源未确认月份',dimensions:[{id:'sales',label:'样本成交',factIds:['sales'],gapIds:[]}],factLabels:[{factId:'sales',label:'样本销量'}]}};
  const saved=await f.stores.snapshots.saveInput({actor:f.actor,studyId:f.scope.researchId,now:new Date().toISOString(),input:{scope:f.scope,kind:'overview',sourceVersion:'synthetic/v1',ruleVersion:'synthetic-analysis/v1',collectedAt:f.source.evidence.fetchedAt,expectedRecordIds:['overview'],records:[{id:'overview',scope:f.scope,data:{semantic}}]}});
  const initial={stepKey:'analysis/prepare',kind:'prepare-model-batches' as const,subject:{task:'market-overview-explanation'},input:{task:'market-overview-explanation',inputSnapshotId:saved.snapshot.snapshotId,selectionRevision:'synthetic-analysis/v1',dataCutoffAt:saved.snapshot.collectedAt},inputRefs:[{kind:'input' as const,id:saved.snapshot.snapshotId}]};
  const created=await f.stores.steps.createModuleRun({actor:f.actor,scope:f.scope,moduleKind:'overview',params:{},versions:{source:'synthetic/v1',rule:'synthetic-analysis/v1',mapping:'synthetic/v1',planner:'synthetic/v1',model:runtime.modelAlias,prompt:runtime.promptVersion,configuration:runtime.configurationVersion},collectionRevision:'synthetic/v1',idempotencyKey:randomUUID(),initialSteps:[initial]});
  for(let i=0;i<5&&await runtime.tick();i++){}
  const view=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:created.run.id}))!;assert.equal(view.steps.find(s=>s.kind==='model-batch')?.status,'succeeded',JSON.stringify(view.attempts));assert.equal(calls,1);
  const audit=(await f.stores.audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:created.run.id}))[0];assert.equal(audit.validationStatus,'passed');
  const output=MarketOverviewExplanationOutputSchema.parse(audit.outcome!.output);assert.equal(output.analysis!.dimensions[0].data.parts[0].kind,'metric');assert.match(JSON.stringify(output.analysis),/代表性/);assert.equal(output.analysis!.dimensions[0].dimensionId,'sales');assert.deepEqual(output.analysis!.dimensions[0].data.factIds,['sales']);assert.deepEqual(output.analysis!.dimensions[0].data.parts[0],{kind:'metric',metricId:'units'});
  await runtime.stop();const reopened=await createMarketModelRuntime(f.context,base,{client});t.after(()=>reopened.stop());assert.equal(await reopened.tick(),false);assert.equal(calls,1);
});
