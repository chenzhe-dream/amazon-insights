import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {findHttpContract} from '../../shared/agent-contracts';
import {MarketShapeExplanationRunResponseSchema} from '../../shared/market-shape-explanation-public-contracts';
import {MarketShapeRevisionResponseSchema} from '../../shared/market-shape-public-contracts';
import {registerMarketModuleRoutes} from '../../server/routes/market-modules';
import {MarketModuleService} from '../../server/services/market-module-service';
import {PostgresMarketShapeExplanationRunStore} from '../../server/db/postgres/market-shape-explanation-run-store';
import {MarketModuleStepWorker} from '../../server/runtime/market-module-step-worker';
import {createMarketSourceStepHandlers} from '../../server/runtime/market-source-step-handlers';
import {createMarketShapeSelectionStep} from '../../server/runtime/market-shape-selection-step';
import {MARKET_SHAPE_FLOW_VERSION,marketShapeFlowInitialSteps} from '../../server/domain/market-research/shape-price-flow';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createMarketSemanticFixture} from './helpers/market-semantic-fixture';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';

test('public shape revision atomically queues its explanation and exposes only authorized resumable state',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketSemanticFixture(pg.pool);await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:f.subject.moduleRunId,idempotencyKey:randomUUID()});
 const connector:RemoteMcpConnector={id:'sellerSprite',probe:async()=>{throw Error('unused')},execute:async r=>{const q=(r.input as any).request;return {data:{code:'OK',marketplace:'US',currency:'USD',nodeIdPath:f.scope.nodeIdPath,month:q.month,data:[{asin:'B000000001',title:'Shelf lamp',brand:'Fixture',price:20,totalUnits:10,totalRevenue:200,ranking:1,rating:4,ratings:10,sellerName:'Fixture',sellerType:'FBA',shelfDate:'2025-01-01'}]},source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}}}};
 const sources=createMarketSourceStepHandlers({context:f.context,connectors:{sellerSprite:connector,sorftime:{...connector,id:'sorftime'}}});
 const worker=new MarketModuleStepWorker({steps:f.stores.steps,handlers:{...sources,'prepare-members':createMarketShapeSelectionStep(f.context)}});t.after(()=>worker.stop());
 let shapeIdentity:{configurationVersion:string;promptVersion:string}|null={configurationVersion:'shape-config/v1',promptVersion:'shape-prompt/v1'};
 let principal:any={kind:'user',...f.actor};
 const service=new MarketModuleService({context:f.context,modelIdentity:()=>null,shapeModelIdentity:()=>shapeIdentity});
 const app=Fastify();t.after(()=>app.close());app.decorateRequest('authPrincipal',null);app.addHook('preHandler',async req=>{req.authPrincipal=principal});registerMarketModuleRoutes(app,service);
 const labels=[{labelId:'shelf',label:'层架式',definition:'标题明确带层架的灯'}];
 async function parent(taxonomyVersion:string,legacy=false){const startBody={poolSize:100,newProductMonths:6,catalog:{task:'market-product-shape-suggestion' as const,taxonomyVersion,allowedLabels:labels}};
  let id:string;
  if(legacy){const request={actor:f.actor,scope:f.scope,moduleKind:'shape-price' as const,params:{...startBody,flow:MARKET_SHAPE_FLOW_VERSION},versions:{source:'market-source-handlers/v1',rule:'market-shape-price-catalog/v1',mapping:taxonomyVersion,planner:MARKET_SHAPE_FLOW_VERSION,model:'market.semantic.text.v1',prompt:'shape-prompt/v1',configuration:'shape-config/v1'},collectionRevision:'initial/v1',idempotencyKey:randomUUID()};id=(await f.stores.steps.createModuleRun({...request,initialSteps:marketShapeFlowInitialSteps(request)})).run.id;}
  else{const response=await app.inject({method:'POST',url:`/v1/market-analysis/studies/${f.scope.researchId}/shape-price`,headers:{'idempotency-key':randomUUID()},payload:startBody});assert.equal(response.statusCode,201,response.body);id=response.json().run.id;}
  for(let i=0;i<12&&await worker.tick();i++){}const view=await service.findShapes(f.actor,id);assert.ok(view.run.source);return {id,view,taxonomyVersion};}
 const firstParent=await parent('test-shapes/v1',true),source=firstParent.view.run.source!;
 const revision={referenceAttemptId:source.referenceAttemptId,historyAttemptIds:source.historyAttemptIds,expectedParentRevisionId:null,selectedAsins:['B000000001'],taxonomyVersion:firstParent.taxonomyVersion,labels,assignments:[{asin:'B000000001',labelId:'shelf'}],bands:[{id:'all',minInclusive:0,maxExclusive:null}]};
 const revisionUrl=`/v1/market-analysis/runs/${firstParent.id}/shape-price/revisions`,key=randomUUID();
 const save=()=>app.inject({method:'POST',url:revisionUrl,headers:{'idempotency-key':key},payload:revision});
 const saved=await save();assert.equal(saved.statusCode,201,saved.body);const savedBody=MarketShapeRevisionResponseSchema.parse(saved.json());assert.ok(savedBody.explanation);assert.equal(savedBody.explanation!.status,'queued');
 const duplicate=await save();assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal(duplicate.json().explanation.moduleRunId,savedBody.explanation!.moduleRunId);
 const childId=savedBody.explanation!.moduleRunId;
 assert.equal((await pg.pool.query("SELECT count(*) FROM market_analysis_module_runs WHERE request_json->'params'->>'flow'='shape-explanation/v1' AND request_json->'params'->>'parentRunId'=$1",[firstParent.id])).rows[0].count,'1');
 const explanationUrl=`/v1/market-analysis/runs/${childId}/shape-explanation`;
 const pending=await app.inject({url:explanationUrl});assert.equal(pending.statusCode,200,pending.body);const pendingBody=MarketShapeExplanationRunResponseSchema.parse(pending.json());assert.equal(pendingBody.run.report,null);assert.equal(pendingBody.run.revisionId,savedBody.revision.revisionId);
 principal={...principal,organizationId:randomUUID()};assert.equal((await app.inject({url:explanationUrl})).statusCode,404);principal=null;assert.equal((await app.inject({url:explanationUrl})).statusCode,401);principal={kind:'user',...f.actor};
 const claim=await f.stores.steps.claimStep({moduleRunId:childId,leaseOwnerId:randomUUID(),leaseMs:60000});assert.ok(claim);await f.stores.steps.settleAndEnqueue({claim,outcome:{status:'failed',error:{code:'invalid-data',retryable:true}}});
 const failed=MarketShapeExplanationRunResponseSchema.parse((await app.inject({url:explanationUrl})).json());const failedStep=failed.run.steps.find(s=>s.status==='failed');assert.ok(failedStep?.canRetry);assert.equal(failedStep.errorCode,'invalid-data');
 const retryBody={steps:[{stepId:failedStep.id,failedAttemptId:failedStep.latestAttemptId!}]};shapeIdentity={configurationVersion:'shape-config/v2',promptVersion:'shape-prompt/v2'};
 assert.equal((await app.inject({method:'POST',url:`/v1/market-analysis/runs/${childId}/retry`,headers:{'idempotency-key':randomUUID()},payload:retryBody})).statusCode,503);
 shapeIdentity={configurationVersion:'shape-config/v1',promptVersion:'shape-prompt/v1'};assert.equal((await app.inject({method:'POST',url:`/v1/market-analysis/runs/${childId}/retry`,headers:{'idempotency-key':randomUUID()},payload:retryBody})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:`/v1/market-analysis/runs/${childId}/cancel`,headers:{'idempotency-key':randomUUID()},payload:{}})).statusCode,200);
 assert.equal(MarketShapeExplanationRunResponseSchema.parse((await app.inject({url:explanationUrl})).json()).run.status,'cancelled');

 const revisionReadUrl=`${revisionUrl}/${encodeURIComponent(savedBody.revision.revisionId)}`;
 shapeIdentity=null;
 const restored=await app.inject({url:revisionReadUrl});assert.equal(restored.statusCode,200,restored.body);
 assert.deepEqual(restored.json().explanations.map((item:any)=>({id:item.moduleRunId,status:item.status})),[{id:childId,status:'cancelled'}]);
 const newer=await new PostgresMarketShapeExplanationRunStore(f.context).ensureExplanationForRevision({actor:f.actor,parentRunId:firstParent.id,revisionId:savedBody.revision.revisionId,idempotencyKey:randomUUID(),identity:{configurationVersion:'shape-config/v2',promptVersion:'shape-prompt/v2'}});
 const countBefore=(await pg.pool.query('SELECT count(*) FROM market_analysis_commands')).rows[0].count;
 const history=await app.inject({url:revisionReadUrl});assert.equal(history.statusCode,200,history.body);
 assert.deepEqual(history.json().explanations.map((item:any)=>item.moduleRunId),[newer.childRun.id,childId]);
 assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_commands')).rows[0].count,countBefore,'history GET must never create a command');
 principal={...principal,organizationId:randomUUID()};assert.equal((await app.inject({url:revisionReadUrl})).statusCode,404);principal={kind:'user',...f.actor};

 shapeIdentity={configurationVersion:'shape-config/v1',promptVersion:'shape-prompt/v1'};const secondParent=await parent('test-shapes/v2'),secondSource=secondParent.view.run.source!,offlineRevision={...revision,taxonomyVersion:secondParent.taxonomyVersion,referenceAttemptId:secondSource.referenceAttemptId,historyAttemptIds:secondSource.historyAttemptIds};
 const rulesKey=randomUUID(),rulesUrl=`/v1/market-analysis/runs/${secondParent.id}/shape-price/revisions`;
 const offline=await app.inject({method:'POST',url:rulesUrl,headers:{'idempotency-key':rulesKey},payload:offlineRevision});assert.equal(offline.statusCode,201,offline.body);const offlineBody=MarketShapeRevisionResponseSchema.parse(offline.json());assert.equal(offlineBody.explanation,null);assert.match(offlineBody.explanationUnavailableReason!,/本地规则任务未启用模型解释/);
 const replay=await app.inject({method:'POST',url:rulesUrl,headers:{'idempotency-key':rulesKey},payload:offlineRevision});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().revision.revisionId,offlineBody.revision.revisionId);assert.equal(replay.json().explanation,null);
 assert.equal((await pg.pool.query('SELECT count(*) FROM market_shape_explanation_runs WHERE parent_run_id=$1',[secondParent.id])).rows[0].count,'0');
 const offlineRead=await app.inject({url:`/v1/market-analysis/runs/${secondParent.id}/shape-price/revisions/${encodeURIComponent(offlineBody.revision.revisionId)}`});assert.equal(offlineRead.statusCode,200,offlineRead.body);assert.deepEqual(offlineRead.json().explanations,[]);
 assert.equal((await app.inject({url:`/v1/market-analysis/runs/${secondParent.id}/shape-price/revisions/${encodeURIComponent(savedBody.revision.revisionId)}`})).statusCode,404);
 const before=(await pg.pool.query('SELECT count(*) FROM market_shape_price_revisions WHERE run_id=$1',[secondParent.id])).rows[0].count;
 const invalid=await app.inject({method:'POST',url:`/v1/market-analysis/runs/${secondParent.id}/shape-price/revisions`,headers:{'idempotency-key':randomUUID()},payload:{...offlineRevision,referenceAttemptId:randomUUID(),expectedParentRevisionId:offlineBody.revision.revisionId}});assert.ok(invalid.statusCode>=400);assert.equal((await pg.pool.query('SELECT count(*) FROM market_shape_price_revisions WHERE run_id=$1',[secondParent.id])).rows[0].count,before);

 for(const [method,path] of [['POST',`/v1/market-analysis/runs/${firstParent.id}/shape-price/revisions`],['GET',explanationUrl],['POST',`/v1/market-analysis/runs/${childId}/retry`],['POST',`/v1/market-analysis/runs/${childId}/cancel`]])assert.ok(findHttpContract(method,path),`${method} ${path}`);
});
