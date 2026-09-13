import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {MarketShapeSynthesisInputSchema,MarketShapeSynthesisOutputSchema} from '../../shared/market-semantic-contracts';
import {marketSemanticWire} from '../../server/runtime/market-semantic-wire';
import {createStructuredResponseFormat} from '../../server/runtime/structured-response-format';
import {buildMarketShapeExplanationCatalog} from '../../server/domain/market-research/shape-explanation-catalog';
import {buildMarketShapeExplanationWindows,decodeMarketShapeExplanationWindow} from '../../server/domain/market-research/shape-explanation-wire';
import {buildMarketShapeDimensionSynthesisInput,buildMarketShapeFinalSynthesisInput,validateMarketShapeDimensionSynthesisOutput,validateMarketShapeFinalSynthesisOutput} from '../../server/domain/market-research/shape-explanation-synthesis';
import {createMarketShapeSynthesisModelWire} from '../../server/runtime/market-shape-synthesis-wire';
import type {MarketShapeExplanationCatalog} from '../../shared/market-shape-explanation-contracts';
import type {MarketShapeExplanationWindow} from '../../shared/market-shape-explanation-wire-contracts';
import type {MarketShapeSynthesisChild} from '../../shared/market-shape-synthesis-contracts';
import {sourceCatalog} from './helpers/market-shape-explanation-fixture';

function leaf(catalog:MarketShapeExplanationCatalog,window:MarketShapeExplanationWindow):MarketShapeSynthesisChild {
  const evidence=decodeMarketShapeExplanationWindow(catalog,window),row=evidence.rows.find(row=>row.cells.some(cell=>cell.value!==null));
  assert.ok(row);const cell=row.cells.find(cell=>cell.value!==null);assert.ok(cell);
  const observed={kind:'observed' as const,parts:[{kind:'text' as const,text:'Returned value:'},{kind:'cell' as const,rowId:row.id,cellId:cell.id}],evidenceRowIds:[row.id],limitationCodes:[]};
  const risk={kind:'risk' as const,parts:[{kind:'text' as const,text:'Retain the original source limitations.'}],evidenceRowIds:[],limitationCodes:[...new Set(evidence.limitations.map(item=>item.code))]};
  return {childId:window.windowId,leafWindowIds:[window.windowId],section:{dimension:window.dimension,status:'explained',summary:observed,findings:[observed],limitations:[risk],verification:[{...risk,kind:'verification',parts:[{kind:'text',text:'Verify using comparable evidence.'}]}]}};
}
async function fixture(){
  const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog());
  const split=await buildMarketShapeExplanationWindows(catalog,window=>window.coverage.rowIds.length<=2),brand=split.filter(window=>window.dimension==='brand').slice(0,2);
  const dimension=await buildMarketShapeDimensionSynthesisInput(catalog,'brand',brand.map(window=>leaf(catalog,window)),brand.map(window=>window.windowId),()=>true);
  const full=await buildMarketShapeExplanationWindows(catalog,()=>true);
  const final=await buildMarketShapeFinalSynthesisInput(catalog,full.map(window=>leaf(catalog,window)),full.map(window=>window.windowId),()=>true);
  return {catalog,dimension,final};
}
function response(wire:ReturnType<typeof createMarketShapeSynthesisModelWire>){
  const section=wire.input.children[0].section;
  const risk={kind:'risk' as const,parts:[{kind:'text' as const,text:'Retain the original source limitations.'}],evidenceRowRefs:[],limitationRefs:wire.input.limitations.map(item=>item.limitationRef)};
  const verification={...risk,kind:'verification' as const,parts:[{kind:'text' as const,text:'Verify using comparable evidence.'}]};
  const identity={nodeId:wire.input.nodeId,inputDigest:wire.input.inputDigest};
  return wire.input.mode==='final'
    ?{...identity,version:'market-shape-final-synthesis-output/v1',synthesis:{decision:'insufficient-evidence',summary:risk,limitations:[risk],verification:[verification]}}
    :{...identity,version:'market-shape-dimension-synthesis-output/v1',section:{dimension:section.dimension,status:section.status,summary:wire.input.statements[section.summary],findings:section.findings.map(index=>wire.input.statements[index]),limitations:[risk],verification:[verification]}};
}

