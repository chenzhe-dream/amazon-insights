import { z } from "zod";

import {
  VOC_SOURCE_REFERENCES,
  VocDataSnapshotRecordSchema,
  buildVocSnapshotCandidate,
  deepFreeze,
  type VocSnapshotSourceBundle,
} from "../data/voc-data-snapshot";
import { preprocessVocSnapshot } from "../domain/voc/preprocess-voc-snapshot";
import {
  VocPositioningInputSchema,
  buildVocPositioningInput,
} from "../domain/voc/voc-positioning-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";
import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS,
} from "./analysis-agent-evaluation-contract";

export { REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS } from "./analysis-agent-evaluation-contract";

export const ANALYSIS_AGENT_EVAL_SET_VERSION = "openspec-9.1.0" as const;

const HUMAN_BASELINE_TARGETS: Readonly<Record<
  (typeof ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS)[number],
  string
>> = Object.freeze({
  accuracy: "Matches the frozen input facts, source scope, priorities, and missing-data boundaries.",
  "explanation-quality": "Explains conclusions with cited evidence and separates facts from interpretation.",
  actionability: "Translates findings into concrete product, listing, validation, or stop/go actions.",
  "risk-completeness": "Covers P0 safety, compliance, data gaps, metric conflicts, and dependency blockers.",
  "unsupported-inference-avoidance": "Does not infer market size, price, demand, or approval from unsupported evidence.",
  "business-readability": "Uses concise product-language that a non-engineering business reviewer can understand.",
});

const EVAL_ASINS = ["B000000001", "B000000002", "B000000003"] as const;
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const CAPTURED_AT = "2026-08-10T23:59:59.999Z";
const DATA_CUTOFF_AT = "2026-08-15T23:59:59.999Z";

const VocDimensionSchema = z.enum([
  "attention",
  "positives",
  "negatives",
  "unmet",
  "audiences",
  "scenarios",
  "motives",
]);

const SourceIdSchema = z.enum([
  "alexa-voc",
  "sorftime-review-analysis",
  "seller-sprite-review-analysis",
]);

const HumanBaselineSchema = z.strictObject({
  dimensions: z.array(
    z.strictObject({
      id: z.enum(ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS),
      minimumScore: z.number().int().min(1).max(5),
      target: z.string().min(1),
    }),
  ).length(ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.length),
});

const SourceScopedMetricConflictSchema = z.strictObject({
  dimension: VocDimensionSchema,
  themeKey: z.string().min(1),
  aggregateMentionPct: z.null(),
  metrics: z.array(
    z.strictObject({
      sourceId: SourceIdSchema,
      mentionPct: z.number().min(0).max(100).nullable(),
    }),
  ).length(3),
});

const ProtectedThemeSchema = z.strictObject({
  dimension: VocDimensionSchema,
  themeKey: z.string().min(1),
  priority: z.literal("P0"),
  safetyRule: z.enum([
    "safety",
    "compliance",
    "unusable",
    "structural-failure",
    "severe-damage",
    "concentrated-return",
  ]),
  cannotDowngradeReason: z.string().min(1),
});

const ExpectationsSchema = z.strictObject({
  dataCoverage: z.enum([
    "three-source-complete",
    "blocked-missing-input",
    "source-scoped-conflict",
    "protected-safety-p0",
  ]),
  requiredAssertions: z.array(z.string().min(1)).min(1),
  forbiddenConclusions: z.array(z.string().min(1)).min(1),
  sourceScopedMetricConflict: SourceScopedMetricConflictSchema.optional(),
  protectedTheme: ProtectedThemeSchema.optional(),
  safetyDowngradeForbidden: z.boolean().optional(),
});

const DependencyBlockedInputSchema = z.strictObject({
  kind: z.literal("dependency-blocked-input"),
  status: z.literal("waiting-input"),
  executable: z.literal(false),
  missingDependencies: z.array(z.enum(["voc", "keywords"])).min(1),
});

const EvalCaseInputSchema = z.union([
  VocPositioningInputSchema,
  DependencyBlockedInputSchema,
]);

const EvalCaseSchema = z.strictObject({
  id: z.enum(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS),
  title: z.string().min(1),
  snapshot: z.strictObject({
    frozenAt: z.string().datetime(),
    sanitized: z.literal(true),
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
    input: EvalCaseInputSchema,
  }),
  expectations: ExpectationsSchema,
  humanBaseline: HumanBaselineSchema,
});

const EvalSetSchema = z.strictObject({
  version: z.literal(ANALYSIS_AGENT_EVAL_SET_VERSION),
  caseIds: z.tuple([
    z.literal("scooter-complete"),
    z.literal("lighting-complete"),
    z.literal("missing-voc-keyword"),
    z.literal("third-party-metric-conflict"),
    z.literal("safety-p0"),
  ]),
  cases: z.array(EvalCaseSchema).length(5),
  casesById: z.record(z.enum(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS), EvalCaseSchema),
});

export type AnalysisAgentEvalSet = z.infer<typeof EvalSetSchema>;
export type AnalysisAgentEvalCase = z.infer<typeof EvalCaseSchema>;

