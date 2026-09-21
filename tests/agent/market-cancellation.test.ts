import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresMarketModelBudgetStore} from '../../server/db/postgres/market-model-budget-store';
import {MarketSemanticExecutionService} from '../../server/runtime/market-semantic-execution-service';
import {MarketModelBatchWorker, type MarketModelWorkerEvent} from '../../server/runtime/market-model-batch-worker';
import {SkillRegistry} from '../../server/skills/registry';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';
import type {FinalizeAgentRunOutcome} from '../../server/db/agent-run-repository';
import type {MarketModuleExecutionRepository} from '../../server/db/market-module-execution-repository';

const succeeded:FinalizeAgentRunOutcome={terminalStatus:'succeeded',validationStatus:'passed',responseId:'fixture',output:{ok:true},error:null,inputTokens:10,outputTokens:5,estimatedCostMicros:1,durationMs:1,attemptCount:1,usageCompleteness:'complete',attempts:[{ordinal:0,kind:'initial',transientRetryCount:0,formatRepair:false,accounting:'settled',errorClassification:null}],terminalMetadata:{kind:'succeeded'}};
test('market cancellation atomically terminates audits and fences late execution',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const registry=await SkillRegistry.open('skills-src'),manifest=(await registry.load('market-classify-keyword-demand','1.0.0')).manifest;
 const fixture=()=>createMarketSemanticFixture(pg.pool,{manifest});
 const read=(f:Awaited<ReturnType<typeof createMarketSemanticFixture>>)=>f.stores.audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId});
 const cancel=(f:Awaited<ReturnType<typeof createMarketSemanticFixture>>,key=randomUUID())=>f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:key});
 await t.test('idle pending audit cancels atomically, replay is immutable and foreign actors cannot cancel',async()=>{
  const f=await fixture(),other=await fixture(),key=randomUUID();
  await assert.rejects(()=>f.stores.steps.cancelModuleRun({actor:other.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:key}));
  await cancel(f,key);const rows=await read(f);assert.equal(rows[0].terminalStatus,'cancelled');assert.equal(rows[0].outcome?.output,null);assert.equal(rows[0].outcome?.attemptCount,0);
  assert.equal(rows[0].outcome?.inputTokens,null);assert.equal(rows[0].outcome?.usageCompleteness,'unavailable');
  await cancel(f,key);assert.deepEqual(await read(f),rows);
  await assert.rejects(()=>f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:succeeded}));
  await assert.rejects(()=>f.stores.audit.assertAgentRunClaim(f.authority));
  await assert.rejects(()=>f.stores.audit.beginAgentRun({...f.beginInput,id:randomUUID()}));
  assert.equal((await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId}))?.run.status,'cancelled');
 });
 await t.test('concurrent completion and cancellation serialize to one immutable audit outcome',async()=>{
  for(let i=0;i<3;i++){
   const f=await fixture();
   const results=await Promise.allSettled([f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:succeeded}),cancel(f)]);
   assert.equal(results[1].status,'fulfilled');const row=(await read(f))[0];
   assert.ok(row.terminalStatus==='cancelled'||row.terminalStatus==='succeeded');
   if(row.terminalStatus==='succeeded'){assert.equal(results[0].status,'fulfilled');assert.deepEqual(row.outcome,succeeded);}
   else {assert.equal(results[0].status,'rejected');assert.equal(row.outcome?.output,null);}
   const before=await read(f);await cancel(f);assert.deepEqual(await read(f),before);
  }
 });
 await t.test('cancel captures dispatched accounting without replacing late ledger settlement or completed history',async()=>{
  const f=await fixture(),budget=new PostgresMarketModelBudgetStore(f.context),id=randomUUID(),at=new Date().toISOString();
  const cap={maxTokens:1000,maxCostMicros:1000};
  await budget.reserve({id,idempotencyKey:randomUUID(),requestFingerprint:'b'.repeat(64),authority:f.authority,projected:{inputTokens:30,outputTokens:20,costMicros:5},limits:{call:cap,run:cap,organizationUtcDay:cap},reservedAt:at,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),request:{ordinal:0,kind:'initial',transientRetryCount:0,formatRepair:false}});
  const transition={reservationId:id,authority:f.authority,transitionedAt:at};await budget.dispatch(transition);
  await cancel(f);const rows=await read(f);assert.equal(rows[0].terminalStatus,'cancelled');assert.equal(rows[0].outcome?.attemptCount,1);assert.equal(rows[0].outcome?.attempts[0].accounting,'projected');assert.equal(rows[0].outcome?.inputTokens,null);
  await budget.settle({...transition,actual:{inputTokens:10,outputTokens:5,costMicros:1},responseId:'late-fixture'});
  assert.equal((await budget.getAgentUsage(f.authority)).inputTokens,10);assert.deepEqual(await read(f),rows);
  const completed=await fixture();await completed.stores.audit.finalizeAgentRun({authority:completed.authority,outcome:succeeded});const before=await read(completed);await cancel(completed);assert.deepEqual(await read(completed),before);
 });
 await t.test('an audit write error rolls cancellation and step fencing back together',async()=>{
  const f=await fixture();
  await pg.pool.query(`CREATE FUNCTION reject_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.record.id}' AND NEW.terminal_status='cancelled' THEN RAISE EXCEPTION 'fixture cancellation write failure'; END IF; RETURN NEW; END; $$`);
  await pg.pool.query('CREATE TRIGGER reject_cancel_audit BEFORE UPDATE ON market_agent_runs FOR EACH ROW EXECUTE FUNCTION reject_cancel_audit()');
  try {await assert.rejects(()=>cancel(f));assert.equal((await read(f))[0].terminalStatus,null);const view=await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId});assert.notEqual(view?.run.status,'cancelled');assert.equal(view?.steps.find(s=>s.id===f.subject.stepId)?.status,'running');}
  finally {await pg.pool.query('DROP TRIGGER reject_cancel_audit ON market_agent_runs');await pg.pool.query('DROP FUNCTION reject_cancel_audit()');}
 });
 await t.test('repeating cancellation safely closes legacy orphan audits on already cancelled runs',async()=>{
  const f=await fixture();
  await pg.pool.query("UPDATE market_analysis_step_attempts SET status='cancelled',finished_at=clock_timestamp() WHERE run_id=$1 AND status='running'",[f.subject.moduleRunId]);
  await pg.pool.query("UPDATE market_analysis_steps SET status='cancelled',lease_owner_id=NULL,lease_until=NULL WHERE run_id=$1 AND status='running'",[f.subject.moduleRunId]);
  await pg.pool.query("UPDATE market_analysis_module_runs SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",[f.subject.moduleRunId]);
  assert.equal((await read(f))[0].terminalStatus,null);await cancel(f);assert.equal((await read(f))[0].terminalStatus,'cancelled');
 });
 const cap={maxTokens:100000,maxCostMicros:1000000};
 // Exercise the configured tokenizer admission with a supported model identity;
 // the injected client below remains entirely synthetic and makes no network call.
 const config={task:'market-keyword-semantics' as const,configurationVersion:'fixture/v1',model:{name:'gpt-5.6',estimatedInputTokens:10000,maxOutputTokens:4000,timeoutMs:90000,pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}},providerName:'fixture',transport:'responses-strict' as const,limits:{call:cap,run:cap,organizationUtcDay:cap},openAI:{apiKey:'fixture'}};
 await t.test('cancelling during a model call returns the durable cancelled audit and never publishes the late output',async()=>{
  const f=await createMarketSemanticFixture(pg.pool,{manifest});
  await f.stores.steps.settleAndEnqueue({claim:f.modelClaim,outcome:{status:'failed',error:{code:'internal',retryable:false}}});
  await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:f.subject.moduleRunId,steps:[{stepId:f.modelClaim.stepId,failedAttemptId:f.modelClaim.attemptId}],idempotencyKey:randomUUID()});
  const claim=await f.stores.steps.claimStep({moduleRunId:f.subject.moduleRunId,leaseOwnerId:randomUUID(),leaseMs:30000});assert.ok(claim);
  const unknown={status:'unknown',reason:'insufficient-evidence',evidence:[]};let calls=0;
  const value={schemaVersion:'1.0.0',task:f.binding.task,batchId:f.inputProjection.batchId,inputDigest:f.inputProjection.inputDigest,keywords:[{keywordId:'keyword-a',W1:unknown,W2:unknown,W3:unknown,W4:unknown,cluster:unknown}],proposals:[],synonymRelations:[]};
  const client={responses:{create:async()=>{calls++;await cancel(f);return {id:'late',status:'completed',usage:{input_tokens:10,output_tokens:5,total_tokens:15},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]};}}} as unknown as OpenAIProviderOptions['client'];
  const result=await new MarketSemanticExecutionService(f.context,registry).executeBatch(claim,{...config,openAI:{apiKey:'fixture',client}});
  assert.equal(calls,1,`Cancellation must happen inside the fake provider call; premature failure: ${JSON.stringify(result.agentRun.outcome?.error)}`);
  assert.equal(result.agentRun.terminalStatus,'cancelled');assert.equal(result.value,null);
  assert.ok((await read(f)).every(r=>r.terminalStatus==='cancelled'));
  const view=await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId});assert.equal(view?.steps.find(s=>s.id===claim.stepId)?.status,'cancelled');
 });
 await t.test('worker treats a committed cancellation as cancelled rather than persistence failure',async()=>{
  const f=await fixture(),events:MarketModelWorkerEvent[]=[];
  await f.stores.steps.settleAndEnqueue({claim:f.modelClaim,outcome:{status:'failed',error:{code:'internal',retryable:false}}});
  await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:f.subject.moduleRunId,steps:[{stepId:f.modelClaim.stepId,failedAttemptId:f.modelClaim.attemptId}],idempotencyKey:randomUUID()});
  const steps={...f.stores.steps,claimStep:(options:Parameters<MarketModuleExecutionRepository['claimStep']>[0])=>f.stores.steps.claimStep({...options,moduleRunId:f.subject.moduleRunId}),renewStep:f.stores.steps.renewStep.bind(f.stores.steps),findModuleRun:f.stores.steps.findModuleRun.bind(f.stores.steps),settleAndEnqueue:f.stores.steps.settleAndEnqueue.bind(f.stores.steps)};
  const worker=new MarketModelBatchWorker({steps:steps as typeof f.stores.steps,audit:f.stores.audit,resolveConfiguration:()=>config,execution:{executeBatch:async()=>{await cancel(f);throw new Error('Cancellation race');}},onEvent:e=>events.push(e)});
  await worker.tick();await worker.stop();assert.equal(events.at(-1)?.event,'cancelled');assert.ok(!events.some(e=>e.event==='persistence-failed'));
 });
});
