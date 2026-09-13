import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {createMarketShapeSynthesisModelWire} from '../../server/runtime/market-shape-synthesis-wire';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresMarketShapeExplanationRunStore} from '../../server/db/postgres/market-shape-explanation-run-store';
import {PostgresMarketAgentRunStore} from '../../server/db/postgres/market-agent-run-store';
import {PostgresMarketAnalysisSnapshotStore} from '../../server/db/postgres/market-analysis-snapshot-store';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {MarketSemanticBatchPreparationService} from '../../server/runtime/market-semantic-batch-preparation';
import {MarketSemanticExecutionService} from '../../server/runtime/market-semantic-execution-service';
import {buildMarketShapeExplanationWindows,decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {buildMarketShapeDimensionSynthesisInput,buildMarketShapeFinalSynthesisInput} from '../../server/domain/market-research/shape-explanation-synthesis';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {loadMarketShapeExplanationCatalog} from '../../server/services/market-shape-explanation-input-service';
import {readMarketShapeExplanationFragments} from '../../server/services/market-shape-explanation-fragment-service';
import {loadMarketShapeSynthesisEvidence} from '../../server/services/market-shape-synthesis-input-service';
import {SkillRegistry} from '../../server/skills/registry';
import {MARKET_SHAPE_EXPLANATION_DIMENSIONS} from '../../shared/market-shape-explanation-contracts';
import type {MarketShapeSynthesisChild,MarketShapeDimensionSynthesisInput,MarketShapeFinalSynthesisInput} from '../../shared/market-shape-synthesis-contracts';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketShapeExplanationRunFixture} from './helpers/market-shape-explanation-run-fixture';
import {startFakeOpenAIResponsesServer} from './helpers/fake-openai-responses-server';