type ReviewBlockKey =
  | "consumerProfile"
  | "scenarios"
  | "unmet"
  | "positives"
  | "negatives"
  | "motives";

function alexaRecord(asin: string, negatives: readonly string[], reviewCount = 100) {
  return {
    asin,
    attention: ["1. Common attention: structured theme."],
    positives: ["Common positive"],
    negatives: [...negatives],
    unmet: ["Common unmet need."],
    audiences: ["Audience | sanitized synthetic segment"],
    scenarios: ["Scenario | sanitized synthetic use case"],
    motives: ["Motive | sanitized purchase reason"],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "Sanitized customer review analysis",
      asin,
      rating: 4,
      reviewCount,
      prompt: "sanitized prompt",
      overallConclusion: "sanitized conclusion",
      captureStatus: "dialog" as const,
    },
  };
}

function reviewRecord(
  asin: string,
  rows: readonly Readonly<{
    label: string;
    sharePct: number;
    metricKind?: "review_sample_incidence" | "customers_say_topic_share";
    numerator?: number;
    denominator?: number;
  }>[],
  options: Readonly<{
    family?: "scooter" | "lighting" | "generic";
    blockKey?: ReviewBlockKey;
    blockLabel?: string;
    sampledReviews?: number;
  }> = {},
) {
  return {
    asin,
    marketplace: "US" as const,
    sampledReviews: options.sampledReviews ?? 100,
    fetchedAt: "2026-08-10",
    status: "ready" as const,
    ...(options.family ? { family: options.family } : {}),
    blocks: [
      {
        key: options.blockKey ?? ("negatives" as const),
        label: options.blockLabel ?? "Negatives",
        rows: rows.map((row) => ({ ...row, reason: "sanitized fixture row" })),
      },
    ],
  };
}

function sourceBundles(args: Readonly<{
  alexa?: readonly ReturnType<typeof alexaRecord>[];
  sorftime?: readonly ReturnType<typeof reviewRecord>[];
  sellerSprite?: readonly ReturnType<typeof reviewRecord>[];
}>): VocSnapshotSourceBundle[] {
  const bundles: VocSnapshotSourceBundle[] = [];
  if (args.alexa?.length) {
    bundles.push({
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      records: args.alexa,
    });
  }
  if (args.sorftime?.length) {
    bundles.push({
      sourceId: "sorftime-review-analysis",
      type: "connector",
      reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      records: args.sorftime,
    });
  }
  if (args.sellerSprite?.length) {
    bundles.push({
      sourceId: "seller-sprite-review-analysis",
      type: "connector",
      reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      records: args.sellerSprite,
    });
  }
  return bundles;
}

function buildInputFromBundles(
  id: string,
  bundles: readonly VocSnapshotSourceBundle[],
) {
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: EVAL_ASINS,
    dataCutoffAt: DATA_CUTOFF_AT,
    sourceBundles: bundles,
  });
  const snapshot = VocDataSnapshotRecordSchema.parse({
    ...candidate,
    id,
    runId: RUN_ID,
    createdAt: DATA_CUTOFF_AT,
  });
  return buildVocPositioningInput(preprocessVocSnapshot(snapshot));
}

function completeInput(family: "scooter" | "lighting", id: string) {
  const label = family === "scooter" ? "Lean-to-steer stability" : "Stable warm lighting";
  const rows = [{ label, sharePct: 12 }];
  return buildInputFromBundles(
    id,
    sourceBundles({
      alexa: EVAL_ASINS.map((asin) => alexaRecord(asin, [`${label} mentioned by buyers`])),
      sorftime: EVAL_ASINS.map((asin) => reviewRecord(asin, rows, { family })),
      sellerSprite: EVAL_ASINS.map((asin) => reviewRecord(asin, rows, { family })),
    }),
  );
}

function conflictInput() {
  return buildInputFromBundles(
    "44444444-4444-4444-8444-444444444443",
    sourceBundles({
      alexa: [alexaRecord(EVAL_ASINS[0], ["【普通问题】约 2% 评论提及（2 条）"])],
      sorftime: [reviewRecord(EVAL_ASINS[0], [{ label: "普通问题", sharePct: 6, metricKind: "review_sample_incidence", numerator: 6, denominator: 100 }])],
      sellerSprite: [reviewRecord(EVAL_ASINS[0], [{ label: "普通问题", sharePct: 11, metricKind: "review_sample_incidence", numerator: 11, denominator: 100 }])],
    }),
  );
}

function safetyInput() {
  return buildInputFromBundles(
    "44444444-4444-4444-8444-444444444444",
    sourceBundles({
      alexa: [
        alexaRecord(EVAL_ASINS[0], ["【普通问题】3 条", "【结构断裂】没有统计口径"], 0),
      ],
      sorftime: [reviewRecord(EVAL_ASINS[0], [{ label: "结构稳固", sharePct: 99 }])],
    }),
  );
}

function humanBaseline(): AnalysisAgentEvalCase["humanBaseline"] {
  return {
    dimensions: ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.map((id) => ({
      id,
      minimumScore: 4,
      target: HUMAN_BASELINE_TARGETS[id],
    })),
  };
}

