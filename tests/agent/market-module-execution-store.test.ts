import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresMarketModuleExecutionStore } from "../../server/db/postgres/market-module-execution-store";
import { PostgresMarketAnalysisSnapshotStore } from "../../server/db/postgres/market-analysis-snapshot-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { startPostgresTestContainer } from "./helpers/postgres-test-container";
import type { MarketAnalysisScope } from "../../shared/market-analysis-contracts";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { performance } from "node:perf_hooks";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { createRemoteMcpConnector } from '../../server/connectors/remote-mcp-connector';
import { ConnectorError } from '../../server/connectors/connector-contract';

test("market module execution persists independent runs and database-clock fenced leases", { timeout: 90_000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const store = new PostgresMarketModuleExecutionStore(pg.pool);
  const snapshots = new PostgresMarketAnalysisSnapshotStore(pg.pool);
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  const outsider = { organizationId: randomUUID(), userId: randomUUID() };
  for (const user of [actor, outsider]) await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Step test','member','active',now(),now())", [user.userId,user.organizationId,`${user.userId}@example.com`]);
  const scope: MarketAnalysisScope = { organizationId:actor.organizationId,researchId:randomUUID(),marketplace:"US",nodeIdPath:"12:34",fromMonth:"2026-07",toMonth:"2026-08",currency:"USD" };
  await snapshots.createStudy({ actor,scope,idempotencyKey:randomUUID(),now:new Date().toISOString() });
  const step = (key: string) => ({ stepKey:key,kind:"collect-product-month" as const,subject:{month:"2026-08"},input:{month:"2026-08"},inputRefs:[] });
  const request = (revision = randomUUID()) => ({ actor,scope,moduleKind:"shape-price" as const,params:{poolSize:20},versions:{source:"fixture/v1",rule:"rules/v1",mapping:"mapping/v1",planner:"planner/v1",model:null,prompt:null,configuration:null},collectionRevision:revision,idempotencyKey:randomUUID(),initialSteps:[step("month/2026-08")] });
  const claim = (moduleRunId:string, leaseMs=30_000) => store.claimStep({moduleRunId,leaseOwnerId:randomUUID(),leaseMs});
  const sourceInput = (tag=randomUUID()) => ({scope,provider:"sorftime",operation:"product_customers_say",requestIdentity:{marketplace:"US"},responseIdentityPaths:{},payload:{tag,data:{details:[]}},fetchedAt:new Date().toISOString(),observationPeriod:{kind:"unknown",reason:"fixture window unknown"},units:{},coverage:{receivedCount:0,expectedCount:null,truncation:{status:"unknown",reason:"fixture"}}});
  const inputSnapshot = () => ({scope,kind:"products",sourceVersion:"fixture/v1",ruleVersion:"rules/v1",collectedAt:new Date().toISOString(),expectedRecordIds:["B000000001"],records:[{id:"B000000001",scope,data:{units:0}}]});
  const success = {status:"succeeded" as const,output:{observed:0}};

  await t.test('ambiguous dispatched connector timeout stops durable automatic retries but permits explicit retry', async () => {
    let dispatches=0;
    const connector=createRemoteMcpConnector({id:'sellerSprite',physicalGovernance:'transport-dispatch',resolveCredential:async()=> 'fixture',clock:()=>new Date(),sleep:async()=>assert.fail('no immediate retry'),
      policy:{timeoutMs:1000,maxAttempts:2,retryDelayMs:0,maxConcurrent:1,maxQueue:1},probeTransport:async()=>({}),
      transport:async()=>{dispatches++;throw Object.assign(new Error('ambiguous transport'),{kind:'timeout',doNotRetry:true});}});
    let failure:ConnectorError|undefined;
    try { await connector.execute({operation:'fixture',input:{},sessionScope:'market',governorScope:{organizationId:actor.organizationId,jobId:'fixture'}}); }
    catch(error) { assert.ok(error instanceof ConnectorError); failure=error; }
    assert.ok(failure);assert.equal(failure.code,'timeout');assert.equal(failure.retryable,false);assert.equal(dispatches,1);
    const run=(await store.createModuleRun({...request(),initialSteps:[step('ambiguous-timeout')]})).run;
    const active=await claim(run.id);assert.ok(active);
    await store.settleAndEnqueue({claim:active,outcome:{status:'failed',error:{code:'timeout',retryable:failure.retryable}}});
    assert.equal(await claim(run.id),null);
    await store.retryFailedSteps({actor,moduleRunId:run.id,steps:[{stepId:active.stepId,failedAttemptId:active.attemptId}],idempotencyKey:randomUUID()});
    const manual=await claim(run.id);assert.ok(manual);await store.settleAndEnqueue({claim:manual,outcome:success});
  });

  await t.test('local cooldown is durable, refunds failure budget, rechecks once and cancels safely',async()=>{
    const run=(await store.createModuleRun({...request(),initialSteps:[step('waiting'),step('sibling')]})).run;
    const first=await claim(run.id);assert.ok(first);
    const sibling=await claim(run.id);assert.ok(sibling);await store.settleAndEnqueue({claim:sibling,outcome:success});
    for(let round=0;round<4;round++){
      const active=round===0?first:await claim(run.id);assert.ok(active);
      const retryAt=new Date(Date.now()+60000).toISOString();
      await store.settleAndEnqueue({claim:active,outcome:{status:'failed',error:{code:'local-admission',retryable:true,admission:{reason:'rolling-window',retryAt}}}});
      const view=await store.findModuleRun({actor,moduleRunId:run.id});assert.equal(view!.steps.find(s=>s.id===first.stepId)!.status,'queued');
      assert.ok(Date.parse(view!.steps.find(s=>s.id===first.stepId)!.nextAttemptAt!)>=Date.parse(retryAt));
      assert.equal(view!.steps.find(s=>s.id===sibling.stepId)!.attemptCount,1);
      assert.equal(await claim(run.id),null);
      const row: {round_attempt_count:number}=(await pg.pool.query('SELECT round_attempt_count FROM market_analysis_steps WHERE id=$1',[first.stepId])).rows[0];assert.equal(row.round_attempt_count,0);
      await pg.pool.query("UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp() WHERE id=$1",[first.stepId]);
    }
    await store.cancelModuleRun({actor,moduleRunId:run.id,idempotencyKey:randomUUID()});assert.equal(await claim(run.id),null);
  });

  await t.test('flow-specific consumers skip legacy jobs while still claiming unrelated step kinds',async()=>{
    const legacy={stepKey:'legacy-reconcile',kind:'reconcile' as const,subject:{},input:{task:'legacy-task'},inputRefs:[]};
    const run=(await store.createModuleRun({...request(),initialSteps:[legacy,step('collect')]})).run;
    const filters={moduleRunId:run.id,leaseOwnerId:randomUUID(),leaseMs:30000,flowVersionsByStepKind:{reconcile:['market-theme-flow/v2']}};
    const collected=await store.claimStep({...filters,kinds:['collect-product-month','reconcile']});assert.ok(collected);assert.equal(collected.step.kind,'collect-product-month');
    assert.equal(await store.claimStep({...filters,kinds:['reconcile']}),null);
    assert.equal((await store.findModuleRun({actor,moduleRunId:run.id}))!.steps.find(s=>s.kind==='reconcile')!.attemptCount,0);
    assert.equal((await store.claimStep({moduleRunId:run.id,leaseOwnerId:randomUUID(),leaseMs:30000,kinds:['reconcile']}))!.step.kind,'reconcile');
    const opted=(await store.createModuleRun({...request(),params:{flow:'fixture-native/v1'},initialSteps:[legacy]})).run;
    assert.ok(await store.claimStep({...filters,moduleRunId:opted.id,kinds:['reconcile'],flowVersionsByStepKind:{reconcile:['fixture-native/v1']}}));
    await store.cancelModuleRun({actor,moduleRunId:run.id,idempotencyKey:randomUUID()});await store.cancelModuleRun({actor,moduleRunId:opted.id,idempotencyKey:randomUUID()});
  });

  await t.test("concurrent matching creation is one run and immutable request keys reject drift", async () => {
    const input=request();
    const results=await Promise.all([store.createModuleRun(input),store.createModuleRun(input)]);
    assert.equal(results.filter(r=>r.created).length,1);
    assert.equal(results[0].run.id,results[1].run.id);
    const found=await store.findModuleRun({actor,moduleRunId:results[0].run.id});
    assert.equal(found?.steps.length,1);
    assert.deepEqual(found?.run.scope,scope);
    await assert.rejects(()=>store.createModuleRun({...input,params:{poolSize:21}}));
    const alias={...input,idempotencyKey:randomUUID()};
    assert.equal((await store.createModuleRun(alias)).run.id,results[0].run.id);
    await assert.rejects(()=>store.createModuleRun({...alias,params:{poolSize:22}}));
  });
  await t.test("module runs and parameters remain separate; wrong organizations and full scope are rejected", async () => {
    const input=request();
    const first=await store.createModuleRun(input);
    const second=await store.createModuleRun({...input,moduleKind:"customer-themes",idempotencyKey:randomUUID()});
    assert.notEqual(first.run.id,second.run.id);
    assert.equal(await store.findModuleRun({actor:outsider,moduleRunId:first.run.id}),null);
    await assert.rejects(()=>store.createModuleRun({...request(),actor:outsider}));
    await assert.rejects(()=>store.createModuleRun({...request(),scope:{...scope,nodeIdPath:"99:88"}}));
  });
  await t.test("parallel workers claim a step once and renewal checks owner generation and actual DB time", async () => {
    const run=(await store.createModuleRun(request())).run;
    const claims=await Promise.all([claim(run.id),claim(run.id)]);
    const active=claims.find(c=>c!==null); assert.ok(active);
    assert.equal(claims.filter(Boolean).length,1);
    assert.equal(active.leaseGeneration,1);
    assert.equal(await store.renewStep({claim:active,leaseMs:30_000}),true);
    assert.equal(await store.renewStep({claim:{...active,leaseOwnerId:randomUUID()},leaseMs:30_000}),false);
    assert.equal(await store.renewStep({claim:{...active,leaseGeneration:active.leaseGeneration+1},leaseMs:30_000}),false);
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[active.stepId]);
    assert.equal(await store.renewStep({claim:active,leaseMs:30_000}),false);
    await assert.rejects(()=>store.claimStep({...{moduleRunId:run.id,leaseOwnerId:randomUUID(),leaseMs:30_000},now:"2099-01-01T00:00:00.000Z"}));
  });
  await t.test("expired claims preserve interrupted attempts and cannot exceed three automatic attempts", async () => {
    const run=(await store.createModuleRun(request())).run;
    const generations:number[]=[];
    for(let index=0;index<3;index++) {
      const active=await claim(run.id); assert.ok(active); generations.push(active.leaseGeneration);
      await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[active.stepId]);
      assert.equal(await claim(run.id),null);
      await pg.pool.query("UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[run.id]);
    }
    assert.deepEqual(generations,[1,2,3]);
    assert.equal(await claim(run.id),null);
    const found=await store.findModuleRun({actor,moduleRunId:run.id});
    assert.equal(found?.steps[0].status,"failed");
    assert.equal(found?.attempts.length,3);
    assert.ok(found?.attempts.every(a=>a.status==="interrupted"));
  });
  await t.test("a new store resumes queued state without re-creating completed request identity", async () => {
    const run=(await store.createModuleRun(request())).run;
    const restarted=new PostgresMarketModuleExecutionStore(pg.pool);
    const active=await restarted.claimStep({moduleRunId:run.id,leaseOwnerId:randomUUID(),leaseMs:30_000});
    assert.ok(active);
    assert.equal(active.moduleRunId,run.id);
    assert.equal((await restarted.findModuleRun({actor,moduleRunId:run.id}))?.steps[0].attemptCount,1);
  });
  await t.test("T10 context injection joins the outer transaction instead of committing a separate source", async () => {
    const context=new PostgresQueryContext(pg.pool);
    const joined=new PostgresMarketAnalysisSnapshotStore(context);
    const input=sourceInput();let reached=false;
    await assert.rejects(()=>context.transaction(async()=>{
      await joined.saveSource({actor,studyId:scope.researchId,input,now:new Date().toISOString()});reached=true;
      throw new Error("rollback fixture");
    }));
    assert.equal(reached,true);
    assert.equal((await pg.pool.query("SELECT id FROM market_analysis_sources WHERE document_json->'payload'->>'tag'=$1",[input.payload.tag])).rowCount,0);
  });
  await t.test("settlement atomically persists T10 sources and inputs, terminal output and unique child steps", async () => {
    const run=(await store.createModuleRun(request())).run;const active=await claim(run.id);assert.ok(active);
    const child={...step("prepare/members"),kind:"prepare-members" as const,inputRefs:[{kind:"step-output" as const,id:active.attemptId}]};
    const completion={claim:active,outcome:success,sources:[sourceInput()],inputs:[inputSnapshot()],children:[child]};
    const saved=await store.settleAndEnqueue(completion);
    assert.equal(saved.status,"committed");assert.equal(saved.sourceIds.length,1);assert.equal(saved.inputIds.length,1);assert.equal(saved.childStepIds.length,1);
    const repeated=await store.settleAndEnqueue(completion);
    assert.equal(repeated.status,"already-committed");assert.deepEqual(repeated.childStepIds,saved.childStepIds);
    await assert.rejects(()=>store.settleAndEnqueue({...completion,outcome:{...success,output:{observed:99}}}));
    const restarted=new PostgresMarketModuleExecutionStore(pg.pool);
    const next=await restarted.claimStep({moduleRunId:run.id,leaseOwnerId:randomUUID(),leaseMs:30_000});assert.equal(next?.step.kind,"prepare-members");
    const found=await store.findModuleRun({actor,moduleRunId:run.id});assert.equal(found?.steps.length,2);
    assert.deepEqual(found?.attempts.find(a=>a.id===active.attemptId)?.output,{observed:0});
    assert.ok(await snapshots.findSource({actor,studyId:scope.researchId,id:saved.sourceIds[0]}));
    await assert.rejects(pg.pool.query("UPDATE market_analysis_step_attempts SET output_json='{}' WHERE id=$1",[active.attemptId]));
    await assert.rejects(pg.pool.query("DELETE FROM market_analysis_steps WHERE id=$1",[active.stepId]));
    await assert.rejects(pg.pool.query("UPDATE market_analysis_steps SET status='queued' WHERE id=$1",[active.stepId]));
  });
  await t.test("settlement accepts multiple individually bounded snapshots above the envelope node budget", async () => {
    const run=(await store.createModuleRun(request())).run,active=await claim(run.id);assert.ok(active);
    const values=Array.from({length:27_000},(_,index)=>index);
    const inputs=[1,2].map(tag=>({scope,kind:'products',sourceVersion:'fixture/v1',ruleVersion:'rules/v1',collectedAt:new Date().toISOString(),expectedRecordIds:['B000000001'],records:[{id:'B000000001',scope,data:{tag,values}}]}));
    const saved=await store.settleAndEnqueue({claim:active,outcome:success,inputs});
    assert.equal(saved.inputIds.length,2);
    assert.equal((await store.findModuleRun({actor,moduleRunId:run.id}))?.steps[0].status,'succeeded');
  });
  await t.test("child enqueue failure rolls back previously saved source, input and attempt completion", async () => {
    const run=(await store.createModuleRun(request())).run;const active=await claim(run.id);assert.ok(active);
    const input=sourceInput();
    await assert.rejects(()=>store.settleAndEnqueue({claim:active,outcome:success,sources:[input],inputs:[inputSnapshot()],children:[{...step("invalid-child"),inputRefs:[{kind:"step-output",id:randomUUID()}]}]}));
    assert.equal((await pg.pool.query("SELECT id FROM market_analysis_sources WHERE document_json->'payload'->>'tag'=$1",[input.payload.tag])).rowCount,0);
    const found=await store.findModuleRun({actor,moduleRunId:run.id});assert.equal(found?.steps.length,1);assert.equal(found?.attempts[0].status,"running");
  });
  await t.test("expired completion writes neither source nor children and a reclaimed generation stays authoritative", async () => {
    const run=(await store.createModuleRun(request())).run;const old=await claim(run.id);assert.ok(old);const input=sourceInput();
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.stepId]);
    const result=await store.settleAndEnqueue({claim:old,outcome:success,sources:[input],children:[step("late-child")]});assert.equal(result.status,"lease-lost");
    await claim(run.id);await pg.pool.query("UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[run.id]);
    const replacement=await claim(run.id);assert.ok(replacement);
    assert.equal(replacement.leaseGeneration,old.leaseGeneration+1);
    assert.equal((await store.settleAndEnqueue({claim:old,outcome:success,sources:[input]})).status,"lease-lost");
    assert.equal((await pg.pool.query("SELECT id FROM market_analysis_sources WHERE document_json->'payload'->>'tag'=$1",[input.payload.tag])).rowCount,0);
    assert.equal((await store.findModuleRun({actor,moduleRunId:run.id}))?.steps.length,1);
  });
  await t.test("lease expiry during a source insert rolls the entire settlement back", async () => {
    const input=sourceInput();
    await pg.pool.query("CREATE FUNCTION test_market_source_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document_json->'payload'->>'tag'=TG_ARGV[0] THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$");
    await pg.pool.query(`CREATE TRIGGER test_market_source_delay BEFORE INSERT ON market_analysis_sources FOR EACH ROW EXECUTE FUNCTION test_market_source_delay('${input.payload.tag}')`);
    try {
      const run=(await store.createModuleRun(request())).run;const active=await claim(run.id,500);assert.ok(active);const started=performance.now();
      const result=await store.settleAndEnqueue({claim:active,outcome:success,sources:[input],children:[step("late-transaction-child")]});
      assert.ok(performance.now()-started>=1000,"fixture must enter source INSERT before the lease expires");
      assert.equal(result.status,"lease-lost");
      assert.equal((await pg.pool.query("SELECT id FROM market_analysis_sources WHERE document_json->'payload'->>'tag'=$1",[input.payload.tag])).rowCount,0);
      const found=await store.findModuleRun({actor,moduleRunId:run.id});assert.equal(found?.steps.length,1);assert.equal(found?.attempts[0].status,"running");
    } finally {await pg.pool.query("DROP TRIGGER test_market_source_delay ON market_analysis_sources");await pg.pool.query("DROP FUNCTION test_market_source_delay()");}
  });
  await t.test("bounded automatic attempts retain failure diagnostics and manual retry is failed-only and idempotent", async () => {
    const run=(await store.createModuleRun({...request(),initialSteps:[step("first"),step("second")]})).run;
    const kept=await claim(run.id);assert.ok(kept);await store.settleAndEnqueue({claim:kept,outcome:success});
    let last:Awaited<ReturnType<typeof claim>>=null;
    for(let i=0;i<3;i++){
      last=await claim(run.id);assert.ok(last);
      await store.settleAndEnqueue({claim:last,outcome:{status:"failed",error:{code:"upstream-temporary",retryable:true},diagnostic:{response:"bounded raw"}}});
      await pg.pool.query("UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE run_id=$1 AND status='queued'",[run.id]);
    }
    assert.ok(last);assert.equal(await claim(run.id),null);
    const retry={actor,moduleRunId:run.id,steps:[{stepId:last.stepId,failedAttemptId:last.attemptId}],idempotencyKey:randomUUID()};
    const receipt=await store.retryFailedSteps(retry);assert.deepEqual(await store.retryFailedSteps(retry),receipt);
    await assert.rejects(()=>store.retryFailedSteps({...retry,idempotencyKey:randomUUID()}));
    await assert.rejects(()=>store.retryFailedSteps({...retry,steps:[{stepId:kept.stepId,failedAttemptId:kept.attemptId}],idempotencyKey:randomUUID()}));
    const next=await claim(run.id);assert.ok(next);assert.equal(next.stepId,last.stepId);
    const found=await store.findModuleRun({actor,moduleRunId:run.id});assert.equal(found?.attempts.length,5);
    assert.equal(found?.steps.find(s=>s.id===kept.stepId)?.status,"succeeded");
    assert.ok(found?.attempts.filter(a=>a.status==="failed").every(a=>a.error!==null));
  });
  await t.test("cancellation is idempotent, fences active work, and keeps successful history", async () => {
    const run=(await store.createModuleRun({...request(),initialSteps:[step("first"),step("second"),step("third")]})).run;
    const kept=await claim(run.id);assert.ok(kept);await store.settleAndEnqueue({claim:kept,outcome:success});
    const active=await claim(run.id);assert.ok(active);
    await assert.rejects(()=>store.cancelModuleRun({actor:outsider,moduleRunId:run.id,idempotencyKey:randomUUID()}));
    const command={actor,moduleRunId:run.id,idempotencyKey:randomUUID()};
    assert.deepEqual(await store.cancelModuleRun(command),await store.cancelModuleRun(command));
    assert.equal((await store.settleAndEnqueue({claim:active,outcome:success,children:[step("late-cancel-child")]})).status,"lease-lost");
    assert.equal(await claim(run.id),null);
    const found=await store.findModuleRun({actor,moduleRunId:run.id});assert.equal(found?.run.status,"cancelled");assert.equal(found?.steps.find(s=>s.id===kept.stepId)?.status,"succeeded");
    assert.equal(found?.steps.filter(s=>s.status==="cancelled").length,2);
  });
  await t.test("model batches never multiply the runner's physical attempts with outer automatic retries", async () => {
    const modelRequest={...request(),initialSteps:[{...step("model/0"),kind:"model-batch" as const}]};
    const run=(await store.createModuleRun(modelRequest)).run;
    const active=await claim(run.id);assert.ok(active);
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[active.stepId]);
    assert.equal(await claim(run.id),null);
    assert.equal((await store.findModuleRun({actor,moduleRunId:run.id}))?.steps[0].status,"failed");
    await store.retryFailedSteps({actor,moduleRunId:run.id,steps:[{stepId:active.stepId,failedAttemptId:active.attemptId}],idempotencyKey:randomUUID()});
    const manual=await claim(run.id);assert.ok(manual);
    await store.settleAndEnqueue({claim:manual,outcome:{status:"failed",error:{code:"timeout",retryable:true}}});
    assert.equal((await store.findModuleRun({actor,moduleRunId:run.id}))?.steps[0].status,"failed");
    assert.equal(await claim(run.id),null);
  });
  await t.test("database rejects a run whose complete scope differs from its immutable study", async () => {
    const {actor:unusedActor,idempotencyKey:unusedKey,...input}=request();
    void unusedActor;void unusedKey;
    const changed={...input,scope:{...scope,nodeIdPath:"88:99"}};
    await assert.rejects(pg.pool.query("INSERT INTO market_analysis_module_runs(id,organization_id,study_id,created_by,request_json,request_fingerprint,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,'queued')",[randomUUID(),actor.organizationId,scope.researchId,actor.userId,JSON.stringify(changed),canonicalJsonSha256(changed)]));
  });
  await t.test("module-specific handlers skip unsupported rules without blocking other work in the same run", async () => {
    const filter = { rules: ['customer-themes' as const] };
    const run = (await store.createModuleRun({ ...request(), initialSteps: [
      { stepKey: 'rules-first', kind: 'rules', subject: {}, input: {}, inputRefs: [] }, step('source-second'),
    ] })).run;
    const filteredClaim = (moduleRunId: string) => store.claimStep({ moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 30000,
      kinds: ['rules', 'collect-product-month'], moduleKindsByStepKind: filter });
    const collected = await filteredClaim(run.id); assert.ok(collected); assert.equal(collected.step.kind, 'collect-product-month');
    await store.settleAndEnqueue({ claim: collected, outcome: success }); assert.equal(await filteredClaim(run.id), null);
    const untouched = (await store.findModuleRun({ actor, moduleRunId: run.id }))!.steps.find(s => s.kind === 'rules')!;
    assert.equal(untouched.status, 'queued'); assert.equal(untouched.attemptCount, 0);
    const themes = (await store.createModuleRun({ ...request(), moduleKind: 'customer-themes', initialSteps: [
      { stepKey: 'theme-rules', kind: 'rules', subject: {}, input: {}, inputRefs: [] },
    ] })).run;
    assert.equal((await filteredClaim(themes.id))!.step.kind, 'rules');
    assert.equal((await claim(run.id))!.step.kind, 'rules');
    await assert.rejects(() => store.claimStep({ moduleRunId: run.id, leaseOwnerId: randomUUID(), leaseMs: 30000,
      moduleKindsByStepKind: { rules: ['foreign-module'] } }));
  });
  await t.test("revoked actors cannot read, renew or receive new claims", async () => {
    const run=(await store.createModuleRun(request())).run;
    const active=await claim(run.id); assert.ok(active);
    const queued=(await store.createModuleRun(request())).run;
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[actor.userId]);
    assert.equal(await store.findModuleRun({actor,moduleRunId:run.id}),null);
    assert.equal(await store.renewStep({claim:active,leaseMs:30_000}),false);
    assert.equal((await store.settleAndEnqueue({claim:active,outcome:success})).status,"lease-lost");
    assert.equal(await claim(queued.id),null);
    await assert.rejects(()=>store.createModuleRun(request()));
  });
});
