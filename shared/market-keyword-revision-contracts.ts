import { z } from 'zod';
import { MarketKeywordFactsSchema } from './market-keyword-public-contracts';
const identity = z.string().min(1).max(240).refine(s => s.trim() === s, 'Identity must not have surrounding whitespace');
const label = z.object({ labelId: identity, label: z.string().trim().min(1).max(240), definition: z.string().trim().min(1).max(4000) }).strict();
const cluster = z.object({ clusterId: identity, label: z.string().trim().min(1).max(240), definition: z.string().trim().min(1).max(4000) }).strict();
const choices = z.array(identity).max(3).refine(a => new Set(a).size === a.length, 'Duplicate label assignment');
export const MarketKeywordRevisionIdSchema = z.string().regex(/^market-keyword-revision:[a-f0-9]{64}$/);
export const MarketKeywordRevisionClassificationSchema = z.object({
  labels: z.object({ W1: z.array(label).max(48), W2: z.array(label).max(48), W3: z.array(label).max(48), W4: z.array(label).max(48) }).strict(),
  clusters: z.array(cluster).max(2000),
  assignments: z.array(z.object({ keywordId: identity, W1: choices, W2: choices, W3: choices, W4: choices, clusterId: identity.nullable() }).strict()).max(2000),
}).strict();
export const MarketKeywordRevisionRequestSchema = MarketKeywordRevisionClassificationSchema.extend({
  factsId: MarketKeywordFactsSchema.shape.factsId,
  expectedParentRevisionId: MarketKeywordRevisionIdSchema.nullable(), note: z.string().max(8000),
}).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), number = z.number().finite();
const volume = z.object({ memberIds: z.array(identity).max(2000), memberCount: count, totalSearchVolume: number.min(0).nullable(), knownSearchVolume: number.min(0), knownSearchVolumeCount: count, unknownSearchVolumeCount: count }).strict();
const metric = z.object({ value: number.nullable(), weightSum: number.min(0), weightedMemberCount: count, knownValueCount: count, unknownValueCount: count }).strict();
const summary = volume.extend({ clusterId: identity.nullable(), searchVolumeSharePercent: number.min(0).max(100).nullable(), searchVolumeShareDenominator: number.min(0).nullable(), cpc: metric, yoyGrowth: metric, recentGrowth: metric }).strict();
export const MarketKeywordRevisionCatalogSchema = z.object({
  version: z.literal('market-keyword-revision/v1'),
  revision: z.object({ revisionId: MarketKeywordRevisionIdSchema, parentRevisionId: MarketKeywordRevisionIdSchema.nullable(), authorId: z.string().uuid(), createdAt: z.string().datetime(), note: z.string().max(8000) }).strict(),
  facts: MarketKeywordFactsSchema,
  classification: MarketKeywordRevisionClassificationSchema,
  aggregation: z.object({ pool: volume, clusters: z.array(summary).max(2000), unassigned: summary }).strict(),
}).strict();
export type MarketKeywordRevisionRequest = z.infer<typeof MarketKeywordRevisionRequestSchema>;
export type MarketKeywordRevisionCatalog = z.infer<typeof MarketKeywordRevisionCatalogSchema>;
