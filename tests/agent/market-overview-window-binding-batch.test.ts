import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type {QueryResultRow} from 'pg';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {MarketAgentRunConflictError} from '../../server/db/market-agent-run-repository';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {MarketSemanticRecord} from '../../shared/market-semantic-contracts';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

test('overview binding batch validates every input and shares sources only inside its locked transaction',{timeout:90_000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  // Only native snapshot/binding storage is exercised; no provider or worker runs.
  const f=await createMarketSemanticFixture(pg.pool),task='market-overview-explanation' as const;
  const semantic:MarketSemanticRecord={task,metrics:[{metricId:'metric',state:'known',value:10,unit:{status:'known',unit:'count',rawUnit:'count'},
    period:{kind:'calendar-months',fromMonth:f.scope.fromMonth,toMonth:f.scope.toMonth},sourceRefs:[f.source.id],formulaVersion:'synthetic/v1',
    numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}}],gaps:[],
    facts:[{factId:'fact',kind:'value',metricRefs:['metric'],sourceRefs:[f.source.id],statementTemplateId:'synthetic'}],interpretationOptions:[],validationOptions:[]};
  const saved=await f.stores.snapshots.saveInput({actor:f.actor,studyId:f.scope.researchId,now:new Date().toISOString(),input:{scope:f.scope,kind:'overview',sourceVersion:'synthetic/v1',ruleVersion:'semantic/v1',collectedAt:f.subject.dataCutoffAt,expectedRecordIds:['overview'],records:[{id:'overview',scope:f.scope,data:{semantic}}]}});
  const scope=f.inputProjection.scope,ids:string[]=[];
  for(let ordinal=0;ordinal<2;ordinal++){
    const id=randomUUID(),batchKey=`overview/window-${ordinal}`,body={schemaVersion:'1.0.0',...semantic,batchId:randomUUID(),scopeDigest:digest(f.scope),scope,
      contentSnapshotId:saved.snapshot.snapshotId,selectionRevision:'selection/v1',batchKey,dataCutoffAt:f.subject.dataCutoffAt,sourceRefs:[f.source.id]};
    await f.stores.audit.saveSnapshotBinding({id,subject:f.subject,inputSnapshotId:saved.snapshot.snapshotId,inputProjection:{...body,inputDigest:digest(body)},memberRefs:['overview'],sourceRefs:[f.source.id],selectionRevision:'selection/v1',batchKey});ids.push(id);
  }
  const read={actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId,bindingIds:[...ids].reverse()},original=f.context.query.bind(f.context);
  let sourceReads=0,inputReads=0,corruptSource=false,corruptSecondBinding=false,checkLocks=true;
  let abortOnSource:AbortController|undefined;
  t.mock.method(f.context,'query',async function<Row extends QueryResultRow=QueryResultRow>(sql:string,values?:unknown[]){
    const result=await original<Row>(sql,values);
    if(sql.includes('SELECT d.* FROM market_analysis_inputs'))inputReads++;
    if(sql.includes('SELECT d.* FROM market_analysis_sources')){
      sourceReads++;
      if(checkLocks){
        checkLocks=false;
        await assert.rejects(pg.pool.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[f.actor.userId]),{code:'55P03'});
        await assert.rejects(pg.pool.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 FOR UPDATE NOWAIT',[f.subject.moduleRunId]),{code:'55P03'});
        const other=await pg.pool.connect();
        try{
          await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='50ms'");
          await assert.rejects(other.query("UPDATE users SET status='disabled' WHERE id=$1",[f.actor.userId]),{code:'55P03'});
        }finally{await other.query('ROLLBACK');other.release();}
      }
      if(corruptSource)(result.rows[0] as Record<string,unknown>).document_hash='0'.repeat(64);
      abortOnSource?.abort();
    }
    if(corruptSecondBinding&&sql.includes('AND id=ANY(')){
      const row=result.rows.find(row=>row.id===read.bindingIds[1]);assert.ok(row);
      (row as Record<string,unknown>).input_digest='0'.repeat(64);
    }
    return result;
  });
  const batch=await f.stores.audit.findOverviewWindowBindings(read);
  assert.deepEqual(batch.bindings.map(binding=>binding.id),read.bindingIds);
  assert.deepEqual(batch.sourceEvidenceByRef,{[f.source.id]:f.source.evidence});
  assert.ok(Object.isFrozen(batch));assert.ok(Object.isFrozen(batch.bindings));assert.ok(Object.isFrozen(batch.sourceEvidenceByRef[f.source.id].scope));
  assert.equal(sourceReads,1);assert.equal(inputReads,2,'each binding restores and validates its input');
  await f.stores.audit.findOverviewWindowBindings(read);assert.equal(sourceReads,2,'a new call restores its own source');assert.equal(inputReads,4);
  for(const changed of [{bindingIds:[ids[0],ids[0]]},{bindingIds:[]},{bindingIds:Array.from({length:2001},()=>randomUUID())},
    {bindingIds:[f.binding.id]},{bindingIds:[ids[0],randomUUID()]},{studyId:randomUUID()},{moduleRunId:randomUUID()},
    {actor:{...f.actor,organizationId:randomUUID()}},{actor:{...f.actor,userId:randomUUID()}},{sourceEvidenceByRef:batch.sourceEvidenceByRef}]){
    await assert.rejects(f.stores.audit.findOverviewWindowBindings({...read,...changed}),MarketAgentRunConflictError);
  }
  corruptSecondBinding=true;await assert.rejects(f.stores.audit.findOverviewWindowBindings(read),MarketAgentRunConflictError);corruptSecondBinding=false;
  corruptSource=true;const beforeCorrupt=sourceReads;await assert.rejects(f.stores.audit.findOverviewWindowBindings(read),MarketAgentRunConflictError);assert.equal(sourceReads,beforeCorrupt+1);corruptSource=false;
  await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[f.actor.userId]);
  const beforeInactive=sourceReads;await assert.rejects(f.stores.audit.findOverviewWindowBindings(read),MarketAgentRunConflictError);assert.equal(sourceReads,beforeInactive);
  await pg.pool.query("UPDATE users SET status='active' WHERE id=$1",[f.actor.userId]);
  await f.stores.audit.findOverviewWindowBindings(read);assert.equal(sourceReads,beforeInactive+1);
  const aborted=new AbortController();aborted.abort();const beforeAbort=sourceReads;
  await assert.rejects(f.stores.audit.findOverviewWindowBindings(read,aborted.signal),MarketAgentRunConflictError);assert.equal(sourceReads,beforeAbort);
  abortOnSource=new AbortController();const inputsBeforeAbort=inputReads;
  await assert.rejects(f.stores.audit.findOverviewWindowBindings(read,abortOnSource.signal),MarketAgentRunConflictError);
  assert.equal(inputReads,inputsBeforeAbort+1,'abort during first source prevents the second binding replay');abortOnSource=undefined;
  await pg.pool.query('UPDATE market_analysis_module_runs SET cancelled_at=clock_timestamp() WHERE id=$1',[f.subject.moduleRunId]);
  assert.equal((await f.stores.audit.findOverviewWindowBindings(read)).bindings.length,2,'cancelled runs retain historical reads');
  t.diagnostic(JSON.stringify({bindings:2,sourcesPerBatch:1,eachInputValidated:true,actorAndRunLocked:true,newCallRevalidates:true}));
});
