import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresMarketShapeExplanationRunStore} from '../../server/db/postgres/market-shape-explanation-run-store';
import {createMarketShapeExplanationWindowStep} from '../../server/runtime/market-shape-explanation-window-step';
import {MarketSemanticBatchPreparationService} from '../../server/runtime/market-semantic-batch-preparation';
import {MarketSemanticExecutionService} from '../../server/runtime/market-semantic-execution-service';
import {decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {loadMarketShapeExplanationCatalog} from '../../server/services/market-shape-explanation-input-service';
import {readMarketShapeExplanationFragments} from '../../server/services/market-shape-explanation-fragment-service';
import {SkillRegistry} from '../../server/skills/registry';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketShapeExplanationRunFixture} from './helpers/market-shape-explanation-run-fixture';
import {startFakeOpenAIResponsesServer} from './helpers/fake-openai-responses-server';

test('fragment reader restores current audited windows, preserves partial work and rejects forged history',{timeout:180_000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketShapeExplanationRunFixture(pg.pool),registry=await SkillRegistry.open('skills-src');
 const configurationVersion='shape-fragment-reader/v1',linked=await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({actor:f.actor,parentRunId:f.parentRunId,request:f.request,idempotencyKey:randomUUID(),identity:{configurationVersion,promptVersion:'shape-fragment-reader-prompt/v1'}});
 const catalog=await loadMarketShapeExplanationCatalog(f.context,f.actor,linked.childRun.id),cap={maxTokens:100_000,maxCostMicros:1_000_000};let invalidFirst=true;
 const server=await startFakeOpenAIResponsesServer(body=>{const input=JSON.parse(body.input),decoded=decodeMarketShapeExplanationWindow(catalog,input.window),row=decoded.rows.find((r:any)=>r.cells.some((c:any)=>c.value!==null)),cell=row?.cells.find((c:any)=>c.value!==null);
  const codes=decoded.limitations.map((l:any)=>l.code),risk={kind:'risk',parts:[{kind:'text',text:'The fixed source boundary limits this interpretation.'}],evidenceRowIds:[],limitationCodes:codes};
  const observed=row&&cell?{kind:'observed',parts:[{kind:'text',text:'The saved value is '},{kind:'cell',rowId:row.id,cellId:invalidFirst?'forged-cell':cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;
  invalidFirst=false;
  return {schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,fragment:{version:'market-shape-explanation-fragment/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windowId:input.window.windowId,section:{dimension:input.window.dimension,status:row?'explained':'insufficient-evidence',summary:observed,findings:row?[observed]:[],limitations:[risk],verification:[{...risk,kind:'verification',parts:[{kind:'text',text:'Verify against an independent comparable source.'}]}]}}};
 });t.after(()=>server.close());
 const configuration:any={task:'market-shape-structure-explanation',configurationVersion,providerName:'local-reader-test',transport:'responses-strict',model:{name:'shape-reader',estimatedInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000,pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}},limits:{call:cap,run:cap,organizationUtcDay:cap},openAI:{apiKey:'test',baseUrl:server.baseUrl}};
 assert.equal((await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id})).status,'preparing');
 const anchor=await f.steps.claimStep({moduleRunId:linked.childRun.id,kinds:['prepare-members'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(anchor);
 const planned=await createMarketShapeExplanationWindowStep(f.context,{registry,configuration})({claim:anchor,signal:new AbortController().signal});assert.equal(planned.kind,'settlement');await f.steps.settleAndEnqueue({claim:anchor,...planned.value});
 const pending=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(pending.status,'pending');assert.ok(pending.windows.every((w:any)=>w.status==='pending'));
 const preparation=new MarketSemanticBatchPreparationService(f.context,registry),execution=new MarketSemanticExecutionService(f.context,registry);
 while(true){const claim=await f.steps.claimStep({moduleRunId:linked.childRun.id,kinds:['prepare-model-batches'],leaseOwnerId:randomUUID(),leaseMs:120000});if(!claim)break;await preparation.prepareBatches(claim,configuration);}
 while(true){const claim=await f.steps.claimStep({moduleRunId:linked.childRun.id,kinds:['model-batch'],leaseOwnerId:randomUUID(),leaseMs:120000});if(!claim)break;await execution.executeBatch(claim,configuration);}
 const partial=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(partial.status,'partial');const failedWindow=partial.windows.filter(w=>w.status==='failed');assert.equal(failedWindow.length,1);assert.ok(failedWindow[0]?.retryStepId);
 const failed=(await f.steps.findModuleRun({actor:f.actor,moduleRunId:linked.childRun.id}))!.steps.find(s=>s.kind==='model-batch'&&s.status==='failed')!;
 await f.steps.retryFailedSteps({actor:f.actor,moduleRunId:linked.childRun.id,steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}],idempotencyKey:randomUUID()});
 const retry=await f.steps.claimStep({moduleRunId:linked.childRun.id,kinds:['model-batch'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(retry);await execution.executeBatch(retry,configuration);
 const counts=async()=>JSON.stringify((await pg.pool.query(`SELECT (SELECT count(*) FROM market_analysis_step_attempts WHERE run_id=$1) attempts,(SELECT count(*) FROM market_agent_runs WHERE module_run_id=$1) audits,(SELECT count(*) FROM market_analysis_inputs WHERE study_id=$2) inputs`,[linked.childRun.id,f.scope.researchId])).rows[0]);
 const ready=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(ready.status,'ready-for-synthesis');assert.equal(ready.synthesisStatus,'not-started');const beforeRead=await counts();assert.equal((await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id})).status,'ready-for-synthesis');assert.equal(await counts(),beforeRead,'reader must not write');
 await assert.rejects(readMarketShapeExplanationFragments(f.context,{actor:{organizationId:randomUUID(),userId:randomUUID()},moduleRunId:linked.childRun.id}));
 await f.steps.cancelModuleRun({actor:f.actor,moduleRunId:linked.childRun.id,idempotencyKey:randomUUID()});const cancelled=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.fragments?.successful.length,ready.fragments?.successful.length);assert.ok(cancelled.windows.every(window=>window.retryStepId===null));
 const before=await pg.pool.query('SELECT output_json FROM market_analysis_step_attempts WHERE id=$1',[anchor.attemptId]);await pg.pool.query('ALTER TABLE market_analysis_step_attempts DISABLE TRIGGER USER');await pg.pool.query("UPDATE market_analysis_step_attempts SET output_json=jsonb_set(output_json,'{revisionId}',to_jsonb($2::text)) WHERE id=$1",[anchor.attemptId,'market-shape-revision:'+ 'f'.repeat(64)]);
 await assert.rejects(readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id}));
 await pg.pool.query('UPDATE market_analysis_step_attempts SET output_json=$2::jsonb WHERE id=$1',[anchor.attemptId,JSON.stringify(before.rows[0].output_json)]);
 await pg.pool.query('ALTER TABLE market_analysis_step_attempts ENABLE TRIGGER USER');
});

test('failed preparation anchor is explicit and retryable only while the run is active',{timeout:120_000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketShapeExplanationRunFixture(pg.pool);
 const linked=await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({actor:f.actor,parentRunId:f.parentRunId,request:f.request,idempotencyKey:randomUUID(),identity:{configurationVersion:'shape-anchor-reader/v1',promptVersion:'shape-anchor-prompt/v1'}});
 const claim=await f.steps.claimStep({moduleRunId:linked.childRun.id,kinds:['prepare-members'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(claim);await f.steps.settleAndEnqueue({claim,outcome:{status:'failed',error:{code:'timeout',retryable:false}}});
 const failed=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(failed.status,'partial');assert.equal(failed.errorCode,'timeout');assert.equal(failed.retryStepId,claim.stepId);
 await f.steps.cancelModuleRun({actor:f.actor,moduleRunId:linked.childRun.id,idempotencyKey:randomUUID()});const cancelled=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.errorCode,'timeout');assert.equal(cancelled.retryStepId,null);
});
