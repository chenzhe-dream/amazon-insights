import {createMarketShapeSynthesisModelWire} from '../../server/runtime/market-shape-synthesis-wire';
import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {sourceCatalog,observation} from './helpers/market-shape-explanation-fixture';
import {buildMarketShapeExplanationCatalog} from '../../server/domain/market-research/shape-explanation-catalog';
import {buildMarketShapeExplanationWindows,decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {buildMarketShapeFinalSynthesisInput} from '../../server/domain/market-research/shape-explanation-synthesis';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {validateMarketSemanticInput,validateMarketShapeSynthesisOutput} from '../../server/domain/market-research/semantic-validation';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import type {MarketShapeSynthesisInput} from '../../shared/market-semantic-contracts';
import {marketSemanticWire} from '../../server/runtime/market-semantic-wire';

async function fixture(){
 const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog()),windows=await buildMarketShapeExplanationWindows(catalog,()=>true);
 const children=windows.map(w=>{const row=catalog.rows.find(r=>w.coverage.rowIds.includes(r.id)&&r.cells.some(c=>c.value!==null))!,cell=row.cells.find(c=>c.value!==null)!;
  const risk={kind:'risk' as const,parts:[{kind:'text' as const,text:'保留来源限制。'}],evidenceRowIds:[],limitationCodes:[...new Set(decodeMarketShapeExplanationWindow(catalog,w).limitations.map(l=>l.code))]};
  const observed={kind:'observed' as const,parts:[{kind:'text' as const,text:'保存指标为：'},{kind:'cell' as const,rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]};
  return {childId:w.windowId,leafWindowIds:[w.windowId],section:{dimension:w.dimension,status:'explained' as const,summary:observed,findings:[observed],limitations:[risk],verification:[{...risk,kind:'verification' as const}]}};});
 const leaves=windows.map(w=>w.windowId),synthesis=await buildMarketShapeFinalSynthesisInput(catalog,children,leaves,()=>true);
 const {requestedAsins:_r,eligibleAsins:_e,...scope}=catalog.scope;
 const sources=await Promise.all([observation('2026-08'),observation('2026-07',p=>{p.data[1].totalUnits=0;})]);
 const snapshot=createMarketInputSnapshot({scope,kind:'overview',sourceVersion:catalog.version,ruleVersion:'shape-explanation/v1',collectedAt:catalog.source.dataCutoffAt,expectedRecordIds:[synthesis.nodeId],records:[{id:synthesis.nodeId,scope,data:{semantic:{task:'market-shape-synthesis',synthesis,sourceRefs:catalog.source.sourceRefs}}}]});
 return {task:'market-shape-synthesis' as const,moduleRunId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',snapshot,sources:Object.fromEntries(sources.map(s=>[s.sourceRef,s.source])),selectionRevision:catalog.revisionId,configurationVersion:'synthesis-test/v1',dataCutoffAt:catalog.source.dataCutoffAt,shapeExplanationCatalog:catalog,shapeSynthesisChildren:children,shapeSynthesisExpectedLeaves:leaves};
}
test('native synthesis binds complete authorized children and preserves canonical final output',async()=>{
 const f=await fixture(),plan=await planMarketSemanticBatches(f,async()=>true);assert.equal(plan.batches.length,1);
 const b=plan.batches[0],input=validateMarketSemanticInput(b.input,b.validationBinding) as MarketShapeSynthesisInput;
 const risk={kind:'risk',parts:[{kind:'text',text:'已有样本不足以形成确定判断。'}],evidenceRowIds:[],limitationCodes:input.synthesis.limitations.map(l=>l.code)};
 const candidate={schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,result:{version:'market-shape-final-synthesis-output/v1',nodeId:input.synthesis.nodeId,inputDigest:input.synthesis.inputDigest,synthesis:{decision:'insufficient-evidence',summary:risk,limitations:[risk],verification:[{...risk,kind:'verification'}]}}};
 assert.deepEqual(validateMarketShapeSynthesisOutput(input,candidate,b.validationBinding),candidate);
 const wire=marketSemanticWire(input);assert.ok(wire.inputSchema!.safeParse(wire.input).success);
 for(const field of ['scopeDigest','contentSnapshotId','selectionRevision','batchKey','sourceRefs']){assert.equal(field in wire.input,false,`${field} is server-side lineage`);assert.equal(field in input,true,'canonical audit input keeps lineage');}
 assert.equal(wire.encoding,'shape-synthesis-envelope/v2');
 const {version:_version,encoding:_encoding,...completeGraph}=createMarketShapeSynthesisModelWire(input.synthesis).input;assert.deepEqual((wire.input as any).synthesis,completeGraph,'only redundant protocol tags are omitted from the complete graph');
 assert.ok(!wire.inputSchema!.safeParse(input).success,'canonical saved input must not masquerade as model transport');
 const wireCandidate=JSON.parse(JSON.stringify(candidate)) as any;
 for(const statement of [wireCandidate.result.synthesis.summary,...wireCandidate.result.synthesis.limitations,...wireCandidate.result.synthesis.verification]){
  statement.evidenceRowRefs=statement.evidenceRowIds;delete statement.evidenceRowIds;
  statement.limitationRefs=statement.limitationCodes.map((code:string)=>'c'+input.synthesis.limitations.findIndex(l=>l.code===code));delete statement.limitationCodes;
 }
 assert.deepEqual(validateMarketShapeSynthesisOutput(input,wire.decode(wireCandidate),b.validationBinding),candidate);
 wireCandidate.result.dictionary={r0:'forged'};assert.throws(()=>wire.decode(wireCandidate));
 assert.equal('shapeExplanationCatalog' in input,false);
 const bad=structuredClone(candidate);bad.result.nodeId='foreign';assert.throws(()=>validateMarketShapeSynthesisOutput(input,bad,b.validationBinding),z.ZodError);
});
test('self-consistent saved input cannot replace authorized child evidence or full leaf manifest',async()=>{
 const f=await fixture();let calls=0;const meter=async()=>{calls++;return true;};
 await assert.rejects(planMarketSemanticBatches({...f,shapeSynthesisChildren:undefined},meter));
 await assert.rejects(planMarketSemanticBatches({...f,shapeSynthesisExpectedLeaves:undefined},meter));
 const forged=structuredClone(f.shapeSynthesisChildren);forged[0].section.verification[0].parts[0].text='替换已审计的原始判断。';
 await assert.rejects(planMarketSemanticBatches({...f,shapeSynthesisChildren:forged},meter));
 await assert.rejects(planMarketSemanticBatches({...f,shapeSynthesisExpectedLeaves:f.shapeSynthesisExpectedLeaves.slice(1)},meter));
 await assert.rejects(planMarketSemanticBatches({...f,selectionRevision:'wrong-revision'},meter));
 assert.equal(calls,0);
});
