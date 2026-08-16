import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  Sha256Schema,
} from "../../../shared/agent-contracts";
import { VocSnapshotSourceIdSchema, deepFreeze } from "../../data/voc-data-snapshot";
import {
  parseVocDeterministicPreprocessingResult,
  type VocDeterministicPreprocessingResult,
} from "./preprocess-voc-snapshot";

const VocDimensionSchema = z.enum([
  "attention",
  "positives",
  "negatives",
  "unmet",
  "audiences",
  "scenarios",
  "motives",
]);
const VocFamilySchema = z.enum(["scooter", "lighting", "generic"]);
const SourceTypeSchema = z.enum(["manual-voc", "connector"]);
const SourceStatusSchema = z.enum(["available", "partial", "unavailable"]);
const PrioritySchema = z.enum(["P0", "P1", "P2", "P3", "unknown"]);
const MetricBasisSchema = z.enum([
  "explicit-percentage",
  "mention-count",
  "presence-only",
  "review-share-percentage",
]);
const ComparabilitySchema = z.enum([
  "comparable",
  "not-comparable",
  "partial",
  "unknown",
]);

const InputMetricSchema = z.strictObject({
  evidenceId: Sha256Schema,
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: SourceTypeSchema,
  capturedAt: DateTimeSchema,
  asin: AsinSchema,
  family: VocFamilySchema,
  rawLabel: z.string().min(1).max(500),
  basis: MetricBasisSchema,
  mentionCount: z.number().int().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  mentionPct: z.number().min(0).max(100).nullable(),
  denominatorScope: z.literal("source-record"),
  comparability: z.literal("record-only"),
});

const InputThemeSchema = z.strictObject({
  key: z.string().min(1).max(500),
  label: z.string().min(1).max(500),
  family: VocFamilySchema,
  metrics: z.array(InputMetricSchema).min(1),
  priority: z.strictObject({
    level: PrioritySchema,
    reasons: z.array(z.string().min(1)),
    cannotDowngradeReason: z.string().min(1).nullable(),
    safetyRule: z
      .enum([
        "safety",
        "compliance",
        "unusable",
        "structural-failure",
        "severe-damage",
        "concentrated-return",
      ])
      .nullable(),
  }),
  evidenceIds: z.array(Sha256Schema).min(1),
});

const InputCoverageSchema = z.strictObject({
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: SourceTypeSchema,
  status: SourceStatusSchema,
  marketplace: MarketplaceSchema,
  capturedAt: DateTimeSchema.nullable(),
  recordCount: z.number().int().nonnegative(),
  targetCount: z.number().int().positive(),
  missingAsins: z.array(AsinSchema),
  comparability: ComparabilitySchema,
  denominators: z.array(
    z.strictObject({
      asin: AsinSchema,
      kind: z.enum(["review-count", "sampled-reviews", "unknown"]),
      sampleCount: z.number().int().nonnegative().nullable(),
      recordCapturedAt: DateTimeSchema,
      family: VocFamilySchema,
    }),
  ),
});

const InputEvidenceSchema = z.strictObject({
  id: Sha256Schema,
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: SourceTypeSchema,
  capturedAt: DateTimeSchema,
  asin: AsinSchema,
  family: VocFamilySchema,
  dimension: VocDimensionSchema,
  themeKey: z.string().min(1).max(500),
  basis: MetricBasisSchema,
});

export const VocPositioningInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("voc-positioning-input"),
  snapshot: z.strictObject({
    id: EntityIdSchema,
    contentHash: Sha256Schema,
    marketplace: MarketplaceSchema,
    asins: z.array(AsinSchema).min(1).max(10),
    dataCutoffAt: DateTimeSchema,
  }),
  factsDigest: Sha256Schema,
  coverage: z.array(InputCoverageSchema).length(3),
  dimensions: z
    .array(
      z.strictObject({
        key: VocDimensionSchema,
        label: z.string().min(1).max(500),
        themes: z.array(InputThemeSchema),
      }),
    )
    .length(7),
  evidenceIndex: z.array(InputEvidenceSchema),
});

