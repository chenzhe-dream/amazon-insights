import { z } from 'zod';
const identity = z.string().min(1).max(240).refine(s => s.trim() === s, 'Identity must not have surrounding whitespace');
const label = z.object({ labelId: identity, label: z.string().trim().min(1).max(240), definition: z.string().trim().min(1).max(4000) }).strict();
const cluster = z.object({ clusterId: identity, label: z.string().trim().min(1).max(240), definition: z.string().trim().min(1).max(4000) }).strict();
const choices = z.array(identity).max(3).refine(a => new Set(a).size === a.length, 'Duplicate label assignment');
export const MarketKeywordRevisionClassificationSchema = z.object({
  labels: z.object({ W1: z.array(label).max(48), W2: z.array(label).max(48), W3: z.array(label).max(48), W4: z.array(label).max(48) }).strict(),
  clusters: z.array(cluster).max(2000),
  assignments: z.array(z.object({ keywordId: identity, W1: choices, W2: choices, W3: choices, W4: choices, clusterId: identity.nullable() }).strict()).max(2000),
}).strict();

export type MarketKeywordClassification = z.infer<typeof MarketKeywordRevisionClassificationSchema>;
