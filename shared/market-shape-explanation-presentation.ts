import { z } from 'zod';
import {
  MARKET_SHAPE_EXPLANATION_DIMENSIONS,
  MarketShapeExplanationDimensionSchema,
  MarketShapeExplanationLimitationSchema,
  MarketShapeExplanationRowSchema,
} from './market-shape-explanation-contracts';

/** Text and original evidence resolved by the server from an authorized catalog.
 * This is a display contract, not independent authorization of the evidence. */
export const MarketShapeExplanationPresentedStatementSchema = z.object({
  kind: z.enum(['observed', 'inferred', 'risk', 'verification']),
  text: z.string().min(1),
  evidenceRows: z.array(MarketShapeExplanationRowSchema),
  limitations: z.array(MarketShapeExplanationLimitationSchema),
}).strict();
const statement = MarketShapeExplanationPresentedStatementSchema;
export const MarketShapeExplanationPresentationSchema = z.object({
  revisionId: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
  explanationCatalogId: z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/),
  dimensions: z.array(z.object({
    dimension: MarketShapeExplanationDimensionSchema,
    status: z.enum(['explained', 'insufficient-evidence']),
    summary: statement,
    findings: z.array(statement).max(5),
    limitations: z.array(statement).min(1).max(5),
    verification: z.array(statement).min(1).max(3),
  }).strict()).length(6),
  synthesis: z.object({
    decision: z.enum(['insufficient-evidence', 'exploratory-opportunity', 'competitive-risk', 'mixed-signals']),
    summary: statement,
    limitations: z.array(statement).min(1).max(5),
    verification: z.array(statement).min(1).max(3),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.dimensions.map(d => d.dimension)).size !== MARKET_SHAPE_EXPLANATION_DIMENSIONS.length)
    context.addIssue({code:'custom',path:['dimensions'],message:'Presentation must contain all six distinct dimensions'});
  for (const [index, section] of value.dimensions.entries()) {
    if (section.status === 'insufficient-evidence' && (section.summary.kind !== 'risk' || section.findings.length))
      context.addIssue({code:'custom',path:['dimensions',index],message:'Insufficient evidence cannot present successful findings'});
    if (section.status === 'explained' && !section.findings.length)
      context.addIssue({code:'custom',path:['dimensions',index],message:'Explained dimension requires findings'});
    if (section.findings.some(s => s.kind !== 'observed' && s.kind !== 'inferred'))
      context.addIssue({code:'custom',path:['dimensions',index,'findings'],message:'Findings must distinguish observation and inference'});
  }
  for (const section of [...value.dimensions, value.synthesis]) {
    if (section.limitations.some(s => s.kind !== 'risk') || section.verification.some(s => s.kind !== 'verification'))
      context.addIssue({code:'custom',message:'Statement role differs from its section'});
  }
  if (value.synthesis.summary.kind !== (value.synthesis.decision === 'insufficient-evidence' ? 'risk' : 'inferred'))
    context.addIssue({code:'custom',path:['synthesis','summary'],message:'Synthesis role differs from its decision'});
});

export type MarketShapeExplanationPresentedStatement = z.infer<typeof statement>;
export type MarketShapeExplanationPresentation = z.infer<typeof MarketShapeExplanationPresentationSchema>;
