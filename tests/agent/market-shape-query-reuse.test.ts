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
 assert.equal((await pg.pool.query('SELECT count(*)::int AS count FROM sorftime_source_refresh_scopes WHERE job_id=$1',[fresh.run.id])).rows[0].count,1);
 assert.equal((await pg.pool.query('SELECT count(*)::int AS count FROM sorftime_source_refresh_scopes WHERE job_id=$1',[a.run.id])).rows[0].count,0);
 assert.equal((await service.queryShapes(f.actor,{...body,forceRefresh:true},key)).run.id,fresh.run.id);
 const future=new MarketModuleService({context:f.context,modelIdentity:()=>null,now:()=>new Date('2030-01-01T00:00:00Z')});
 assert.equal((await future.queryShapes(f.actor,{...body,forceRefresh:true},key)).run.id,fresh.run.id,'accepted command replays after its original collection window expires');
 await assert.rejects(future.queryShapes(f.actor,body,randomUUID()),/最近24个完整月份/);
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

test('completed usable cache expires after seven days without changing explicit history reads',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
 const {organizationId,researchId,...scope}=f.scope;const params={poolSize:100,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'manual-after-collection/v1',allowedLabels:[]}};const body={scope,params};
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null});const first=await service.queryShapes(f.actor,body,randomUUID());
 await pg.pool.query("UPDATE market_analysis_module_runs SET status='succeeded' WHERE id=$1",[first.run.id]);
 // Stub only the source projection; cache lookup, persisted status, identity, TTL and receipts use PostgreSQL.
 const withSource=(base:MarketModuleService)=>{const read=base.findShapes.bind(base);base.findShapes=async(actor,id)=>{const result=await read(actor,id);if(result.run.id===first.run.id)result.run.source={referenceAttemptId:randomUUID(),historyAttemptIds:[],referenceSnapshotId:'fixture',fetchedAt:new Date().toISOString(),selectionBasis:'provider-row-order',bsrTopVerified:false,products:[{asin:'B000000001',title:'fixture',brand:null,price:20,units:10}]};return result;};return base;};
 withSource(service);assert.equal((await service.queryShapes(f.actor,body,randomUUID())).run.id,first.run.id);
 const latestEmpty=await service.queryShapes(f.actor,{...body,forceRefresh:true},randomUUID());await pg.pool.query("UPDATE market_analysis_module_runs SET status='succeeded' WHERE id=$1",[latestEmpty.run.id]);assert.equal((await service.queryShapes(f.actor,body,randomUUID())).run.id,first.run.id,'new empty result must not hide an older usable cache');
 const late=withSource(new MarketModuleService({context:f.context,modelIdentity:()=>null,now:()=>new Date(Date.now()+8*86400000)}));
 assert.notEqual((await late.queryShapes(f.actor,body,randomUUID())).run.id,first.run.id);assert.equal((await late.findShapes(f.actor,first.run.id)).run.id,first.run.id);
});