// Synthetic protocol exercise: explicit test gates drive native settlements.
// This does not assert automatic production continuation or model quality.
test('native synthesis executes audited reductions and final output, then restores ancestry without provider calls',{timeout:600_000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const f=await createMarketShapeExplanationRunFixture(pg.pool),registry=await SkillRegistry.open('skills-src');
 const configurationVersion='synthesis-native-test/v1',linked=await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({actor:f.actor,parentRunId:f.parentRunId,request:f.request,idempotencyKey:randomUUID(),identity:{configurationVersion,promptVersion:'synthesis-native-prompt/v1'}});
 const catalog=await loadMarketShapeExplanationCatalog(f.context,f.actor,linked.childRun.id);let providerCalls=0,numericNode='',invalidAliasSent=false;
 const server=await startFakeOpenAIResponsesServer(body=>{
  providerCalls++;const input=JSON.parse(body.input);
  if(input.task==='market-shape-synthesis'){
   const s=input.synthesis,risk={kind:'risk',parts:[{kind:'text',text:'Synthetic protocol evidence does not establish a business conclusion.'}],evidenceRowRefs:[],limitationRefs:s.limitations.map((l:any)=>l.limitationRef)};
   const row=s.evidenceRows.find((r:any)=>r.cells.some((c:any)=>c[2]!==null)),cell=row?.cells.find((c:any)=>c[2]!==null);
   if(s.mode==='dimension-reduce'&&row&&cell&&!numericNode)numericNode=s.nodeId;
   let observed:any;
   if(s.nodeId===numericNode){const alias=invalidAliasSent?row.rowRef:'r99999';invalidAliasSent=true;observed={kind:'observed',parts:[{kind:'text',text:'The saved value is '},{kind:'cell',rowRef:alias,cellRef:cell[0]}],evidenceRowRefs:[alias],limitationRefs:[]};}
   const result=s.mode==='final'?{version:'market-shape-final-synthesis-output/v1',nodeId:s.nodeId,inputDigest:s.inputDigest,synthesis:{decision:'insufficient-evidence',summary:risk,limitations:[risk],verification:[{...risk,kind:'verification'}]}}:
    {version:'market-shape-dimension-synthesis-output/v1',nodeId:s.nodeId,inputDigest:s.inputDigest,section:{dimension:s.dimension,status:observed?'explained':'insufficient-evidence',summary:observed??risk,findings:observed?[observed]:[],limitations:[risk],verification:[{...risk,kind:'verification'}]}};
   return {schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,result};
  }
  const decoded=decodeMarketShapeExplanationWindow(catalog,input.window),row=decoded.rows.find(r=>r.cells.some(c=>c.value!==null)),cell=row?.cells.find(c=>c.value!==null);
  const risk={kind:'risk',parts:[{kind:'text',text:'The saved source limits this synthetic interpretation.'}],evidenceRowIds:[],limitationCodes:[...new Set(decoded.limitations.map(l=>l.code))]};
  const observed=row&&cell?{kind:'observed',parts:[{kind:'text',text:'The saved value is '},{kind:'cell',rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;
  return {schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,fragment:{version:'market-shape-explanation-fragment/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windowId:input.window.windowId,section:{dimension:input.window.dimension,status:row?'explained':'insufficient-evidence',summary:observed,findings:row?[observed]:[],limitations:[risk],verification:[{...risk,kind:'verification'}]}}};
 });t.after(()=>server.close());
 const cap={maxTokens:10_000_000,maxCostMicros:10_000_000};
 const configuration=(task:'market-shape-structure-explanation'|'market-shape-synthesis'):any=>({task,configurationVersion,providerName:'native-synthetic-test',transport:'responses-strict',model:{name:'shape-synthetic',estimatedInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000,pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}},limits:{call:cap,run:cap,organizationUtcDay:cap},openAI:{apiKey:'test',baseUrl:server.baseUrl}});
 const claim=async(kind:'prepare-members'|'prepare-model-batches'|'model-batch')=>f.steps.claimStep({moduleRunId:linked.childRun.id,kinds:[kind],leaseOwnerId:randomUUID(),leaseMs:120000});
 const gate=(n:number)=>({stepKey:`synthetic/synthesis-gate/${n}`,kind:'prepare-members' as const,subject:{synthetic:true},input:{phase:'synthetic-synthesis-gate',index:n},inputRefs:[]});
 const snapshotFor=(task:string,id:string,payload:Record<string,unknown>)=>({scope:f.scope,kind:'overview' as const,sourceVersion:catalog.version,ruleVersion:'shape-explanation/v1',collectedAt:catalog.source.dataCutoffAt,expectedRecordIds:[id],records:[{id,scope:f.scope,data:{semantic:{task,...payload,sourceRefs:catalog.source.sourceRefs}}}]});
 const prepareStep=(task:string,snapshotId:string)=>({stepKey:`synthetic/prepare/${snapshotId}`,kind:'prepare-model-batches' as const,subject:{task},input:{task,inputSnapshotId:snapshotId,selectionRevision:catalog.revisionId,dataCutoffAt:catalog.source.dataCutoffAt},inputRefs:[{kind:'input' as const,id:snapshotId}]});
 const windows=await buildMarketShapeExplanationWindows(catalog,w=>w.coverage.rowIds.length<=2),windowInputs=windows.map(w=>snapshotFor('market-shape-structure-explanation',w.windowId,{window:w}));
 const anchor=await claim('prepare-members');assert.ok(anchor);
 await f.steps.settleAndEnqueue({claim:anchor,outcome:{status:'succeeded',output:{manifestVersion:'shape-explanation-windows/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windows}},inputs:windowInputs as any,children:[...windowInputs.map(input=>prepareStep('market-shape-structure-explanation',createMarketInputSnapshot(input).snapshotId)),gate(0)]});
 const preparation=new MarketSemanticBatchPreparationService(f.context,registry),execution=new MarketSemanticExecutionService(f.context,registry);
 while(true){const c=await claim('prepare-model-batches');if(!c)break;const result=await preparation.prepareBatches(c,configuration('market-shape-structure-explanation'));assert.equal((result.manifest as any).rejectedMembers.length,0);}
 while(true){const c=await claim('model-batch');if(!c)break;assert.equal((await execution.executeBatch(c,configuration('market-shape-structure-explanation'))).status,'succeeded');}
 const recovered=await readMarketShapeExplanationFragments(f.context,{actor:f.actor,moduleRunId:linked.childRun.id});assert.equal(recovered.status,'ready-for-synthesis');
 const leaves=recovered.windows.flatMap(w=>w.status==='succeeded'?[{childId:w.windowId,leafWindowIds:[w.windowId],section:w.output.section}]:[]),expected=leaves.flatMap(x=>x.leafWindowIds);
 let gateOrdinal=1,reduceCount=0,lastSnapshotId='';
 const execute=async(synthesis:MarketShapeDimensionSynthesisInput|MarketShapeFinalSynthesisInput)=>{
  const input=snapshotFor('market-shape-synthesis',synthesis.nodeId,{synthesis}),snapshot=createMarketInputSnapshot(input),g=await claim('prepare-members');assert.ok(g);
  await f.steps.settleAndEnqueue({claim:g,outcome:{status:'succeeded',output:{synthetic:true}},inputs:[input] as any,children:[prepareStep('market-shape-synthesis',snapshot.snapshotId),gate(gateOrdinal++)]});
  const pc=await claim('prepare-model-batches');assert.ok(pc);const prepared=await preparation.prepareBatches(pc,configuration('market-shape-synthesis'));
  assert.equal((prepared.manifest as any).rejectedMembers.length,0,JSON.stringify(prepared.manifest));
  const mc=await claim('model-batch');assert.ok(mc);const result=await execution.executeBatch(mc,configuration('market-shape-synthesis'));assert.equal(result.status,'succeeded',JSON.stringify(result.agentRun.outcome?.error));
  if(synthesis.nodeId===numericNode){assert.equal(result.agentRun.outcome?.attemptCount,2);const part=(result.value as any).result.section.summary.parts.find((p:any)=>p.kind==='cell');assert.ok(part?.rowId);assert.equal('rowRef' in part,false);}
  const calls=providerCalls,replay=await new MarketSemanticExecutionService(new PostgresQueryContext(pg.pool),registry).executeBatch(mc,configuration('market-shape-synthesis'));assert.equal(replay.replayed,true);assert.equal(providerCalls,calls);
  lastSnapshotId=snapshot.snapshotId;return result.value as any;
 };
 const roots:MarketShapeSynthesisChild[]=[];
 for(const dimension of MARKET_SHAPE_EXPLANATION_DIMENSIONS){
  const nodes=leaves.filter(c=>c.section.dimension===dimension);
  while(nodes.length>1){const pair=nodes.splice(0,2),synthesis=await buildMarketShapeDimensionSynthesisInput(catalog,dimension,pair,pair.flatMap(c=>c.leafWindowIds),()=>true),output=await execute(synthesis);reduceCount++;
   nodes.unshift({childId:synthesis.nodeId,leafWindowIds:synthesis.leafWindowIds,section:output.result.section});}
  roots.push(nodes[0]);
 }
 assert.ok(reduceCount>1);
 assert.ok(invalidAliasSent,'exercise a real bounded alias repair');
 const final=await buildMarketShapeFinalSynthesisInput(catalog,roots,expected,()=>true);
 await writeFile('test-results/market-research-goal/T17/shape-synthesis-native-final-fixture.json',JSON.stringify(final,null,2));
 const finalWire=createMarketShapeSynthesisModelWire(final).input; t.diagnostic(JSON.stringify({synthetic:true,finalWireBytes:Buffer.byteLength(JSON.stringify(finalWire)),fields:Object.fromEntries(Object.entries(finalWire).map(([k,v])=>[k,Buffer.byteLength(JSON.stringify(v))]))}));
 const output=await execute(final);assert.equal(output.result.version,'market-shape-final-synthesis-output/v1');
 const calls=providerCalls,fresh=new PostgresQueryContext(pg.pool),restored=await loadMarketShapeSynthesisEvidence(fresh,f.actor,linked.childRun.id,lastSnapshotId);
 assert.deepEqual(restored.shapeSynthesisChildren,roots);assert.deepEqual(new Set(restored.shapeSynthesisExpectedLeaves),new Set(expected));assert.equal(providerCalls,calls);
 const auditStore=new PostgresMarketAgentRunStore(fresh),audits=await auditStore.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:linked.childRun.id});assert.equal(audits.filter(a=>a.task==='market-shape-synthesis'&&a.terminalStatus==='succeeded').length,reduceCount+1);
 const snapshots=new PostgresMarketAnalysisSnapshotStore(fresh),bad=structuredClone(final);bad.children[0].section.summary.parts[0]={kind:'text',text:'Forged saved model conclusion.'};
 const forged=await buildMarketShapeFinalSynthesisInput(catalog,bad.children,expected,()=>true),saved=await snapshots.saveInput({actor:f.actor,studyId:f.scope.researchId,now:catalog.source.dataCutoffAt,input:snapshotFor('market-shape-synthesis',forged.nodeId,{synthesis:forged})});
 await assert.rejects(loadMarketShapeSynthesisEvidence(fresh,f.actor,linked.childRun.id,saved.snapshot.snapshotId));
 await assert.rejects(loadMarketShapeSynthesisEvidence(fresh,{organizationId:randomUUID(),userId:randomUUID()},linked.childRun.id,lastSnapshotId));
 await f.steps.cancelModuleRun({actor:f.actor,moduleRunId:linked.childRun.id,idempotencyKey:randomUUID()});
 assert.deepEqual((await loadMarketShapeSynthesisEvidence(fresh,f.actor,linked.childRun.id,lastSnapshotId)).shapeSynthesisChildren,roots);assert.equal(providerCalls,calls);
});
