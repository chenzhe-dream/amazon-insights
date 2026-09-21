import {MarketOverviewSynthesisInputSchema as OverviewSynthesisGraphInputSchema,MarketOverviewSynthesisOutputSchema as OverviewSynthesisGraphOutputSchema,type MarketOverviewSynthesisChild} from './market-overview-reduction-contracts';
import type {MarketOverviewSynthesisBasis} from './market-overview-synthesis-contracts';
import { z } from "zod";
import {MarketSiteSchema,MarketCurrencySchema,marketSiteCurrencyMatches} from './market-sites';
import {MarketOverviewAnalysisBriefSchema,MarketOverviewAnalysisSchema,MarketOverviewCompleteBriefSchema} from './market-overview-analysis-contracts';
import type { MarketAnalysisScope, MarketInputSnapshot } from "./market-analysis-contracts";
import type { MarketSourceEvidence } from "./market-source-contracts";
import { MarketShapeExplanationWindowSchema } from './market-shape-explanation-wire-contracts';
import { MarketShapeExplanationFragmentOutputSchema } from './market-shape-explanation-fragment-contracts';
import type { MarketShapeExplanationCatalog } from './market-shape-explanation-contracts';
import {MarketShapeSynthesisChildSchema,MarketShapeDimensionSynthesisInputSchema,MarketShapeFinalSynthesisInputSchema,MarketShapeDimensionSynthesisOutputSchema,MarketShapeFinalSynthesisOutputSchema,type MarketShapeSynthesisChild} from './market-shape-synthesis-contracts';

/** Static provider contracts. Source/scope/span relations are checked by the input-bound validators. */
const id = z.string().min(1).max(160).regex(/\S/);
const label = z.string().min(1).max(60).regex(/\S/);
const description = z.string().min(1).max(240).regex(/\S/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const timestamp = z.string().datetime();
const ids = (max: number, min = 0) => z.array(id).min(min).max(max);

export const MarketSemanticTaskNameSchema = z.enum([
  "market-overview-explanation", "market-product-shape-suggestion",
  "market-keyword-semantics", "market-customer-theme-mapping",
  "market-shape-structure-explanation", "market-shape-synthesis", "market-overview-synthesis",
]);
export type MarketSemanticTaskName = z.infer<typeof MarketSemanticTaskNameSchema>;
export const MarketSemanticMissingReasonSchema = z.enum([
  "not-collected", "collection-failed", "field-absent", "invalid-source", "period-incompatible", "unit-unknown",
]);
const available = <T extends z.ZodType>(value: T) => z.discriminatedUnion("state", [
  z.object({ state: z.literal("known"), value }).strict(),
  z.object({ state: z.literal("missing"), reason: MarketSemanticMissingReasonSchema }).strict(),
]);
export const MarketSemanticLabelSchema = z.object({ labelId: id, label, definition: description }).strict();
const sourceField = <T extends readonly [string, ...string[]]>(fields: T, max: number) => z.object({
  refId: id, sourceRef: id, recordId: id, field: z.enum(fields), text: z.string().min(1).max(max),
}).strict();
export const MarketShapeSourceFieldSchema = sourceField(["title", "parameter"], 4_000);
export const MarketKeywordSourceFieldSchema = sourceField(["keyword"], 2_000);
export const MarketThemeSourceFieldSchema = sourceField(["keyword", "content"], 8_000);
export const MarketTextSpanRefSchema = z.object({
  refId: id, start: count, end: count, quote: z.string().min(1).max(512).regex(/\S/),
}).strict();
export type MarketTextSpanRef = z.infer<typeof MarketTextSpanRefSchema>;
const spans = (min = 0) => z.array(MarketTextSpanRefSchema).min(min).max(8);
export const MarketSemanticUnknownSchema = z.object({
  status: z.literal("unknown"),
  reason: z.enum(["missing-source", "insufficient-evidence", "ambiguous", "contradictory", "outside-taxonomy"]),
  evidence: spans(),
}).strict();

const commonInput = {
  schemaVersion: z.literal("1.0.0"), task: MarketSemanticTaskNameSchema, batchId: uuid,
  inputDigest: hash, scopeDigest: hash,
  scope: z.object({ researchId: z.string().uuid(), marketplace: MarketSiteSchema,
    nodeIdPath: z.string().max(240).regex(/^\d+(?::\d+)*$/), fromMonth: month, toMonth: month,
    currency: MarketCurrencySchema }).strict().refine(marketSiteCurrencyMatches,'Market currency differs from marketplace'),
  contentSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/),
  selectionRevision: id, batchKey: id, dataCutoffAt: timestamp, sourceRefs: ids(2_000),
};
const commonOutput = {
  schemaVersion: z.literal("1.0.0"), task: MarketSemanticTaskNameSchema, batchId: uuid, inputDigest: hash,
};

