import { productValidationRule } from './product-validation-rules';
import { z } from "zod";

import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./agent-contracts";
import { VocEvidenceManifestSchema } from "./voc-evidence-contracts";

export const PRODUCT_DEFINITION_DATA_BOUNDARY =
  "当前最终产品定义由VOC与关键词需求交叉推导。关键词数据反映搜索需求和市场入口，VOC反映使用体验与需求缺口；机会等级仅代表需求与产品定义机会，不得视为完整立项批准。完整立项仍需验证竞争、成本利润、专利合规、MOQ、供应链和现金投入。" as const;

const CommercialValidationStateSchema = z.literal("requires-validation");
const PrioritySchema = z.enum(["P0", "P1", "P2", "P3", "待验证"]);
const EvidenceIdsSchema = z.array(z.string().trim().min(1).max(200)).max(100);
const RequiredEvidenceIdsSchema = EvidenceIdsSchema.min(1);
const SafeTextSchema = z.string().trim().min(1).max(2_000);

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

const FeatureSchema = z.strictObject({ item: SafeTextSchema, evidenceIds: RequiredEvidenceIdsSchema });

export const ProductDefinitionOutputShapeSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("amazon-product-definition"),
  status: z.enum(["complete", "partial", "unavailable"]),
  evidenceSelection: VocEvidenceManifestSchema.optional(),
  identity: z.strictObject({
    vocReportId: EntityIdSchema,
    vocReportVersion: z.number().int().positive(),
    keywordSnapshotId: EntityIdSchema,
    keywordContentHash: Sha256Schema,
    dataCutoffAt: DateTimeSchema,
    inputFingerprint: Sha256Schema.optional(),
  }),
  opportunity: z.strictObject({
    grade: z.enum(["A", "B", "C", "D"]).nullable(),
    pendingReason: SafeTextSchema.nullable().optional(),
    scope: z.literal("demand-and-product-definition-opportunity"),
    projectApproval: z.literal("not-approved"),
  }).superRefine((value, context) => {
    if (value.grade === null && !value.pendingReason) {
      context.addIssue({ code: "custom", path: ["pendingReason"], message: "A null opportunity grade requires an explicit pending reason", params: productValidationRule("product-pending-reason-required") });
    }
  }),
  evidenceMatrix: z.array(z.strictObject({
    themeKey: z.string().trim().min(1).max(200).nullable(),
    keywordGroupId: z.string().trim().min(1).max(200).nullable(),
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
  configurationLayers: z.strictObject({ mustHave: z.array(FeatureSchema).max(50), differentiation: z.array(FeatureSchema).max(50), optional: z.array(FeatureSchema).max(50), notInV1: z.array(FeatureSchema).max(50), p0Avoid: z.array(FeatureSchema).max(50) }),
  keywordLanding: z.array(z.strictObject({ groupId: z.string().trim().min(1).max(200), role: z.enum(["core-term", "product-form", "feature", "audience", "scenario", "long-tail", "risk"]), productLink: SafeTextSchema, listingAngle: SafeTextSchema, skuHint: SafeTextSchema, evidenceIds: RequiredEvidenceIdsSchema })).min(1).max(50),
  priorities: z.array(z.strictObject({ priority: PrioritySchema, direction: SafeTextSchema, evidenceIds: RequiredEvidenceIdsSchema, action: z.enum(["include", "redesign", "validate", "exclude"]), acceptance: SafeTextSchema })).min(1).max(50),
  risks: z.array(RiskSchema).length(5),
  commercialValidation: CommercialValidationSchema,
  dataBoundary: z.literal(PRODUCT_DEFINITION_DATA_BOUNDARY),
}).superRefine(validateProductDefinitionOutputStructure);

export function validateProductDefinitionOutputStructure(output: {
  evidenceSelection?: { sourceMode: "manual" | "review-fallback" } | null;
  opportunity: { grade: "A" | "B" | "C" | "D" | null };
  evidenceMatrix: Array<{ themeKey: string | null; keywordGroupId: string | null; vocEvidenceIds: string[]; keywordEvidenceIds: string[]; judgment: "dual-validation" | "voc-only" | "keyword-candidate" | "conflict" | "avoid" }>;
  finalDefinition: Array<{ vocEvidenceIds: string[]; keywordEvidenceIds: string[]; validationStatus: "supported" | "requires-validation" }>;
}, context: z.RefinementCtx) {
  if (output.evidenceSelection?.sourceMode === "review-fallback" && output.opportunity.grade === "A") {
    context.addIssue({ code: "custom", path: ["opportunity", "grade"], message: "Review fallback evidence cannot support grade A", params: productValidationRule("product-review-fallback-grade") });
  }
  output.evidenceMatrix.forEach((row, index) => {
    const hasVoc = row.vocEvidenceIds.length > 0;
    const hasKeywords = row.keywordEvidenceIds.length > 0;
    if (!hasVoc && !hasKeywords) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Evidence matrix row needs at least one evidence source", params: productValidationRule("product-matrix-needs-evidence") });
    if (row.judgment === "voc-only" && (!hasVoc || hasKeywords || row.themeKey === null || row.keywordGroupId !== null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "VOC-only row has invalid evidence sides", params: productValidationRule("product-matrix-voc-only-sides") });
    if (row.judgment === "keyword-candidate" && (hasVoc || !hasKeywords || row.themeKey !== null || row.keywordGroupId === null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Keyword candidate row has invalid evidence sides", params: productValidationRule("product-matrix-keyword-only-sides") });
    if (row.judgment === "dual-validation" && (!hasVoc || !hasKeywords || row.themeKey === null || row.keywordGroupId === null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Dual validation requires both evidence sides", params: productValidationRule("product-matrix-dual-sides") });
    if ((row.judgment === "conflict" || row.judgment === "avoid") && (!hasVoc || !hasKeywords || row.themeKey === null || row.keywordGroupId === null)) context.addIssue({ code: "custom", path: ["evidenceMatrix", index], message: "Conflict and avoidance judgments require substantive evidence", params: productValidationRule("product-matrix-conflict-avoid-sides") });
  });
  output.finalDefinition.forEach((row, index) => {
    const hasVoc = row.vocEvidenceIds.length > 0;
    const hasKeywords = row.keywordEvidenceIds.length > 0;
    if (!hasVoc && !hasKeywords) context.addIssue({ code: "custom", path: ["finalDefinition", index], message: "Final definition row needs evidence", params: productValidationRule("product-final-definition-needs-evidence") });
    if (row.validationStatus === "supported" && (!hasVoc || !hasKeywords)) context.addIssue({ code: "custom", path: ["finalDefinition", index, "validationStatus"], message: "Supported definition requires both evidence sides", params: productValidationRule("product-supported-requires-both-evidence") });
  });
}

export type ProductDefinitionOutput = z.infer<typeof ProductDefinitionOutputShapeSchema>;
export const ProductDefinitionOutputSchema = ProductDefinitionOutputShapeSchema;
