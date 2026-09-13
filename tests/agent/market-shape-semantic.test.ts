import assert from 'node:assert/strict';
import test from 'node:test';
import {sourceCatalog,observation} from './helpers/market-shape-explanation-fixture';
import {buildMarketShapeExplanationCatalog} from '../../server/domain/market-research/shape-explanation-catalog';
import {buildMarketShapeExplanationWindows,decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {validateMarketSemanticInput,validateMarketShapeStructureExplanation} from '../../server/domain/market-research/semantic-validation';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {MarketShapeStructureExplanationInput,MarketSemanticValidationBinding} from '../../shared/market-semantic-contracts';

async function fixture(){
 const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog('market-shape-price-catalog/v3'));
 const {requestedAsins,eligibleAsins,...scope}=catalog.scope;
 const windows=await buildMarketShapeExplanationWindows(catalog,w=>w.coverage.rowIds.length<=2);
 const sources=await Promise.all([observation('2026-08'),observation('2026-07',p=>{p.data[1].totalUnits=0;})]);
 assert.deepEqual([...catalog.source.sourceRefs].sort(),sources.map(s=>s.sourceRef).sort());
 const snapshot=createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'market-shape-explanation-catalog/v1',ruleVersion:'shape-explanation/v1',collectedAt:catalog.source.dataCutoffAt,
 expectedRecordIds:windows.map(w=>w.windowId),records:windows.map(window=>({id:window.windowId,scope,data:{semantic:{task:'market-shape-structure-explanation',window,sourceRefs:catalog.source.sourceRefs}}}))});
 return {task:'market-shape-structure-explanation' as const,moduleRunId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',snapshot,sources:Object.fromEntries(sources.map(s=>[s.sourceRef,s.source])),selectionRevision:catalog.revisionId,configurationVersion:'shape-explanation-test/v1',dataCutoffAt:catalog.source.dataCutoffAt,shapeExplanationCatalog:catalog};
}
function output(input:MarketShapeStructureExplanationInput,binding:MarketSemanticValidationBinding){
 const catalog=binding.shapeExplanationCatalog!,w=input.window;
 const row=catalog.rows.find(r=>w.coverage.rowIds.includes(r.id)&&r.cells.some(c=>c.value!==null)),cell=row?.cells.find(c=>c.value!==null);
 const risk={kind:'risk' as const,parts:[{kind:'text' as const,text:'结论受已保存的范围与来源限制。'}],evidenceRowIds:[],limitationCodes:[...new Set(decodeMarketShapeExplanationWindow(catalog,w).limitations.map(l=>l.code))]};
 const finding=row&&cell?{kind:'observed' as const,parts:[{kind:'text' as const,text:'本窗保存的指标为：'},{kind:'cell' as const,rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]}:risk;
 return {schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,
 fragment:{version:'market-shape-explanation-fragment/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windowId:w.windowId,
 section:{dimension:w.dimension,status:row?'explained':'insufficient-evidence',summary:finding,findings:row?[finding]:[],limitations:[risk],verification:[{...risk,kind:'verification',parts:[{kind:'text',text:'核对来源后再解释。'}]}]}}};
}

test('native shape task keeps each complete window and validates outputs against the restored revision',async()=>{
 const f=await fixture(),plan=await planMarketSemanticBatches(f,async()=>true);
 assert.equal(plan.batches.length,f.snapshot.records.length);
 for(const batch of plan.batches){
  assert.equal(batch.input.task,'market-shape-structure-explanation');assert.equal(batch.memberRefs.length,1);
  assert.equal('shapeExplanationCatalog' in batch.input,false);
  const input=validateMarketSemanticInput(batch.input,batch.validationBinding) as MarketShapeStructureExplanationInput;
  const accepted=validateMarketShapeStructureExplanation(input,output(input,batch.validationBinding),batch.validationBinding);
  assert.equal(accepted.fragment.windowId,input.window.windowId);assert.ok(Object.isFrozen(accepted));
 }
 const altered=await planMarketSemanticBatches({...f,configurationVersion:'another-config'},async()=>true);
 assert.notEqual(altered.batches[0].bindingId,plan.batches[0].bindingId);
});

test('missing authorized catalogue, wrong revision and a changed window fail before budget admission',async()=>{
 const f=await fixture();let metered=0;const meter=async()=>{metered++;return true;};
 await assert.rejects(planMarketSemanticBatches({...f,shapeExplanationCatalog:undefined},meter));
 await assert.rejects(planMarketSemanticBatches({...f,selectionRevision:'wrong-revision'},meter));
 const first=structuredClone(f.snapshot.records[0]);
 (first.data as any).semantic.window.dictionary.strings.push('unbound context');
 const {windowId,...body}=(first.data as any).semantic.window;(first.data as any).semantic.window.windowId='market-shape-explanation-window:'+digest(body);
 const snapshot=createMarketInputSnapshot({scope:f.snapshot.scope,kind:f.snapshot.kind,sourceVersion:f.snapshot.sourceVersion,ruleVersion:f.snapshot.ruleVersion,collectedAt:f.snapshot.collectedAt,expectedRecordIds:[first.id],records:[first]});
 await assert.rejects(planMarketSemanticBatches({...f,snapshot},meter));assert.equal(metered,0);
});

test('native output rejects another batch identity and another window even in the same revision',async()=>{
 const plan=await planMarketSemanticBatches(await fixture(),async()=>true),a=plan.batches[0],b=plan.batches[1];
 const input=a.input as MarketShapeStructureExplanationInput,value=output(input,a.validationBinding);
 value.batchId=b.input.batchId;assert.throws(()=>validateMarketShapeStructureExplanation(input,value,a.validationBinding),/output_identity/);
 value.batchId=input.batchId;value.fragment.windowId=(b.input as MarketShapeStructureExplanationInput).window.windowId;
 assert.throws(()=>validateMarketShapeStructureExplanation(input,value,a.validationBinding),/identity/);
 const {shapeExplanationCatalog:_catalog,...missing}=a.validationBinding;assert.throws(()=>validateMarketSemanticInput(input,missing),/missing_shape/);
});

test('shape task rejects hidden input, output and restored-catalog getters without executing them',async()=>{
 const plan=await planMarketSemanticBatches(await fixture(),async()=>true),batch=plan.batches[0];
 for(const part of ['input','output','binding','catalog'] as const){
  const input=structuredClone(batch.input) as MarketShapeStructureExplanationInput;
  const binding=structuredClone(batch.validationBinding),candidate=output(input,binding);
  const target=part==='input'?input:part==='output'?candidate:part==='binding'?binding:binding.shapeExplanationCatalog!;
  let reads=0;
  Object.defineProperty(target,'hidden',{get(){reads++;throw new Error('getter must not execute');}});
  assert.throws(()=>validateMarketShapeStructureExplanation(input,candidate,binding),/unsafe_json/);
  assert.equal(reads,0);
 }
});
