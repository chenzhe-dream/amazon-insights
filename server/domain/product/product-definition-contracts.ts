import { productValidationRule } from '../../../shared/product-validation-rules';
import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  Sha256Schema,
} from "../../../shared/agent-contracts";
import { KeywordAnalysisSnapshotRecordSchema } from "../../data/keyword-analysis-snapshot";
import { VocPositioningOutputShapeSchema } from "../voc/voc-positioning-contracts";
import { VocEvidenceManifestSchema, type VocEvidenceManifest } from "../../../shared/voc-evidence-contracts";
export {
  PRODUCT_DEFINITION_DATA_BOUNDARY,
  ProductDefinitionOutputSchema,
  ProductDefinitionOutputShapeSchema,
  type ProductDefinitionOutput,
} from "../../../shared/product-definition-output";
import {
  PRODUCT_DEFINITION_DATA_BOUNDARY,
  ProductDefinitionOutputShapeSchema,
} from "../../../shared/product-definition-output";

const CommercialDataStateSchema = z.literal("missing");
const VocPositioningDependencyResultSchema =
  VocPositioningOutputShapeSchema.omit({ identity: true });
export const HISTORICAL_KEYWORD_EVIDENCE_RULE = "若关键词 queryWindow.time_type=month 且 currentEmpty 为 valid-empty，该词仅是所标月份的历史证据；近30天查询无词。不得称为近30天流量，不得推断未给出的搜索量、转化率或全样本覆盖；按 coverage 保留未命中的 ASIN。" as const;

export const ProductDefinitionInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("amazon-product-definition-input"),
  marketplace: MarketplaceSchema,
  asins: z.array(AsinSchema).min(1).max(10),
  dataCutoffAt: DateTimeSchema,
  evidenceSelection: VocEvidenceManifestSchema.optional(),
  voc: z.strictObject({
    reportId: EntityIdSchema,
    version: z.number().int().positive(),
    snapshotIds: z.array(EntityIdSchema).min(1),
    result: VocPositioningDependencyResultSchema,
  }),
  keywords: z.strictObject({
    snapshotId: EntityIdSchema,
    contentHash: Sha256Schema,
    groups: KeywordAnalysisSnapshotRecordSchema.shape.payload.shape.groups,
    evidence: KeywordAnalysisSnapshotRecordSchema.shape.payload.shape.evidence,
    coverage: KeywordAnalysisSnapshotRecordSchema.shape.payload.shape.coverage,
    evidenceUseRule: z.literal(HISTORICAL_KEYWORD_EVIDENCE_RULE).optional(),
  }),
  commercialData: z.strictObject({
    cost: CommercialDataStateSchema,
    profitability: CommercialDataStateSchema,
    patent: CommercialDataStateSchema,
    compliance: CommercialDataStateSchema,
    supplyChain: CommercialDataStateSchema,
  }),
});
export type ProductDefinitionInput = z.infer<typeof ProductDefinitionInputSchema>;

const approvalOrBypassPattern = /company approved|project approved|公司已批准|批准立项|无需(?:成本|专利|合规|供应链).*验证/i;

