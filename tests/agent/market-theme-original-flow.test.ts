import assert from 'node:assert/strict';
import test from 'node:test';
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
import {loadThemeSelectionFacts,restoreThemeSelectionFacts} from '../../server/services/market-theme-selection-facts';
import {MarketThemeReportService} from '../../server/services/market-theme-report-service';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';

test('original theme flow freezes Sorftime sample, enriches only missing images and preserves reports on targeted retry',{timeout:120000},async t=>{
 const db=await startPostgresTestContainer();t.after(()=>db.close());await runPostgresMigrations(db.pool);
 const context=new PostgresQueryContext(db.pool),steps=new PostgresMarketModuleExecutionStore(context),actor={organizationId:randomUUID(),userId:randomUUID()};
 await db.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Theme original','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
 const service=new MarketModuleService({context,modelIdentity:()=>null});
 const study=await service.createStudy(actor,{marketplace:'US',nodeIdPath:'1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},randomUUID());
 const image='https://m.media-amazon.com/images/I/fixture.jpg',calls:string[]=[];let repaired=false,emptyPool=false,badImage=false,mixed=false;
 const connector:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('No probes')},execute:async r=>{
  calls.push(`${r.operation}:${r.input.asin??''}`);
  const data=r.operation==='category_report'?{data:{category_stats_report:{category_name:'Floor Lamps'},top100_products:emptyPool?[]:[{asin:'B099WTN2TR',title:'Lamp A',main_image:image},{asin:'B07Z5NQPDS',title:'Lamp B'}]}}:
   r.operation==='product_detail'?(badImage?{error:'synthetic image failure'}:{data:{asin:r.input.asin,main_image:[image]}}):
   {data:{customer_say:'Customers mention brightness.',details:[...(mixed?[{keyword:'invalid',content:'Bad source row',mention:1,positive:99,negative:0,update_time:'2026-08-01'}]:[]),{keyword:r.input.asin==='B099WTN2TR'?'Brightness':'brightness',content:'Bright light',mention:10,positive:8,negative:!repaired&&r.input.asin==='B07Z5NQPDS'?76:2,update_time:'2026-08-01'}]}};
  return {data,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
 }};
 const forbidden:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('No SellerSprite')},execute:async()=>{throw Error('No SellerSprite')}};
 const worker=new MarketModuleStepWorker({steps,handlers:{...createMarketSourceStepHandlers({context,connectors:{sorftime:connector,sellerSprite:forbidden}}),'prepare-members':createMarketSourceProjectionStep(context),rules:createMarketThemeRulesStep(context),report:createMarketThemeReportStep(context)}});t.after(()=>worker.stop());
 const started=await service.startThemes(actor,study.study.id,{memberCount:2,poolSize:20},randomUUID());
 assert.equal(started.run.steps[0].kind,'collect-shape-pool');
 async function drain(){for(let i=0;i<45;i++)if(!await worker.tick())return;assert.fail('Flow did not quiesce');}
 await drain();const first=(await service.findRun(actor,started.run.id)).run;
 assert.equal(first.currentReport?.report.status,'partial',JSON.stringify(first.steps));
 const failed=first.steps.find(s=>s.kind==='collect-customer-themes'&&s.status==='failed')!;assert.ok(failed);
 assert.equal(calls.filter(s=>s.startsWith('product_detail')).length,1);assert.ok(calls.includes('product_detail:B07Z5NQPDS'));
 const query={actor,moduleRunId:first.id,attemptId:first.currentReport!.attemptId};
 const facts=await loadThemeSelectionFacts(context,query);assert.ok(facts);assert.deepEqual(facts.samples.map(s=>s.imageUrl.value),[image,image]);
 const before=[...calls],old=first.currentReport!;await service.findRun(actor,first.id);await loadThemeSelectionFacts(context,query);assert.deepEqual(calls,before);
 repaired=true;await service.retry(actor,first.id,{steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}]},randomUUID());await drain();
 const next=(await service.findRun(actor,first.id)).run;assert.equal(next.currentReport?.report.status,'complete',JSON.stringify(next.steps));
 assert.deepEqual(calls.slice(before.length),['product_customers_say:B07Z5NQPDS']);
 assert.deepEqual(next.history.find(r=>r.attemptId===old.attemptId),{...old,current:false});
 const restored=restoreThemeSelectionFacts((await loadThemeSelectionFacts(context,{...query,attemptId:next.currentReport!.attemptId}))!).restored;
 assert.equal(restored.aggregation.groups.length,1);assert.equal(restored.aggregation.groups[0].totals.mention,20);
 assert.equal(restored.labels[0].labelZh,'亮度');
 assert.equal(next.currentReport!.report.categoryName,'Floor Lamps');
 const firstMember=restored.aggregation.groups[0].members[0];
 const evidence=await new MarketThemeReportService(context).readEvidence({...query,attemptId:next.currentReport!.attemptId,query:{sourceThemeId:firstMember.sourceThemeId}});
 assert.equal(evidence?.evidence.analysis,null);assert.equal(evidence?.evidence.keyword,firstMember.keyword);
 assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM market_agent_runs WHERE module_run_id=$1',[first.id])).rows[0].n,0);
 await t.test('image failure preserves themes, image retry changes only the new report image',async()=>{
  badImage=true;
  const fresh=await service.createStudy(actor,{marketplace:'US',nodeIdPath:'1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},randomUUID());
  const begun=await service.startThemes(actor,fresh.study.id,{memberCount:2,poolSize:20},randomUUID());await drain();
  const failedImage=(await service.findRun(actor,begun.run.id)).run,report=failedImage.currentReport!;
  assert.equal(report.report.counts.successfulCount,2);assert.equal(report.report.dataReady,true);
  const imageStep=failedImage.steps.find(s=>s.kind==='collect-product-image'&&s.status==='failed')!;assert.ok(imageStep?.canRetry);
  const identity={actor,moduleRunId:begun.run.id,attemptId:report.attemptId};
  const prior=await loadThemeSelectionFacts(context,identity);assert.equal(prior!.samples[1].imageUrl.value,null);assert.match(prior!.samples[1].imageUrl.missingReason!,/失败/);
  const n=calls.length;badImage=false;await service.retry(actor,begun.run.id,{steps:[{stepId:imageStep.id,failedAttemptId:imageStep.latestAttemptId!}]},randomUUID());await drain();
  assert.deepEqual(calls.slice(n),['product_detail:B07Z5NQPDS']);
  const refreshed=(await service.findRun(actor,begun.run.id)).run;
  const current=await loadThemeSelectionFacts(context,{...identity,attemptId:refreshed.currentReport!.attemptId});assert.equal(current!.samples[1].imageUrl.value,image);
  assert.deepEqual(await loadThemeSelectionFacts(context,identity),prior);
 });
 await t.test('mixed source themes stay partial through saved report, detail, selection and original row evidence',async()=>{
  mixed=true;const fresh=await service.createStudy(actor,{marketplace:'US',nodeIdPath:'1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},randomUUID());
  const begun=await service.startThemes(actor,fresh.study.id,{memberCount:2,poolSize:20},randomUUID());await drain();
  const current=(await service.findRun(actor,begun.run.id)).run;assert.ok(current.currentReport,JSON.stringify(current.steps));
  assert.equal(current.currentReport.report.status,'partial');assert.equal(current.currentReport.report.counts.successfulCount,2);assert.equal(current.currentReport.report.counts.quarantinedThemeCount,2);
  const q={actor,moduleRunId:current.id,attemptId:current.currentReport.attemptId};const saved=await loadThemeSelectionFacts(context,q);assert.ok(saved);
  const facts=restoreThemeSelectionFacts(saved).restored;assert.equal(facts.aggregation.totals!.mention,20);assert.equal(facts.aggregation.coverage.status,'partial');
  const {deriveThemeSelection}=await import('../../server/domain/market-research/customer-theme-selection');
  const baseline=deriveThemeSelection(facts,[],false,false,true,true);assert.equal(baseline.status,'partial');assert.equal(baseline.asins[0].quarantine!.rejected.length,1);
  const removed=deriveThemeSelection(facts,[baseline.selectedAsins[0]],false,false,true,true);assert.equal(removed.totals!.mention,10);assert.equal(removed.status,'partial');
  assert.deepEqual(deriveThemeSelection(facts,[],false,false,true,true),baseline);
  const member=facts.aggregation.groups[0].members[0];assert.match(member.sourceThemeId,/:1$/);
  const evidence=await new MarketThemeReportService(context).readEvidence({...q,query:{sourceThemeId:member.sourceThemeId}});assert.equal(evidence!.evidence.keyword,member.keyword);
  mixed=false;
 });
 await t.test('empty Sorftime category creates readable no-data report without per-ASIN calls',async()=>{
  emptyPool=true;const n=calls.length;
  const fresh=await service.createStudy(actor,{marketplace:'US',nodeIdPath:'1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},randomUUID());
  const begun=await service.startThemes(actor,fresh.study.id,{memberCount:20,poolSize:100},randomUUID());await drain();
  const result=(await service.findRun(actor,begun.run.id)).run;assert.equal(result.currentReport!.report.status,'no-data');assert.equal(result.currentReport!.report.counts.selectedCount,0);
  assert.deepEqual(calls.slice(n),['category_report:']);
 });
});