// JSON-schema-safe representations of T4's known unit and observation period.
// T4's exported period includes transforms, so its runtime checks are applied by the validator.
const knownUnit = z.object({ status: z.literal("known"), unit: z.enum(["count", "ratio", "percent", "currency"]),
  rawUnit: z.string().min(1).max(100).regex(/\S/), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict();
const period = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calendar-months"), fromMonth: month, toMonth: month }).strict(),
  z.object({ kind: z.literal("trailing-days"), days: count.min(1), asOf: timestamp }).strict(),
  z.object({ kind: z.literal("current"), asOf: timestamp }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string().min(1).max(500).regex(/\S/) }).strict(),
]);
export const MarketOverviewMetricSchema = z.object({
  metricId: id, state: z.literal("known"), value: z.number().finite(), unit: knownUnit, period,
  sourceRefs: ids(2_000, 1), formulaVersion: id, numeratorRef: id.nullable(), denominatorRef: id.nullable(),
  coverage: z.object({ status: z.enum(["complete", "partial"]), expectedCount: count, availableCount: count }).strict(),
}).strict();
export const MarketOverviewFactSchema = z.object({
  factId: id, kind: z.enum(["value", "comparison", "share", "trend"]), metricRefs: ids(24, 1),
  sourceRefs: ids(2_000, 1), statementTemplateId: id,
}).strict();
const overviewFields = {
  analysisBrief: MarketOverviewAnalysisBriefSchema.optional(),
  metrics: z.array(MarketOverviewMetricSchema).max(24),
  gaps: z.array(z.object({ gapId: id, metricId: id.nullable(), reason: MarketSemanticMissingReasonSchema,
    sourceRefs: ids(2_000) }).strict()).max(32),
  facts: z.array(MarketOverviewFactSchema).min(1).max(32),
  interpretationOptions: z.array(z.object({ optionId: id, kind: z.enum(["inference", "risk"]), templateId: id,
    allowedFactIds: ids(32), allowedGapIds: ids(32), requiredFactIds: ids(32), requiredGapIds: ids(32) }).strict()).max(16),
  validationOptions: z.array(z.object({ actionId: id, templateId: id, allowedFactIds: ids(32), allowedGapIds: ids(32) }).strict()).max(16),
};
const overviewTask = z.literal("market-overview-explanation");
const requestOverviewFields={...overviewFields,metrics:z.array(MarketOverviewMetricSchema).max(128)};
const legacyOverviewLimit=(input:{metrics:unknown[];analysisBrief?:{referenceEncoding?:string}},ctx:z.RefinementCtx)=>{
  if(input.metrics.length>24&&input.analysisBrief?.referenceEncoding!=='metric-table/v1')ctx.addIssue({code:'custom',path:['metrics'],message:'Legacy overview requests support at most 24 metrics'});
};
export const MarketOverviewExplanationInputSchema = z.object({ ...commonInput, task: overviewTask, ...requestOverviewFields }).strict().superRefine(legacyOverviewLimit);
export const MarketOverviewRequestRecordSchema=z.object({task:overviewTask,...requestOverviewFields}).strict().superRefine(legacyOverviewLimit);
const overviewCompleteFields={...overviewFields,analysisBrief:MarketOverviewCompleteBriefSchema.optional(),
  metrics:z.array(MarketOverviewMetricSchema).max(16000),facts:z.array(MarketOverviewFactSchema).min(1).max(2000),
  gaps:z.array(overviewFields.gaps.element).max(10000)};
const factSelection = { factIds: ids(32), gapIds: ids(32), evidenceRefs: ids(2_000) };
export const MarketOverviewExplanationOutputSchema = z.object({ ...commonOutput, task: overviewTask,
  analysis: MarketOverviewAnalysisSchema.nullable().optional(),
  findings: z.array(z.discriminatedUnion("mode", [
    z.object({ findingId: id, mode: z.literal("observed"), factIds: ids(32, 1), evidenceRefs: ids(2_000, 1) }).strict(),
    z.object({ findingId: id, mode: z.literal("inferred"), optionId: id, ...factSelection }).strict(),
  ])).max(6),
  risks: z.array(z.object({ optionId: id, ...factSelection }).strict()).max(6),
  validationTasks: z.array(z.object({ actionId: id, ...factSelection }).strict()).max(6),
}).strict();

