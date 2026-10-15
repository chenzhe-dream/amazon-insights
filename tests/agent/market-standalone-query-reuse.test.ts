import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleService} from '../../server/services/market-module-service';
import {linkedModuleParams} from '../../shared/market-linked-contracts';
import {createSorftimeSourceCache} from '../../scripts/lib/sorftime-source-cache.mjs';

test('standalone queries share server history, isolate intent, and fence explicit refresh atomically',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool),service=new MarketModuleService({context:f.context,modelIdentity:()=>null});
 const {organizationId,researchId,...scope}=f.scope;
 for(const module of ['keywords','themes'] as const){
  const method=module==='keywords'?'queryKeywords':'queryThemes';
  assert.equal(typeof service[method],'function','standalone entry must have a durable server query');
  const body={scope,params:linkedModuleParams(module,'Floor Lamps',6,10) as Record<string,unknown>};
  const [a,b]=await Promise.all([service[method](f.actor,body,randomUUID()),service[method](f.actor,body,randomUUID())]);
  assert.equal(a.run.id,b.run.id,'parallel queries reuse the same queued task');
  const other=await createMarketSemanticFixture(pg.pool,{organizationId:f.actor.organizationId});
  assert.equal((await service[method](other.actor,body,randomUUID())).run.id,a.run.id,'same organization shares validated history');
  const leaf=scope.nodeIdPath.split(':').at(-1)!;
  assert.equal((await service[method](f.actor,{...body,scope:{...scope,nodeIdPath:leaf}},randomUUID())).run.id,a.run.id);
  const changed={...body,params:{...body.params,...(module==='keywords'?{maxMembers:150}:{memberCount:10})}};
  assert.notEqual((await service[method](f.actor,changed,randomUUID())).run.id,a.run.id);
  assert.notEqual((await service[method](f.actor,{...body,scope:{...scope,marketplace:'DE',currency:'EUR'}},randomUUID())).run.id,a.run.id);
  const foreign=await createMarketSemanticFixture(pg.pool);
  assert.notEqual((await service[method](foreign.actor,body,randomUUID())).run.id,a.run.id);
  await assert.rejects(service[method]({...f.actor,userId:randomUUID()},body,randomUUID()));
  const cache=createSorftimeSourceCache({pool:pg.pool});let calls=0;
  const spec={key:'synthetic-'+module,endpoint:'http://127.0.0.1:1',tool:'product_trend',args:{amz_site:'US',asin:'B000000001',type:'SalesVolume'}};
  const execute=async()=>{calls++;return {data:{values:[1,2]}};};
  await cache.run({...spec,jobId:a.run.id},execute);
  const key=randomUUID(),fresh=await service[method](f.actor,{...body,forceRefresh:true},key);
  assert.notEqual(fresh.run.id,a.run.id);
  assert.equal((await pg.pool.query('SELECT count(*)::int AS n FROM sorftime_source_refresh_scopes WHERE job_id=$1',[fresh.run.id])).rows[0].n,1);
  await cache.run({...spec,jobId:fresh.run.id},execute);assert.equal(calls,2,'explicit refresh bypasses the older physical response');
  const restarted=new MarketModuleService({context:f.context,modelIdentity:()=>null});
  assert.equal((await restarted[method](f.actor,{...body,forceRefresh:true},key)).run.id,fresh.run.id);
  await assert.rejects(service[method](f.actor,{...changed,forceRefresh:true},key));
  await pg.pool.query("UPDATE market_analysis_module_runs SET status='failed' WHERE id=$1",[fresh.run.id]);
  assert.equal((await restarted[method](f.actor,body,randomUUID())).run.id,a.run.id,'failed refresh cannot hide the existing matching task');
  await pg.pool.query("UPDATE market_analysis_module_runs SET status='succeeded' WHERE id=$1",[a.run.id]);
  assert.notEqual((await restarted[method](f.actor,body,randomUUID())).run.id,a.run.id,'empty success is not a usable historical report');
 }
});
