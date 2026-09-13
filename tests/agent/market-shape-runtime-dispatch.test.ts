import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresMarketShapeExplanationRunStore} from '../../server/db/postgres/market-shape-explanation-run-store';
import {PostgresMarketAgentRunStore} from '../../server/db/postgres/market-agent-run-store';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadMarketShapeExplanationCatalog} from '../../server/services/market-shape-explanation-input-service';
import {readMarketShapeExplanationFragments} from '../../server/services/market-shape-explanation-fragment-service';
import {decodeMarketShapeExplanationWindow,decodeMarketShapeExplanationWindows} from '../../server/domain/market-research/shape-explanation-wire';
import {collectMarketShapeExplanationFragments} from '../../server/domain/market-research/shape-explanation-fragments';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';
import type {MarketShapeStructureExplanationInput} from '../../shared/market-semantic-contracts';
import {createMarketShapeExplanationRunFixture} from './helpers/market-shape-explanation-run-fixture';
import {startPostgresTestContainer} from './helpers/postgres-test-container';

const base=()=>loadVocPositioningRuntimeConfig({
 OPENAI_API_KEY:'synthetic-shape-runtime-key',AGENT_VOC_MODEL:'synthetic-shape-runtime-model',
 AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',
 AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',
 AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',
 AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',
 AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-shape-runtime',
})!;

test('registered runtime resumes all windows and leaves automatic synthesis queued',{timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketShapeExplanationRunFixture(pg.pool);
 let catalog:Awaited<ReturnType<typeof loadMarketShapeExplanationCatalog>>;
 const requested:string[]=[];
 const client={responses:{create:async(body:{input:string})=>{
  const input=JSON.parse(body.input) as MarketShapeStructureExplanationInput;
  assert.equal(input.task,'market-shape-structure-explanation');requested.push(input.window.windowId);
  const decoded=decodeMarketShapeExplanationWindow(catalog,input.window);
  const row=decoded.rows.find(r=>r.cells.some(c=>c.value!==null)),cell=row?.cells.find(c=>c.value!==null);
  const codes=[...new Set(decoded.limitations.map(l=>l.code))];
  const risk={kind:'risk',parts:[{kind:'text',text:'The saved evidence has source and scope limitations.'}],evidenceRowIds:[],limitationCodes:codes};
  const observed=row&&cell?{kind:'observed',parts:[{kind:'text',text:'The recorded value is '},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;
  const output={schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,
   fragment:{version:'market-shape-explanation-fragment/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windowId:input.window.windowId,
    section:{dimension:input.window.dimension,status:row?'explained':'insufficient-evidence',summary:observed,findings:row?[observed]:[],limitations:[risk],verification:[{...risk,kind:'verification'}]}}};
  return {id:'synthetic-response',status:'completed',usage:{input_tokens:100,output_tokens:50,total_tokens:150},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output)}]}]};
 }}} as unknown as OpenAIProviderOptions['client'];
 const runtime=await createMarketModelRuntime(f.context,base(),{client});t.after(()=>runtime.stop());
 const linked=await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({actor:f.actor,parentRunId:f.parentRunId,request:f.request,idempotencyKey:randomUUID(),identity:{configurationVersion:runtime.shapeExplanationConfigurationVersion,promptVersion:runtime.shapeExplanationPromptVersion}});
 catalog=await loadMarketShapeExplanationCatalog(f.context,f.actor,linked.childRun.id);
 assert.equal(await runtime.tick(),true);
 const prepared=(await f.steps.findModuleRun({actor:f.actor,moduleRunId:linked.childRun.id}))!;
 const preparation=prepared.steps.find(s=>s.kind==='prepare-members')!;
 assert.equal(preparation.status,'succeeded');
 const manifest=prepared.attempts.find(a=>a.id===preparation.latestAttemptId)!.output as any;
 assert.deepEqual(decodeMarketShapeExplanationWindows(catalog,manifest.windows),{rows:catalog.rows,limitations:catalog.limitations});
 assert.equal(prepared.steps.filter(s=>s.kind==='prepare-model-batches').length,manifest.windows.length);
 for(let ticks=0;requested.length===0&&ticks<20;ticks++)assert.equal(await runtime.tick(),true);
 assert.equal(requested.length,1);await runtime.stop();
 const restarted=await createMarketModelRuntime(f.context,base(),{client});t.after(()=>restarted.stop());
 for(let ticks=0;requested.length<manifest.windows.length&&ticks<manifest.windows.length*3+5;ticks++)assert.equal(await restarted.tick(),true);
assert.equal(requested.length,manifest.windows.length);assert.equal(new Set(requested).size,requested.length);
 const audit=await new PostgresMarketAgentRunStore(f.context).listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id});
 assert.equal(audit.length,manifest.windows.length);assert.ok(audit.every(a=>a.validationStatus==='passed'));
 const collected=collectMarketShapeExplanationFragments(catalog,manifest.windows,audit.map(a=>{const fragment=(a.outcome!.output as any).fragment;return {status:'succeeded',windowId:fragment.windowId,output:fragment};}));
 assert.equal(collected.status,'ready-for-synthesis');assert.equal(collected.synthesisStatus,'not-started');
 const restored=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});
 assert.equal(restored.status,'ready-for-synthesis');assert.equal(restored.synthesisStatus,'not-started');
 assert.equal(restored.windows.filter(w=>w.status==='succeeded').length,manifest.windows.length);
 const final=(await f.steps.findModuleRun({actor:f.actor,moduleRunId:linked.childRun.id}))!;
 assert.equal(final.steps.some(s=>s.kind==='report'),false,'completed local windows cannot claim a final report');
 assert.equal(final.steps.filter(s=>s.kind==='prepare-members'&&(s.input as any).phase==='prepare-shape-synthesis'&&s.status==='queued').length,1);
 await restarted.stop();assert.equal(requested.length,manifest.windows.length);
});