test('shape synthesis repeatedly creates and decodes dimension and final requests in one process',async()=>{
  const {catalog,dimension,final}=await fixture();
  for(const input of [dimension,final,dimension,final]){
    const wire=createMarketShapeSynthesisModelWire(input),raw=response(wire);
    // Exercise the exported schemas too: native admission and execution reuse them.
    assert.deepEqual(wire.inputSchema.parse(wire.input),wire.input);
    assert.deepEqual(wire.outputSchema.parse(raw),raw);
    const first=wire.decode(raw),second=wire.decode(structuredClone(raw));assert.deepEqual(second,first);
    if(input.mode==='dimension-reduce'){
      const checked=validateMarketShapeDimensionSynthesisOutput(catalog,input,first);
      assert.deepEqual(checked.section.summary,input.children[0].section.summary);
      assert.deepEqual(checked.section.limitations[0].limitationCodes,input.limitations.map(item=>item.code));
    }else{
      const checked=validateMarketShapeFinalSynthesisOutput(catalog,input,first);
      assert.deepEqual(checked.dimensions,input.children.map(child=>child.section));
      assert.deepEqual(checked.synthesis.summary.limitationCodes,input.limitations.map(item=>item.code));
    }
  }
});

test('shape synthesis keeps nested request data immutable while schemas remain reusable',async()=>{
  const {dimension}=await fixture(),wire=createMarketShapeSynthesisModelWire(dimension),before=structuredClone(wire.input);
  assert.equal(Reflect.set(wire.input.evidenceRows[0].cells[0],2,999),false);
  assert.equal(Reflect.set(wire.input.statements[0].parts[0],'text','Changed after admission'),false);
  assert.equal(Reflect.set(wire.input.leafSets[0],0,'l999'),false);
  assert.deepEqual(wire.input,before);
  const raw=response(wire);assert.deepEqual(wire.decode(raw),wire.decode(structuredClone(raw)));
  assert.deepEqual(wire.inputSchema.parse(before),before);
  const next=createMarketShapeSynthesisModelWire(dimension);assert.deepEqual(next.input,before);
});

test('native synthesis runner repeatedly generates strict response schemas and decodes transport envelopes',async()=>{
  const {catalog,dimension,final}=await fixture(),formats=new Map<string,unknown>(),inputSchemas=new Map<string,unknown>();
  const {organizationId,requestedAsins,eligibleAsins,...publicScope}=catalog.scope;void organizationId;void requestedAsins;void eligibleAsins;
  for(const synthesis of [dimension,final,dimension,final]){
    const canonical=MarketShapeSynthesisInputSchema.parse({schemaVersion:'1.0.0',task:'market-shape-synthesis',batchId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',inputDigest:'a'.repeat(64),scopeDigest:'b'.repeat(64),scope:publicScope,contentSnapshotId:`market-input:${'c'.repeat(64)}`,selectionRevision:catalog.revisionId,batchKey:'continuous-schema-regression',dataCutoffAt:catalog.source.dataCutoffAt,sourceRefs:catalog.source.sourceRefs,synthesis});
    const wire=marketSemanticWire(canonical);assert.ok(wire.inputSchema);assert.ok(wire.responseSchema);
    const inputSchema=z.toJSONSchema(wire.inputSchema),format=createStructuredResponseFormat(wire.responseSchema,'MarketShapeSynthesisOutput@1.0.0',wire.responseSchemaDefinitions);
    assert.equal(format.format.strict,true);assert.equal(format.format.type,'json_schema');
    if(formats.has(synthesis.mode)){
      assert.deepEqual(format,formats.get(synthesis.mode));assert.deepEqual(inputSchema,inputSchemas.get(synthesis.mode));
    }else{formats.set(synthesis.mode,format);inputSchemas.set(synthesis.mode,inputSchema);}
    assert.deepEqual(wire.inputSchema.parse(wire.input),wire.input);
    const raw={schemaVersion:canonical.schemaVersion,task:canonical.task,batchId:canonical.batchId,inputDigest:canonical.inputDigest,result:response(createMarketShapeSynthesisModelWire(synthesis))};
    assert.deepEqual(wire.responseSchema.parse(raw),raw);
    const decoded=MarketShapeSynthesisOutputSchema.parse(wire.decode(raw));assert.deepEqual(wire.decode(structuredClone(raw)),decoded);
    assert.equal(decoded.task,'market-shape-synthesis');
    if(decoded.task!=='market-shape-synthesis')throw new Error('Unexpected decoded task');
    if(synthesis.mode==='dimension-reduce')validateMarketShapeDimensionSynthesisOutput(catalog,synthesis,decoded.result);
    else validateMarketShapeFinalSynthesisOutput(catalog,synthesis,decoded.result);
  }
});
