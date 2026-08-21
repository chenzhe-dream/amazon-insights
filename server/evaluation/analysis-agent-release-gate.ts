import { z } from "zod";

import {
  AnalysisReportSchema,
  EntityIdSchema,
  SkillProvenanceSchema,
} from "../../shared/agent-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";
import {
  VocPositioningOutputShapeSchema,
} from "../domain/voc/voc-positioning-contracts";
import {
  ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS,
  evaluateAnalysisAgentCandidate,
} from "./analysis-agent-auto-evaluator";
import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  AnalysisAgentHumanRatingSchema,
} from "./analysis-agent-human-review";
import {
  REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS,
} from "./analysis-agent-evaluation-contract";
import {
  ANALYSIS_AGENT_EVAL_SET_VERSION,
  buildAnalysisAgentEvaluationSet,
} from "./analysis-agent-eval-set";

export const ANALYSIS_AGENT_RELEASE_FAILURE_CODES = [
  "auto-case-coverage-invalid",
  "auto-candidate-mismatch",
  "auto-gate-coverage-invalid",
  "auto-gate-failed",
  "human-case-coverage-invalid",
  "human-candidate-mismatch",
  "human-score-below-threshold",
] as const;

const ModuleSchema = z.literal("voc-positioning");
const CandidateModelSchema = z.strictObject({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
});

export const AnalysisAgentReleaseCandidateSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  organizationId: EntityIdSchema,
  module: ModuleSchema,
  skill: SkillProvenanceSchema,
  model: CandidateModelSchema,
  evalSetVersion: z.literal(ANALYSIS_AGENT_EVAL_SET_VERSION),
});

const AnalysisAgentReleaseCaseEvidenceSchema = z.strictObject({
  caseId: z.enum(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS),
  candidate: z.unknown().optional(),
  observation: z.unknown(),
});

export const AnalysisAgentReleaseSubmissionSchema = z.strictObject({
  id: EntityIdSchema,
  actorUserId: EntityIdSchema,
  createdAt: z.string().datetime(),
  candidate: AnalysisAgentReleaseCandidateSchema,
  caseEvidence: z.array(AnalysisAgentReleaseCaseEvidenceSchema)
    .length(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.length)
    .refine(
      (items) => exactCoverage(
        items.map((item) => item.caseId),
        REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS,
      ),
      { message: "Release evidence must cover every evaluation case exactly once" },
    ),
  ratingIds: z.array(EntityIdSchema)
    .length(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.length)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Release rating IDs must be unique",
    }),
});

const AutoGateSchema = z.strictObject({
  id: z.enum(ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS),
  passed: z.boolean(),
  ruleIds: z.array(z.string().regex(/^[a-z0-9-]+$/)),
});

const AutoResultSchema = z.strictObject({
  candidateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  evalSetVersion: z.literal(ANALYSIS_AGENT_EVAL_SET_VERSION),
  caseId: z.enum(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS),
  passed: z.boolean(),
  gates: z.array(AutoGateSchema),
});

export const AnalysisAgentReleaseDecisionSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  actorUserId: EntityIdSchema,
  module: ModuleSchema,
  status: z.enum(["approved", "rejected"]),
  candidate: AnalysisAgentReleaseCandidateSchema,
  candidateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  autoResultsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  humanRatingsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  ratingIds: z.array(EntityIdSchema).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: "Rating IDs must be unique" },
  ),
  failureCodes: z.array(z.enum(ANALYSIS_AGENT_RELEASE_FAILURE_CODES)).refine(
    (codes) => new Set(codes).size === codes.length,
    { message: "Failure codes must be unique" },
  ),
  createdAt: z.string().datetime(),
}).superRefine((decision, context) => {
  if (decision.organizationId !== decision.candidate.organizationId) {
    context.addIssue({
      code: "custom",
      path: ["candidate", "organizationId"],
      message: "Decision and candidate organizations must match",
    });
  }
  if (decision.module !== decision.candidate.module) {
    context.addIssue({
      code: "custom",
      path: ["candidate", "module"],
      message: "Decision and candidate modules must match",
    });
  }
  if (decision.candidateDigest !== analysisAgentReleaseCandidateDigest(decision.candidate)) {
    context.addIssue({
      code: "custom",
      path: ["candidateDigest"],
      message: "Candidate digest does not match candidate provenance",
    });
  }
  if (
    (decision.status === "approved" && decision.failureCodes.length !== 0) ||
    (decision.status === "rejected" && decision.failureCodes.length === 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["failureCodes"],
      message: "Release decision status and failure codes are inconsistent",
    });
  }
  if (
    decision.status === "approved" &&
    decision.ratingIds.length !== REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["ratingIds"],
      message: "Approved release decision requires five rating IDs",
    });
  }
});

