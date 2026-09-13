import {createMarketOverviewSynthesisModelWire,MarketOverviewSynthesisModelInputSchema} from './market-overview-synthesis-wire';
import {MarketOverviewSynthesisInputSchema,MarketOverviewSynthesisOutputSchema} from '../../shared/market-semantic-contracts';
import {z} from 'zod';
import {MarketShapeSynthesisInputSchema,MarketShapeSynthesisOutputSchema,MarketKeywordSemanticsLegacyInputSchema,MarketKeywordSemanticsDiscoveryInputSchema,MarketKeywordSemanticsReconciliationInputSchema,MarketKeywordSemanticsInputSchema,type MarketSemanticInput} from '../../shared/market-semantic-contracts';
import {marketOverviewWire} from './market-overview-wire';
import {createMarketShapeSynthesisModelWire,MarketShapeSynthesisModelSchemaDefinitions,MarketShapeSynthesisModelInputSchema} from './market-shape-synthesis-wire';

// Storage lineage stays in the immutable canonical binding. It is not semantic
// evidence for the model; the inner node retains the complete evidence graph.
export const MarketShapeSynthesisTransportInputSchema=MarketShapeSynthesisInputSchema.omit({scopeDigest:true,contentSnapshotId:true,selectionRevision:true,batchKey:true,sourceRefs:true}).extend({synthesis:MarketShapeSynthesisModelInputSchema.omit({version:true,encoding:true})});

export const MarketOverviewSynthesisTransportInputSchema=MarketOverviewSynthesisInputSchema.omit({scopeDigest:true,contentSnapshotId:true,selectionRevision:true,batchKey:true,sourceRefs:true}).extend({scope:MarketOverviewSynthesisInputSchema.shape.scope.omit({researchId:true}),synthesis:MarketOverviewSynthesisModelInputSchema.omit({encoding:true})});

/** One transport projection for both budget metering and provider execution.
 * responseSchema describes aliases; the normal output schema validates decoded data. */
export function marketSemanticWire(input:MarketSemanticInput){
 if(input.task==='market-overview-synthesis'){
  const wire=createMarketOverviewSynthesisModelWire(input.synthesis),inputSchema=MarketOverviewSynthesisTransportInputSchema;
  const responseSchema=MarketOverviewSynthesisOutputSchema.extend({result:wire.outputSchema});
  const {scopeDigest:_scopeDigest,contentSnapshotId:_snapshot,selectionRevision:_revision,batchKey:_batchKey,sourceRefs:_sources,...modelInput}=input;
  const {encoding:_encoding,...graph}=wire.input;
  const {researchId:_researchId,...scope}=modelInput.scope;
  return {input:{...modelInput,scope,synthesis:graph},inputSchema,responseSchema,responseSchemaDefinitions:wire.schemaDefinitions,encoding:'overview-synthesis-envelope/v1',variant:input.synthesis.mode,
   decode:(value:unknown)=>{const parsed=responseSchema.parse(value);return {...parsed,result:wire.decode(parsed.result)};}};
 }

 if(input.task==='market-keyword-semantics')return {...marketOverviewWire(input),inputSchema:input.outputProtocol==='explicit-shape/v1'?MarketKeywordSemanticsInputSchema:input.reconciliationDimension!==undefined?MarketKeywordSemanticsReconciliationInputSchema:input.discoveryMode==='labels-and-clusters/v1'?MarketKeywordSemanticsDiscoveryInputSchema:MarketKeywordSemanticsLegacyInputSchema,responseSchema:undefined as z.ZodType<unknown>|undefined,variant:input.reconciliationDimension??input.discoveryMode??'default',responseSchemaDefinitions:undefined as Readonly<Record<string,z.ZodType>>|undefined};
 if(input.task!=='market-shape-synthesis')return {...marketOverviewWire(input),responseSchema:undefined as z.ZodType<unknown>|undefined,variant:'default',responseSchemaDefinitions:undefined as Readonly<Record<string,z.ZodType>>|undefined};
 const wire=createMarketShapeSynthesisModelWire(input.synthesis);
 const inputSchema=MarketShapeSynthesisTransportInputSchema;
 const responseSchema=MarketShapeSynthesisOutputSchema.extend({result:wire.outputSchema});
 const {scopeDigest:_scopeDigest,contentSnapshotId:_snapshot,selectionRevision:_revision,batchKey:_batchKey,sourceRefs:_sources,...modelInput}=input;
 const {version:_innerVersion,encoding:_innerEncoding,...graph}=wire.input;
 return {input:{...modelInput,synthesis:graph},inputSchema,responseSchema,responseSchemaDefinitions:MarketShapeSynthesisModelSchemaDefinitions,encoding:'shape-synthesis-envelope/v2',variant:input.synthesis.mode,
  decode:(value:unknown)=>{const parsed=responseSchema.parse(value);return {...parsed,result:wire.decode(parsed.result)};}};
}
