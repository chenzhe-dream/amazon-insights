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

const commercialClaimPattern = /profit(?:ability)?|\broi(?=\b|\d)|margin|company approved|project approved|盈利|利润|毛利|投资回报|公司已批准|批准立项|无需(?:成本|专利|合规|供应链).*验证/i;
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

// These are explicit unknown/check statements, not a general negation escape.
// Check each clause independently so a disclaimer cannot hide an adjacent claim.
const financialSubject = '(?:利润率|毛利率|利润|毛利|盈利能力|盈利|投资回报|ROI)';
const financialUnknownPatterns = [
  new RegExp(`^${financialSubject}(?:仍|尚|还)?(?:需|需要|有待|待)(?:验证|评估|测算)$`, 'i'),
  /^(?:profitability|profit margin|profit|margin|ROI)(?: cannot be determined(?: from the available evidence)?| (?:still )?requires? (?:validation|verification|assessment))$/i,
];

function onlyFinancialSubjects(list: string): boolean {
  const subject = new RegExp(`^(?:成本)?${financialSubject}(?:表现|预测|保证|结论|数据|证据)?$`, 'i');
  return list.split(/[、和与及或]+/u).every(item =>
    !commercialClaimPattern.test(item) || subject.test(item.trim()),
  );
}

function isFinancialUnknown(clause: string): boolean {
  if (financialUnknownPatterns.some(pattern => pattern.test(clause))) return true;
  const unknownPredicate = clause.match(/^(.+?)(?:(?:尚未|未)(?:评估|测算|验证|确认)|(?:(?:仍|尚|还)?(?:需|需要|待)|另行)(?:另行)?(?:验证|评估|测算)|(?:不能|无法|不可)(?:由此|据此)?(?:判断|推断|确定|确认|预测))$/u);
  if (unknownPredicate && onlyFinancialSubjects(unknownPredicate[1])) return true;
  const missing = clause.match(/^(?:当前|目前)?(?:缺少|缺乏|缺失|尚缺|未提供)(.+?)(?:数据|证据)$/u);
  if (missing && onlyFinancialSubjects(missing[1])) return true;
  const conditional = clause.match(/^(?:不得|不能|不应|不可)在(?:无|缺少)(.+?)(?:数据|证据)时(?:输出|给出|作出|做出)(.+)$/u);
  if (conditional && onlyFinancialSubjects(conditional[1]) &&
    onlyFinancialSubjects(conditional[2].replace(/(^|[、和与及或])(?:承诺|保证|预测)/gu, '$1'))) return true;
  const denial = clause.match(/^(?:现有证据|现有数据|当前|目前)?(?:无法|不能|尚不能|不足以|不得|不应|不可|不)(?:(?:据|根据)(.+?))?(?:判断|推断|推定|确定|证明|确认|评估|预测|宣称|承诺|保证|认定)(.+)$/u);
  if (denial && (!denial[1] || !commercialClaimPattern.test(denial[1])) && onlyFinancialSubjects(denial[2])) return true;
  const inference = clause.match(/^(?:不得|不能|不应|不可)(?:把|将)(.+?)(?:当作|视为|作为)(.+)$/u);
  return Boolean(inference && !commercialClaimPattern.test(inference[1]) && onlyFinancialSubjects(inference[2]));
}

function isFinancialValidationStep(clause: string): boolean {
  const prerequisite = clause.match(/^(.*?)(?:需要|需)补齐(.+?)后再(.+)$/u);
  if (prerequisite && !commercialClaimPattern.test(prerequisite[1]) &&
    onlyFinancialSubjects(prerequisite[2]) && !commercialClaimPattern.test(prerequisite[3])) return true;
  const step = clause.match(/^(.*?)(?:需要|仍需|尚需|有待|必须|应先|补齐|完成|建立|需|待)(.+?)(?:验证|评估|测算|模型)(?:(?:后再|和|与|及)(.+))?$/i);
  if (!step || commercialClaimPattern.test(step[1]) || (step[3] && commercialClaimPattern.test(step[3]))) return false;
  // Cost inputs can be BOM, freight, returns, platform fees, etc. Only the
  // financial items must be bare unknowns: never "high margin" or "margin 30%".
  return onlyFinancialSubjects(step[2]);
}

function commercialCapabilityIssuePaths(value: Record<string, unknown>): (string | number)[][] {
  const issues: (string | number)[][] = [];
  const visit = (item: unknown, path: (string | number)[]) => {
    if (typeof item === 'string') {
      const invalid = approvalOrBypassPattern.test(item) || item.split(/[，,。；;！？!?\n]+/u).some(part => {
        const clause = part.trim().replace(/[.]+$/, '');
        return commercialClaimPattern.test(clause) &&
          !isFinancialUnknown(clause) && !isFinancialValidationStep(clause);
      });
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
