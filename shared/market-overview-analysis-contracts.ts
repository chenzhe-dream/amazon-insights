import {z} from 'zod';
const id=z.string().min(1).max(240),ids=z.array(id).max(32);
/** Model prose has no numeric literals. Numbers and source labels are rendered
 * only through identifiers from the frozen server catalog. Semantic grounding
 * still needs evaluation; structural validity alone does not prove truth. */
const prose=z.string().trim().min(1).max(280).regex(/^[^0-9０-９%％$€£¥￥]+$/);
export const MarketOverviewAnalysisBriefSchema=z.object({mode:z.enum(['dimension','synthesis']),scopeStatement:z.string().min(1).max(800),
  referenceEncoding:z.enum(['local-identifiers/v1','metric-table/v1']).optional(),
  dimensions:z.array(z.object({id,label:z.string().min(1).max(120),factIds:ids,gapIds:ids,
    coverage:z.object({totalFactCount:z.number().int().min(0).max(2000),totalGapCount:z.number().int().min(0).max(10000)}).strict().optional(),
  }).strict()).min(1).max(20),
  factLabels:z.array(z.object({factId:id,label:z.string().min(1).max(400)}).strict()).max(32),
}).strict();
export const MarketOverviewAnalysisStatementSchema=z.object({parts:z.array(z.discriminatedUnion('kind',[
  z.object({kind:z.literal('text'),text:prose}).strict(),z.object({kind:z.literal('metric'),metricId:id}).strict(),z.object({kind:z.literal('fact-label'),factId:id}).strict(),
])).min(1).max(10),factIds:ids,gapIds:ids}).strict();
const statement=MarketOverviewAnalysisStatementSchema;
export const MarketOverviewAnalysisSchema=z.object({dimensions:z.array(z.object({dimensionId:id,data:statement,meaning:statement,conclusion:statement,
  limitations:z.array(statement).max(3),verification:z.array(statement).min(1).max(3)}).strict()).min(1).max(20),
  summary:z.object({decision:z.enum(['insufficient-evidence','exploratory-opportunity','competitive-risk','mixed-signals']),statement}).strict(),
}).strict();
export type MarketOverviewAnalysis=z.infer<typeof MarketOverviewAnalysisSchema>;
export type MarketOverviewAnalysisBrief=z.infer<typeof MarketOverviewAnalysisBriefSchema>;
/** Persisted complete evidence is not a provider request. Native input limits
 * remain on MarketOverviewAnalysisBriefSchema and are enforced after partition. */
export const MarketOverviewCompleteBriefSchema=MarketOverviewAnalysisBriefSchema.extend({
  dimensions:z.array(MarketOverviewAnalysisBriefSchema.shape.dimensions.element.extend({factIds:z.array(id).max(2000),gapIds:z.array(id).max(10000)})).min(1).max(64),
  factLabels:z.array(MarketOverviewAnalysisBriefSchema.shape.factLabels.element).max(2000),
});
