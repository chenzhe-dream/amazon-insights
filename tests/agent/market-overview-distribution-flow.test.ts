import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketOverviewCatalogStep} from '../../server/runtime/market-overview-catalog-step';
import {createMarketOverviewWindowsStep} from '../../server/runtime/market-overview-windows-step';
import {createMarketOverviewReportStep} from '../../server/runtime/market-overview-report-step';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketOverviewReportService} from '../../server/services/market-overview-report-service';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

test('native overview collects all distributions, keeps partial reports and retries one endpoint without rewriting history',{timeout:120000},async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketSemanticFixture(pg.pool);
  await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
  const calls:string[]=[];let failPrice=true;
  const connector:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw new Error('unused');},execute:async r=>{
    const q=r.input.request as {month:string},op=r.operation;calls.push(`${q.month}/${op}`);
    if(failPrice&&q.month==='202608'&&op==='market_price_distribution')throw new ConnectorError('sellerSprite','upstream-permanent',false);
    const identities={marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,month:q.month},basic={...identities,topProducts:100,products:100,totalUnits:1000,totalRevenue:20000};
    const row={label:'bucket',brand:'brand',sellerName:'seller',asins:['B000000001'],products:1,units:10,totalUnits:10,revenue:20,totalRevenue:20};
    const data=op==='market_research'?{items:[basic]}:op==='market_research_statistics'?basic:op==='market_product_demand_trend'?{items:[],asinCount:null}:op==='market_seller_type_concentration'?[{label:'FBA',asinNum:1,productNum:1,units:10}]:op==='market_ebc_distribution'?['有A+有视频','有A+无视频','无A+有视频','无A+无视频'].flatMap(label=>[{label,products:1,units:10},{label:`新品${label}`,products:0,units:0}]):[row];
    return {data:{code:'OK',...identities,data},source:{connectorId:'sellerSprite',operation:op,fetchedAt:new Date().toISOString(),attemptCount:1}};
  }};
  const service=new MarketModuleService({context:f.context,modelIdentity:()=>null}),key=randomUUID();
  const started=await service.startOverview(f.actor,f.scope.researchId,{},key);assert.equal(started.run.steps.length,26);
  const repeated=await service.startOverview(f.actor,f.scope.researchId,{},key);assert.equal(repeated.run.id,started.run.id);
  const id=started.run.id,view=async()=>(await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:id}))!;
  const makeWorker=()=>new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:connector,sorftime:connector}}),rules:createMarketOverviewCatalogStep(f.context),'prepare-members':createMarketOverviewWindowsStep(f.context,null),report:createMarketOverviewReportStep(f.context)}});
  let worker=makeWorker();t.after(()=>worker.stop());for(let i=0;i<8;i++)await worker.tick();await worker.stop();worker=makeWorker();for(let i=0;i<35&&await worker.tick();i++){}
  const querySpy=t.mock.method(f.context,'query');
  const snapshotReads=()=>querySpy.mock.calls.filter(call=>String(call.arguments[0]).includes('SELECT d.* FROM market_analysis_')).length;
  const beforeRead=snapshotReads();
  const reports=new MarketOverviewReportService(f.context),first=(await reports.read({actor:f.actor,moduleRunId:id}))!.currentReport!;
  const reportSnapshotReads=snapshotReads()-beforeRead;assert.ok(reportSnapshotReads>0);
  assert.equal(first.report.analysisStatus,'partial');assert.equal(first.report.dataReady,true);assert.equal(first.report.coverage.find(c=>c.dimension==='price-distribution')?.status,'missing');
  assert.equal(first.report.coverage.find(c=>c.dimension==='rating-distribution')?.status,'available');
  assert.ok(first.report.reasons.includes('distribution-synthesis-not-integrated'));assert.equal(calls.length,26);
  const beforeDetail=snapshotReads();
  const detail=await reports.details({actor:f.actor,moduleRunId:id,attemptId:first.attemptId});assert.ok(detail);
  assert.equal(snapshotReads()-beforeDetail,reportSnapshotReads,'Details must reuse the same-request verified report without another evidence replay');
  querySpy.mock.restore();
  assert.equal(detail.numbers.distributions!.length,22);assert.equal(detail.numbers.distributions!.find(d=>d.month==='2026-08'&&d.operation==='market_product_demand_trend')!.status,'empty');
  const priorHash=digest(first.report),saved=await view(),successes=saved.steps.filter(s=>s.kind==='collect-overview-month'&&s.status!=='failed'),failed=saved.steps.find(s=>s.kind==='collect-overview-month'&&s.status==='failed')!;
  failPrice=false;await service.retry(f.actor,id,{steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId}]},randomUUID());for(let i=0;i<10&&await worker.tick();i++){}
  const next=(await reports.read({actor:f.actor,moduleRunId:id}))!.currentReport!;assert.notEqual(next.attemptId,first.attemptId);assert.equal(next.report.coverage.find(c=>c.dimension==='price-distribution')?.status,'available');
  assert.equal(calls.length,27);for(const step of successes)assert.equal((await view()).steps.find(s=>s.id===step.id)!.latestAttemptId,step.latestAttemptId);
  const old=await reports.details({actor:f.actor,moduleRunId:id,attemptId:first.attemptId});assert.equal(digest(old!.entry.report),priorHash);assert.equal(old!.numbers.distributions!.find(d=>d.month==='2026-08'&&d.operation==='market_price_distribution')!.status,'failed');
  const current=await reports.details({actor:f.actor,moduleRunId:id,attemptId:next.attemptId});assert.equal(current!.numbers.distributions!.find(d=>d.month==='2026-08'&&d.operation==='market_price_distribution')!.distribution!.groups[0].units,10);
  t.diagnostic(JSON.stringify({sourceCalls:calls.length,months:2,endpointCount:13,historyPreserved:true,modelCalls:0}));
});