export type VocPositioningInput = z.infer<typeof VocPositioningInputSchema>;

const PositioningDimensionSchema = z.enum([
  "target-audience",
  "core-scenario",
  "core-pain",
  "product-form",
  "base-function",
  "differentiator",
  "material-structure",
  "color-sku",
  "price-tier",
  "core-selling-point",
]);
const ThemeReferenceSchema = z.strictObject({
  dimension: VocDimensionSchema,
  themeKey: z.string().min(1).max(500),
});
const ReferencedAssertionSchema = z.strictObject({
  themeRefs: z.array(ThemeReferenceSchema).min(1),
  evidenceIds: z.array(Sha256Schema).min(1),
});
const ValidationDomainSchema = z.enum([
  "market",
  "price",
  "cost",
  "compliance",
  "patent",
  "supply-chain",
  "user",
]);
const EchoMetricSchema = z.strictObject({
  evidenceId: Sha256Schema,
  sourceId: VocSnapshotSourceIdSchema,
  asin: AsinSchema,
  capturedAt: DateTimeSchema,
  mentionCount: z.number().int().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  mentionPct: z.number().min(0).max(100).nullable(),
});

export const VocPositioningOutputShapeSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("voc-positioning-analysis-result"),
  status: z.enum(["complete", "partial"]),
  identity: z.strictObject({
    snapshotId: EntityIdSchema,
    contentHash: Sha256Schema,
    factsDigest: Sha256Schema,
    dataCutoffAt: DateTimeSchema,
  }),
  coverage: z.array(
    z.strictObject({
      sourceId: VocSnapshotSourceIdSchema,
      status: SourceStatusSchema,
      missingAsins: z.array(AsinSchema),
    }),
  ).length(3),
  coreConclusion: z.strictObject({
    strategy: z.enum([
      "retain-verified-value",
      "redesign-protected-problem",
      "validate-differentiation",
      "avoid-protected-failure",
    ]),
    themeRefs: z.array(ThemeReferenceSchema).min(1),
    evidenceIds: z.array(Sha256Schema).min(1),
  }),
  positioning: z.array(
    z.strictObject({
      dimension: PositioningDimensionSchema,
      stance: z.enum([
        "supported-by-voc",
        "requires-validation",
        "not-assessed",
      ]),
      strategy: z.enum(["retain", "redesign", "differentiate", "avoid", "validate"]),
      priority: PrioritySchema,
      themeRefs: z.array(ThemeReferenceSchema).min(1),
      evidenceIds: z.array(Sha256Schema).min(1),
    }),
  ).length(10),
  themeJudgments: z.array(
    z.strictObject({
      themeKey: z.string().min(1).max(500),
      label: z.string().min(1).max(500),
      dimension: VocDimensionSchema,
      role: z.enum([
        "core-retention",
        "retain-and-redesign",
        "differentiation-breakthrough",
        "new-product-avoidance",
        "selective-optimization",
        "observe-or-pseudo-demand",
        "needs-validation",
      ]),
      priority: PrioritySchema,
      metrics: z.array(EchoMetricSchema).min(1),
      evidenceIds: z.array(Sha256Schema).min(1),
    }),
  ),
  actions: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
      priority: PrioritySchema,
      actionType: z.enum(["retain", "redesign", "avoid", "differentiate", "validate"]),
      validationDomains: z.array(ValidationDomainSchema),
      themeRefs: z.array(ThemeReferenceSchema).min(1),
      evidenceIds: z.array(Sha256Schema).min(1),
    }),
  ),
  checklists: z.strictObject({
    mustKeep: z.array(ReferencedAssertionSchema).max(3),
    mustAvoid: z.array(ReferencedAssertionSchema).max(3),
    differentiationOpportunities: z.array(ReferencedAssertionSchema).max(3),
  }),
  nextValidations: z.array(
    z.strictObject({
      domain: ValidationDomainSchema,
      reason: z.enum([
        "decision-boundary",
        "partial-coverage",
        "implementation-feasibility",
        "risk-control",
      ]),
      themeRefs: z.array(ThemeReferenceSchema).min(1),
      evidenceIds: z.array(Sha256Schema).min(1),
    }),
  ),
  decisionBoundaries: z.strictObject({
    marketSize: z.literal("not-assessed"),
    salesForecast: z.literal("not-assessed"),
    profitability: z.literal("not-assessed"),
    projectApproval: z.literal("not-assessed"),
    price: z.literal("requires-validation"),
    cost: z.literal("requires-validation"),
    compliance: z.literal("requires-validation"),
    patent: z.literal("requires-validation"),
    supplyChain: z.literal("requires-validation"),
  }),
});

