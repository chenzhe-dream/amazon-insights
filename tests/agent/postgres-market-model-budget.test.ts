import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketModelBudgetStore } from '../../server/db/postgres/market-model-budget-store';
import { PostgresModelBudgetStore } from '../../server/db/postgres/model-budget-store';
import { PostgresCoreStore } from '../../server/db/postgres/core-store';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { BudgetExceededError } from '../../server/runtime/budget-policy';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import type { ReserveMarketModelBudgetInput } from '../../server/db/market-model-budget-repository';

const limits=(maxTokens=1000)=>({call:{maxTokens,maxCostMicros:1000},run:{maxTokens,maxCostMicros:1000},organizationUtcDay:{maxTokens,maxCostMicros:1000}});
const amount={inputTokens:30,outputTokens:20,costMicros:5};
const input=(f:Awaited<ReturnType<typeof createMarketSemanticFixture>>):ReserveMarketModelBudgetInput=>({id:randomUUID(),idempotencyKey:randomUUID(),requestFingerprint:'c'.repeat(64),projected:amount,limits:limits(),reservedAt:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60_000).toISOString(),request:{ordinal:0,kind:'initial',transientRetryCount:0,formatRepair:false},authority:f.authority});
const transition=(i:ReserveMarketModelBudgetInput)=>({reservationId:i.id,authority:i.authority,transitionedAt:new Date().toISOString()});

