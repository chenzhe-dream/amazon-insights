import {z} from 'zod';
import {MarketOverviewAnalysisStatementSchema} from './market-overview-analysis-contracts';

// Independent of market-semantic-contracts: that module embeds these contracts.
const id=z.string().min(1).max(240).regex(/\S/);
const ids=(max:number,min=0)=>z.array(id).min(min).max(max);
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const period=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('calendar-months'),fromMonth:month,toMonth:month}).strict(),
  z.object({kind:z.literal('trailing-days'),days:count.min(1),asOf:z.string().datetime()}).strict(),
  z.object({kind:z.literal('current'),asOf:z.string().datetime()}).strict(),
  z.object({kind:z.literal('unknown'),reason:z.string().min(1).max(500)}).strict(),
]);
const metric=z.object({metricId:id,state:z.literal('known'),value:z.number().finite(),
  unit:z.object({status:z.literal('known'),unit:z.enum(['count','ratio','percent','currency']),rawUnit:z.string().min(1).max(100),currency:z.string().regex(/^[A-Z]{3}$/).optional()}).strict(),period,
  sourceRefs:ids(2000,1),formulaVersion:id,numeratorRef:id.nullable(),denominatorRef:id.nullable(),
  coverage:z.object({status:z.enum(['complete','partial']),expectedCount:count,availableCount:count}).strict(),
}).strict();
const fact=z.object({factId:id,kind:z.enum(['value','comparison','share','trend']),metricRefs:ids(24,1),sourceRefs:ids(2000,1),statementTemplateId:id}).strict();
export const MarketOverviewSynthesisStatementSchema=MarketOverviewAnalysisStatementSchema.omit({gapIds:true}).extend({gapGroupIds:ids(128)}).strict();
export const MarketOverviewSynthesisDimensionSectionSchema=z.object({dimensionId:id,data:MarketOverviewSynthesisStatementSchema,meaning:MarketOverviewSynthesisStatementSchema,conclusion:MarketOverviewSynthesisStatementSchema,
  limitations:z.array(MarketOverviewSynthesisStatementSchema).max(3),verification:z.array(MarketOverviewSynthesisStatementSchema).min(1).max(3),}).strict();
export const MarketOverviewSynthesisChildSchema=z.object({childId:id,leafSectionIds:ids(4096,1),section:MarketOverviewSynthesisDimensionSectionSchema}).strict();
/** Compact provider meaning. Original IDs live in the recoverable basis registry. */
export const MarketOverviewGapGroupSchema=z.object({gapGroupId:id,dimensionId:id,
  reason:z.enum(['not-collected','collection-failed','field-absent','invalid-source','period-incompatible','unit-unknown']),
  sourceRefs:ids(2000),fieldKind:id,scopeKey:z.string().min(1).max(800),memberCount:count.min(1),}).strict();
export const MarketOverviewSynthesisInputSchema=z.object({version:z.literal('market-overview-synthesis-input/v1'),nodeId:id,inputDigest:z.string().regex(/^[a-f0-9]{64}$/),basisId:id,
  mode:z.enum(['dimension-reduce','final']),dimensionId:id,children:z.array(MarketOverviewSynthesisChildSchema).min(1).max(256),directChildIds:ids(256,1),leafSectionIds:ids(4096,1),
  evidenceFacts:z.array(fact).max(2000),metrics:z.array(metric).max(16000),labels:z.array(z.object({factId:id,label:z.string().min(1).max(400)}).strict()).max(2000),
  gapGroups:z.array(MarketOverviewGapGroupSchema).max(128),scopeStatement:z.string().min(1).max(800),}).strict();
export const MarketOverviewDimensionSynthesisOutputSchema=z.object({mode:z.literal('dimension-reduce'),dimensionSection:MarketOverviewSynthesisDimensionSectionSchema}).strict();
export const MarketOverviewFinalSynthesisOutputSchema=z.object({mode:z.literal('final'),summary:z.object({decision:z.enum(['insufficient-evidence','exploratory-opportunity','competitive-risk','mixed-signals']),statement:MarketOverviewSynthesisStatementSchema}).strict(),
  conflicts:z.array(MarketOverviewSynthesisStatementSchema).max(3),limitations:z.array(MarketOverviewSynthesisStatementSchema).max(3),verification:z.array(MarketOverviewSynthesisStatementSchema).min(1).max(3),}).strict();
export const MarketOverviewSynthesisOutputSchema=z.discriminatedUnion('mode',[MarketOverviewDimensionSynthesisOutputSchema,MarketOverviewFinalSynthesisOutputSchema]);
export type MarketOverviewSynthesisInput=z.infer<typeof MarketOverviewSynthesisInputSchema>;
export type MarketOverviewSynthesisChild=z.infer<typeof MarketOverviewSynthesisChildSchema>;
export type MarketOverviewGapGroup=z.infer<typeof MarketOverviewGapGroupSchema>;
export type MarketOverviewSynthesisStatement=z.infer<typeof MarketOverviewSynthesisStatementSchema>;
export type MarketOverviewSynthesisDimensionSection=z.infer<typeof MarketOverviewSynthesisDimensionSectionSchema>;
export type MarketOverviewDimensionSynthesisOutput=z.infer<typeof MarketOverviewDimensionSynthesisOutputSchema>;
export type MarketOverviewFinalSynthesisOutput=z.infer<typeof MarketOverviewFinalSynthesisOutputSchema>;
export type MarketOverviewSynthesisOutput=z.infer<typeof MarketOverviewSynthesisOutputSchema>;