export type VocPositioningOutput = z.infer<
  typeof VocPositioningOutputShapeSchema
>;

export const VOC_POSITIONING_VALIDATION_RULE_IDS = [
  "voc-identity-mismatch",
  "voc-coverage-mismatch",
  "voc-status-mismatch",
  "voc-all-missing-facts",
  "voc-decision-boundaries-mismatch",
  "voc-positioning-dimension-incomplete",
  "voc-protected-core-strategy-downgrade",
  "voc-positioning-strategy-stance-mismatch",
  "voc-price-tier-requires-validation",
  "voc-protected-priority-downgrade",
  "voc-protected-positioning-strategy-downgrade",
  "voc-duplicate-theme-judgment",
  "voc-forged-theme-judgment",
  "voc-theme-label-mismatch",
  "voc-theme-priority-mismatch",
  "voc-protected-role-downgrade",
  "voc-theme-metrics-mismatch",
  "voc-theme-evidence-mismatch",
  "voc-protected-theme-judgment-missing",
  "voc-protected-action-downgrade",
  "voc-protected-theme-action-missing",
  "voc-evidence-missing-for-reference",
  "voc-forged-theme-reference",
  "voc-duplicate-result-reference",
  "voc-dangling-evidence",
  "voc-evidence-crosses-theme-boundary",
] as const;

export type VocPositioningValidationRuleId =
  typeof VOC_POSITIONING_VALIDATION_RULE_IDS[number];

const VOC_POSITIONING_VALIDATION_RULE_ID_SET = new Set<string>(
  VOC_POSITIONING_VALIDATION_RULE_IDS,
);

export function isVocPositioningValidationRuleId(
  value: unknown,
): value is VocPositioningValidationRuleId {
  return typeof value === "string" &&
    VOC_POSITIONING_VALIDATION_RULE_ID_SET.has(value);
}

export function buildVocPositioningInput(
  input: unknown,
): Readonly<VocPositioningInput> {
  const facts = parseVocDeterministicPreprocessingResult(input);
  return deepFreeze(VocPositioningInputSchema.parse({
    schemaVersion: "1.0.0",
    kind: "voc-positioning-input",
    snapshot: {
      id: facts.snapshot.id,
      contentHash: facts.snapshot.contentHash,
      marketplace: facts.snapshot.marketplace,
      asins: facts.snapshot.asins,
      dataCutoffAt: facts.snapshot.dataCutoffAt,
    },
    factsDigest: facts.factsDigest,
    coverage: facts.availability.map((source) => ({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      status: source.status,
      marketplace: source.marketplace,
      capturedAt: source.capturedAt,
      recordCount: source.recordCount,
      targetCount: source.targetCount,
      missingAsins: source.missingAsins,
      comparability: source.comparability,
      denominators: source.denominators,
    })),
    dimensions: facts.dimensions.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      themes: dimension.themes.map((theme) => ({
        key: theme.key,
        label: theme.label,
        family: theme.family,
        metrics: theme.metrics.map((metric) => ({
          evidenceId: metric.evidenceId,
          sourceId: metric.sourceId,
          sourceType: metric.sourceType,
          capturedAt: metric.capturedAt,
          asin: metric.asin,
          family: metric.family,
          rawLabel: metric.rawLabel,
          basis: metric.basis,
          mentionCount: metric.mentionCount,
          sampleCount: metric.sampleCount,
          mentionPct: metric.mentionPct,
          denominatorScope: metric.denominatorScope,
          comparability: metric.comparability,
        })),
        priority: theme.priority,
        evidenceIds: theme.evidenceIds,
      })),
    })),
    evidenceIndex: facts.evidenceIndex.map((evidence) => ({
      id: evidence.id,
      sourceId: evidence.sourceId,
      sourceType: evidence.sourceType,
      capturedAt: evidence.capturedAt,
      asin: evidence.asin,
      family: evidence.family,
      dimension: evidence.dimension,
      themeKey: evidence.themeKey,
      basis: evidence.basis,
    })),
  }));
}

