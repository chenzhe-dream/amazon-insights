import { z } from 'zod';
import { EntityIdSchema } from './agent-contracts';

/** Server-held identity. Never accepted from model output or included in prompts. */
export const MarketExecutionSubjectSchema = z.object({
  kind: z.literal('market-module-run'),
  organizationId: EntityIdSchema,
  studyId: EntityIdSchema,
  moduleRunId: EntityIdSchema,
  stepId: EntityIdSchema,
  attemptId: EntityIdSchema,
  leaseOwnerId: EntityIdSchema,
  leaseGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  dataCutoffAt: z.string().datetime(),
}).strict();

export const MarketModelExecutionAuthoritySchema = MarketExecutionSubjectSchema.extend({
  agentRunId: EntityIdSchema,
  claimToken: EntityIdSchema,
}).strict();

export type MarketExecutionSubject = z.infer<typeof MarketExecutionSubjectSchema>;
export type MarketModelExecutionAuthority = z.infer<typeof MarketModelExecutionAuthoritySchema>;
