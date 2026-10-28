import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MarketLinkedService} from '../../server/services/market-linked-service';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketResearchService} from '../../server/services/market-research-service';
import {PostgresMarketResearchStore} from '../../server/db/postgres/market-research-store';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {marketSiteCurrency,type MarketSite} from '../../shared/market-sites';
import type {MarketOverviewReport} from '../../shared/market-research-contracts';

// Synthetic source responses, isolated disposable PostgreSQL, no live connectors/models.
// Non-US nodes below are test identities, not claims of real marketplace taxonomy.
test('offline multi-category dispatch preserves each site, category and date without cross-batch contamination',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool),store=new PostgresMarketResearchStore(f.context);
 const research=new MarketResearchService({repository:store,findUser:async id=>id===f.actor.userId?{organizationId:f.actor.organizationId,status:'active'}:null});
 let providerCalls=0;
 const modules=new MarketModuleService({context:f.context,modelIdentity:()=>null,resolveNodePath:async()=>{providerCalls++;throw Error('Live provider forbidden in offline suite');}});
 const make=()=>new MarketLinkedService({context:f.context,research,modules,now:()=>new Date('2026-10-14T00:00:00Z')});
 const cases:[MarketSite,string,string,string,string][]=[
  ['US','3405881','3375251:10971181011:706808011:3405651:3405881','Fixture backyard game','2026-07'],
  ['DE','990000002','9900:990000002','Testkategorie Spielzeug','2026-08'],
  ['JP','990000003','9900:990000003','テスト用おもちゃ','2026-09'],
 ];
 const batches: {id:string;runIds:string[]}[]=[];
 for(const [marketplace,nodeQuery,nodePath,categoryName,fromMonth] of cases){await t.test(`${marketplace} ${nodeQuery} propagates all four module identities`,async()=>{
  const request={scope:{marketplace,nodeQuery,month:'2026-09',headTopN:10,newProductMonths:6},fromMonth};
  const key=randomUUID(),created=await make().create(f.actor,request,key);
  const claim=await store.claim({ownerId:'offline-multicategory',now:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString()});assert.ok(claim);assert.equal(claim.job.id,created.batch.basicJobId);
  const report:MarketOverviewReport={schemaVersion:'market-overview/v1',scope:claim.job.scope,nodeId:nodeQuery,nodeIdPath:nodePath,categoryName,currency:marketSiteCurrency(marketplace),collectedAt:new Date().toISOString(),metrics:{sampleProducts:100,brands:null,sellers:null,totalUnits:null,totalRevenue:null,avgPrice:null,avgUnits:null,avgRatings:null,avgRating:null,productConcentrationRaw:null,brandConcentrationRaw:null,sellerConcentrationRaw:null,newCount:null,newAvgPrice:null,newAvgUnits:null},evidence:[],issues:[],boundaries:['SYNTHETIC offline connectivity fixture; not supplier acceptance']};
  await store.finish({claim,now:new Date().toISOString(),report,error:null});await make().tick();
  const batch=(await make().find(f.actor,key)).batch;assert.equal(batch.status,'started');
  const ids=Object.values(batch.modules).map(m=>{assert.equal(m.status,'started');assert.ok(m.runId);return m.runId!;});assert.equal(new Set(ids).size,4);
  const runs=(await pg.pool.query('SELECT id,request_json FROM market_analysis_module_runs WHERE id=ANY($1::uuid[])',[ids])).rows;assert.equal(runs.length,4);
  for(const r of runs){const s=r.request_json.scope;assert.equal(s.marketplace,marketplace);assert.equal(s.currency,marketSiteCurrency(marketplace));assert.equal(s.nodeIdPath,['shape-price','customer-themes'].includes(r.request_json.moduleKind)?nodeQuery:nodePath,'early independent runs preserve their original verified leaf scope');assert.equal(s.fromMonth,fromMonth);assert.equal(s.toMonth,'2026-09');}
  assert.equal(runs.find(r=>r.request_json.moduleKind==='keywords').request_json.params.plannedPages[0].seed,categoryName);
  // Reload/recreate and replay are reads or deduplicated commands; no additional runs.
  await make().find(f.actor,key);await make().create(f.actor,request,key);await make().tick();
  const reloaded=(await make().find(f.actor,key)).batch;assert.deepEqual(reloaded.modules,batch.modules);
  batches.push({id:key,runIds:ids});
 });}
 assert.equal(new Set(batches.flatMap(b=>b.runIds)).size,12);
 for(const b of batches)assert.deepEqual(Object.values((await make().find(f.actor,b.id)).batch.modules).map(m=>m.runId),b.runIds);
 assert.equal(providerCalls,0);
});