const shapeTask = z.literal("market-product-shape-suggestion");
export const MarketSemanticProductSchema = z.object({ productId: asin, asin,
  title: available(MarketShapeSourceFieldSchema), parameters: available(z.array(MarketShapeSourceFieldSchema).min(1).max(12)),
}).strict();
const shapeCatalog = { taxonomyVersion: id, allowedLabels: z.array(MarketSemanticLabelSchema).max(32) };
export const MarketShapeSuggestionInputSchema = z.object({ ...commonInput, task: shapeTask, ...shapeCatalog,
  products: z.array(MarketSemanticProductSchema).min(1).max(10) }).strict();
export const MarketShapeSuggestionOutputSchema = z.object({ ...commonOutput, task: shapeTask,
  products: z.array(z.object({ productId: asin, decision: z.discriminatedUnion("status", [
    MarketSemanticUnknownSchema,
    z.object({ status: z.literal("supported"), candidates: z.array(z.object({ labelId: id, evidence: spans(1) }).strict()).min(1).max(3),
      requiresManualConfirmation: z.literal(true) }).strict(),
  ]) }).strict()).min(1).max(10),
}).strict();

const keywordTask = z.literal("market-keyword-semantics");
export const MarketSemanticKeywordSchema = z.object({ keywordId: id, text: MarketKeywordSourceFieldSchema }).strict();
const legacyKeywordCatalog = { dictionaryVersion: id, categoryContext: description,
  dimensionLabels: z.object({ W1: z.array(MarketSemanticLabelSchema).max(48), W2: z.array(MarketSemanticLabelSchema).max(48),
    W3: z.array(MarketSemanticLabelSchema).max(48), W4: z.array(MarketSemanticLabelSchema).max(48) }).strict(),
  clusterCatalog: z.array(z.object({ clusterId: id, label, definition: description }).strict()).max(32),
};
const discoveryKeywordCatalog = { ...legacyKeywordCatalog, discoveryMode: z.literal('labels-and-clusters/v1').optional() };
const reconciliationKeywordCatalog = {...discoveryKeywordCatalog,reconciliationDimension:z.enum(['W1','W2','W3','W4','cluster']).optional()};
export const MarketKeywordSemanticsLegacyInputSchema = z.object({ ...commonInput, task: keywordTask, ...legacyKeywordCatalog,
  keywords: z.array(MarketSemanticKeywordSchema).min(1).max(20) }).strict();
export const MarketKeywordSemanticsDiscoveryInputSchema=z.object({...commonInput,task:keywordTask,...discoveryKeywordCatalog,
  keywords:z.array(MarketSemanticKeywordSchema).min(1).max(20)}).strict();
const keywordCatalog = {...reconciliationKeywordCatalog,outputProtocol:z.literal('explicit-shape/v1').optional()};
export const MarketKeywordSemanticsReconciliationInputSchema = z.object({ ...commonInput, task: keywordTask, ...reconciliationKeywordCatalog,
  keywords: z.array(MarketSemanticKeywordSchema).min(1).max(20) }).strict();
export const MarketKeywordSemanticsInputSchema = MarketKeywordSemanticsReconciliationInputSchema.extend({outputProtocol:keywordCatalog.outputProtocol});
export const MarketDimensionDecisionSchema = z.discriminatedUnion("status", [MarketSemanticUnknownSchema,
  z.object({ status: z.literal("supported"), labelIds: ids(3, 1), evidence: spans(1) }).strict()]);
