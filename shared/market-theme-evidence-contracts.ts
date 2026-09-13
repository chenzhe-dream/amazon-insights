import { z } from 'zod';
import { MarketModuleIdSchema, MarketThemeReportEntrySchema } from './market-module-contracts';
import { MarketThemeDecisionSchema } from './market-theme-detail-contracts';
export const MarketThemeEvidenceQuerySchema=z.object({sourceThemeId:z.string().min(1).max(512)}).strict();
const text=z.string().max(1000000),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const MarketThemeEvidenceSchema=z.object({sourceThemeId:z.string().min(1).max(512),asin:z.string().regex(/^[A-Z0-9]{10}$/),sourceRecordId:z.string().min(1).max(512),sourceUpdatedAt:z.string().nullable(),
  keyword:text,content:text,sourceKind:z.literal('customers-say-summary'),decision:MarketThemeDecisionSchema,
  analysis:z.object({agentRunId:MarketModuleIdSchema,modelAttemptId:MarketModuleIdSchema,bindingId:MarketModuleIdSchema,batchId:MarketModuleIdSchema,
    outputDigest:hash,executionFingerprint:hash,labelZh:z.string().max(60).nullable(),explanationZh:z.string().max(240).nullable(),
    status:z.enum(['mapped','unknown']),reason:z.string().max(240).nullable(),
    evidence:z.array(z.object({field:z.enum(['keyword','content']),refId:z.string().max(160),sourceRef:z.string().max(160),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),quote:z.string().min(1).max(512)}).strict()).max(8)}).strict().nullable()
}).strict();
export const MarketThemeEvidenceResponseSchema=z.object({report:MarketThemeReportEntrySchema,evidence:MarketThemeEvidenceSchema}).strict();
