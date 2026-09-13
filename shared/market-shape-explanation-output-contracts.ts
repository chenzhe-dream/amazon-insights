import { z } from 'zod';

import { MARKET_SHAPE_EXPLANATION_DIMENSIONS } from './market-shape-explanation-contracts';
export const SHAPE_EXPLANATION_DIMENSIONS = MARKET_SHAPE_EXPLANATION_DIMENSIONS;
const id = z.string().min(1).max(240);
const ids = z.array(id).max(128);
// This blocks literal numeric output. Semantic number words and causal claims
// still require the independent G09 evaluation, not a regular expression.
const prose = z.string().trim().min(1).max(400).regex(/^[^\p{Number}%％$€£¥￥]+$/u);
export const MarketShapeExplanationStatementSchema = z.object({
  kind: z.enum(['observed', 'inferred', 'risk', 'verification']),
  parts: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: prose }).strict(),
    z.object({ kind: z.literal('cell'), rowId: id, cellId: id }).strict(),
    z.object({ kind: z.literal('context'), rowId: id, key: id }).strict(),
  ])).min(1).max(24),
  evidenceRowIds: ids,
  limitationCodes: ids,
}).strict();
const statements = z.array(MarketShapeExplanationStatementSchema);
export const MarketShapeExplanationOutputSchema = z.object({
  version: z.literal('market-shape-explanation-output/v1'),
  explanationCatalogId: z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/),
  revisionId: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
  dimensions: z.array(z.object({
    dimension: z.enum(SHAPE_EXPLANATION_DIMENSIONS),
    status: z.enum(['explained', 'insufficient-evidence']),
    summary: MarketShapeExplanationStatementSchema,
    findings: statements.max(5),
    limitations: statements.min(1).max(5),
    verification: statements.min(1).max(3),
  }).strict()).length(6),
  synthesis: z.object({
    decision: z.enum(['insufficient-evidence', 'exploratory-opportunity', 'competitive-risk', 'mixed-signals']),
    summary: MarketShapeExplanationStatementSchema,
    limitations: statements.min(1).max(5),
    verification: statements.min(1).max(3),
  }).strict(),
}).strict();
export type MarketShapeExplanationOutput = z.infer<typeof MarketShapeExplanationOutputSchema>;
export type MarketShapeExplanationStatement = z.infer<typeof MarketShapeExplanationStatementSchema>;
