import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketSourceProjectionStep} from '../../server/runtime/market-source-projection-step';
import {createMarketThemeReportStep} from '../../server/runtime/market-theme-report-step';
import {marketThemeFlowInitialSteps} from '../../server/domain/market-research/customer-theme-flow';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {MARKET_THEME_MAPPING_RULE_VERSION} from '../../server/domain/market-research/customer-theme-mapping-rules';
import {MarketThemeReportService} from '../../server/services/market-theme-report-service';
import {MarketThemeSelectionStore} from '../../server/db/postgres/market-theme-selection-store';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {createMarketThemeReport,restoreMarketThemeReportEnvelope} from '../../server/domain/market-research/customer-theme-report';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';

test('pre-status-field theme reports remain readable with their original hash and no source work',{timeout:120000},async t=>{
 const db=await startPostgresTestContainer();t.after(()=>db.close());await runPostgresMigrations(db.pool);const f=await createMarketSemanticFixture(db.pool);
 let calls=0;const source=(id:'sorftime'|'sellerSprite'):RemoteMcpConnector=>({id,probe:async()=>{throw Error('No probes')},execute:async r=>{calls++;return {data:id==='sorftime'?{data:{top100_products:[]}}:{code:'OK',data:[]},source:{connectorId:id,operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};}});
 const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:source('sellerSprite'),sorftime:source('sorftime')}}),'prepare-members':createMarketSourceProjectionStep(f.context),report:createMarketThemeReportStep(f.context)}});t.after(()=>worker.stop());
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null});
 for(const flow of ['market-theme-flow/v1','market-theme-flow/v2','market-theme-flow/rules-v3'])await t.test(flow,async()=>{
  const catalog={task:'market-customer-theme-mapping',mappingVersion:'theme-groups/unreviewed-v1',groupCatalog:[]};
  const request={actor:f.actor,scope:f.scope,moduleKind:'customer-themes' as const,params:{flow,memberCount:20,poolSize:100,newProductMonths:6,catalog},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_THEME_MAPPING_RULE_VERSION,mapping:catalog.mappingVersion,planner:flow,model:flow.endsWith('rules-v3')?null:'market.semantic.text.v1',prompt:flow.endsWith('rules-v3')?null:'fixture/v1',configuration:flow.endsWith('rules-v3')?null:'fixture/v1'},collectionRevision:randomUUID(),idempotencyKey:randomUUID()};
  const started=await f.stores.steps.createModuleRun({...request,initialSteps:marketThemeFlowInitialSteps(request)});
  for(let i=0;i<8;i++)if(!await worker.tick())break;
  const attempt=(await db.pool.query("SELECT a.id,a.output_json FROM market_analysis_step_attempts a JOIN market_analysis_steps s ON s.id=a.step_id WHERE a.run_id=$1 AND s.kind='report' AND a.status='empty'",[started.run.id])).rows[0];assert.ok(attempt);
  let stored=attempt.output_json;
  if(!flow.endsWith('rules-v3')){
   const {ruleStatus:_rule,semanticStatus:_semantic,reportHash:_hash,...original}=stored;stored={...original,reportHash:digest(original)};
   // Seed the pre-field report format only in this disposable test database.
   const client=await db.pool.connect();try{await client.query('BEGIN');await client.query('ALTER TABLE market_analysis_step_attempts DISABLE TRIGGER market_attempts_protect');await client.query('UPDATE market_analysis_step_attempts SET output_json=$2::jsonb,output_hash=$3 WHERE id=$1',[attempt.id,JSON.stringify(stored),digest(stored)]);await client.query('ALTER TABLE market_analysis_step_attempts ENABLE TRIGGER market_attempts_protect');await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  const view=(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:started.run.id}))!;
  const step=view.steps.find(s=>s.kind==='report')!,snapshot=(await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:(step.input as {inputSnapshotId:string}).inputSnapshotId}))!;
  const rebuilt=createMarketThemeReport(view,step,snapshot.snapshot);
  const rehash=(value:Record<string,unknown>)=>{const {reportHash:_old,...body}=value;return {...body,reportHash:digest(body)};};
  assert.equal(restoreMarketThemeReportEnvelope(rebuilt,rehash({...stored,counts:{...stored.counts,requestedCount:19}})),null);
  assert.equal(restoreMarketThemeReportEnvelope(rebuilt,{...stored,reportHash:'0'.repeat(64)}),null);
  assert.equal(restoreMarketThemeReportEnvelope(rebuilt,rehash({...stored,extraField:'unexpected'})),null);
  if(!flow.endsWith('rules-v3'))assert.equal(restoreMarketThemeReportEnvelope(rebuilt,rehash({...stored,ruleStatus:'unavailable'})),null);
  else{const {ruleStatus:_r,semanticStatus:_s,...incomplete}=stored;assert.equal(restoreMarketThemeReportEnvelope(rebuilt,rehash(incomplete)),null);}
  const stats=async()=>(await db.pool.query('SELECT (SELECT count(*)::int FROM market_analysis_step_attempts WHERE run_id=$1) attempts,(SELECT count(*)::int FROM market_agent_runs WHERE module_run_id=$1) models',[started.run.id])).rows[0];const counts=await stats(),priorCalls=calls;
  const result=(await service.findRun(f.actor,started.run.id)).run,entry=result.currentReport!;assert.ok(entry);assert.deepEqual(entry.report,stored);assert.equal(entry.report.status,'no-data');
  const identity={actor:f.actor,moduleRunId:started.run.id,attemptId:entry.attemptId};
  const details=await new MarketThemeReportService(f.context).readDetails({...identity,query:{section:'groups'}});assert.deepEqual(details?.report.report,stored);assert.equal(details?.page.totalItems,0);
  const selection=await new MarketThemeSelectionStore(f.context).read(identity);assert.deepEqual(selection?.base.report,stored);assert.equal(selection?.samples.length,0);
  assert.deepEqual((await service.findRun(f.actor,started.run.id)).run.history,result.history);assert.deepEqual(await stats(),counts);assert.equal(calls,priorCalls);assert.equal(counts.models,0);
 });
});