export function createProductDefinitionOutputSchema(input: ProductDefinitionInput) {
  const vocEvidenceIds = collectVocEvidenceIds(input.voc.result);
  const keywordEvidenceIds = new Set(input.keywords.evidence.map(({ id }) => id));
  const allEvidenceIds = new Set([...vocEvidenceIds, ...keywordEvidenceIds]);
  const themeKeys = new Set(input.voc.result.themeJudgments.map(({ themeKey }) => themeKey));
  const groupIds = new Set(input.keywords.groups.map(({ id }) => id));
  return ProductDefinitionOutputShapeSchema.superRefine((output, context) => {
    if (
      output.identity.vocReportId !== input.voc.reportId ||
      output.identity.vocReportVersion !== input.voc.version ||
      output.identity.keywordSnapshotId !== input.keywords.snapshotId ||
      output.identity.keywordContentHash !== input.keywords.contentHash ||
      output.identity.dataCutoffAt !== input.dataCutoffAt
    ) {
      context.addIssue({ code: "custom", path: ["identity"], message: "Product definition identity mismatch", params: productValidationRule("product-identity-mismatch") });
    }
    if (input.evidenceSelection && (
      output.identity.inputFingerprint !== input.evidenceSelection.fingerprint ||
      !output.evidenceSelection ||
      JSON.stringify(output.evidenceSelection) !== JSON.stringify(input.evidenceSelection)
    )) context.addIssue({ code: "custom", path: ["identity", "inputFingerprint"], message: "Product definition input fingerprint or evidence selection mismatch", params: productValidationRule("product-fingerprint-mismatch") });
    if (input.evidenceSelection?.sourceMode === "review-fallback" && output.opportunity.grade === "A") {
      context.addIssue({ code: "custom", path: ["opportunity", "grade"], message: "Review fallback evidence cannot support grade A", params: productValidationRule("product-review-fallback-grade") });
    }
    output.evidenceMatrix.forEach((row, index) => {
      const hasVoc = row.vocEvidenceIds.length > 0;
      const hasKeywords = row.keywordEvidenceIds.length > 0;
      if (!hasVoc && !hasKeywords) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Evidence matrix row needs at least one evidence source", params: productValidationRule("product-matrix-needs-evidence") });
      if (row.themeKey !== null && !themeKeys.has(row.themeKey)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index, "themeKey"], message: "Unknown VOC theme", params: productValidationRule("product-unknown-voc-theme") });
      if (row.keywordGroupId !== null && !groupIds.has(row.keywordGroupId)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index, "keywordGroupId"], message: "Unknown keyword group", params: productValidationRule("product-unknown-keyword-group") });
      if (row.judgment === "voc-only" && (!hasVoc || hasKeywords || row.themeKey === null || row.keywordGroupId !== null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "VOC-only row has invalid evidence sides", params: productValidationRule("product-matrix-voc-only-sides") });
      if (row.judgment === "keyword-candidate" && (hasVoc || !hasKeywords || row.themeKey !== null || row.keywordGroupId === null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Keyword candidate row has invalid evidence sides", params: productValidationRule("product-matrix-keyword-only-sides") });
      if (row.judgment === "dual-validation" && (!hasVoc || !hasKeywords || row.themeKey === null || row.keywordGroupId === null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Dual validation requires both evidence sides", params: productValidationRule("product-matrix-dual-sides") });
      if ((row.judgment === "conflict" || row.judgment === "avoid") && (!hasVoc || !hasKeywords || row.themeKey === null || row.keywordGroupId === null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Conflict and avoidance judgments require substantive evidence", params: productValidationRule("product-matrix-conflict-avoid-sides") });
      validateIds(row.vocEvidenceIds, vocEvidenceIds, context, ["evidenceMatrix", index, "vocEvidenceIds"]);
      validateIds(row.keywordEvidenceIds, keywordEvidenceIds, context, ["evidenceMatrix", index, "keywordEvidenceIds"]);
    });
    output.finalDefinition.forEach((row, index) => {
      const hasVoc = row.vocEvidenceIds.length > 0;
      const hasKeywords = row.keywordEvidenceIds.length > 0;
      if (!hasVoc && !hasKeywords) context.addIssue({ code: "custom", path: ["finalDefinition", index], message: "Final definition row needs evidence", params: productValidationRule("product-final-definition-needs-evidence") });
      if (row.validationStatus === "supported" && (!hasVoc || !hasKeywords)) context.addIssue({ code: "custom", path: ["finalDefinition", index, "validationStatus"], message: "Supported definition requires both evidence sides", params: productValidationRule("product-supported-requires-both-evidence") });
      validateIds(row.vocEvidenceIds, vocEvidenceIds, context, ["finalDefinition", index, "vocEvidenceIds"]);
      validateIds(row.keywordEvidenceIds, keywordEvidenceIds, context, ["finalDefinition", index, "keywordEvidenceIds"]);
    });
    output.keywordLanding.forEach((row, index) => {
      if (!groupIds.has(row.groupId)) context.addIssue({ code: "custom", path: ["keywordLanding", index, "groupId"], message: "Unknown keyword group", params: productValidationRule("product-unknown-keyword-group") });
      validateIds(row.evidenceIds, keywordEvidenceIds, context, ["keywordLanding", index, "evidenceIds"]);
    });
    Object.entries(output.configurationLayers).forEach(([layer, rows]) => rows.forEach((row, index) => {
      validateIds(row.evidenceIds, allEvidenceIds, context, ["configurationLayers", layer, index, "evidenceIds"]);
    }));
    output.priorities.forEach((row, index) => {
      validateIds(row.evidenceIds, allEvidenceIds, context, ["priorities", index, "evidenceIds"]);
    });
    const riskAreas = new Set(output.risks.map(({ area }) => area));
    if (riskAreas.size !== 5) context.addIssue({ code: "custom", path: ["risks"], message: "Every commercial gate must remain explicit", params: productValidationRule("product-commercial-gates-required") });
    for (const path of commercialCapabilityIssuePaths(output)) {
      context.addIssue({ code: "custom", path, message: "Product definition commercial capability boundary failed", params: productValidationRule("product-commercial-capability-language") });
    }
  });
}

export function canonicalizeProductDefinitionOutput(
  candidate: unknown,
  input: ProductDefinitionInput,
): unknown {
  if (!isRecord(candidate)) return candidate;
  const result = { ...candidate };
  delete result.evidenceSelection;
  // This is model output, not a deterministic rule-engine execution. Never
  // persist a model-invented trace or claim today's rules explain old reports.
  delete result.ruleTrace;
  delete result.ruleSetVersion;
  delete result.ruleDefinitions;
  return {
    ...result,
    identity: {
      vocReportId: input.voc.reportId,
      vocReportVersion: input.voc.version,
      keywordSnapshotId: input.keywords.snapshotId,
      keywordContentHash: input.keywords.contentHash,
      dataCutoffAt: input.dataCutoffAt,
      ...(input.evidenceSelection ? { inputFingerprint: input.evidenceSelection.fingerprint } : {}),
    },
    ...(input.evidenceSelection ? { evidenceSelection: input.evidenceSelection } : {}),
    opportunity: {
      ...(isRecord(candidate.opportunity) ? candidate.opportunity : {}),
      scope: "demand-and-product-definition-opportunity",
      projectApproval: "not-approved",
    },
    commercialValidation: {
      cost: "requires-validation",
      profitability: "requires-validation",
      patent: "requires-validation",
      compliance: "requires-validation",
      supplyChain: "requires-validation",
    },
    dataBoundary: PRODUCT_DEFINITION_DATA_BOUNDARY,
  };
}

export function assertProductDefinitionCapabilityLanguage(value: unknown): void {
  if (!isRecord(value) || commercialCapabilityIssuePaths(value).length > 0) {
    throw new Error("Product definition commercial capability boundary failed");
  }
}

// Financial vocabulary is not an assertion. Detect concrete unsupported claims
// instead of requiring every unknown/check sentence to match a whitelist.
// This is a bounded language check; structural gates and evidence identity are
// enforced separately and cannot be made true by narrative text.
const financialNoun = '(?:利润率|毛利率|利润|毛利|盈利能力|盈利|投资回报率|投资回报|ROI|profit(?:ability)?(?: margin)?|margin)';
const positiveCommercialPatterns = [
  new RegExp(`${financialNoun}\\s*(?:(?:已经|已|很|非常|较|十分|是|为|将|可|能够|预计|预期|达到|达|约|至少|超过|is|will be)\\s*)*(?:高|强|可观|可接受|充足|稳定|可靠|达标|保证|attractive|high|strong|positive|guaranteed|profitable)`, 'i'),
  new RegExp(`(?:高|强|稳定|保证|确保|实现|能够|可以|将会|必然|预期|预计|guaranteed|high|strong)\\s*${financialNoun}`, 'i'),
  new RegExp(`${financialNoun}\\s*(?:(?:为|是|约|达到|达|至少|超过|预计|预期|可达|将达到|is|of|at least)\\s*)*(?:[+-]?\\d+(?:[.,]\\d+)*\\s*(?:[%％]|元|美元|欧元|英镑|加元)?|百分之[零一二三四五六七八九十百两]+)`, 'i'),
  new RegExp(`${financialNoun}\\s*(?:已经|已)(?:验证|确认|通过)`, 'i'),
  new RegExp(`完成${financialNoun}(?:$|[。；;])`, 'i'),
  /\b(?:will be|is|guaranteed to be)\s+profitable\b/i,
];

function hasUnsupportedCommercialAssertion(text: string): boolean {
  // Approval/bypass claims are a separate invariant and must not be hidden by
  // a financial disclaimer elsewhere in the field.
  if (approvalOrBypassPattern.test(text)) return true;
  return text.split(/[，,。；;！？!?\n]+/u).some(clause =>
    positiveCommercialPatterns.some(pattern => pattern.test(clause)),
  );
}
function commercialCapabilityIssuePaths(value: Record<string, unknown>): (string | number)[][] {
  const issues: (string | number)[][] = [];
  const visit = (item: unknown, path: (string | number)[]) => {
    if (typeof item === 'string') {
      const invalid = hasUnsupportedCommercialAssertion(item);
      if (invalid) issues.push(path);
    } else if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, [...path, index]));
    else if (isRecord(item)) Object.entries(item).forEach(([key, entry]) => visit(entry, [...path, key]));
  };
  for (const [key, item] of Object.entries(value)) {
    if (!['dataBoundary', 'commercialValidation', 'opportunity', 'risks'].includes(key)) visit(item, [key]);
  }
  return issues;
}