test('native market requests share PostgreSQL organization budgets and retain fenced accounting',{timeout:120_000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  const native=new PostgresMarketModelBudgetStore(pg.pool);
  const legacy=new PostgresModelBudgetStore(new PostgresQueryContext(pg.pool));
  async function seedLegacy(f:Awaited<ReturnType<typeof createMarketSemanticFixture>>) {
    const core=new PostgresCoreStore(new PostgresQueryContext(pg.pool)),now=new Date().toISOString(),projectId=randomUUID(),runId=randomUUID();
    await core.createProject({id:projectId,organizationId:f.actor.organizationId,name:'Budget fixture',marketplace:'US',asins:['B07Z5NQPDS','B0ABC12345','B0DEF67890'],createdBy:f.actor.userId,createdAt:now,updatedAt:now});
    await core.createAnalysisRun({id:runId,projectId,mode:'existing-data',status:'running',createdBy:f.actor.userId,dataCutoffAt:now,idempotencyScope:randomUUID(),idempotencyKey:'create',createdAt:now,updatedAt:now});
    return {id:randomUUID(),idempotencyKey:randomUUID(),requestFingerprint:'d'.repeat(64),runId,projectId,projected:amount,limits:limits(75),reservedAt:now,leaseExpiresAt:new Date(Date.now()+60_000).toISOString()};
  }
  await t.test('admission persists only native identities and restart/replay preserve one reservation',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f);
    const a=await native.reserve(i),b=await new PostgresMarketModelBudgetStore(pg.pool).reserve({...i,id:randomUUID()});
    assert.equal(a.created,true);assert.equal(b.created,false);assert.deepEqual(a.reservation,b.reservation);
    assert.equal(a.reservation.moduleRunId,f.subject.moduleRunId);assert.equal('projectId' in a.reservation,false);
    const row=(await pg.pool.query('SELECT * FROM model_budget_reservations WHERE id=$1',[i.id])).rows[0];
    assert.equal(row.run_id,null);assert.equal(row.agent_run_id,null);assert.equal(row.market_agent_run_id,f.record.id);
    assert.deepEqual(await native.getUsage({authority:f.authority,asOf:i.reservedAt}),{run:{tokens:50,costMicros:5},organizationUtcDay:{tokens:50,costMicros:5}});
    await assert.rejects(()=>native.reserve({...i,id:randomUUID(),idempotencyKey:randomUUID()}));
    await assert.rejects(()=>native.reserve({...i,projected:{...amount,inputTokens:31}}));
  });
  await t.test('legacy and market admissions enforce the same daily cap in both directions and concurrently',async()=>{
    for(const order of ['legacy','market','concurrent']) {
      const f=await createMarketSemanticFixture(pg.pool),old=await seedLegacy(f),i={...input(f),limits:limits(75)};
      if(order==='legacy'){await legacy.reserveModelBudget(old);await assert.rejects(()=>native.reserve(i),BudgetExceededError);}
      else if(order==='market'){await native.reserve(i);await assert.rejects(()=>legacy.reserveModelBudget(old),BudgetExceededError);}
      else {const results=await Promise.allSettled([native.reserve(i),legacy.reserveModelBudget(old)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected');assert.ok(rejected?.status==='rejected'&&rejected.reason instanceof BudgetExceededError);}
      const usage=await legacy.getModelBudgetUsage({runId:old.runId,projectId:old.projectId,asOf:new Date().toISOString()});assert.equal(usage.organizationUtcDay.tokens,50);
    }
  });
  await t.test('only one dispatch wins and legacy transitions cannot mutate native reservations',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f);await native.reserve(i);
    const old={reservationId:i.id,transitionedAt:new Date().toISOString()};
    for(const action of [()=>legacy.dispatchModelBudget(old),()=>legacy.releaseModelBudget(old),()=>legacy.settleModelBudget({...old,actual:amount})])await assert.rejects(action);
    const results=await Promise.all([native.dispatch(transition(i)),native.dispatch(transition(i))]);assert.equal(results.filter(r=>r.transitioned).length,1);
    await assert.rejects(()=>native.release(transition(i)));assert.equal((await native.getUsage({authority:f.authority,asOf:i.reservedAt})).run.tokens,50);
  });
  await t.test('wrong token/org and cancellation reject execution but dispatched usage can settle late exactly once',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f);await native.reserve(i);
    await assert.rejects(()=>native.dispatch({...transition(i),authority:{...i.authority,claimToken:randomUUID()}}));
    await assert.rejects(()=>native.dispatch({...transition(i),authority:{...i.authority,organizationId:randomUUID()}}));
    await native.dispatch(transition(i));await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
    await assert.rejects(()=>native.dispatch(transition(i)));await assert.rejects(()=>native.reserve({...i,id:randomUUID(),idempotencyKey:randomUUID()}));
    const settlement={...transition(i),actual:{inputTokens:11,outputTokens:9,costMicros:2},responseId:'late'};
    assert.equal((await native.settle(settlement)).transitioned,true);assert.equal((await native.settle(settlement)).transitioned,false);
    await assert.rejects(()=>native.settle({...settlement,actual:amount}));
    await assert.rejects(()=>native.settle({...settlement,authority:{...i.authority,leaseGeneration:2}}));
    await assert.rejects(()=>pg.pool.query('UPDATE model_budget_reservations SET actual_cost_micros=99 WHERE id=$1',[i.id]));
    const audit=(await f.stores.audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:f.subject.moduleRunId}))[0];assert.equal(audit.validationStatus,'pending');
  });
  await t.test('reserved requests cannot settle, expired ownership cannot dispatch and expiry releases projection',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f);await native.reserve(i);
    await assert.rejects(()=>native.settle({...transition(i),actual:amount}));
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.subject.stepId]);
    await assert.rejects(()=>native.dispatch(transition(i)));
    await pg.pool.query("UPDATE model_budget_reservations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[i.id]);
    assert.equal((await native.release(transition(i))).reservation.state,'released');
  });
  await t.test('database clock determines admission day; invalid amounts and changed identities are rejected',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f);i.reservedAt='2000-01-01T00:00:00.000Z';i.leaseExpiresAt='2000-01-01T00:01:00.000Z';
    const r=await native.reserve(i);const now=(await pg.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    assert.equal(r.reservation.utcDay,now.toISOString().slice(0,10));assert.ok(Math.abs(Date.parse(r.reservation.createdAt)-now.getTime())<5000);
    await assert.rejects(()=>native.reserve({...input(f),projected:{...amount,inputTokens:NaN}}));
    await assert.rejects(()=>pg.pool.query('UPDATE model_budget_reservations SET market_claim_token=$2 WHERE id=$1',[i.id,randomUUID()]));
    await assert.rejects(()=>pg.pool.query('DELETE FROM model_budget_reservations WHERE id=$1',[i.id]));
  });
  await t.test('expiry inside the reservation/dispatch transaction rolls back writes before provider authority is granted',async()=>{
    for(const operation of ['reserve','dispatch']) {
      const f=await createMarketSemanticFixture(pg.pool),i=input(f);
      if(operation==='dispatch')await native.reserve(i);
      await pg.pool.query('CREATE SEQUENCE budget_expiry_probe');
      await pg.pool.query(`CREATE FUNCTION delay_market_budget_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${i.id}' THEN PERFORM nextval('budget_expiry_probe'); PERFORM pg_sleep(1.1); END IF; RETURN NEW; END; $$`);
      await pg.pool.query(`CREATE TRIGGER budget_expiry_probe BEFORE ${operation==='reserve'?'INSERT':'UPDATE'} ON model_budget_reservations FOR EACH ROW EXECUTE FUNCTION delay_market_budget_write()`);
      try {
        await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()+interval '700 milliseconds' WHERE id=$1",[f.subject.stepId]);
        await assert.rejects(()=>operation==='reserve'?native.reserve(i):native.dispatch(transition(i)));
        assert.equal((await pg.pool.query('SELECT is_called FROM budget_expiry_probe')).rows[0].is_called,true);
        const row=(await pg.pool.query('SELECT state FROM model_budget_reservations WHERE id=$1',[i.id])).rows[0];
        if(operation==='reserve')assert.equal(row,undefined);else assert.equal(row.state,'reserved');
      } finally {await pg.pool.query('DROP TRIGGER budget_expiry_probe ON model_budget_reservations');await pg.pool.query('DROP FUNCTION delay_market_budget_write()');await pg.pool.query('DROP SEQUENCE budget_expiry_probe');}
    }
  });
  await t.test('old caller timestamps cannot prematurely release a native reservation and stale actors cannot start new work',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f),old=await seedLegacy(f);await native.reserve(i);
    await legacy.getModelBudgetUsage({runId:old.runId,projectId:old.projectId,asOf:'2099-01-01T00:00:00.000Z'});
    assert.equal((await pg.pool.query('SELECT state FROM model_budget_reservations WHERE id=$1',[i.id])).rows[0].state,'reserved');
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[f.actor.userId]);
    await assert.rejects(()=>native.dispatch(transition(i)));await assert.rejects(()=>native.resolveSubject(i.authority));
  });
  await t.test('ledger audit distinguishes projected admission from actual usage and counts every physical retry',async()=>{
    const f=await createMarketSemanticFixture(pg.pool),i=input(f);
    assert.equal((await native.getAgentUsage(f.authority)).reservationCount,0);
    await native.reserve(i);const pending=await native.getAgentUsage(f.authority);assert.equal(pending.reservationCount,1);assert.equal(pending.attempts.length,0);assert.equal(pending.inputTokens,null);
    await native.dispatch(transition(i));const sent=await native.getAgentUsage(f.authority);assert.equal(sent.attempts.length,1);assert.equal(sent.inputTokens,null);assert.equal(sent.usageCompleteness,'unavailable');
    await native.settle({...transition(i),actual:amount,responseId:'first'});
    const retry={...input(f),request:{ordinal:1,kind:'transient-retry' as const,transientRetryCount:1,formatRepair:false}};
    await native.reserve(retry);await native.dispatch(transition(retry));const partial=await native.getAgentUsage(f.authority);assert.equal(partial.usageCompleteness,'partial');assert.equal(partial.inputTokens,null);assert.equal(partial.attempts.length,2);
    await native.settle({...transition(retry),actual:{inputTokens:10,outputTokens:5,costMicros:1},responseId:'retry'});
    const complete=await new PostgresMarketModelBudgetStore(pg.pool).getAgentUsage(f.authority);assert.equal(complete.usageCompleteness,'complete');assert.equal(complete.inputTokens,40);assert.equal(complete.outputTokens,25);assert.equal(complete.estimatedCostMicros,6);assert.equal(complete.responseId,'retry');
    await assert.rejects(()=>native.getAgentUsage({...f.authority,organizationId:randomUUID()}));
  });
});
