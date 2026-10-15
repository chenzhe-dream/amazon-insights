import {z} from 'zod';
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
export const ConclusionBasisSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('reviews'),runId:uuid,attemptId:uuid,revisionId:z.string().regex(/^market-theme-selection-revision:[a-f0-9]{64}$/).nullable()}).strict(),
 z.object({kind:z.literal('linked'),batchId:uuid}).strict(),
]);
export type ConclusionBasis=z.infer<typeof ConclusionBasisSchema>;
export const ConclusionScopeSchema=z.object({marketplace:z.string().min(2).max(8),nodeIdPath:z.string().regex(/^\d+(?::\d+)*$/),fromMonth:z.string().regex(/^20\d{2}-\d{2}$/),toMonth:z.string().regex(/^20\d{2}-\d{2}$/)}).strict();
export const ConclusionModuleSchema=z.enum(['overview','shapes','keywords','themes']);
export const ConclusionEvidenceSchema=z.object({module:ConclusionModuleSchema,runId:uuid.nullable(),identity:z.string().max(250).nullable(),scope:ConclusionScopeSchema.nullable(),status:z.enum(['ready','partial','missing','mismatch']),facts:z.array(z.string()).max(100),findings:z.array(z.string()).max(100),gaps:z.array(z.string()).max(200),refs:z.array(z.string()).max(300)}).strict();
export type ConclusionEvidence=z.infer<typeof ConclusionEvidenceSchema>;
export const DevelopmentConclusionSchema=z.object({version:z.literal('market-development/20261015.1'),kind:z.enum(['reviews','linked']),scope:ConclusionScopeSchema,status:z.enum(['partial','no-data','evidence-ready']),headline:z.string(),evidence:z.array(ConclusionEvidenceSchema).max(4),
 sections:z.array(z.object({title:z.string(),status:z.enum(['observed','candidate','pending']),text:z.string(),refs:z.array(z.string()).max(300)}).strict()).max(30),
 actions:z.array(z.object({priority:z.enum(['P0','P1','P2']),action:z.string(),validation:z.string(),refs:z.array(z.string()).max(300)}).strict()).max(30),gaps:z.array(z.string()).max(220)}).strict();
export type DevelopmentConclusion=z.infer<typeof DevelopmentConclusionSchema>;
export const ConclusionResponseSchema=z.object({basis:ConclusionBasisSchema,contentHash:hash,conclusion:DevelopmentConclusionSchema,savedAt:z.string().datetime().nullable(),history:z.array(z.object({contentHash:hash,savedAt:z.string().datetime()}).strict()).max(100)}).strict();
export type ConclusionResponse=z.infer<typeof ConclusionResponseSchema>;
export const ConclusionQuerySchema=z.object({basis:z.string().min(1).max(2000),snapshot:hash.optional()}).strict();
export const ConclusionSaveSchema=z.object({basis:ConclusionBasisSchema,expectedHash:hash}).strict();