const proposal = z.object({ proposalId: id, labelZh: label, definition: description, evidence: spans(1) }).strict();
const keywordOutputFields = {
  keywords: z.array(z.object({ keywordId: id, W1: MarketDimensionDecisionSchema, W2: MarketDimensionDecisionSchema, W3: MarketDimensionDecisionSchema, W4: MarketDimensionDecisionSchema,
    cluster: z.discriminatedUnion("status", [MarketSemanticUnknownSchema,
      z.object({ status: z.literal("existing"), clusterId: id, evidence: spans(1) }).strict(),
      z.object({ status: z.literal("proposed"), proposalId: id, evidence: spans(1) }).strict()]) }).strict()).min(1).max(20),
  proposals: z.array(proposal).max(8),
  synonymRelations: z.array(z.object({ leftKeywordId: id, rightKeywordId: id,
    relation: z.enum(["equivalent", "related"]), evidence: spans(1) }).strict()).max(12),
};
export const MarketKeywordLabelProposalSchema = z.object({
  dimension: z.enum(['W1', 'W2', 'W3', 'W4']), labelId: id, label, definition: description, evidence: spans(1),
}).strict();
export const MarketKeywordSemanticsLegacyOutputSchema = z.object({ ...commonOutput, task: keywordTask, ...keywordOutputFields }).strict();
export const MarketKeywordSemanticsOutputSchema = z.object({ ...commonOutput, task: keywordTask, ...keywordOutputFields,
  labelProposals: z.array(MarketKeywordLabelProposalSchema).max(32).optional(),
}).strict();
export const MarketKeywordSemanticsDiscoveryOutputSchema = z.object({ ...commonOutput, task: keywordTask, ...keywordOutputFields,
  labelProposals: z.array(MarketKeywordLabelProposalSchema).max(32),
}).strict();

const themeTask = z.literal("market-customer-theme-mapping");
export const MarketSemanticThemeSchema = z.object({ sourceThemeId: id, asin,
  keyword: available(MarketThemeSourceFieldSchema), content: available(MarketThemeSourceFieldSchema) }).strict();
const themeCatalog = { mappingVersion: id, selectedAsins: z.array(asin).min(1).max(20),
  mappingMode: z.literal("catalog-only").optional(),
  groupCatalog: z.array(z.object({ groupId: id, labelZh: label, definition: description }).strict()).max(32) };
export const MarketCustomerThemeMappingInputSchema = z.object({ ...commonInput, task: themeTask, ...themeCatalog,
  themes: z.array(MarketSemanticThemeSchema).min(1).max(12) }).strict();
export const MarketCustomerThemeMappingOutputSchema = z.object({ ...commonOutput, task: themeTask,
  themes: z.array(z.object({ sourceThemeId: id, decision: z.discriminatedUnion("status", [MarketSemanticUnknownSchema,
    z.object({ status: z.literal("mapped"), target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("existing"), groupId: id }).strict(),
      z.object({ kind: z.literal("proposed"), proposalId: id }).strict()]),
    labelZh: label, explanationZh: description, evidence: spans(1) }).strict()]) }).strict()).min(1).max(12),
  proposals: z.array(proposal).max(8),
}).strict();

const shapeExplanationTask=z.literal('market-shape-structure-explanation');
export const MarketShapeStructureExplanationInputSchema=z.object({...commonInput,task:shapeExplanationTask,window:MarketShapeExplanationWindowSchema}).strict();
export const MarketShapeStructureExplanationOutputSchema=z.object({...commonOutput,task:shapeExplanationTask,fragment:MarketShapeExplanationFragmentOutputSchema}).strict();
const shapeSynthesisTask=z.literal('market-shape-synthesis');
export const MarketShapeSynthesisInputSchema=z.object({...commonInput,task:shapeSynthesisTask,synthesis:z.discriminatedUnion('mode',[MarketShapeDimensionSynthesisInputSchema,MarketShapeFinalSynthesisInputSchema])}).strict();
export const MarketShapeSynthesisOutputSchema=z.object({...commonOutput,task:shapeSynthesisTask,result:z.union([MarketShapeDimensionSynthesisOutputSchema,MarketShapeFinalSynthesisOutputSchema])}).strict();

const overviewSynthesisTask=z.literal('market-overview-synthesis');
export const MarketOverviewSynthesisInputSchema=z.object({...commonInput,task:overviewSynthesisTask,synthesis:OverviewSynthesisGraphInputSchema}).strict();
export const MarketOverviewSynthesisOutputSchema=z.object({...commonOutput,task:overviewSynthesisTask,result:OverviewSynthesisGraphOutputSchema}).strict();

