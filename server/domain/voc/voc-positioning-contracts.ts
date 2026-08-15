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

const CitationSchema = z.strictObject({
  statement: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(Sha256Schema).min(1),
});
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
  coreConclusion: CitationSchema,
  positioning: z.array(
    z.strictObject({
      dimension: PositioningDimensionSchema,
      conclusion: z.string().trim().min(1).max(4_000),
      priority: PrioritySchema,
      themeRefs: z.array(ThemeReferenceSchema).min(1),
      evidenceIds: z.array(Sha256Schema).min(1),
      limitation: z.string().trim().min(1).max(2_000).nullable(),
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
      direction: z.string().trim().min(1).max(2_000),
      productAction: z.string().trim().min(1).max(4_000),
      acceptanceCriteria: z.string().trim().min(1).max(4_000),
      risks: z.array(z.string().trim().min(1).max(2_000)),
      themeRefs: z.array(ThemeReferenceSchema).min(1),
      evidenceIds: z.array(Sha256Schema).min(1),
    }),
  ),
  checklists: z.strictObject({
    mustKeep: z.array(CitationSchema).max(3),
    mustAvoid: z.array(CitationSchema).max(3),
    differentiationOpportunities: z.array(CitationSchema).max(3),
  }),
  nextValidations: z.array(
    z.strictObject({
      domain: z.enum([
        "market",
        "price",
        "cost",
        "compliance",
        "patent",
        "supply-chain",
        "user",
      ]),
      question: z.string().trim().min(1).max(2_000),
      evidenceIds: z.array(Sha256Schema).min(1),
    }),
  ),
  limitations: z
    .array(
      z.enum([
        "voc-only",
        "no-market-size",
        "no-sales-forecast",
        "no-profitability",
        "no-project-approval",
        "requires-market-price-cost-compliance-patent-supply-chain-validation",
      ]),
    )
    .length(6),
});

export type VocPositioningOutput = z.infer<
  typeof VocPositioningOutputShapeSchema
>;

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
    validateOutput(value, facts, (path, message) => {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    });
  });
}

type Issue = (path: PropertyKey[], message: string) => void;

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
  })) issue(["identity"], "VOC execution identity does not match deterministic facts");

  const expectedCoverage = facts.availability.map((source) => ({
    sourceId: source.sourceId,
    status: source.status,
    missingAsins: [...source.missingAsins],
  }));
  if (!isDeepStrictEqual(value.coverage, expectedCoverage)) {
    issue(["coverage"], "VOC missing-data coverage does not match deterministic facts");
  }
  const expectedStatus = facts.availability.every(
    (source) => source.status === "available",
  ) ? "complete" : "partial";
  if (value.status !== expectedStatus) {
    issue(["status"], "VOC result status does not match source availability");
  }
  if (facts.evidenceIndex.length === 0) {
    issue(["status"], "All-missing VOC facts cannot produce an analysis result");
  }
  if (!isDeepStrictEqual(value.limitations, [
    "voc-only",
    "no-market-size",
    "no-sales-forecast",
    "no-profitability",
    "no-project-approval",
    "requires-market-price-cost-compliance-patent-supply-chain-validation",
  ])) {
    issue(["limitations"], "Required VOC decision boundaries were changed");
  }

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
    issue(["positioning"], "Every positioning dimension must appear exactly once");
  }
  validateEvidenceIds(value.coreConclusion.evidenceIds, evidenceById, ["coreConclusion"], issue);

  value.positioning.forEach((item, index) => {
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
          "P0/P1 positioning priority was downgraded",
        );
      }
    }
  });

  const seenJudgments = new Set<string>();
  value.themeJudgments.forEach((judgment, index) => {
    const identity = `${judgment.dimension}\u0000${judgment.themeKey}`;
    if (seenJudgments.has(identity)) {
      issue(["themeJudgments", index], "Duplicate VOC theme judgment");
      return;
    }
    seenJudgments.add(identity);
    const found = themeByIdentity.get(identity);
    if (!found) {
      issue(["themeJudgments", index, "themeKey"], "Forged VOC theme judgment");
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
      issue(["themeJudgments", index, "label"], "VOC theme label was changed");
    }
    if (judgment.priority !== found.theme.priority.level) {
      issue(["themeJudgments", index, "priority"], "Deterministic VOC priority was changed");
    }
    if (!isDeepStrictEqual(judgment.metrics, expectedMetrics)) {
      issue(["themeJudgments", index, "metrics"], "Deterministic VOC metric was changed");
    }
    if (!isDeepStrictEqual(judgment.evidenceIds, found.theme.evidenceIds)) {
      issue(["themeJudgments", index, "evidenceIds"], "VOC theme evidence was changed");
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
      issue(["themeJudgments"], "P0/P1 VOC theme is missing from the result");
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
    for (const protectedTheme of protectedThemes) {
      const protectedIdentity = `${protectedTheme.dimension}\u0000${protectedTheme.theme.key}`;
      if (
        referencedThemes.includes(protectedIdentity) &&
        priorityRank(action.priority) > priorityRank(protectedTheme.theme.priority.level)
      ) {
        issue(["actions", index, "priority"], "P0/P1 action priority was downgraded");
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
      issue(["actions"], "P0/P1 VOC theme has no product action");
    }
  }

  for (const [listName, list] of Object.entries(value.checklists)) {
    list.forEach((entry, index) =>
      validateEvidenceIds(
        entry.evidenceIds,
        evidenceById,
        ["checklists", listName, index, "evidenceIds"],
        issue,
      ),
    );
  }
  value.nextValidations.forEach((entry, index) =>
    validateEvidenceIds(
      entry.evidenceIds,
      evidenceById,
      ["nextValidations", index, "evidenceIds"],
      issue,
    ),
  );
}

function validateKnownThemes(
  values: readonly string[],
  known: ReadonlySet<string>,
  path: PropertyKey[],
  issue: Issue,
) {
  if (values.some((value) => !known.has(value))) {
    issue(path, "Result references a forged VOC theme");
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
    issue(path, "Result contains dangling VOC evidence");
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
      issue(path, "VOC evidence crosses its theme or dimension boundary");
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
  if (new Set(values).size !== values.length) issue(path, "Duplicate result reference");
}

function priorityRank(priority: VocPositioningOutput["actions"][number]["priority"]) {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3, unknown: 4 } as const)[priority];
}
