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

export const PRODUCT_DEFINITION_DATA_BOUNDARY =
  "当前最终产品定义由VOC与关键词需求交叉推导。关键词数据反映搜索需求和市场入口，VOC反映使用体验与需求缺口；机会等级仅代表需求与产品定义机会，不得视为完整立项批准。完整立项仍需验证竞争、成本利润、专利合规、MOQ、供应链和现金投入。" as const;

const CommercialDataStateSchema = z.literal("missing");
const CommercialValidationStateSchema = z.literal("requires-validation");
const PrioritySchema = z.enum(["P0", "P1", "P2", "P3", "待验证"]);
const EvidenceIdsSchema = z.array(z.string().trim().min(1).max(200)).min(1).max(100);
const SafeTextSchema = z.string().trim().min(1).max(2_000);
const VocPositioningDependencyResultSchema =
  VocPositioningOutputShapeSchema.omit({ identity: true });

export const ProductDefinitionInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("amazon-product-definition-input"),
  marketplace: MarketplaceSchema,
  asins: z.array(AsinSchema).min(1).max(10),
  dataCutoffAt: DateTimeSchema,
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

const CommercialValidationSchema = z.strictObject({
  cost: CommercialValidationStateSchema,
  profitability: CommercialValidationStateSchema,
  patent: CommercialValidationStateSchema,
  compliance: CommercialValidationStateSchema,
  supplyChain: CommercialValidationStateSchema,
});

const RiskSchema = z.strictObject({
  area: z.enum(["cost", "profitability", "patent", "compliance", "supply-chain"]),
  status: CommercialValidationStateSchema,
  nextStep: SafeTextSchema,
});

const FeatureSchema = z.strictObject({
  item: SafeTextSchema,
  evidenceIds: EvidenceIdsSchema,
});

export const ProductDefinitionOutputShapeSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("amazon-product-definition"),
  status: z.enum(["complete", "partial", "unavailable"]),
  identity: z.strictObject({
    vocReportId: EntityIdSchema,
    vocReportVersion: z.number().int().positive(),
    keywordSnapshotId: EntityIdSchema,
    keywordContentHash: Sha256Schema,
    dataCutoffAt: DateTimeSchema,
  }),
  opportunity: z.strictObject({
    grade: z.enum(["A", "B", "C", "D"]),
    scope: z.literal("demand-and-product-definition-opportunity"),
    projectApproval: z.literal("not-approved"),
  }),
  evidenceMatrix: z.array(z.strictObject({
    themeKey: z.string().trim().min(1).max(200),
    keywordGroupId: z.string().trim().min(1).max(200),
    vocEvidenceIds: EvidenceIdsSchema,
    keywordEvidenceIds: EvidenceIdsSchema,
    judgment: z.enum(["dual-validation", "voc-only", "keyword-candidate", "conflict", "avoid"]),
    productRole: z.enum(["core-foundation", "core-strengthening", "retain-and-redesign", "differentiation", "experience-optimization", "new-product-avoidance", "optional", "do-not-build", "validate"]),
    priority: PrioritySchema,
  })).min(1).max(100),
  finalDefinition: z.array(z.strictObject({
    dimension: z.enum(["target-market", "demand", "seasonality", "audience", "scenario", "motivation", "pain-point", "product-form", "base-feature", "differentiation", "specification", "material-structure", "color-sku", "price-tier", "selling-point", "avoidance"]),
    conclusion: SafeTextSchema,
    vocEvidenceIds: EvidenceIdsSchema,
    keywordEvidenceIds: EvidenceIdsSchema,
    action: z.enum(["include", "redesign", "validate", "exclude"]),
    priority: PrioritySchema,
    validationStatus: z.enum(["supported", "requires-validation"]),
  })).min(1).max(100),
  configurationLayers: z.strictObject({
    mustHave: z.array(FeatureSchema).max(50),
    differentiation: z.array(FeatureSchema).max(50),
    optional: z.array(FeatureSchema).max(50),
    notInV1: z.array(FeatureSchema).max(50),
    p0Avoid: z.array(FeatureSchema).max(50),
  }),
  keywordLanding: z.array(z.strictObject({
    groupId: z.string().trim().min(1).max(200),
    role: z.enum(["core-term", "product-form", "feature", "audience", "scenario", "long-tail", "risk"]),
    productLink: SafeTextSchema,
    listingAngle: SafeTextSchema,
    skuHint: SafeTextSchema,
    evidenceIds: EvidenceIdsSchema,
  })).min(1).max(50),
  priorities: z.array(z.strictObject({
    priority: PrioritySchema,
    direction: SafeTextSchema,
    evidenceIds: EvidenceIdsSchema,
    action: z.enum(["include", "redesign", "validate", "exclude"]),
    acceptance: SafeTextSchema,
  })).min(1).max(50),
  risks: z.array(RiskSchema).length(5),
  commercialValidation: CommercialValidationSchema,
  dataBoundary: z.literal(PRODUCT_DEFINITION_DATA_BOUNDARY),
});
export type ProductDefinitionOutput = z.infer<typeof ProductDefinitionOutputShapeSchema>;
export const ProductDefinitionOutputSchema = ProductDefinitionOutputShapeSchema;

