import {categoryProductsFixture} from './helpers/category-products-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../../server/db/postgres/market-module-execution-store';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketSourceProjectionStep} from '../../server/runtime/market-source-projection-step';
import {createMarketThemeRulesStep} from '../../server/runtime/market-theme-rules-step';
import {createMarketThemeReportStep} from '../../server/runtime/market-theme-report-step';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';

test('all-invalid theme counts explain the failed ASIN; retry preserves successful sources and old report',{timeout:90000},async t=>{
 const invalid=JSON.parse(readFileSync(new URL('../fixtures/market/floor-customers-say-invalid-count.json',import.meta.url),'utf8')).payload;
 // Mixed-valid rows now survive; force every row invalid to retain the failed-ASIN retry contract.
 invalid.data.details=invalid.data.details.map((row:any)=>({...row,negative:row.mention+1}));
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const context=new PostgresQueryContext(pg.pool),steps=new PostgresMarketModuleExecutionStore(context),actor={organizationId:randomUUID(),userId:randomUUID()};
 await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Theme failure fixture','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
 const service=new MarketModuleService({context,modelIdentity:()=>null});
 const study=await service.createStudy(actor,{marketplace:'US',nodeIdPath:'1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},randomUUID());
 let repaired=false;const calls:string[]=[];
 const connector=(id:'sorftime'|'sellerSprite'):RemoteMcpConnector=>({id,probe:async()=>{throw new Error('unused');},execute:async r=>{
  calls.push(r.operation+':'+(r.input.asin??''));
  const data=(r.operation==='category_report'||r.operation==='category_products')?{data:{top100_products:[{asin:'B099WTN2TR',title:'Lamp 1',category_rank:1,main_image:'https://m.media-amazon.com/images/I/lamp-1.jpg'},{asin:'B07Z5NQPDS',title:'Lamp 2',category_rank:2,main_image:'https://m.media-amazon.com/images/I/lamp-2.jpg'}]}}:
   r.input.asin==='B07Z5NQPDS'&&!repaired?invalid:{data:{details:[{keyword:'assembly',content:'Easy assembly',mention:10,positive:8,negative:2,update_time:'2026-08-01'}]}};
  return {data:r.operation==='category_products'?categoryProductsFixture(data,r.input.node_id):data,source:{connectorId:id,operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }});
 const worker=new MarketModuleStepWorker({steps,handlers:{...createMarketSourceStepHandlers({context,connectors:{sorftime:connector('sorftime'),sellerSprite:connector('sellerSprite')}}),'prepare-members':createMarketSourceProjectionStep(context),rules:createMarketThemeRulesStep(context),report:createMarketThemeReportStep(context)}});t.after(()=>worker.stop());
 async function drain(){for(let i=0;i<30;i++)if(!await worker.tick())return;assert.fail('Did not quiesce');}
 const started=await service.startThemes(actor,study.study.id,{memberCount:2,poolSize:2},randomUUID());await drain();
 const first=(await service.findRun(actor,started.run.id)).run,report=first.currentReport!.report;
 assert.equal(report.semanticStatus,'skipped');assert.equal(report.status,'partial');assert.equal(report.counts.failedCount,1);
 const failed=first.steps.find(s=>s.asin==='B07Z5NQPDS')!;
 assert.equal(failed.errorCode,'invalid-data');assert.equal(failed.canRetry,true);
 assert.deepEqual((failed as any).sourceIssue,{code:'count-exceeds-mention',themeIndex:0,field:'negative'});
 const diagnostic=(await pg.pool.query('SELECT diagnostic_json FROM market_analysis_step_attempts WHERE id=$1',[failed.latestAttemptId])).rows[0].diagnostic_json;assert.deepEqual(diagnostic.rawPayload,invalid);
 const before=[...calls];assert.deepEqual((await service.findRun(actor,started.run.id)).run,first);assert.deepEqual(calls,before);
 const key=randomUUID(),request={steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}]};repaired=true;
 await service.retry(actor,started.run.id,request,key);await service.retry(actor,started.run.id,request,key);await drain();
 const next=(await service.findRun(actor,started.run.id)).run;
 assert.deepEqual(calls.slice(before.length),['product_customers_say:B07Z5NQPDS']);
 assert.equal(next.currentReport!.report.status,'complete');assert.equal(next.currentReport!.report.counts.successfulCount,2);
 assert.equal((next.steps.find(s=>s.id===failed.id) as any).sourceIssue,undefined);
 assert.deepEqual(next.history.find(h=>h.report.reportHash===report.reportHash)!.report,report);
 assert.equal((await pg.pool.query('SELECT count(*)::int AS count FROM market_agent_runs WHERE module_run_id=$1',[started.run.id])).rows[0].count,0);
});
