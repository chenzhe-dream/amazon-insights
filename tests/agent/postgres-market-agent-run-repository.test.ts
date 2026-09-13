import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketAgentRunStore } from '../../server/db/postgres/market-agent-run-store';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import type { FinalizeAgentRunOutcome } from '../../server/db/agent-run-repository';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';

const succeeded:FinalizeAgentRunOutcome={terminalStatus:'succeeded',validationStatus:'passed',responseId:'synthetic-response',output:{checked:true},error:null,inputTokens:10,outputTokens:5,estimatedCostMicros:1,durationMs:20,attemptCount:1,usageCompleteness:'complete',attempts:[{ordinal:0,kind:'initial',transientRetryCount:0,formatRepair:false,accounting:'settled',errorClassification:null}],terminalMetadata:{kind:'succeeded'}};

test('native market semantic audit binds snapshots and fences PostgreSQL claims',{timeout:90_000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  await t.test('prepare transaction saves immutable full projection, then native model audit has no legacy identity',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);
    assert.equal(f.record.studyId,f.scope.researchId);assert.deepEqual(f.record.snapshotIds,[f.binding.id]);
    assert.equal('projectId' in f.record,false);assert.equal('stageId' in f.record,false);
    assert.deepEqual(f.binding.inputProjection,f.inputProjection);assert.ok(Object.isFrozen(f.record));assert.ok(Object.isFrozen(f.binding.inputProjection));
    const read=await new PostgresMarketAgentRunStore(pg.pool).findSnapshotBinding({actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId,bindingId:f.binding.id});assert.deepEqual(read,f.binding);
    await assert.rejects(pg.pool.query("UPDATE market_analysis_semantic_snapshot_bindings SET input_digest=$2 WHERE id=$1",[f.binding.id,'c'.repeat(64)]));
    await assert.rejects(pg.pool.query('DELETE FROM market_analysis_semantic_snapshot_bindings WHERE id=$1',[f.binding.id]));
  });
  await t.test('concurrent begin observes one audit and refuses fingerprint, skill or binding drift',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);
    const results=await Promise.all([f.stores.audit.beginAgentRun({...f.beginInput,id:randomUUID()}),f.stores.audit.beginAgentRun({...f.beginInput,id:randomUUID(),claimToken:randomUUID()})]);
    assert.ok(results.every(r=>r.record.id===f.record.id&&!r.created));assert.deepEqual(results.map(r=>r.claimStatus),['acquired','observing']);
    for(const drift of [{executionFingerprint:'c'.repeat(64)},{bindingId:randomUUID()},{skill:{...f.beginInput.skill,contentHash:'d'.repeat(64)}}])await assert.rejects(()=>f.stores.audit.beginAgentRun({...f.beginInput,...drift}));
    assert.equal((await f.stores.audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId})).length,1);
  });
  await t.test('binding rejects forged digest, outside member and mismatched source before writing',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);const base={id:randomUUID(),subject:f.subject,inputSnapshotId:f.inputSnapshot.snapshotId,inputProjection:f.inputProjection,memberRefs:['keyword-a'],sourceRefs:[f.source.id],selectionRevision:'selection/v1',batchKey:'keywords/batch-1'};
    await assert.rejects(()=>f.stores.audit.saveSnapshotBinding({...base,inputProjection:{...f.inputProjection,inputDigest:'d'.repeat(64)}}));
    await assert.rejects(()=>f.stores.audit.saveSnapshotBinding({...base,memberRefs:['outside']}));
    await assert.rejects(()=>f.stores.audit.saveSnapshotBinding({...base,sourceRefs:[`market-source:${'c'.repeat(64)}`]}));
    let reads=0;const unsafe=Object.defineProperty({},'keywords',{get(){reads++;return [];},enumerable:true});
    await assert.rejects(()=>f.stores.audit.saveSnapshotBinding({...base,inputProjection:unsafe}));assert.equal(reads,0);
  });
  await t.test('cross organization reads and claims do not authorize source, audit or model writes',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);const other=await createMarketSemanticFixture(pg.pool);
    assert.equal(await f.stores.audit.findSnapshotBinding({actor:other.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId,bindingId:f.binding.id}),null);
    await assert.rejects(()=>f.stores.audit.assertAgentRunClaim({...f.authority,organizationId:other.actor.organizationId}));
    await assert.rejects(()=>f.stores.audit.beginAgentRun({...f.beginInput,bindingId:other.binding.id}));
    await assert.rejects(()=>f.stores.audit.finalizeAgentRun({authority:{...f.authority,studyId:other.scope.researchId},outcome:succeeded}));
  });
  await t.test('claim token, owner and generation are checked and an expired claim can be reacquired',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);await f.stores.audit.assertAgentRunClaim(f.authority);
    for(const drift of [{claimToken:randomUUID()},{leaseOwnerId:randomUUID()},{leaseGeneration:2},{attemptId:randomUUID()}])await assert.rejects(()=>f.stores.audit.assertAgentRunClaim({...f.authority,...drift}));
    const next={...f.authority,claimToken:randomUUID()};assert.equal((await f.stores.audit.claimAgentRun({authority:next,claimTtlMs:30_000})).claimStatus,'observing');
    await pg.pool.query("UPDATE market_agent_runs SET execution_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.record.id]);
    assert.equal((await f.stores.audit.claimAgentRun({authority:next,claimTtlMs:30_000})).claimStatus,'acquired');
    await assert.rejects(()=>f.stores.audit.assertAgentRunClaim(f.authority));await f.stores.audit.assertAgentRunClaim(next);
  });
  await t.test('actual database expiry, cancellation and inactive actor reject late publication',async()=>{
    for(const scenario of ['expired','cancelled','inactive']){
      const f=await createMarketSemanticFixture(pg.pool);
      if(scenario==='expired')await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.subject.stepId]);
      if(scenario==='cancelled')await pg.pool.query('UPDATE market_analysis_module_runs SET cancelled_at=clock_timestamp() WHERE id=$1',[f.subject.moduleRunId]);
      if(scenario==='inactive')await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[f.actor.userId]);
      await assert.rejects(()=>f.stores.audit.assertAgentRunClaim(f.authority));await assert.rejects(()=>f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:succeeded}));
    }
  });
  await t.test('success is immutable, replay is read-only and changed outcomes cannot overwrite it',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);const first=await f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:succeeded});assert.equal(first.transitioned,true);assert.equal(first.record.terminalStatus,'succeeded');
    assert.equal((await f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:succeeded})).transitioned,false);
    await assert.rejects(()=>f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:{...succeeded,output:{checked:false}}}));
    await assert.rejects(pg.pool.query("UPDATE market_agent_runs SET output_json='{}' WHERE id=$1",[f.record.id]));await assert.rejects(pg.pool.query('DELETE FROM market_agent_runs WHERE id=$1',[f.record.id]));
    const usage=await f.stores.audit.getAgentRunUsage({actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId});assert.equal(usage.source,'audit-terminal');assert.equal(usage.inputTokens,10);
  });
  await t.test('invalid accounting and future cutoff are rejected while failure remains an immutable audit',async()=>{
    const f=await createMarketSemanticFixture(pg.pool);
    await assert.rejects(()=>f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:{...succeeded,inputTokens:Infinity}}));
    await assert.rejects(()=>f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:{...succeeded,attemptCount:2}}));
    await assert.rejects(()=>f.stores.audit.beginAgentRun({...f.beginInput,subject:{...f.subject,dataCutoffAt:'2099-01-01T00:00:00.000Z'}}));
    const failed:FinalizeAgentRunOutcome={...succeeded,terminalStatus:'failed',validationStatus:'failed',responseId:null,output:null,error:{code:'MODEL_OUTPUT_ERROR',message:'Synthetic malformed output',requestId:'synthetic-request',retryable:false},terminalMetadata:{kind:'failed',classification:'model-output'}};
    const result=await f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:failed});assert.equal(result.record.terminalStatus,'failed');assert.equal((await f.stores.audit.finalizeAgentRun({authority:f.authority,outcome:failed})).transitioned,false);
  });
  await t.test('binding creation joins an outer transaction and expiry during insertion rolls back the binding',async()=>{
    for (const expiry of [false,true]) {
      const f=await createMarketSemanticFixture(pg.pool); const id=randomUUID(),batchKey=`extra-${id}`;
      const {inputDigest:_old,...rest}=f.inputProjection;
      const projection={...rest,batchKey}; const inputProjection={...projection,inputDigest:canonicalJsonSha256(projection)};
      const input={id,subject:f.subject,inputSnapshotId:f.inputSnapshot.snapshotId,inputProjection,memberRefs:['keyword-a'],sourceRefs:[f.source.id],selectionRevision:'selection/v1',batchKey};
      if(expiry) {
        await pg.pool.query("CREATE FUNCTION test_market_binding_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$");
        await pg.pool.query('CREATE TRIGGER test_market_binding_delay BEFORE INSERT ON market_analysis_semantic_snapshot_bindings FOR EACH ROW EXECUTE FUNCTION test_market_binding_delay()');
        await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[f.subject.stepId]);
      }
      try {
        if(expiry) await assert.rejects(()=>f.stores.audit.saveSnapshotBinding(input));
        else await assert.rejects(()=>f.context.transaction(async()=>{await f.stores.audit.saveSnapshotBinding(input);throw new Error('synthetic transaction rollback');}));
        assert.equal((await pg.pool.query('SELECT id FROM market_analysis_semantic_snapshot_bindings WHERE id=$1',[id])).rowCount,0);
      } finally {
        if(expiry){await pg.pool.query('DROP TRIGGER test_market_binding_delay ON market_analysis_semantic_snapshot_bindings');await pg.pool.query('DROP FUNCTION test_market_binding_delay()');}
      }
    }
  });
});
