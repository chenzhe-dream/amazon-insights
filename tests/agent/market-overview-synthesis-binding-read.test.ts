import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type {QueryResultRow} from 'pg';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {MarketAgentRunConflictError} from '../../server/db/market-agent-run-repository';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

test('overview synthesis binding read rejects external evidence and wrong scope/task without changing legacy reads',{timeout:90_000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  const f=await createMarketSemanticFixture(pg.pool),other=await createMarketSemanticFixture(pg.pool);
  const read={actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId,bindingId:f.binding.id};
  const original=f.context.query.bind(f.context);let queries=0,checkLocks=true,sourceReads=0;
  t.mock.method(f.context,'query',async function<Row extends QueryResultRow=QueryResultRow>(sql:string,values?:unknown[]){
    queries++;const result=await original<Row>(sql,values);
    if(sql.includes('SELECT d.* FROM market_analysis_sources'))sourceReads++;
    if(checkLocks&&sql.includes('SELECT * FROM market_analysis_semantic_snapshot_bindings')){
      checkLocks=false;
      await assert.rejects(pg.pool.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 FOR UPDATE NOWAIT',[f.subject.moduleRunId]),{code:'55P03'});
      await assert.rejects(pg.pool.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[f.actor.userId]),{code:'55P03'});
    }
    return result;
  });
  // The genuine persisted keyword binding must never be accepted as synthesis.
  await assert.rejects(f.stores.audit.findOverviewSynthesisBinding(read),MarketAgentRunConflictError);assert.equal(checkLocks,false);assert.equal(sourceReads,0);
  const noQueryInput=[{evidence:{}},{sourceReport:{}},{trustedEvidence:{}},{overviewSynthesisBasis:{}},{onOverviewSynthesisRestored:()=>{}},{bindingIds:[f.binding.id]},{bindingId:'not-a-uuid'}];
  for(const extra of noQueryInput){const before=queries;await assert.rejects(f.stores.audit.findOverviewSynthesisBinding({...read,...extra}),MarketAgentRunConflictError);assert.equal(queries,before);}
  for(const changed of [{bindingId:randomUUID()},{bindingId:other.binding.id},{studyId:other.scope.researchId},{moduleRunId:other.subject.moduleRunId},
    {actor:other.actor},{actor:{...f.actor,userId:other.actor.userId}},{actor:{...f.actor,organizationId:other.actor.organizationId}}]){
    assert.equal(await f.stores.audit.findOverviewSynthesisBinding({...read,...changed}),null);
  }
  const controller=new AbortController();controller.abort();const beforeAbort=queries;
  await assert.rejects(f.stores.audit.findOverviewSynthesisBinding(read,controller.signal),MarketAgentRunConflictError);assert.equal(queries,beforeAbort);
  const legacy=await f.stores.audit.findSnapshotBinding(read);assert.deepEqual(legacy,f.binding);assert.equal(sourceReads,1);
  await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[f.actor.userId]);
  assert.equal(await f.stores.audit.findOverviewSynthesisBinding(read),null);assert.equal(await f.stores.audit.findSnapshotBinding(read),null);
  await pg.pool.query("UPDATE users SET status='active' WHERE id=$1",[f.actor.userId]);
  assert.deepEqual(await f.stores.audit.findSnapshotBinding(read),legacy);assert.equal(sourceReads,2,'later legacy reads still restore source evidence');
  await pg.pool.query('UPDATE market_analysis_module_runs SET cancelled_at=clock_timestamp() WHERE id=$1',[f.subject.moduleRunId]);
  await assert.rejects(f.stores.audit.findOverviewSynthesisBinding(read),MarketAgentRunConflictError,'cancelled run reaches task validation instead of being hidden');
  assert.deepEqual(await f.stores.audit.findSnapshotBinding(read),legacy);
  t.diagnostic(JSON.stringify({externalEvidenceRejected:true,wrongTaskRejected:true,scopeFenced:true,actorAndRunLocked:true,legacyReadsUnchanged:true,successfulEvidenceNotMocked:true}));
});