const commercialClaimPattern = /profit(?:ability)?|\broi\b|margin|company approved|project approved|盈利|利润|毛利|投资回报|公司已批准|批准立项|无需(?:成本|专利|合规|供应链).*验证/i;

export function createProductDefinitionOutputSchema(input: ProductDefinitionInput) {
  const vocEvidenceIds = collectVocEvidenceIds(input.voc.result);
  const keywordEvidenceIds = new Set(input.keywords.evidence.map(({ id }) => id));
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
      context.addIssue({ code: "custom", path: ["identity"], message: "Product definition identity mismatch" });
    }
    output.evidenceMatrix.forEach((row, index) => {
      if (!themeKeys.has(row.themeKey)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index, "themeKey"], message: "Unknown VOC theme" });
      if (!groupIds.has(row.keywordGroupId)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index, "keywordGroupId"], message: "Unknown keyword group" });
      validateIds(row.vocEvidenceIds, vocEvidenceIds, context, ["evidenceMatrix", index, "vocEvidenceIds"]);
      validateIds(row.keywordEvidenceIds, keywordEvidenceIds, context, ["evidenceMatrix", index, "keywordEvidenceIds"]);
    });
    output.finalDefinition.forEach((row, index) => {
      validateIds(row.vocEvidenceIds, vocEvidenceIds, context, ["finalDefinition", index, "vocEvidenceIds"]);
      validateIds(row.keywordEvidenceIds, keywordEvidenceIds, context, ["finalDefinition", index, "keywordEvidenceIds"]);
    });
    output.keywordLanding.forEach((row, index) => {
      if (!groupIds.has(row.groupId)) context.addIssue({ code: "custom", path: ["keywordLanding", index, "groupId"], message: "Unknown keyword group" });
      validateIds(row.evidenceIds, keywordEvidenceIds, context, ["keywordLanding", index, "evidenceIds"]);
    });
    const riskAreas = new Set(output.risks.map(({ area }) => area));
    if (riskAreas.size !== 5) context.addIssue({ code: "custom", path: ["risks"], message: "Every commercial gate must remain explicit" });
    try {
      assertProductDefinitionCapabilityLanguage(output);
    } catch {
      context.addIssue({ code: "custom", path: ["dataBoundary"], message: "Product definition commercial capability boundary failed" });
    }
  });
}

export function canonicalizeProductDefinitionOutput(
  candidate: unknown,
  input: ProductDefinitionInput,
): unknown {
  if (!isRecord(candidate)) return candidate;
  return {
    ...candidate,
    identity: {
      vocReportId: input.voc.reportId,
      vocReportVersion: input.voc.version,
      keywordSnapshotId: input.keywords.snapshotId,
      keywordContentHash: input.keywords.contentHash,
      dataCutoffAt: input.dataCutoffAt,
    },
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
  if (!isRecord(value)) throw new Error("Product definition commercial capability boundary failed");
  const claims = { ...value };
  delete claims.dataBoundary;
  delete claims.commercialValidation;
  delete claims.opportunity;
  delete claims.risks;
  if (commercialClaimPattern.test(JSON.stringify(claims))) {
    throw new Error("Product definition commercial capability boundary failed");
  }
}

export function buildProductDefinitionInput(input: {
  marketplace: "US";
  asins: readonly string[];
  dataCutoffAt: string;
  vocReport: { id: string; version: number; snapshotIds: readonly string[]; result: unknown };
  keywordSnapshot: { id: string; contentHash: string; payload: { groups: unknown; evidence: unknown } };
}): ProductDefinitionInput {
  return ProductDefinitionInputSchema.parse({
    schemaVersion: "1.0.0",
    kind: "amazon-product-definition-input",
    marketplace: input.marketplace,
    asins: input.asins,
    dataCutoffAt: input.dataCutoffAt,
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

function collectVocEvidenceIds(result: z.infer<typeof VocPositioningDependencyResultSchema>) {
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
  const parsed = VocPositioningOutputShapeSchema.parse(value);
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
    context.addIssue({ code: "custom", path, message: "Evidence reference is not part of the trusted dependency" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