export const MarketSemanticRecordSchema = z.discriminatedUnion("task", [
  z.object({task:overviewSynthesisTask,synthesis:OverviewSynthesisGraphInputSchema,sourceRefs:ids(2_000),sourceReportAttemptId:z.string().uuid()}).strict(),
  z.object({ task: overviewTask, ...overviewCompleteFields }).strict(),
  z.object({ task: shapeTask, ...shapeCatalog, product: MarketSemanticProductSchema }).strict(),
  z.object({ task: keywordTask, ...keywordCatalog, keyword: MarketSemanticKeywordSchema }).strict(),
  z.object({ task: themeTask, ...themeCatalog, theme: MarketSemanticThemeSchema }).strict(),
  z.object({task:shapeExplanationTask,window:MarketShapeExplanationWindowSchema,sourceRefs:ids(2_000)}).strict(),
  z.object({task:shapeSynthesisTask,synthesis:z.discriminatedUnion('mode',[MarketShapeDimensionSynthesisInputSchema,MarketShapeFinalSynthesisInputSchema]),sourceRefs:ids(2_000)}).strict(),
]);
export type MarketSemanticRecord = z.infer<typeof MarketSemanticRecordSchema>;
export type MarketOverviewExplanationInput = z.infer<typeof MarketOverviewExplanationInputSchema>;
export type MarketOverviewExplanationOutput = z.infer<typeof MarketOverviewExplanationOutputSchema>;
export type MarketShapeSuggestionInput = z.infer<typeof MarketShapeSuggestionInputSchema>;
export type MarketShapeSuggestionOutput = z.infer<typeof MarketShapeSuggestionOutputSchema>;
export type MarketKeywordSemanticsLegacyInput = z.infer<typeof MarketKeywordSemanticsLegacyInputSchema>;
export type MarketKeywordSemanticsLegacyOutput = z.infer<typeof MarketKeywordSemanticsLegacyOutputSchema>;
export type MarketKeywordSemanticsInput = z.infer<typeof MarketKeywordSemanticsInputSchema>;
export type MarketKeywordSemanticsOutput = z.infer<typeof MarketKeywordSemanticsOutputSchema>;
export type MarketKeywordSemanticsDiscoveryOutput = z.infer<typeof MarketKeywordSemanticsDiscoveryOutputSchema>;
export type MarketKeywordLabelProposal = z.infer<typeof MarketKeywordLabelProposalSchema>;
export type MarketCustomerThemeMappingInput = z.infer<typeof MarketCustomerThemeMappingInputSchema>;
export type MarketCustomerThemeMappingOutput = z.infer<typeof MarketCustomerThemeMappingOutputSchema>;
export type MarketShapeStructureExplanationInput=z.infer<typeof MarketShapeStructureExplanationInputSchema>;
export type MarketShapeStructureExplanationOutput=z.infer<typeof MarketShapeStructureExplanationOutputSchema>;
export type MarketShapeSynthesisInput=z.infer<typeof MarketShapeSynthesisInputSchema>;
export type MarketShapeSynthesisOutput=z.infer<typeof MarketShapeSynthesisOutputSchema>;
export type MarketOverviewSynthesisInput=z.infer<typeof MarketOverviewSynthesisInputSchema>;
export type MarketOverviewSynthesisOutput=z.infer<typeof MarketOverviewSynthesisOutputSchema>;
export type MarketSemanticInput = MarketOverviewSynthesisInput | MarketOverviewExplanationInput | MarketShapeSuggestionInput | MarketKeywordSemanticsInput | MarketCustomerThemeMappingInput | MarketShapeStructureExplanationInput | MarketShapeSynthesisInput;
export type MarketSemanticOutput = MarketOverviewSynthesisOutput | MarketOverviewExplanationOutput | MarketShapeSuggestionOutput | MarketKeywordSemanticsOutput | MarketCustomerThemeMappingOutput | MarketShapeStructureExplanationOutput | MarketShapeSynthesisOutput;
export type MarketSemanticSourceField = z.infer<typeof MarketShapeSourceFieldSchema> | z.infer<typeof MarketKeywordSourceFieldSchema> | z.infer<typeof MarketThemeSourceFieldSchema>;
export type MarketSemanticValidationBinding = Readonly<{
  scope: MarketAnalysisScope; inputSnapshot: MarketInputSnapshot;
  sourceEvidenceByRef: Readonly<Record<string, MarketSourceEvidence>>;
  selectionRevision: string; batchKey: string; inputDigest: string; expectedIds: readonly string[];
  sourceCatalog: Readonly<Record<string, MarketSemanticRecord>>;
  shapeExplanationCatalog?: MarketShapeExplanationCatalog;
  shapeSynthesisChildren?: readonly MarketShapeSynthesisChild[];
  shapeSynthesisExpectedLeaves?: readonly string[];
  overviewSynthesisBasis?:MarketOverviewSynthesisBasis;
  overviewSynthesisChildren?:readonly MarketOverviewSynthesisChild[];
  overviewSynthesisExpectedLeaves?:readonly string[];
}>;
export {MarketShapeSynthesisChildSchema};
export type {MarketShapeSynthesisChild};
