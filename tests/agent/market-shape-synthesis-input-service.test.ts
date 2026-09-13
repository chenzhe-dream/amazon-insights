import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketAnalysisSnapshotStore } from '../../server/db/postgres/market-analysis-snapshot-store';
import { PostgresMarketShapeExplanationRunStore } from '../../server/db/postgres/market-shape-explanation-run-store';
import { buildMarketShapeFinalSynthesisInput } from '../../server/domain/market-research/shape-explanation-synthesis';
import { decodeMarketShapeExplanationWindow } from '../../server/domain/market-research/shape-explanation-wire';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { readMarketShapeExplanationFragments } from '../../server/services/market-shape-explanation-fragment-service';
import { loadMarketShapeExplanationCatalog } from '../../server/services/market-shape-explanation-input-service';
import { loadMarketShapeSynthesisChildren, loadMarketShapeSynthesisEvidence } from '../../server/services/market-shape-synthesis-input-service';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import type { MarketShapeStructureExplanationInput } from '../../shared/market-semantic-contracts';
import { createMarketShapeExplanationRunFixture } from './helpers/market-shape-explanation-run-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

const config = () => loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthesis-loader-key',AGENT_VOC_MODEL:'synthesis-loader-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthesis-loader'});

test('synthesis evidence loader accepts only current audited leaf sections and the linked revision', {timeout:120_000}, async t => {
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);const f=await createMarketShapeExplanationRunFixture(pg.pool);
  let catalog:Awaited<ReturnType<typeof loadMarketShapeExplanationCatalog>>;
  const client={responses:{create:async(body:{input:string})=>{const input=JSON.parse(body.input) as MarketShapeStructureExplanationInput,decoded=decodeMarketShapeExplanationWindow(catalog,input.window),row=decoded.rows.find(r=>r.cells.some(c=>c.value!==null)),cell=row?.cells.find(c=>c.value!==null),codes=[...new Set(decoded.limitations.map(l=>l.code))],risk={kind:'risk',parts:[{kind:'text',text:'The fixed source boundary limits this interpretation.'}],evidenceRowIds:[],limitationCodes:codes},observed=row&&cell?{kind:'observed',parts:[{kind:'text',text:'The saved value is '},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;return {id:'synthesis-loader-response',status:'completed',usage:{input_tokens:100,output_tokens:50,total_tokens:150},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,fragment:{version:'market-shape-explanation-fragment/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windowId:input.window.windowId,section:{dimension:input.window.dimension,status:row?'explained':'insufficient-evidence',summary:observed,findings:row?[observed]:[],limitations:[risk],verification:[{...risk,kind:'verification'}]}}})}]}]};}}} as unknown as OpenAIProviderOptions['client'];
  const runtime=await createMarketModelRuntime(f.context,config(),{client});t.after(()=>runtime.stop());
  const linked=await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({actor:f.actor,parentRunId:f.parentRunId,request:f.request,idempotencyKey:randomUUID(),identity:{configurationVersion:runtime.shapeExplanationConfigurationVersion,promptVersion:runtime.shapeExplanationPromptVersion}});catalog=await loadMarketShapeExplanationCatalog(f.context,f.actor,linked.childRun.id);
  let recovered:Awaited<ReturnType<typeof readMarketShapeExplanationFragments>>|undefined;
  for(let i=0;i<100;i++){if(!await runtime.tick())break;try{const current=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});if(current.status==='ready-for-synthesis'){recovered=current;break;}}catch{/* automatic synthesis may transiently advance another runnable step */}}
  recovered??=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(recovered.status,'ready-for-synthesis');
  const selected=recovered.windows.filter((w):w is Extract<typeof w,{status:'succeeded'}>=>w.status==='succeeded');
  const children=selected.map(w=>({childId:w.windowId,leafWindowIds:[w.windowId],section:w.output.section}));
  const beforeParent=await loadMarketShapeSynthesisChildren(f.context,f.actor,linked.childRun.id,children.map(child=>child.childId));
  assert.deepEqual(beforeParent.shapeSynthesisChildren,children,'planner recovery must not require a parent snapshot');
  await assert.rejects(loadMarketShapeSynthesisChildren(f.context,f.actor,linked.childRun.id,[children[0].childId,children[0].childId]));
  await assert.rejects(loadMarketShapeSynthesisChildren(f.context,f.actor,linked.childRun.id,['unknown-reduction-node']));
  await assert.rejects(loadMarketShapeSynthesisChildren(f.context,{organizationId:randomUUID(),userId:randomUUID()},linked.childRun.id,[children[0].childId]));
  const synthesis=await buildMarketShapeFinalSynthesisInput(catalog,children,children.flatMap(c=>c.leafWindowIds),()=>true);
  const store=new PostgresMarketAnalysisSnapshotStore(f.context);
  const save=async(value:any,sourceRefs:readonly string[]=catalog.source.sourceRefs)=>store.saveInput({actor:f.actor,studyId:f.scope.researchId,now:catalog.source.dataCutoffAt,input:{scope:f.scope,kind:'overview',sourceVersion:catalog.version,ruleVersion:'shape-synthesis/v1',collectedAt:catalog.source.dataCutoffAt,expectedRecordIds:[value.nodeId],records:[{id:value.nodeId,scope:f.scope,data:{semantic:{task:'market-shape-synthesis',synthesis:value,sourceRefs}}}]}});
  const saved=await save(synthesis),loaded=await loadMarketShapeSynthesisEvidence(f.context,f.actor,linked.childRun.id,saved.snapshot.snapshotId);
  assert.equal(loaded.shapeExplanationCatalog.explanationCatalogId,catalog.explanationCatalogId);assert.deepEqual(loaded.shapeSynthesisChildren,children);assert.deepEqual(new Set(loaded.shapeSynthesisExpectedLeaves),new Set(recovered.windows.map(window=>window.windowId)));
  await f.steps.cancelModuleRun({actor:f.actor,moduleRunId:linked.childRun.id,idempotencyKey:randomUUID()});
  assert.deepEqual((await loadMarketShapeSynthesisEvidence(f.context,f.actor,linked.childRun.id,saved.snapshot.snapshotId)).shapeSynthesisChildren,children,'cancellation must not erase immutable successful evidence');
  const forgedChildren=structuredClone(children);forgedChildren[0].section.summary.parts[0]={kind:'text',text:'A different but structurally valid interpretation.'};
  const forged=await buildMarketShapeFinalSynthesisInput(catalog,forgedChildren,forgedChildren.flatMap(c=>c.leafWindowIds),()=>true);
  await assert.rejects(loadMarketShapeSynthesisEvidence(f.context,f.actor,linked.childRun.id,(await save(forged)).snapshot.snapshotId));
  const stale=structuredClone(synthesis) as any;stale.revisionId='market-shape-revision:'+'f'.repeat(64);
  await assert.rejects(loadMarketShapeSynthesisEvidence(f.context,f.actor,linked.childRun.id,(await save(stale)).snapshot.snapshotId));
  await assert.rejects(loadMarketShapeSynthesisEvidence(f.context,f.actor,linked.childRun.id,(await save(synthesis,[catalog.source.sourceRefs[0]])).snapshot.snapshotId));
});
