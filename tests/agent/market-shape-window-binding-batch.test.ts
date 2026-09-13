import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresMarketAgentRunStore} from '../../server/db/postgres/market-agent-run-store';
import {PostgresMarketShapeExplanationRunStore} from '../../server/db/postgres/market-shape-explanation-run-store';
import {decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {loadMarketShapeExplanationCatalog} from '../../server/services/market-shape-explanation-input-service';
import {readMarketShapeExplanationFragments} from '../../server/services/market-shape-explanation-fragment-service';
import {createMarketShapeExplanationRunFixture} from './helpers/market-shape-explanation-run-fixture';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

const configuration=()=>loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'batch-binding-key',AGENT_VOC_MODEL:'batch-binding-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'binding-batch'});

test('shape window bindings share one catalog restore and reject unsafe batches',{timeout:120_000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketShapeExplanationRunFixture(pg.pool);let catalog:Awaited<ReturnType<typeof loadMarketShapeExplanationCatalog>>;
 const client:any={responses:{create:async(body:any)=>{const input=JSON.parse(body.input),decoded=decodeMarketShapeExplanationWindow(catalog,input.window),row=decoded.rows.find((r:any)=>r.cells.some((c:any)=>c.value!==null)),cell=row?.cells.find((c:any)=>c.value!==null),codes=decoded.limitations.map((l:any)=>l.code),risk={kind:'risk',parts:[{kind:'text',text:'Synthetic fixed source limitation.'}],evidenceRowIds:[],limitationCodes:codes},statement=row&&cell?{kind:'observed',parts:[{kind:'text',text:'Synthetic value '},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;return{id:'batch-binding-response',status:'completed',usage:{input_tokens:10,output_tokens:10,total_tokens:20},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,fragment:{version:'market-shape-explanation-fragment/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windowId:input.window.windowId,section:{dimension:input.window.dimension,status:row?'explained':'insufficient-evidence',summary:statement,findings:row?[statement]:[],limitations:[risk],verification:[{...risk,kind:'verification'}]}}})}]}]};}}};
 const runtime=await createMarketModelRuntime(f.context,configuration(),{client});t.after(()=>runtime.stop());const linked=await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({actor:f.actor,parentRunId:f.parentRunId,request:f.request,idempotencyKey:randomUUID(),identity:{configurationVersion:runtime.shapeExplanationConfigurationVersion,promptVersion:runtime.shapeExplanationPromptVersion}});catalog=await loadMarketShapeExplanationCatalog(f.context,f.actor,linked.childRun.id);
 let recovered:Awaited<ReturnType<typeof readMarketShapeExplanationFragments>>|undefined;for(let i=0;i<100;i++){if(!await runtime.tick())break;try{const value=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});if(value.status==='ready-for-synthesis'){recovered=value;break;}}catch{}}
 assert.equal(recovered?.status,'ready-for-synthesis');const audit=new PostgresMarketAgentRunStore(f.context),runs=(await audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id})).filter(run=>run.task==='market-shape-structure-explanation');assert.ok(runs.length>=2);const ids=runs.slice(0,2).map(run=>run.bindingId);
 const original=f.context.query.bind(f.context),counts={catalog:0};(f.context as any).query=async(sql:string,values?:unknown[])=>{if(sql.includes('FROM market_shape_explanation_runs'))counts.catalog++;return original(sql,values);};
 const bindings=await audit.findShapeWindowBindings({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id,bindingIds:ids});assert.equal(bindings.length,2);assert.equal(counts.catalog,1);
 await assert.rejects(audit.findShapeWindowBindings({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id,bindingIds:[ids[0],ids[0]]}));
 await assert.rejects(audit.findShapeWindowBindings({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id,bindingIds:[randomUUID()]}));
 await assert.rejects(audit.findShapeWindowBindings({actor:{organizationId:randomUUID(),userId:randomUUID()},studyId:f.scope.researchId,moduleRunId:linked.childRun.id,bindingIds:ids}));
 let nonLeaf:string|undefined;for(let i=0;i<12&&!nonLeaf;i++){try{await runtime.tick();}catch{}nonLeaf=(await pg.pool.query<{id:string}>("SELECT id FROM market_analysis_semantic_snapshot_bindings WHERE module_run_id=$1 AND task='market-shape-synthesis' LIMIT 1",[linked.childRun.id])).rows[0]?.id;}
 assert.ok(nonLeaf,'automatic native preparation should persist a synthesis binding');
 await assert.rejects(audit.findShapeWindowBindings({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id,bindingIds:[nonLeaf]}));
});