export function createVocPositioningOutputSchema(
  input: unknown,
): z.ZodType<VocPositioningOutput> {
  const facts = parseVocDeterministicPreprocessingResult(input);
  return VocPositioningOutputShapeSchema.superRefine((value, context) => {
    validateOutput(value, facts, (path, ruleId) => {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: "VOC output violated a deterministic semantic invariant",
        params: { ruleId },
      });
    });
  });
}

type Issue = (path: PropertyKey[], ruleId: VocPositioningValidationRuleId) => void;

function validateOutput(
  value: VocPositioningOutput,
  facts: VocDeterministicPreprocessingResult,
  issue: Issue,
) {
  if (!isDeepStrictEqual(value.identity, {
    snapshotId: facts.snapshot.id,
    contentHash: facts.snapshot.contentHash,
    factsDigest: facts.factsDigest,
    dataCutoffAt: facts.snapshot.dataCutoffAt,
  })) issue(["identity"], "voc-identity-mismatch");

  const expectedCoverage = facts.availability.map((source) => ({
    sourceId: source.sourceId,
    status: source.status,
    missingAsins: [...source.missingAsins],
  }));
  if (!isDeepStrictEqual(value.coverage, expectedCoverage)) {
    issue(["coverage"], "voc-coverage-mismatch");
  }
  const expectedStatus = facts.availability.every(
    (source) => source.status === "available",
  ) ? "complete" : "partial";
  if (value.status !== expectedStatus) {
    issue(["status"], "voc-status-mismatch");
  }
  if (facts.evidenceIndex.length === 0) {
    issue(["status"], "voc-all-missing-facts");
  }
  if (!isDeepStrictEqual(value.decisionBoundaries, {
    marketSize: "not-assessed",
    salesForecast: "not-assessed",
    profitability: "not-assessed",
    projectApproval: "not-assessed",
    price: "requires-validation",
    cost: "requires-validation",
    compliance: "requires-validation",
    patent: "requires-validation",
    supplyChain: "requires-validation",
  })) issue(["decisionBoundaries"], "voc-decision-boundaries-mismatch");

  const evidenceById = new Map(facts.evidenceIndex.map((item) => [item.id, item]));
  const themes = facts.dimensions.flatMap((dimension) =>
    dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
  );
  const themeByIdentity = new Map(
    themes.map((item) => [`${item.dimension}\u0000${item.theme.key}`, item]),
  );
  const themeIdentities = new Set(themeByIdentity.keys());

  validateUnique(value.positioning.map((item) => item.dimension), ["positioning"], issue);
  if (new Set(value.positioning.map((item) => item.dimension)).size !== 10) {
    issue(["positioning"], "voc-positioning-dimension-incomplete");
  }
  validateReferencedAssertion(
    value.coreConclusion,
    evidenceById,
    themeIdentities,
    ["coreConclusion"],
    issue,
  );
  const coreReferences = value.coreConclusion.themeRefs.map(themeReferenceIdentity);
  if (
    coreReferences.some((identity) => {
      const referenced = themeByIdentity.get(identity);
      return referenced && isSafetyOrP0(referenced.theme);
    }) &&
    value.coreConclusion.strategy !== "avoid-protected-failure" &&
    value.coreConclusion.strategy !== "redesign-protected-problem"
  ) {
    issue(["coreConclusion", "strategy"], "voc-protected-core-strategy-downgrade");
  }

  value.positioning.forEach((item, index) => {
    const allowedStrategies = item.stance === "supported-by-voc"
      ? new Set(["retain", "redesign", "avoid"])
      : item.stance === "requires-validation"
        ? new Set(["differentiate", "validate"])
        : new Set(["validate"]);
    if (!allowedStrategies.has(item.strategy)) {
      issue(
        ["positioning", index, "strategy"],
        "voc-positioning-strategy-stance-mismatch",
      );
    }
    if (
      item.dimension === "price-tier" &&
      (item.stance !== "requires-validation" || item.strategy !== "validate")
    ) {
      issue(
        ["positioning", index, "stance"],
        "voc-price-tier-requires-validation",
      );
    }
    const referencedThemes = item.themeRefs.map(themeReferenceIdentity);
    validateUnique(referencedThemes, ["positioning", index, "themeRefs"], issue);
    validateKnownThemes(
      referencedThemes,
      themeIdentities,
      ["positioning", index, "themeRefs"],
      issue,
    );
    validateScopedEvidence(
      item.evidenceIds,
      evidenceById,
      new Set(referencedThemes),
      ["positioning", index, "evidenceIds"],
      issue,
    );
    validateEvidenceCoversReferences(
      item.evidenceIds,
      evidenceById,
      referencedThemes,
      ["positioning", index, "evidenceIds"],
      issue,
    );
    for (const identity of referencedThemes) {
      const referenced = themeByIdentity.get(identity);
      if (
        referenced &&
        (referenced.theme.priority.level === "P0" ||
          referenced.theme.priority.level === "P1") &&
        priorityRank(item.priority) >
          priorityRank(referenced.theme.priority.level)
      ) {
        issue(
          ["positioning", index, "priority"],
          "voc-protected-priority-downgrade",
        );
      }
      if (
        referenced &&
        isSafetyOrP0(referenced.theme) &&
        (item.stance === "supported-by-voc"
          ? item.strategy !== "avoid" && item.strategy !== "redesign"
          : item.strategy !== "validate")
      ) {
        issue(
          ["positioning", index, "strategy"],
          "voc-protected-positioning-strategy-downgrade",
        );
      }
    }
  });

  const seenJudgments = new Set<string>();
  value.themeJudgments.forEach((judgment, index) => {
    const identity = `${judgment.dimension}\u0000${judgment.themeKey}`;
    if (seenJudgments.has(identity)) {
      issue(["themeJudgments", index], "voc-duplicate-theme-judgment");
      return;
    }
    seenJudgments.add(identity);
    const found = themeByIdentity.get(identity);
    if (!found) {
      issue(["themeJudgments", index, "themeKey"], "voc-forged-theme-judgment");
      return;
    }
    const expectedMetrics = found.theme.metrics.map((metric) => ({
      evidenceId: metric.evidenceId,
      sourceId: metric.sourceId,
      asin: metric.asin,
      capturedAt: metric.capturedAt,
      mentionCount: metric.mentionCount,
      sampleCount: metric.sampleCount,
      mentionPct: metric.mentionPct,
    }));
    if (judgment.label !== found.theme.label) {
      issue(["themeJudgments", index, "label"], "voc-theme-label-mismatch");
    }
    if (judgment.priority !== found.theme.priority.level) {
      issue(["themeJudgments", index, "priority"], "voc-theme-priority-mismatch");
    }
    const protectedRole = expectedProtectedRole(found.dimension, found.theme);
    if (protectedRole !== null && judgment.role !== protectedRole) {
      issue(["themeJudgments", index, "role"], "voc-protected-role-downgrade");
    }
    if (!isDeepStrictEqual(judgment.metrics, expectedMetrics)) {
      issue(["themeJudgments", index, "metrics"], "voc-theme-metrics-mismatch");
    }
    if (!isDeepStrictEqual(judgment.evidenceIds, found.theme.evidenceIds)) {
      issue(["themeJudgments", index, "evidenceIds"], "voc-theme-evidence-mismatch");
    }
    validateScopedEvidence(
      judgment.evidenceIds,
      evidenceById,
      new Set([identity]),
      ["themeJudgments", index, "evidenceIds"],
      issue,
    );
  });

  for (const { dimension, theme } of themes) {
    if (
      (theme.priority.level === "P0" || theme.priority.level === "P1") &&
      !seenJudgments.has(`${dimension}\u0000${theme.key}`)
    ) {
      issue(["themeJudgments"], "voc-protected-theme-judgment-missing");
    }
  }

  const protectedThemes = themes.filter(
    ({ theme }) => theme.priority.level === "P0" || theme.priority.level === "P1",
  );
  validateUnique(value.actions.map((action) => action.id), ["actions"], issue);
  value.actions.forEach((action, index) => {
    const referencedThemes = action.themeRefs.map(themeReferenceIdentity);
    validateUnique(referencedThemes, ["actions", index, "themeRefs"], issue);
    validateKnownThemes(
      referencedThemes,
      themeIdentities,
      ["actions", index, "themeRefs"],
      issue,
    );
    validateScopedEvidence(
      action.evidenceIds,
      evidenceById,
      new Set(referencedThemes),
      ["actions", index, "evidenceIds"],
      issue,
    );
    validateEvidenceCoversReferences(
      action.evidenceIds,
      evidenceById,
      referencedThemes,
      ["actions", index, "evidenceIds"],
      issue,
    );
    for (const protectedTheme of protectedThemes) {
      const protectedIdentity = `${protectedTheme.dimension}\u0000${protectedTheme.theme.key}`;
      if (
        referencedThemes.includes(protectedIdentity) &&
        priorityRank(action.priority) > priorityRank(protectedTheme.theme.priority.level)
      ) {
        issue(["actions", index, "priority"], "voc-protected-priority-downgrade");
      }
      if (
        referencedThemes.includes(protectedIdentity) &&
        isSafetyOrP0(protectedTheme.theme) &&
        (action.actionType !== "avoid" && action.actionType !== "redesign" ||
          !action.validationDomains.includes("compliance"))
      ) {
        issue(["actions", index, "actionType"], "voc-protected-action-downgrade");
      }
    }
  });
  for (const { dimension, theme } of protectedThemes) {
    const identity = `${dimension}\u0000${theme.key}`;
    if (
      !value.actions.some((action) =>
        action.themeRefs.some(
          (reference) => themeReferenceIdentity(reference) === identity,
        ),
      )
    ) {
      issue(["actions"], "voc-protected-theme-action-missing");
    }
  }

  for (const [listName, list] of Object.entries(value.checklists)) {
    list.forEach((entry, index) => validateReferencedAssertion(
      entry,
      evidenceById,
      themeIdentities,
      ["checklists", listName, index],
      issue,
    ));
  }
  value.nextValidations.forEach((entry, index) => validateReferencedAssertion(
    entry,
    evidenceById,
    themeIdentities,
    ["nextValidations", index],
    issue,
  ));
}