export type AnalysisAgentReleaseCandidate = Readonly<
  z.infer<typeof AnalysisAgentReleaseCandidateSchema>
>;
export type AnalysisAgentReleaseDecision = Readonly<
  z.infer<typeof AnalysisAgentReleaseDecisionSchema>
>;
export type AnalysisAgentReleaseCaseEvidence = Readonly<
  z.infer<typeof AnalysisAgentReleaseCaseEvidenceSchema>
>;
type ParsedAnalysisAgentReleaseSubmission = z.infer<
  typeof AnalysisAgentReleaseSubmissionSchema
>;
export type AnalysisAgentReleaseSubmission = Readonly<
  Omit<ParsedAnalysisAgentReleaseSubmission, "caseEvidence" | "ratingIds"> & {
    caseEvidence: readonly AnalysisAgentReleaseCaseEvidence[];
    ratingIds: readonly string[];
  }
>;

export interface AnalysisAgentReleaseDecisionRepository {
  evaluateAndAppendAnalysisAgentReleaseDecision(
    submission: AnalysisAgentReleaseSubmission,
  ): Promise<AnalysisAgentReleaseDecision>;
  findAnalysisAgentReleaseDecision(input: Readonly<{
    organizationId: string;
    decisionId: string;
  }>): Promise<AnalysisAgentReleaseDecision | null>;
}

export class AnalysisAgentReleaseDecisionNotApprovedError extends Error {
  constructor() {
    super("Approved analysis release decision not found");
    this.name = "AnalysisAgentReleaseDecisionNotApprovedError";
  }
}

export class AnalysisAgentReleaseEvidenceNotFoundError extends Error {
  constructor() {
    super("Complete persisted analysis release evidence was not found");
    this.name = "AnalysisAgentReleaseEvidenceNotFoundError";
  }
}

