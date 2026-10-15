import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {PostgresMarketProjectFavoritesStore} from '../../server/db/postgres/market-project-favorites-store';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

test('category catalog groups leaf IDs and modules, preserves versions, pages lightweight history and separates complete scopes',async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const org=randomUUID(),user=randomUUID(),otherOrg=randomUUID(),otherUser=randomUUID();
 for(const [o,u] of [[org,user],[otherOrg,otherUser]])await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Tester','member','active',now(),now())",[u,o,u+'@example.com']);
 const queries=new PostgresQueryContext(pg.pool),store=new PostgresMarketProjectFavoritesStore(queries);
 const actor={organizationId:org,userId:user,role:'admin' as const};
 const reads:string[]=[];const query=queries.query.bind(queries);queries.query=(async(sql:string,values?:unknown[])=>{reads.push(sql);const result=await query(sql,values);assert.ok(!JSON.stringify(result.rows).includes('BODY_MUST_NOT_BE_LOADED'));return result}) as typeof queries.query;
 const kinds={overview:'overview',shapes:'shape-price',keywords:'keywords',themes:'customer-themes'};
 async function add(module:keyof typeof kinds,node='1:1063294',site='US',from='2026-09',to='2026-09',owner=org,author=user,period?:string){
  const study=randomUUID(),run=randomUUID(),step=randomUUID(),attempt=randomUUID(),fav=randomUUID();
  const scope={organizationId:owner,researchId:study,marketplace:site,nodeIdPath:node,fromMonth:from,toMonth:to,...(period?{overviewPeriod:period}:{})};
  const binding={marketplace:site,nodeIdPath:node,fromMonth:from,toMonth:to,runId:run,...(period?{overviewPeriod:period}:{})};
  await pg.pool.query("INSERT INTO market_analysis_studies(id,organization_id,created_by,idempotency_key,scope_json,scope_hash,created_at) VALUES($1,$2,$3,$1,$4,repeat('a',64),now())",[study,owner,author,scope]);
  await pg.pool.query("INSERT INTO market_analysis_module_runs(id,organization_id,study_id,created_by,request_json,request_fingerprint,status) VALUES($1,$2,$3,$4,$5,md5($1::uuid::text)||md5($1::uuid::text),'succeeded')",[run,owner,study,author,{scope,moduleKind:kinds[module],headTopN:20,newProductMonths:3}]);
  await pg.pool.query("INSERT INTO market_analysis_steps(id,organization_id,study_id,run_id,step_key,definition_json,input_hash,kind,status) VALUES($1,$2,$3,$4,'report',$5,repeat('c',64),'report','succeeded')",[step,owner,study,run,{stepKey:'report',kind:'report'}]);
  await pg.pool.query("INSERT INTO market_analysis_step_attempts(id,organization_id,study_id,run_id,step_id,attempt_number,retry_round,lease_owner_id,lease_generation,input_hash,status,output_json,finished_at) VALUES($1,$2,$3,$4,$5,1,0,$6,1,repeat('c',64),'succeeded',$7,now())",[attempt,owner,study,run,step,randomUUID(),{report:{status:'complete',body:'BODY_MUST_NOT_BE_LOADED'.repeat(1000)}}]);
  await pg.pool.query('UPDATE market_analysis_module_runs SET latest_report_attempt_id=$2 WHERE id=$1',[run,attempt]);
  await pg.pool.query("INSERT INTO market_project_favorites(id,organization_id,created_by,title,context_json,fingerprint) VALUES($1,$2,$3,$4,$5,$6)",[fav,owner,author,'灯具 '+node,{[module]:binding,headTopN:'20',newProductMonths:'3'},fav]);
  return {run,fav,binding};
 }
 const first=await add('overview');await add('shapes','1063294');await add('keywords');await add('themes');
 // Distinct versions remain visible; duplicate references to a run count only once.
 for(let n=0;n<11;n++)await add('shapes','1063294');
 const duplicate=randomUUID();await pg.pool.query("INSERT INTO market_project_favorites(id,organization_id,created_by,title,context_json,fingerprint) VALUES($1,$2,$3,'Same run saved again',$4,$1::uuid::text)",[duplicate,org,user,{overview:first.binding}]);
 await add('overview','987','US');await add('shapes','987','DE');await add('keywords','987','US');await add('themes','987','US','2026-08','2026-08');
 await add('themes','1:333','JP','2026-09','2026-09',otherOrg,otherUser);
 const condition=randomUUID();await pg.pool.query("INSERT INTO market_project_favorites(id,organization_id,created_by,title,context_json,fingerprint) VALUES($1,$2,$3,'Only conditions',$4,$1::uuid::text)",[condition,org,user,{overview:{marketplace:'US',nodeIdPath:'1063294',fromMonth:'2026-07',toMonth:'2026-07'}}]);
 const index=await store.catalog(actor,{});
 assert.equal(index.total,3);assert.equal(index.stats.categories,3);assert.equal(index.stats.reports,20);assert.equal(index.stats.complete,1);
 const lamp=index.items.find(c=>c.categoryId==='1063294')!;
 assert.equal(lamp.modules.shapes.reports,12);assert.equal(lamp.modules.overview.reports,1);assert.equal(lamp.modules.overview.conditions,1);assert.equal(lamp.complete,true);
 assert.equal(index.items.find(c=>c.categoryId==='987')?.complete,false,'different sites/months must not imply complete');
 const history=await store.history(actor,{categoryId:'1063294',module:'shapes',page:2});
 assert.equal(history.total,12);assert.equal(history.items.length,2);assert.equal(history.page,2);
 for(const row of history.items){assert.equal(row.context.shapes?.nodeIdPath,'1063294');assert.equal(row.context.headTopN,'20');assert.equal(row.context.newProductMonths,'3');assert.equal(row.status,'ready');assert.ok(!('output_json' in row))}
 assert.equal((await store.history(actor,{categoryId:'1063294',module:'themes',site:'DE'})).total,0);
 assert.equal((await store.catalog(actor,{mine:'true'})).total,2);
 assert.equal((await store.catalog(actor,{q:'987'})).total,1);
 const shared=await store.history({organizationId:otherOrg,userId:otherUser,role:'member'},{categoryId:'1063294',module:'overview'});assert.equal(shared.items.length,2);
 assert.ok(reads.some(sql=>/LIMIT/i.test(sql)&&/OFFSET/i.test(sql)),'history must be paginated by SQL');
 assert.equal((await pg.pool.query('SELECT count(*) FROM market_project_favorites')).rows[0].count,'22','no records removed by grouping');
 assert.equal((await store.catalog(actor,{q:'not-a-category'})).total,0);
 assert.equal((await store.history(actor,{categoryId:'1063294',module:'shapes',page:999})).page,2);
 for(const m of ['overview','shapes','keywords','themes'] as const)await add(m,'444','US','2026-09','2026-09',org,user,m==='overview'?'last30':undefined);
 assert.equal((await store.catalog(actor,{q:'444'})).stats.complete,0,'last30 cannot close a calendar cohort');
 const partialAttempt=randomUUID();
 await pg.pool.query("INSERT INTO market_analysis_step_attempts(id,organization_id,study_id,run_id,step_id,attempt_number,retry_round,lease_owner_id,lease_generation,input_hash,status,output_json,finished_at) SELECT $2,organization_id,study_id,run_id,step_id,2,0,lease_owner_id,2,input_hash,'succeeded',jsonb_build_object('report',jsonb_build_object('status','partial')),now() FROM market_analysis_step_attempts WHERE run_id=$1",[first.run,partialAttempt]);
 await pg.pool.query('UPDATE market_analysis_module_runs SET latest_report_attempt_id=$2 WHERE id=$1',[first.run,partialAttempt]);
 assert.equal((await store.catalog(actor,{})).stats.complete,0,'partial overview breaks completeness');

});
