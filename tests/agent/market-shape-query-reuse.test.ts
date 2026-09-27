import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleService} from '../../server/services/market-module-service';

test('equivalent concurrent shape queries reuse a run and explicit refresh is idempotent',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null});
 const {organizationId,researchId,...scope}=f.scope;
 const params={poolSize:100,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'manual-after-collection/v1',allowedLabels:[]}};
 const body={scope,params};
 const [a,b]=await Promise.all([service.queryShapes(f.actor,body,randomUUID()),service.queryShapes(f.actor,body,randomUUID())]);
 assert.equal(a.run.id,b.run.id);
 const key=randomUUID(),fresh=await service.queryShapes(f.actor,{...body,forceRefresh:true},key);
 assert.notEqual(fresh.run.id,a.run.id);
 assert.equal((await service.queryShapes(f.actor,{...body,forceRefresh:true},key)).run.id,fresh.run.id);
 await assert.rejects(service.queryShapes(f.actor,{...body,params:{...params,poolSize:150},forceRefresh:true},key));
 await assert.rejects(service.queryShapes({...f.actor,userId:randomUUID()},body,randomUUID()));
 // A target size change is a different query, not an incrementally merged task.
 const expanded=await service.queryShapes(f.actor,{...body,params:{...params,poolSize:150}},randomUUID());assert.notEqual(expanded.run.id,a.run.id);
 const leaf=scope.nodeIdPath.split(':').at(-1)!;
 const aliased=await service.queryShapes(f.actor,{...body,scope:{...scope,nodeIdPath:leaf}},randomUUID());assert.equal(aliased.run.id,fresh.run.id);
 const other=await createMarketSemanticFixture(pg.pool,{organizationId:f.actor.organizationId});
 const otherResult=await service.queryShapes(other.actor,body,randomUUID());assert.notEqual(otherResult.run.id,fresh.run.id);
 // Completed but empty runs must not qualify as a usable report cache.
 await pg.pool.query("UPDATE market_analysis_module_runs SET status='succeeded' WHERE id=ANY($1::uuid[])",[[a.run.id,fresh.run.id]]);
 const afterEmpty=await service.queryShapes(f.actor,body,randomUUID());assert.notEqual(afterEmpty.run.id,fresh.run.id);assert.notEqual(afterEmpty.run.id,a.run.id);
 await pg.pool.query("UPDATE market_analysis_module_runs SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",[afterEmpty.run.id]);
 const afterCancelled=await service.queryShapes(f.actor,body,randomUUID());assert.notEqual(afterCancelled.run.id,afterEmpty.run.id);
 const count=await pg.pool.query("SELECT count(*)::int AS n FROM market_analysis_module_runs WHERE request_json->>'moduleKind'='shape-price'");assert.equal(count.rows[0].n,6);
});
