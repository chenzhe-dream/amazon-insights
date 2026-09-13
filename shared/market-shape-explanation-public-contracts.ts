import {z} from 'zod';
import {MarketModuleIdSchema, MarketModuleStepPublicSchema} from './market-module-contracts';
import {MarketShapeExplanationOutputSchema} from './market-shape-explanation-output-contracts';
import {MarketShapeExplanationPresentationSchema} from './market-shape-explanation-presentation';

export const MarketShapeExplanationSavedReportSchema=z.object({
 reportVersion:z.literal('market-shape-explanation-report/v1'),moduleRunId:MarketModuleIdSchema,
 revisionId:z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),explanationCatalogId:z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/),
 dataReady:z.literal(true),explanation:MarketShapeExplanationOutputSchema,
 provenance:z.object({inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/),modelAttemptId:MarketModuleIdSchema,roundAttemptId:MarketModuleIdSchema,windowAttemptId:MarketModuleIdSchema,agentRunId:MarketModuleIdSchema}).strict(),
}).strict();
export const MarketShapeExplanationRunResponseSchema=z.object({run:z.object({
 id:MarketModuleIdSchema,status:z.enum(['queued','running','partial','succeeded','failed','cancelled']),revisionId:z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
 progress:z.object({totalWindows:z.number().int().nonnegative(),completedWindows:z.number().int().nonnegative()}).strict(),
 report:MarketShapeExplanationSavedReportSchema.nullable(),presentation:MarketShapeExplanationPresentationSchema.nullable().optional(),steps:z.array(MarketModuleStepPublicSchema),
}).strict()}).strict();