export function buildProductDefinitionInput(input: {
  marketplace: string;
  asins: readonly string[];
  dataCutoffAt: string;
  vocReport: { id: string; version: number; snapshotIds: readonly string[]; result: unknown };
  keywordSnapshot: { id: string; contentHash: string; payload: { groups: unknown; evidence: unknown; coverage?: unknown } };
  evidenceSelection?: VocEvidenceManifest;
}): ProductDefinitionInput {
  return ProductDefinitionInputSchema.parse({
    schemaVersion: "1.0.0",
    kind: "amazon-product-definition-input",
    marketplace: input.marketplace,
    asins: input.asins,
    dataCutoffAt: input.dataCutoffAt,
    ...(input.evidenceSelection ? { evidenceSelection: input.evidenceSelection } : {}),
    voc: {
      reportId: input.vocReport.id,
      version: input.vocReport.version,
      snapshotIds: input.vocReport.snapshotIds,
      result: omitIdentity(input.vocReport.result),
    },
    keywords: {
      snapshotId: input.keywordSnapshot.id,
      contentHash: input.keywordSnapshot.contentHash,
      groups: input.keywordSnapshot.payload.groups,
      evidence: input.keywordSnapshot.payload.evidence,
      ...(input.keywordSnapshot.payload.coverage ? { coverage: input.keywordSnapshot.payload.coverage } : {}),
      evidenceUseRule: HISTORICAL_KEYWORD_EVIDENCE_RULE,
    },
    commercialData: {
      cost: "missing",
      profitability: "missing",
      patent: "missing",
      compliance: "missing",
      supplyChain: "missing",
    },
  });
}