function validateReferencedAssertion(
  value: { themeRefs: readonly z.infer<typeof ThemeReferenceSchema>[]; evidenceIds: readonly string[] },
  evidenceById: ReadonlyMap<string, VocDeterministicPreprocessingResult["evidenceIndex"][number]>,
  themeIdentities: ReadonlySet<string>,
  path: PropertyKey[],
  issue: Issue,
) {
  const references = value.themeRefs.map(themeReferenceIdentity);
  validateUnique(references, [...path, "themeRefs"], issue);
  validateKnownThemes(references, themeIdentities, [...path, "themeRefs"], issue);
  validateScopedEvidence(
    value.evidenceIds,
    evidenceById,
    new Set(references),
    [...path, "evidenceIds"],
    issue,
  );
  validateEvidenceCoversReferences(
    value.evidenceIds,
    evidenceById,
    references,
    [...path, "evidenceIds"],
    issue,
  );
}

function validateEvidenceCoversReferences(
  ids: readonly string[],
  known: ReadonlyMap<string, VocDeterministicPreprocessingResult["evidenceIndex"][number]>,
  references: readonly string[],
  path: PropertyKey[],
  issue: Issue,
) {
  const cited = new Set(ids.flatMap((id) => {
    const evidence = known.get(id);
    return evidence ? [`${evidence.dimension}\u0000${evidence.themeKey}`] : [];
  }));
  if (references.some((reference) => !cited.has(reference))) {
    issue(path, "voc-evidence-missing-for-reference");
  }
}

