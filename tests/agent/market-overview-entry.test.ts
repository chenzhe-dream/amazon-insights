import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type {Pool} from 'pg';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresMarketAnalysisSnapshotStore} from '../../server/db/postgres/market-analysis-snapshot-store';
import {PostgresMarketModuleExecutionStore} from '../../server/db/postgres/market-module-execution-store';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../../server/db/market-module-execution-repository';
import {MARKET_OVERVIEW_TABLE_CATALOG_VERSION} from '../../server/domain/market-research/overview-complete-catalog';
import {MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,marketOverviewFlowInitialSteps} from '../../server/domain/market-research/overview-flow';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION} from '../../shared/market-overview-distribution-contracts';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

const NOW='2026-09-16T08:00:00.000Z';
const PARAMS={headTopN:10 as const,newProductMonths:6 as const};

async function seedStudy(pool:Pool,organizationId:string=randomUUID()):Promise<{actor:MarketExecutionActor;scope:{organizationId:string;researchId:string;marketplace:'US';nodeIdPath:string;fromMonth:string;toMonth:string;currency:'USD'};context:PostgresQueryContext}> {
  const actor={organizationId,userId:randomUUID()};
  await pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Overview entry','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
  const scope={organizationId,researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
  const context=new PostgresQueryContext(pool);
  await new PostgresMarketAnalysisSnapshotStore(context).createStudy({actor,scope,idempotencyKey:scope.researchId,now:NOW});
  return {actor,scope,context};
}

test('overview entry freezes local rules identity and replays commands by public intent',{timeout:120_000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  const first=await seedStudy(pg.pool),identity={configurationVersion:'overview-config/v1',promptVersion:'overview-prompt/v1'};
  const service=new MarketModuleService({context:first.context,modelIdentity:()=>({configurationVersion:'legacy-config/v9',promptVersion:'legacy-prompt/v9'}),overviewSynthesisModelIdentity:()=>identity,now:()=>new Date(NOW)});

  await t.test('new runs bind local rules flow and no model identity',async()=>{
    const key=randomUUID(),started=await service.startOverview(first.actor,first.scope.researchId,PARAMS,key);
    assert.equal(started.created,true);
    const saved=await new PostgresMarketModuleExecutionStore(first.context).findModuleRun({actor:first.actor,moduleRunId:started.run.id});assert.ok(saved);
    assert.deepEqual(saved.run.params,{...PARAMS,flow:'market-overview-flow/rules-v1'});
    assert.deepEqual(saved.run.versions,{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_TABLE_CATALOG_VERSION,mapping:MARKET_OVERVIEW_TABLE_CATALOG_VERSION,planner:'market-overview-flow/rules-v1',model:null,prompt:null,configuration:null});
  });

  await t.test('missing model identity does not block a rules-only start',async()=>{
    const withoutSynthesis=new MarketModuleService({context:first.context,modelIdentity:()=>({configurationVersion:'legacy-config/v9',promptVersion:'legacy-prompt/v9'}),now:()=>new Date(NOW)});
    const started=await withoutSynthesis.startOverview(first.actor,first.scope.researchId,PARAMS,randomUUID());
    const saved=await new PostgresMarketModuleExecutionStore(first.context).findModuleRun({actor:first.actor,moduleRunId:started.run.id});assert.ok(saved);
    assert.deepEqual({model:saved.run.versions.model,prompt:saved.run.versions.prompt,configuration:saved.run.versions.configuration},{model:null,prompt:null,configuration:null});
  });

  await t.test('legacy command replay returns its frozen run after runtime identity changes',async()=>{
    const store=new PostgresMarketModuleExecutionStore(first.context),key=randomUUID();
    const request={actor:first.actor,scope:first.scope,moduleKind:'overview' as const,params:{...PARAMS,flow:MARKET_OVERVIEW_EXPANDED_FLOW_VERSION},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION,mapping:MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION,planner:MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,model:'market.semantic.text.v1',prompt:'legacy-prompt/v1',configuration:'legacy-config/v1'},collectionRevision:'initial/v1',idempotencyKey:key};
    const legacy=await store.createModuleRun({...request,initialSteps:marketOverviewFlowInitialSteps(request)});
    const replay=await service.startOverview(first.actor,first.scope.researchId,PARAMS,key);
    assert.equal(replay.created,false);assert.equal(replay.run.id,legacy.run.id);
    const frozen=await store.findModuleRun({actor:first.actor,moduleRunId:legacy.run.id});assert.ok(frozen);
    assert.equal((frozen.run.params as {flow:string}).flow,MARKET_OVERVIEW_EXPANDED_FLOW_VERSION);
  });

  await t.test('current rules command replay ignores later model identity changes',async()=>{
    const key=randomUUID(),created=await service.startOverview(first.actor,first.scope.researchId,{...PARAMS,headTopN:5},key);
    const changed=new MarketModuleService({context:first.context,modelIdentity:()=>null,overviewSynthesisModelIdentity:()=>({configurationVersion:'overview-config/v2',promptVersion:'overview-prompt/v2'}),now:()=>new Date(NOW)});
    const replay=await changed.startOverview(first.actor,first.scope.researchId,{...PARAMS,headTopN:5},key);
    assert.equal(replay.created,false);assert.equal(replay.run.id,created.run.id);
  });

  await t.test('same key rejects changed params or study but remains organization scoped',async()=>{
    const key=randomUUID(),original=await service.startOverview(first.actor,first.scope.researchId,PARAMS,key);
    await assert.rejects(service.startOverview(first.actor,first.scope.researchId,{...PARAMS,headTopN:20},key),MarketExecutionConflictError);
    const otherStudy=await seedStudy(pg.pool,first.actor.organizationId);
    await assert.rejects(service.startOverview(first.actor,otherStudy.scope.researchId,PARAMS,key),MarketExecutionConflictError);
    const otherOrg=await seedStudy(pg.pool),otherService=new MarketModuleService({context:otherOrg.context,modelIdentity:()=>null,overviewSynthesisModelIdentity:()=>identity,now:()=>new Date(NOW)});
    const isolated=await otherService.startOverview(otherOrg.actor,otherOrg.scope.researchId,PARAMS,key);
    assert.notEqual(isolated.run.id,original.run.id);
    assert.equal((await new PostgresMarketModuleExecutionStore(first.context).findModuleRun({actor:otherOrg.actor,moduleRunId:original.run.id})),null);
  });

  await t.test('concurrent identical starts converge on one run',async()=>{
    const key=randomUUID(),params={...PARAMS,newProductMonths:3 as const},results=await Promise.all(Array.from({length:6},()=>service.startOverview(first.actor,first.scope.researchId,params,key)));
    assert.equal(new Set(results.map(result=>result.run.id)).size,1);
    assert.equal(results.filter(result=>result.created).length,1);
    const count=await pg.pool.query("SELECT count(*)::int AS count FROM market_analysis_commands WHERE organization_id=$1 AND kind='create' AND idempotency_key=$2",[first.actor.organizationId,key]);
    assert.equal(count.rows[0].count,1);
  });

  await t.test('concurrent starts with different runtime identities return the committed winner',async()=>{
    const key=randomUUID(),params={headTopN:20 as const,newProductMonths:12 as const};
    const services=['a','b'].map(version=>new MarketModuleService({context:new PostgresQueryContext(pg.pool),modelIdentity:()=>null,
      overviewSynthesisModelIdentity:()=>({configurationVersion:`overview-config/${version}`,promptVersion:`overview-prompt/${version}`}),now:()=>new Date(NOW)}));
    let arrivals=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    for(const candidate of services){
      const steps=(candidate as unknown as {steps:PostgresMarketModuleExecutionStore}).steps;
      const original=steps.findCreatedModuleRunByCommand.bind(steps);
      steps.findCreatedModuleRunByCommand=async value=>{const found=await original(value);if(!found&&++arrivals===2)release();if(!found)await gate;return found;};
    }
    const results=await Promise.all(services.map(candidate=>candidate.startOverview(first.actor,first.scope.researchId,params,key)));
    assert.equal(new Set(results.map(result=>result.run.id)).size,1);assert.equal(results.filter(result=>result.created).length,1);
  });

  await t.test('inactive actors cannot replay a command',async()=>{
    const key=randomUUID();await service.startOverview(first.actor,first.scope.researchId,{...PARAMS,newProductMonths:1},key);
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[first.actor.userId]);
    try{await assert.rejects(service.startOverview(first.actor,first.scope.researchId,{...PARAMS,newProductMonths:1},key));}
    finally{await pg.pool.query("UPDATE users SET status='active' WHERE id=$1",[first.actor.userId]);}
  });
});
