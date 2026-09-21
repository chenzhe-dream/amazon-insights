import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../../server/db/postgres/market-module-execution-store';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketKeywordPoolStep} from '../../server/runtime/market-keyword-pool-step';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

test('UK keyword pipeline durably completes basic facts with unsupported ABA, zero SIF calls and stable reopen',{timeout:120000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  const context=new PostgresQueryContext(pg.pool),steps=new PostgresMarketModuleExecutionStore(context),actor={organizationId:randomUUID(),userId:randomUUID()};
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'UK fixture','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
  let sourceCalls=0,abaCalls=0;
  const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('No probe');},execute:async request=>{
    sourceCalls++;assert.equal(request.input.keyword_support_site,'GB');
    return {data:request.operation==='keyword_extends'?{site:'GB',data:[{keyword:'floor lamp',monthly_search_volume:200,recommended_cpc_bid:'1.50'}]}:
      {site:'GB',data:{keyword:request.input.keyword,search_volume_trend:['2026-08 search volume 20'],search_rank_trend:[],recommended_bid_trend:[]}},
      source:{connectorId:'sorftime',operation:request.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
  }};
  const sif:RemoteMcpConnector={id:'sif',probe:async()=>{throw Error('No probe');},execute:async()=>{abaCalls++;throw Error('Unverified site must not call SIF');}};
  const worker=new MarketModuleStepWorker({steps,handlers:{...createMarketSourceStepHandlers({context,connectors:{sorftime,sif,sellerSprite:{...sorftime,id:'sellerSprite'}}}),'prepare-keyword-pool':createMarketKeywordPoolStep(context)}});t.after(()=>worker.stop());
  const service=new MarketModuleService({context,modelIdentity:()=>null});
  const study=await service.createStudy(actor,{marketplace:'UK',currency:'GBP',nodeIdPath:'12:34',fromMonth:'2026-08',toMonth:'2026-08'},randomUUID());
  const created=await service.startKeywords(actor,study.study.id,{supplementalSources:'sif-aba/v1',plannedPages:[{seed:'lamp',page:1}],maxMembers:20,catalog:{task:'market-keyword-semantics',dictionaryVersion:'manual/v1',categoryContext:'Lamp',dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[]}},randomUUID());
  for(let i=0;i<30;i++){if(!await worker.tick())break;if(i===29)assert.fail('Pipeline did not quiesce');}
  const run=(await service.findKeywords(actor,created.run.id)).run;
  assert.ok(run.facts);assert.equal(run.scope.marketplace,'UK');assert.equal(run.scope.currency,'GBP');
  assert.equal(run.facts.members[0].reference.searchVolume,20);assert.equal(run.facts.members[0].aba?.status,'unsupported');
  assert.notEqual(run.facts.members[0].trend.status,'pending');assert.equal(sourceCalls,2);assert.equal(abaCalls,0);
  const supplementary=run.steps.find(step=>step.kind==='collect-keyword-aba')!;
  assert.equal(supplementary.status,'failed');assert.equal(supplementary.errorCode,'unsupported-marketplace');assert.equal(supplementary.canRetry,false);
  assert.ok(!run.steps.some(step=>step.status==='queued'||step.status==='running'));
  await assert.rejects(()=>service.retry(actor,run.id,{steps:[{stepId:supplementary.id,failedAttemptId:supplementary.latestAttemptId}]},randomUUID()),/ABA/);
  const reopened=new MarketModuleService({context:new PostgresQueryContext(pg.pool),modelIdentity:()=>null});
  assert.deepEqual((await reopened.findKeywords(actor,run.id)).run.facts,run.facts);assert.equal(sourceCalls,2);assert.equal(abaCalls,0);
});
