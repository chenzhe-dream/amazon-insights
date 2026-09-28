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

test('durable ABA failure/retry preserves trend inputs and manual history; reads replay saved raw without network',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const context=new PostgresQueryContext(pg.pool),steps=new PostgresMarketModuleExecutionStore(context),actor={organizationId:randomUUID(),userId:randomUUID()};
 await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'ABA fixture','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
 let sourceCalls=0,abaCalls=0,fail=true;
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw new Error('Unused');},execute:async r=>{
  sourceCalls++;return {data:r.operation==='keyword_extends'?{data:[{keyword:'floor lamps',monthly_search_volume:777},{keyword:'floor lamp',monthly_search_volume:888}]}:
   {data:{keyword:r.input.keyword,search_volume_trend:['2026-08 search volume 20'],search_rank_trend:[],recommended_bid_trend:[]}},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const sif:RemoteMcpConnector={id:'sif',probe:async()=>{throw new Error('Unused');},execute:async r=>{
  abaCalls++;
  const keywords=r.input.keywords as string[];assert.equal(keywords.length,2);
  return {data:{country:'US',granularity:'month',keywords:[...keywords].reverse().map(keyword=>({keyword,data_points:1,dates:['2026-08'],volumes:[keyword==='floor lamp'?100:200],ranks:[1],top3_click_shares:[fail?2:keyword==='floor lamp'?0:.2],top3_conversion_shares:[null]}))},source:{connectorId:'sif',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const worker=new MarketModuleStepWorker({steps,handlers:{...createMarketSourceStepHandlers({context,connectors:{sorftime,sif,sellerSprite:{...sorftime,id:'sellerSprite'}}}),'prepare-keyword-pool':createMarketKeywordPoolStep(context)}});t.after(()=>worker.stop());
 const service=new MarketModuleService({context,modelIdentity:()=>null}),study=await service.createStudy(actor,{marketplace:'US',nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD'},randomUUID());
 const body={supplementalSources:'sif-aba/v1',plannedPages:[{seed:'lamp',page:1}],maxMembers:20,catalog:{task:'market-keyword-semantics',dictionaryVersion:'manual/v1',categoryContext:'Lamp',dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[]}};
 const created=await service.startKeywords(actor,study.study.id,body,randomUUID()),id=created.run.id;
 async function drain(){for(let i=0;i<30;i++)if(!await worker.tick())return;assert.fail('Did not quiesce');}
 await drain();const first=(await service.findKeywords(actor,id)).run,facts=first.facts!;
 assert.equal(facts.members.length,2);assert.ok(facts.members.every(m=>m.aba?.status==='failed'),JSON.stringify({steps:first.steps,aba:facts.members.map(m=>m.aba),sourceCalls,abaCalls}));assert.equal(sourceCalls,3);assert.equal(abaCalls,1);
 const trendIds=facts.members.map(m=>m.trend.inputSnapshotId),oldFactsId=facts.factsId;
 const save=await service.saveKeywordRevision(actor,id,{factsId:facts.factsId,expectedParentRevisionId:null,labels:{W1:[],W2:[],W3:[],W4:[]},clusters:[],assignments:facts.members.map(m=>({keywordId:m.keywordId,W1:[],W2:[],W3:[],W4:[],clusterId:null})),note:'Before ABA retry'},randomUUID());
 const failed=first.steps.find(s=>s.kind==='collect-keyword-aba')!;assert.ok(failed.canRetry);
 const diagnostic=(await pg.pool.query('SELECT diagnostic_json FROM market_analysis_step_attempts WHERE id=$1',[failed.latestAttemptId])).rows[0].diagnostic_json;
 assert.equal(diagnostic.abaDiagnostic.stage,'payload-validation');
 assert.deepEqual(diagnostic.abaDiagnostic.issues[0],{code:'too_big',path:['keywords',0,'top3_click_shares',0]});
 assert.equal(Object.hasOwn(diagnostic,'rawPayload'),false);
 fail=false;await service.retry(actor,id,{steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}]},randomUUID());await drain();
 const second=(await service.findKeywords(actor,id)).run;
 assert.equal(sourceCalls,3);assert.equal(abaCalls,2);assert.notEqual(second.facts!.factsId,oldFactsId);assert.deepEqual(second.facts!.members.map(m=>m.trend.inputSnapshotId),trendIds);
 assert.ok(second.facts!.members.every(m=>m.aba?.status==='partial'));
 const lamp=second.facts!.members.find(m=>m.keyword==='floor lamp')!;
 assert.equal(lamp.aba!.member!.searchVolume.value,100);assert.equal(lamp.reference.searchVolume,20);assert.equal(lamp.aba!.member!.top3ClickShare.value,0);assert.equal(lamp.aba!.member!.top3ConversionShare.reason,'missing-value');
 const reopened=new MarketModuleService({context:new PostgresQueryContext(pg.pool),modelIdentity:()=>null});
 assert.deepEqual((await reopened.findKeywords(actor,id)).run.facts,second.facts);assert.equal(abaCalls,2);
 assert.deepEqual(await reopened.keywordRevision(actor,id,save.revision.catalog.revision.revisionId),{revision:save.revision});
 assert.equal(save.revision.ruleReport.clusters.length,0,'Manual unassigned classification remains unchanged');
 assert.equal(second.ruleReport!.clusters.length,second.automaticClassification!.classification.clusters.length,'Automatic report uses its own local classification');
 assert.ok(second.ruleReport!.clusters.every(cluster=>cluster.metrics.abaTop3Share.value===null&&cluster.score.pvs===null),'Collected member shares do not invent cluster shares or final PVS');
});
