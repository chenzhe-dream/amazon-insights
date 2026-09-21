import { z } from 'zod';
import * as schemas from '../../shared/market-semantic-contracts';
import type { ModelExecutionConfig } from '../runtime/skill-runner';
import type { SkillRegistry } from './registry';
import {MarketOverviewAnalysisStatementSchema,MarketOverviewAnalysisSchema} from '../../shared/market-overview-analysis-contracts';
import {MarketShapeExplanationStatementSchema} from '../../shared/market-shape-explanation-output-contracts';

// Shared wire definitions preserve the original Zod validators and member limits.
const evidenceDefinitions = Object.freeze({
  TextSpan: schemas.MarketTextSpanRefSchema,
  UnknownDecision: schemas.MarketSemanticUnknownSchema,
});
export const marketSemanticSchemaDefinitions = Object.freeze({
  'market-overview-explanation': Object.freeze({
    AnalysisStatement: MarketOverviewAnalysisStatementSchema,
    Id: schemas.MarketOverviewExplanationOutputSchema.shape.risks.element.shape.optionId,
    FactIds: schemas.MarketOverviewExplanationOutputSchema.shape.risks.element.shape.factIds,
    GapIds: schemas.MarketOverviewExplanationOutputSchema.shape.risks.element.shape.gapIds,
    EvidenceRefs: schemas.MarketOverviewExplanationOutputSchema.shape.risks.element.shape.evidenceRefs,
  }),
  'market-product-shape-suggestion': evidenceDefinitions,
  'market-keyword-semantics': Object.freeze({ ...evidenceDefinitions, DimensionDecision: schemas.MarketDimensionDecisionSchema }),
  'market-customer-theme-mapping': evidenceDefinitions,
  'market-shape-structure-explanation':Object.freeze({ShapeExplanationStatement:MarketShapeExplanationStatementSchema}),
  'market-shape-synthesis':Object.freeze({ShapeExplanationStatement:MarketShapeExplanationStatementSchema}),
  'market-overview-synthesis':Object.freeze({}),
});

export const marketSemanticContracts = Object.freeze({
  'market-overview-explanation': Object.freeze({input:schemas.MarketOverviewExplanationInputSchema,output:schemas.MarketOverviewExplanationOutputSchema}),
  'market-product-shape-suggestion': Object.freeze({input:schemas.MarketShapeSuggestionInputSchema,output:schemas.MarketShapeSuggestionOutputSchema}),
  'market-keyword-semantics': Object.freeze({input:schemas.MarketKeywordSemanticsInputSchema,output:schemas.MarketKeywordSemanticsLegacyOutputSchema}),
  'market-customer-theme-mapping': Object.freeze({input:schemas.MarketCustomerThemeMappingInputSchema,output:schemas.MarketCustomerThemeMappingOutputSchema}),
  'market-shape-structure-explanation':Object.freeze({input:schemas.MarketShapeStructureExplanationInputSchema,output:schemas.MarketShapeStructureExplanationOutputSchema}),
  'market-shape-synthesis':Object.freeze({input:schemas.MarketShapeSynthesisInputSchema,output:schemas.MarketShapeSynthesisOutputSchema}),
  'market-overview-synthesis':Object.freeze({input:schemas.MarketOverviewSynthesisInputSchema,output:schemas.MarketOverviewSynthesisOutputSchema}),
});

const legacyOverviewOutput=schemas.MarketOverviewExplanationOutputSchema.omit({analysis:true});
export const marketKeywordDiscoverySchemaDefinitions=Object.freeze({
 ...marketSemanticSchemaDefinitions['market-keyword-semantics'],
 Id:schemas.MarketKeywordLabelProposalSchema.shape.labelId,
 Label:schemas.MarketKeywordLabelProposalSchema.shape.label,
 Definition:schemas.MarketKeywordLabelProposalSchema.shape.definition,
});
// The complete catalog supplies no legacy options; all findings are expressed
// by analysis. Empty arrays retain the saved output shape without transmitting
// the unused legacy finding/risk/action item definitions on every request.
// max(0) makes [] the only valid value; a null item schema is strict-output
// compatible, unlike Zod tuple form. The narrowed output type reflects that bound.
const emptyOverviewSlot=z.array(z.null()).max(0) as unknown as z.ZodType<[]>;
export const marketKeywordReconciliationOutputSchema=schemas.MarketKeywordSemanticsLegacyOutputSchema.extend({proposals:emptyOverviewSlot,synonymRelations:emptyOverviewSlot});
const compactOverviewOutput=schemas.MarketOverviewExplanationOutputSchema.extend({findings:emptyOverviewSlot,risks:emptyOverviewSlot,validationTasks:emptyOverviewSlot,analysis:MarketOverviewAnalysisSchema});
const compactOverviewDefinitions=Object.freeze({AnalysisStatement:MarketOverviewAnalysisStatementSchema});
const {AnalysisStatement:_analysisStatement,...legacyOverviewDefinitions}=marketSemanticSchemaDefinitions['market-overview-explanation'];
export const marketOverviewOutputVariants=Object.freeze([
  Object.freeze({name:'legacy',schema:legacyOverviewOutput,definitions:legacyOverviewDefinitions}),
  Object.freeze({name:'local-identifiers/v1',schema:compactOverviewOutput,definitions:compactOverviewDefinitions}),
]);
/** Keep the unused prose schema out of legacy requests; admission measures the
 * exact selected contract, never an artificially reduced numeric input. */