export function extractVocPositioningProjection(value: unknown) {
  if (
    isRecord(value) &&
    value.kind === "amazon-voc-insight-result" &&
    "positioningProjection" in value
  ) {
    return VocPositioningOutputShapeSchema.parse(value.positioningProjection);
  }
  return VocPositioningOutputShapeSchema.parse(value);
}

export function collectVocEvidenceIds(result: z.infer<typeof VocPositioningDependencyResultSchema>) {
  const ids = new Set<string>();
  const add = (values: readonly string[]) => values.forEach((id) => ids.add(id));
  add(result.coreConclusion.evidenceIds);
  result.positioning.forEach((item) => add(item.evidenceIds));
  result.themeJudgments.forEach((item) => add(item.evidenceIds));
  result.actions.forEach((item) => add(item.evidenceIds));
  Object.values(result.checklists).forEach((list) => list.forEach((item) => add(item.evidenceIds)));
  result.nextValidations.forEach((item) => add(item.evidenceIds));
  return ids;
}

function omitIdentity(value: unknown) {
  const parsed = extractVocPositioningProjection(value);
  const result = { ...parsed } as Partial<typeof parsed>;
  delete result.identity;
  return result;
}

function validateIds(
  ids: readonly string[],
  allowed: ReadonlySet<string>,
  context: z.RefinementCtx,
  path: (string | number)[],
) {
  if (ids.some((id) => !allowed.has(id))) {
    context.addIssue({ code: "custom", path, message: "Evidence reference is not part of the trusted dependency", params: productValidationRule("product-unknown-evidence-reference") });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
