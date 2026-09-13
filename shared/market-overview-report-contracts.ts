import {z} from 'zod';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema} from './market-analysis-contracts';
import {MarketSourceUnitSchema} from './market-source-contracts';
import {MarketOverviewExplanationOutputSchema,MarketSemanticRecordSchema} from './market-semantic-contracts';
import {MarketModuleIdSchema as uuid,MarketModuleStepPublicSchema,MarketThemeReportSchema} from './market-module-contracts';
import {MarketOverviewDistributionEntrySchema,MARKET_OVERVIEW_ALL_OPERATIONS} from './market-overview-distribution-contracts';
import {MarketOverviewFinalSynthesisOutputSchema,MarketOverviewSynthesisChildSchema,MarketOverviewGapGroupSchema} from './market-overview-reduction-contracts';
const id=z.string().min(1).max(240),hash=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative().safe(),month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const MarketOverviewStartRequestSchema=z.object({headTopN:z.union([z.literal(5),z.literal(10),z.literal(20)]).default(10),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)]).default(6)}).strict();
export const MarketOverviewLegacyReportSchema=z.object({reportVersion:z.literal('market-overview-report/v1'),moduleRunId:uuid,scope:MarketAnalysisScopeSchema,versions:MarketThemeReportSchema.shape.versions,
  task:z.literal('overview-report'),catalogAttemptId:uuid,phase:z.enum(['numeric','window-results']),windowAttemptId:uuid.nullable(),preparationAttemptIds:z.array(uuid).max(2000),modelAttemptIds:z.array(uuid).max(2000),
  numericInputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/),dataCutoffAt:z.string().datetime(),sourceRefs:z.array(id).max(2000),dataReady:z.boolean(),
  analysisStatus:z.enum(['partial','no-data']),windowStatus:z.enum(['pending','no-input','partial','complete']),expectedWindowCount:count,rejectedCount:count,
  modelResults:z.array(z.object({attemptId:uuid,bindingId:uuid,status:z.enum(['succeeded','failed','empty']),errorCode:id.nullable(),agentRunId:uuid.nullable(),output:MarketOverviewExplanationOutputSchema.nullable()}).strict()).max(2000),
  failures:z.array(z.object({attemptId:uuid,stage:z.enum(['planning','preparation']),errorCode:id}).strict()).max(2000),
  coverage:z.array(z.object({dimension:id,status:z.enum(['available','partial','missing','not-integrated']),availableMetrics:z.array(id),missingMetrics:z.array(id)}).strict()).max(50),
  reasons:z.array(id).max(50),reportHash:hash}).strict();
export const MarketOverviewSavedSynthesisSchema=z.object({status:z.literal('complete'),result:MarketOverviewFinalSynthesisOutputSchema,
  dimensionChildren:z.array(MarketOverviewSynthesisChildSchema).min(1).max(64),
  gapGroups:z.array(MarketOverviewGapGroupSchema.extend({originalGapIds:z.array(id).min(1).max(10000)}).strict()).max(10000),
  provenance:z.object({sourceReportAttemptId:uuid,sourceReportHash:hash,roundAttemptId:uuid,modelAttemptId:uuid,
    inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/),agentRunId:uuid,basisId:id}).strict(),
}).strict();
export const MarketOverviewSynthesisReportSchema=MarketOverviewLegacyReportSchema.extend({reportVersion:z.literal('market-overview-report/v2'),
  phase:z.literal('window-results'),windowAttemptId:uuid,windowStatus:z.literal('complete'),synthesis:MarketOverviewSavedSynthesisSchema}).strict();
export const MarketOverviewReportSchema=z.discriminatedUnion('reportVersion',[MarketOverviewLegacyReportSchema,MarketOverviewSynthesisReportSchema]);
export const MarketOverviewReportEntrySchema=z.object({attemptId:uuid,current:z.boolean(),report:MarketOverviewReportSchema}).strict();
export const MarketOverviewRunResponseSchema=z.object({run:z.object({id:uuid,scope:MarketAnalysisScopeSchema,status:z.enum(['queued','running','partial','succeeded','failed','cancelled']),createdAt:z.string().datetime(),planRevision:count,
  params:MarketOverviewStartRequestSchema,steps:z.array(MarketModuleStepPublicSchema.extend({source:z.object({month,operation:z.enum(MARKET_OVERVIEW_ALL_OPERATIONS)}).strict().optional()})),currentReport:MarketOverviewReportEntrySchema.nullable(),latestSavedReport:MarketOverviewReportEntrySchema.nullable(),history:z.array(MarketOverviewReportEntrySchema)}).strict()}).strict();
const reason=z.enum(['not-collected','collection-failed','field-absent','invalid-source','unit-unknown','period-incompatible']);
const metric=z.object({state:z.enum(['known','missing','conflict']),value:z.number().finite().nullable(),unit:MarketSourceUnitSchema.nullable(),reason:reason.nullable(),
  observations:z.array(z.object({sourceRef:id,field:id,raw:MarketInputRecordSchema.shape.data,value:z.number().finite().nullable(),unit:MarketSourceUnitSchema.nullable(),reason:reason.nullable(),scopeBasis:z.enum(['request-bound','response-verified']).optional()}).strict())}).strict();
export const MarketOverviewDetailsResponseSchema=z.object({entry:MarketOverviewReportEntrySchema,semantic:MarketSemanticRecordSchema.refine(s=>s.task==='market-overview-explanation').nullable(),numbers:z.object({months:z.array(z.object({month,metrics:z.record(id,metric),sourceRefs:z.array(id),
  failures:z.array(z.object({month,operation:z.enum(['market_research','market_research_statistics']),attemptId:uuid,code:id}).strict())}).strict()),trendGaps:z.array(z.object({metricId:id,reason:id}).strict()),distributions:z.array(MarketOverviewDistributionEntrySchema).max(2000).optional()}).strict()}).strict();
export type MarketOverviewRunResponse=z.infer<typeof MarketOverviewRunResponseSchema>;