export function marketSemanticOutputContract(input:schemas.MarketSemanticInput){
  if(input.task==='market-keyword-semantics'&&input.reconciliationDimension!==undefined)return {output:marketKeywordReconciliationOutputSchema,schemaDefinitions:marketKeywordDiscoverySchemaDefinitions};
  if(input.task==='market-keyword-semantics')return input.discoveryMode==='labels-and-clusters/v1'?{output:schemas.MarketKeywordSemanticsDiscoveryOutputSchema,schemaDefinitions:marketKeywordDiscoverySchemaDefinitions}:{output:schemas.MarketKeywordSemanticsLegacyOutputSchema,schemaDefinitions:marketSemanticSchemaDefinitions[input.task]};
  if(input.task==='market-overview-explanation'&&input.analysisBrief?.referenceEncoding!==undefined)return {output:compactOverviewOutput,schemaDefinitions:compactOverviewDefinitions};
  return input.task==='market-overview-explanation'&&!input.analysisBrief
    ?{output:legacyOverviewOutput,schemaDefinitions:legacyOverviewDefinitions}
    :{output:marketSemanticContracts[input.task].output,schemaDefinitions:marketSemanticSchemaDefinitions[input.task]};
}

/** Native tasks do not change the legacy StageName dependency graph. */
export const marketSemanticTaskDefinitions = Object.freeze([
  {id:'market-overview-explanation',skill:{id:'market-explain-overview',version:'1.2.0'},inputSchema:'MarketOverviewExplanationInput@1.2.0',outputSchema:'MarketOverviewExplanationOutput@1.1.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:600000},
  {id:'market-product-shape-suggestion',skill:{id:'market-suggest-product-shape',version:'1.0.0'},inputSchema:'MarketShapeSuggestionInput@1.0.0',outputSchema:'MarketShapeSuggestionOutput@1.0.0',budget:{maxInputTokens:8000,maxOutputTokens:4000,timeoutMs:120000},batchTimeoutMs:250000,stageTimeoutMs:2700000},
  {id:'market-keyword-semantics',skill:{id:'market-classify-keyword-demand',version:'1.0.0'},inputSchema:'MarketKeywordSemanticsInput@1.0.0',outputSchema:'MarketKeywordSemanticsOutput@1.0.0',budget:{maxInputTokens:10000,maxOutputTokens:4000,timeoutMs:90000},batchTimeoutMs:370000,stageTimeoutMs:3600000},
  {id:'market-customer-theme-mapping',skill:{id:'market-map-customer-themes',version:'1.1.0'},inputSchema:'MarketCustomerThemeMappingInput@1.1.0',outputSchema:'MarketCustomerThemeMappingOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:120000},batchTimeoutMs:250000,stageTimeoutMs:7200000},
  {id:'market-shape-structure-explanation',skill:{id:'market-explain-shape-structure',version:'1.0.0'},inputSchema:'MarketShapeStructureExplanationInput@1.0.0',outputSchema:'MarketShapeStructureExplanationOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:2700000},
  {id:'market-shape-synthesis',skill:{id:'market-synthesize-shape-structure',version:'1.0.0'},inputSchema:'MarketShapeSynthesisInput@1.0.0',outputSchema:'MarketShapeSynthesisOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:2700000},
  {id:'market-overview-synthesis',skill:{id:'market-synthesize-overview',version:'1.0.0'},inputSchema:'MarketOverviewSynthesisInput@1.0.0',outputSchema:'MarketOverviewSynthesisOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:600000},
] as const);
for(const d of marketSemanticTaskDefinitions){Object.freeze(d.skill);Object.freeze(d.budget);Object.freeze(d);}
export type MarketSemanticTaskDefinition = typeof marketSemanticTaskDefinitions[number];

// Keep prior request instruction size stable; table guidance is only needed by
// table requests. Both immutable skill versions enter runtime configuration identity.
export const marketOverviewLegacySkill=Object.freeze({id:'market-explain-overview',version:'1.1.0'});
export const marketKeywordDiscoverySkill=Object.freeze({id:'market-classify-keyword-demand',version:'1.1.0'});
export const marketKeywordReconciliationSkill=Object.freeze({id:'market-classify-keyword-demand',version:'1.2.0'});
export const marketKeywordExplicitDiscoverySkill=Object.freeze({id:'market-classify-keyword-demand',version:'1.3.0'});
export const marketKeywordExplicitReconciliationSkill=Object.freeze({id:'market-classify-keyword-demand',version:'1.4.0'});
export function marketSemanticExecutionDefinition(input:schemas.MarketSemanticInput){
 const definition=marketSemanticTaskDefinitions.find(d=>d.id===input.task)!;
 if(input.task==='market-keyword-semantics'&&input.outputProtocol==='explicit-shape/v1'){
  if(input.reconciliationDimension!==undefined)return {...definition,skill:marketKeywordExplicitReconciliationSkill,inputSchema:'MarketKeywordSemanticsInput@1.4.0',outputSchema:'MarketKeywordSemanticsOutput@1.4.0'};
  if(input.discoveryMode==='labels-and-clusters/v1')return {...definition,skill:marketKeywordExplicitDiscoverySkill,inputSchema:'MarketKeywordSemanticsInput@1.3.0',outputSchema:'MarketKeywordSemanticsOutput@1.3.0'};
  throw new TypeError('Explicit keyword output protocol requires discovery or reconciliation');
 }
 if(input.task==='market-keyword-semantics'&&input.reconciliationDimension!==undefined)return {...definition,skill:marketKeywordReconciliationSkill,inputSchema:'MarketKeywordSemanticsInput@1.2.0',outputSchema:'MarketKeywordSemanticsOutput@1.2.0'};
 if(input.task==='market-keyword-semantics'&&input.discoveryMode==='labels-and-clusters/v1')return {...definition,skill:marketKeywordDiscoverySkill,inputSchema:'MarketKeywordSemanticsInput@1.1.0',outputSchema:'MarketKeywordSemanticsOutput@1.1.0'};
 return input.task==='market-overview-explanation'&&input.analysisBrief?.referenceEncoding!=='metric-table/v1'
  ?{...definition,skill:marketOverviewLegacySkill,inputSchema:'MarketOverviewExplanationInput@1.1.0'}:definition;
}


export async function validateMarketSemanticTaskDefinitions(input:unknown,registry:SkillRegistry){
  const list=z.array(z.unknown()).length(7).parse(input);
  // This validates the versioned server contract, not a caller-adjustable workflow or limit object.
  const expected=new Map<string,MarketSemanticTaskDefinition>(marketSemanticTaskDefinitions.map(d=>[d.id,d]));
  const seen=new Set<string>();
  for(const raw of list){
    const id=schemas.MarketSemanticTaskNameSchema.parse((raw as {id?:unknown})?.id);if(seen.has(id))throw new TypeError('Duplicate market task');seen.add(id);
    const definition=expected.get(id)!;
    const actual=z.object({id:z.literal(definition.id),skill:z.object({id:z.literal(definition.skill.id),version:z.literal(definition.skill.version)}).strict(),inputSchema:z.literal(definition.inputSchema),outputSchema:z.literal(definition.outputSchema),budget:z.object({maxInputTokens:z.literal(definition.budget.maxInputTokens),maxOutputTokens:z.literal(definition.budget.maxOutputTokens),timeoutMs:z.literal(definition.budget.timeoutMs)}).strict(),batchTimeoutMs:z.literal(definition.batchTimeoutMs),stageTimeoutMs:z.literal(definition.stageTimeoutMs)}).strict().parse(raw);
    const loaded=await registry.load(actual.skill.id,actual.skill.version);
    if(loaded.manifest.inputSchema!==actual.inputSchema||loaded.manifest.outputSchema!==actual.outputSchema)throw new TypeError('Market task manifest schema mismatch');
  }
  return marketSemanticTaskDefinitions;
}

export function assertMarketSemanticModelLimits(task:schemas.MarketSemanticTaskName,model:ModelExecutionConfig){
  const id=schemas.MarketSemanticTaskNameSchema.parse(task),definition=marketSemanticTaskDefinitions.find(d=>d.id===id)!;
  z.object({name:z.string().trim().min(1),estimatedInputTokens:z.number().int().min(1).max(definition.budget.maxInputTokens),maxOutputTokens:z.number().int().min(1).max(definition.budget.maxOutputTokens),timeoutMs:z.number().int().min(1).max(definition.budget.timeoutMs),pricing:z.object({inputUsdPerMillionTokens:z.number().min(0),outputUsdPerMillionTokens:z.number().min(0)}).strict()}).strict().parse(model);
}