export async function resolveAnalysisAgentReleaseDecision(
  repository: Pick<
    AnalysisAgentReleaseDecisionRepository,
    "findAnalysisAgentReleaseDecision"
  >,
  input: Readonly<{ organizationId: string; decisionId: string }>,
): Promise<AnalysisAgentReleaseDecision | null> {
  try {
    return await repository.findAnalysisAgentReleaseDecision(input);
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function createAnalysisAgentReleaseCandidate(
  input: unknown,
): AnalysisAgentReleaseCandidate {
  return deepFreeze(AnalysisAgentReleaseCandidateSchema.parse(input));
}

export function createAnalysisAgentReleaseDecision(
  input: unknown,
): AnalysisAgentReleaseDecision {
  return deepFreeze(AnalysisAgentReleaseDecisionSchema.parse(input));
}

export function createAnalysisAgentReleaseSubmission(
  input: unknown,
): AnalysisAgentReleaseSubmission {
  return deepFreeze(
    AnalysisAgentReleaseSubmissionSchema.parse(input),
  ) as AnalysisAgentReleaseSubmission;
}

export function analysisAgentReleaseCandidateDigest(
  candidate: AnalysisAgentReleaseCandidate,
) {
  return canonicalJsonSha256(AnalysisAgentReleaseCandidateSchema.parse(candidate));
}

export function evaluateAnalysisAgentRelease(input: Readonly<{
  id: string;
  actorUserId: string;
  createdAt: string;
  candidate: unknown;
  autoResults: readonly unknown[];
  humanRatings: readonly unknown[];
}>): AnalysisAgentReleaseDecision {
  const candidate = createAnalysisAgentReleaseCandidate(input.candidate);
  const candidateDigest = analysisAgentReleaseCandidateDigest(candidate);
  const parsedAuto = input.autoResults.flatMap((value) => {
    const parsed = AutoResultSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const parsedRatings = input.humanRatings.flatMap((value) => {
    const parsed = AnalysisAgentHumanRatingSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

  const autoCaseCoverageValid =
    parsedAuto.length === REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.length &&
    input.autoResults.length === parsedAuto.length &&
    exactCoverage(parsedAuto.map((result) => result.caseId), REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS);
  const autoCandidateMatches = parsedAuto.length === input.autoResults.length &&
    parsedAuto.every((result) =>
      result.evalSetVersion === candidate.evalSetVersion &&
      result.candidateDigest === candidateDigest,
    );
  const autoGateCoverageValid = parsedAuto.length === input.autoResults.length &&
    parsedAuto.every((result) =>
      exactCoverage(result.gates.map((gate) => gate.id), ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS),
    );
  const autoGatesPass = parsedAuto.length === input.autoResults.length &&
    parsedAuto.every((result) =>
      result.passed && result.gates.every((gate) => gate.passed && gate.ruleIds.length === 0),
    );

  const humanCaseCoverageValid =
    parsedRatings.length === REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.length &&
    input.humanRatings.length === parsedRatings.length &&
    exactCoverage(parsedRatings.map((rating) => rating.caseId), REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS) &&
    new Set(parsedRatings.map((rating) => rating.id)).size === parsedRatings.length &&
    new Set(parsedRatings.map((rating) => rating.reportId)).size === parsedRatings.length;
  const humanCandidateMatches = parsedRatings.length === input.humanRatings.length &&
    parsedRatings.every((rating) =>
      rating.organizationId === candidate.organizationId &&
      rating.module === candidate.module &&
      rating.evalSetVersion === candidate.evalSetVersion &&
      canonicalJsonSha256(rating.skill) === canonicalJsonSha256(candidate.skill) &&
      canonicalJsonSha256(rating.model) === canonicalJsonSha256(candidate.model),
    );
  const humanScoresPass = parsedRatings.length === input.humanRatings.length &&
    parsedRatings.every((rating) =>
      ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.every(
        (dimension) => rating.scores[dimension] >= 4,
      ),
    );

  const checks = {
    "auto-case-coverage-invalid": !autoCaseCoverageValid,
    "auto-candidate-mismatch": !autoCandidateMatches,
    "auto-gate-coverage-invalid": !autoGateCoverageValid,
    "auto-gate-failed": !autoGatesPass,
    "human-case-coverage-invalid": !humanCaseCoverageValid,
    "human-candidate-mismatch": !humanCandidateMatches,
    "human-score-below-threshold": !humanScoresPass,
  } satisfies Record<typeof ANALYSIS_AGENT_RELEASE_FAILURE_CODES[number], boolean>;
  const failureCodes = ANALYSIS_AGENT_RELEASE_FAILURE_CODES.filter((code) => checks[code]);
  const normalizedAuto = [...parsedAuto].sort(compareCaseRecords).map((result) => ({
    ...result,
    gates: [...result.gates].sort((left, right) =>
      ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS.indexOf(left.id) -
      ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS.indexOf(right.id)),
  }));
  const normalizedRatings = [...parsedRatings].sort(compareCaseRecords);

  return createAnalysisAgentReleaseDecision({
    schemaVersion: "1.0.0",
    id: input.id,
    organizationId: candidate.organizationId,
    actorUserId: input.actorUserId,
    module: candidate.module,
    status: failureCodes.length === 0 ? "approved" : "rejected",
    candidate,
    candidateDigest,
    autoResultsDigest: canonicalJsonSha256({
      invalidCount: input.autoResults.length - parsedAuto.length,
      results: normalizedAuto,
    }),
    humanRatingsDigest: canonicalJsonSha256({
      invalidCount: input.humanRatings.length - parsedRatings.length,
      ratings: normalizedRatings,
    }),
    ratingIds: [...new Set(parsedRatings.map((rating) => rating.id))].sort(),
    failureCodes,
    createdAt: input.createdAt,
  });
}

export function evaluateAnalysisAgentReleaseEvidence(input: Readonly<{
  submission: unknown;
  humanRatings: readonly unknown[];
}>): AnalysisAgentReleaseDecision {
  const submission = createAnalysisAgentReleaseSubmission(input.submission);
  const candidateDigest = analysisAgentReleaseCandidateDigest(submission.candidate);
  const evaluationSet = buildAnalysisAgentEvaluationSet();
  const autoResults = submission.caseEvidence.map((evidence) => ({
    ...evaluateAnalysisAgentCandidate({
      case: evaluationSet.casesById[evidence.caseId],
      candidate: evidence.candidate,
      observation: evidence.observation,
    }),
    candidateDigest,
  }));
  return evaluateAnalysisAgentRelease({
    id: submission.id,
    actorUserId: submission.actorUserId,
    createdAt: submission.createdAt,
    candidate: submission.candidate,
    autoResults,
    humanRatings: input.humanRatings,
  });
}

function exactCoverage(
  actual: readonly string[],
  expected: readonly string[],
) {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value));
}

function compareCaseRecords(
  left: Readonly<{ caseId: string }>,
  right: Readonly<{ caseId: string }>,
) {
  const caseDifference =
    REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.indexOf(left.caseId as never) -
    REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.indexOf(right.caseId as never);
  if (caseDifference !== 0) return caseDifference;
  return canonicalJsonSha256(left).localeCompare(canonicalJsonSha256(right));
}

const ResolvedModeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    module: ModuleSchema,
    mode: z.literal("legacy-primary"),
    source: z.enum(["event", "default", "read-error"]),
  }),
  z.strictObject({
    module: ModuleSchema,
    mode: z.literal("agent-shadow"),
    source: z.literal("event"),
  }),
  z.strictObject({
    module: ModuleSchema,
    mode: z.literal("agent-primary"),
    source: z.literal("event"),
    releaseDecisionId: EntityIdSchema,
    candidateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);

export function selectReleasedAnalysisAgentModuleResult<TLegacy, TAgent>(input: Readonly<{
  control?: unknown;
  releaseDecision?: unknown;
  candidate?: unknown;
  agentReport?: unknown;
  legacyResult: TLegacy;
}>) {
  const control = ResolvedModeSchema.safeParse(input.control);
  const report = AnalysisReportSchema.safeParse(input.agentReport);
  const vocResult = report.success
    ? VocPositioningOutputShapeSchema.safeParse(report.data.result)
    : null;
  const reportEligible = report.success &&
    vocResult?.success === true &&
    report.data.stage === "voc-positioning" &&
    report.data.status === "complete";
  const legacy = () => Object.freeze({
    mode: "legacy-primary" as const,
    publicPrimary: Object.freeze({ kind: "legacy" as const, result: input.legacyResult }),
    shadowComparison: null,
  });
  if (!control.success) return legacy();
  if (control.data.mode === "agent-shadow") {
    return Object.freeze({
      mode: "agent-shadow" as const,
      publicPrimary: Object.freeze({ kind: "legacy" as const, result: input.legacyResult }),
      shadowComparison: reportEligible
        ? Object.freeze({ kind: "agent" as const, result: vocResult.data as TAgent })
        : null,
    });
  }
  if (control.data.mode !== "agent-primary") return legacy();

  const decision = AnalysisAgentReleaseDecisionSchema.safeParse(input.releaseDecision);
  const candidate = AnalysisAgentReleaseCandidateSchema.safeParse(input.candidate);
  if (!decision.success || !candidate.success || !reportEligible) return legacy();
  const digest = analysisAgentReleaseCandidateDigest(candidate.data);
  const provenanceMatches =
    decision.data.status === "approved" &&
    decision.data.id === control.data.releaseDecisionId &&
    decision.data.candidateDigest === control.data.candidateDigest &&
    digest === control.data.candidateDigest &&
    canonicalJsonSha256(decision.data.candidate) === canonicalJsonSha256(candidate.data) &&
    canonicalJsonSha256(report.data.skill) === canonicalJsonSha256(candidate.data.skill) &&
    report.data.model.provider === candidate.data.model.provider &&
    report.data.model.model === candidate.data.model.model;
  if (!provenanceMatches) return legacy();
  return Object.freeze({
    mode: "agent-primary" as const,
    publicPrimary: Object.freeze({ kind: "agent" as const, result: vocResult.data as TAgent }),
    shadowComparison: null,
  });
}