function withDigest<T extends z.infer<typeof EvalCaseInputSchema>>(input: T) {
  return {
    frozenAt: "2026-08-18T00:00:00.000Z",
    sanitized: true as const,
    inputDigest: canonicalJsonSha256(input),
    input,
  };
}

function sourceScopedConflictExpectation(
  input: z.infer<typeof VocPositioningInputSchema>,
) {
  const dimension = input.dimensions.find((item) => item.key === "negatives");
  const theme = dimension?.themes.find((item) => item.label === "普通问题");
  if (!dimension || !theme) {
    throw new TypeError("Missing source-scoped conflict fixture theme");
  }
  return {
    dimension: dimension.key,
    themeKey: theme.key,
    aggregateMentionPct: null,
    metrics: theme.metrics.map((metric) => ({
      sourceId: metric.sourceId,
      mentionPct: metric.mentionPct,
    })),
  };
}

function protectedThemeExpectation(input: z.infer<typeof VocPositioningInputSchema>) {
  const dimension = input.dimensions.find((item) => item.key === "negatives");
  const theme = dimension?.themes.find((item) => item.label === "耐用性 / 结构强度");
  if (!dimension || !theme || theme.priority.level !== "P0" || !theme.priority.safetyRule) {
    throw new TypeError("Missing safety P0 fixture theme");
  }
  return {
    dimension: dimension.key,
    themeKey: theme.key,
    priority: theme.priority.level,
    safetyRule: theme.priority.safetyRule,
    cannotDowngradeReason: theme.priority.cannotDowngradeReason,
  };
}

function buildCases(): AnalysisAgentEvalCase[] {
  const scooter = completeInput("scooter", "44444444-4444-4444-8444-444444444441");
  const lighting = completeInput("lighting", "44444444-4444-4444-8444-444444444442");
  const conflict = conflictInput();
  const safety = safetyInput();

  return [
    {
      id: "scooter-complete",
      title: "Complete scooter VOC positioning input",
      snapshot: withDigest(scooter),
      expectations: {
        dataCoverage: "three-source-complete",
        requiredAssertions: ["closed-voc-skill-input", "three-source-coverage"],
        forbiddenConclusions: ["invent-missing-source", "downgrade-protected-theme"],
      },
      humanBaseline: humanBaseline(),
    },
    {
      id: "lighting-complete",
      title: "Complete lighting VOC positioning input",
      snapshot: withDigest(lighting),
      expectations: {
        dataCoverage: "three-source-complete",
        requiredAssertions: ["closed-voc-skill-input", "three-source-coverage"],
        forbiddenConclusions: ["invent-missing-source", "downgrade-protected-theme"],
      },
      humanBaseline: humanBaseline(),
    },
    {
      id: "missing-voc-keyword",
      title: "Missing VOC and keyword dependency boundary",
      snapshot: withDigest({
        kind: "dependency-blocked-input" as const,
        status: "waiting-input" as const,
        executable: false as const,
        missingDependencies: ["voc" as const, "keywords" as const],
      }),
      expectations: {
        dataCoverage: "blocked-missing-input",
        requiredAssertions: ["stop-before-skill-run", "request-missing-dependencies"],
        forbiddenConclusions: ["invent-voc-positioning-from-empty-input"],
      },
      humanBaseline: humanBaseline(),
    },
    {
      id: "third-party-metric-conflict",
      title: "Source-scoped metric conflict",
      snapshot: withDigest(conflict),
      expectations: {
        dataCoverage: "source-scoped-conflict",
        requiredAssertions: ["no-cross-source-average", "preserve-source-denominators"],
        forbiddenConclusions: ["average-2-6-11-into-6.33"],
        sourceScopedMetricConflict: sourceScopedConflictExpectation(conflict),
      },
      humanBaseline: humanBaseline(),
    },
    {
      id: "safety-p0",
      title: "Safety P0 cannot be downgraded",
      snapshot: withDigest(safety),
      expectations: {
        dataCoverage: "protected-safety-p0",
        requiredAssertions: ["safety-remains-p0", "cite-protected-theme"],
        forbiddenConclusions: ["downgrade-safety-p0-to-p1"],
        protectedTheme: protectedThemeExpectation(safety),
        safetyDowngradeForbidden: true,
      },
      humanBaseline: humanBaseline(),
    },
  ];
}

const EVALUATION_SET: AnalysisAgentEvalSet = (() => {
  const cases = buildCases();
  const casesById = Object.fromEntries(
    cases.map((entry) => [entry.id, entry]),
  ) as Record<(typeof REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS)[number], AnalysisAgentEvalCase>;
  return deepFreeze(
    EvalSetSchema.parse({
      version: ANALYSIS_AGENT_EVAL_SET_VERSION,
      caseIds: REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS,
      cases,
      casesById,
    }),
  );
})();

export function buildAnalysisAgentEvaluationSet(): AnalysisAgentEvalSet {
  return EVALUATION_SET;
}
