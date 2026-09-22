import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../../server/db/postgres/market-module-execution-store';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketExecutionConflictError} from '../../server/db/market-module-execution-repository';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

test('all market module starts replay frozen commands before current model or date checks',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const actor={organizationId:randomUUID(),userId:randomUUID()};
 await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Module entry','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
 const identity={configurationVersion:'synthetic/config-v1',promptVersion:'synthetic/prompt-v1'};
 const create=(version:typeof identity|null,date='2026-09-16T08:00:00Z')=>new MarketModuleService({context:new PostgresQueryContext(pg.pool),modelIdentity:()=>version,keywordExplicitModelIdentity:()=>version,now:()=>new Date(date)});
 const service=create(identity),study=await service.createStudy(actor,{marketplace:'US',currency:'USD',nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-08'},randomUUID());
 const shapes={poolSize:10,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'synthetic/v1',allowedLabels:[]}};
 const keywords={plannedPages:[{seed:'snow scooter',page:1}],maxMembers:10,catalog:{task:'market-keyword-semantics',dictionaryVersion:'synthetic/v1',categoryContext:'snow sports',dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[]}};
 const themes={memberCount:5,poolSize:10,newProductMonths:6};
 const cases=[{name:'shape-price',method:'startShapes',params:shapes,changed:{...shapes,poolSize:11}},
  {name:'keywords',method:'startKeywords',params:keywords,changed:{...keywords,maxMembers:11}},
  {name:'customer-themes',method:'startThemes',params:themes,changed:{...themes,memberCount:4}}] as const;
 const expectedFlows={
  'shape-price':'market-shape-price-flow/rules-v1',
  keywords:'market-keyword-flow/rules-v1',
  'customer-themes':'market-theme-flow/rules-v1',
 } as const;
 for(const c of cases)await t.test(c.name,async()=>{
  const key=randomUUID(),original=await service[c.method](actor,study.study.id,c.params,key);
  assert.equal(original.created,true);
  const initial=await new PostgresMarketModuleExecutionStore(new PostgresQueryContext(pg.pool)).findModuleRun({actor,moduleRunId:original.run.id});
  assert.equal((initial!.run.params as {flow:string}).flow,expectedFlows[c.name]);
  assert.equal(initial!.run.versions.model,null);
  for(const next of [create(null),create({...identity,configurationVersion:'synthetic/config-v2'},'2027-09-16T08:00:00Z')]){
   const restored=await next[c.method](actor,study.study.id,c.params,key);assert.equal(restored.created,false);assert.equal(restored.run.id,original.run.id);
  }
  await assert.rejects(service[c.method](actor,study.study.id,c.changed,key),MarketExecutionConflictError);
  const otherModule=cases.find(candidate=>candidate.name!==c.name)!;
  await assert.rejects(service[otherModule.method](actor,study.study.id,otherModule.params,key),MarketExecutionConflictError);
  if('catalog' in c.params)await assert.rejects(service[c.method](actor,study.study.id,{...c.params,catalog:{...c.params.catalog,...(c.name==='shape-price'?{taxonomyVersion:'changed/v2'}:{categoryContext:'unrelated product'})}},key),MarketExecutionConflictError);
  const otherStudy=await service.createStudy(actor,{marketplace:'US',currency:'USD',nodeIdPath:'12:35',fromMonth:'2026-07',toMonth:'2026-08'},randomUUID());
  await assert.rejects(service[c.method](actor,otherStudy.study.id,c.params,key),MarketExecutionConflictError);
  const saved=await new PostgresMarketModuleExecutionStore(new PostgresQueryContext(pg.pool)).findModuleRun({actor,moduleRunId:original.run.id});assert.equal(saved?.run.versions.configuration,null);
  const raceKey=randomUUID(),raceParams=c.name==='shape-price'?{...c.params,poolSize:12}:c.name==='keywords'?{...c.params,maxMembers:12}:{...c.params,memberCount:6},contenders=[create(identity),create({...identity,configurationVersion:'synthetic/race-v2'})];
  let arrivals=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  for(const contender of contenders){const store=(contender as unknown as {steps:PostgresMarketModuleExecutionStore}).steps,find=store.findCreatedModuleRunByCommand.bind(store);store.findCreatedModuleRunByCommand=async input=>{const prior=await find(input);if(!prior){if(++arrivals===2)release();await gate;}return prior;};}
  const race=await Promise.all(contenders.map(s=>s[c.method](actor,study.study.id,raceParams,raceKey)));assert.equal(new Set(race.map(r=>r.run.id)).size,1);assert.equal(race.filter(r=>r.created).length,1);
  const outsider={organizationId:randomUUID(),userId:randomUUID()};
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Other organization','member','active',clock_timestamp(),clock_timestamp())",[outsider.userId,outsider.organizationId,`${outsider.userId}@example.test`]);
  const foreignStudy=await service.createStudy(outsider,{marketplace:'US',currency:'USD',nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-08'},randomUUID());
  await assert.rejects(service[c.method](outsider,study.study.id,c.params,key));
  const isolated=await service[c.method](outsider,foreignStudy.study.id,c.params,key);assert.notEqual(isolated.run.id,original.run.id);
  await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[actor.userId]);
  try{await assert.rejects(service[c.method](actor,study.study.id,c.params,key));}finally{await pg.pool.query("UPDATE users SET status='active' WHERE id=$1",[actor.userId]);}
 });
});