function expectedProtectedRole(
  dimension: VocDeterministicPreprocessingResult["dimensions"][number]["key"],
  theme: VocDeterministicPreprocessingResult["dimensions"][number]["themes"][number],
): VocPositioningOutput["themeJudgments"][number]["role"] | null {
  if (theme.priority.safetyRule !== null || theme.priority.level === "P0") {
    return "new-product-avoidance";
  }
  if (theme.priority.level !== "P1") return null;
  if (dimension === "unmet") return "differentiation-breakthrough";
  if (dimension === "negatives" || dimension === "attention") {
    return "retain-and-redesign";
  }
  return "core-retention";
}

function isSafetyOrP0(
  theme: VocDeterministicPreprocessingResult["dimensions"][number]["themes"][number],
) {
  return theme.priority.safetyRule !== null || theme.priority.level === "P0";
}

function validateKnownThemes(
  values: readonly string[],
  known: ReadonlySet<string>,
  path: PropertyKey[],
  issue: Issue,
) {
  if (values.some((value) => !known.has(value))) {
    issue(path, "voc-forged-theme-reference");
  }
}

function validateEvidenceIds(
  ids: readonly string[],
  known: ReadonlyMap<string, VocDeterministicPreprocessingResult["evidenceIndex"][number]>,
  path: PropertyKey[],
  issue: Issue,
) {
  validateUnique(ids, path, issue);
  if (ids.some((id) => !known.has(id))) {
    issue(path, "voc-dangling-evidence");
  }
}

function validateScopedEvidence(
  ids: readonly string[],
  known: ReadonlyMap<string, VocDeterministicPreprocessingResult["evidenceIndex"][number]>,
  allowedThemeIdentities: ReadonlySet<string>,
  path: PropertyKey[],
  issue: Issue,
) {
  validateEvidenceIds(ids, known, path, issue);
  for (const id of ids) {
    const evidence = known.get(id);
    if (
      evidence &&
      !allowedThemeIdentities.has(
        `${evidence.dimension}\u0000${evidence.themeKey}`,
      )
    ) {
      issue(path, "voc-evidence-crosses-theme-boundary");
    }
  }
}

function themeReferenceIdentity(reference: {
  dimension: VocDeterministicPreprocessingResult["dimensions"][number]["key"];
  themeKey: string;
}) {
  return `${reference.dimension}\u0000${reference.themeKey}`;
}

function validateUnique(
  values: readonly string[],
  path: PropertyKey[],
  issue: Issue,
) {
  if (new Set(values).size !== values.length) issue(path, "voc-duplicate-result-reference");
}

function priorityRank(priority: VocPositioningOutput["actions"][number]["priority"]) {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3, unknown: 4 } as const)[priority];
}
