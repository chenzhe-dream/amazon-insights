import { z } from "zod";

import {
  VocPositioningOutputShapeSchema,
  createVocPositioningOutputSchemaFromSkillInput,
  isVocPositioningValidationRuleId,
  type VocPositioningValidationRuleId,
} from "../domain/voc/voc-positioning-contracts";
import {
  ANALYSIS_AGENT_EVAL_SET_VERSION,
  type AnalysisAgentEvalCase,
} from "./analysis-agent-eval-set";

export const ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS = [
  "schema-valid",
  "deterministic-values-match",
  "evidence-resolves",
  "data-boundary-preserved",
  "no-fabricated-data",
  "safety-not-downgraded",
  "missing-input-marked",
  "failure-fallback-effective",
  "history-version-immutable",
] as const;

export type AnalysisAgentAutoEvaluatorGateId =
  typeof ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS[number];

export type AnalysisAgentAutoEvaluatorReportSnapshot = Readonly<{
  id: string;
  version: number;
  contentDigest: string;
}>;

export type AnalysisAgentAutoEvaluatorObservation = Readonly<{
  providerDispatched: boolean;
  terminalStatus: "succeeded" | "failed" | "waiting-input";
  selectedFallbackResult: boolean;
  reportsBefore: readonly AnalysisAgentAutoEvaluatorReportSnapshot[];
  reportsAfter: readonly AnalysisAgentAutoEvaluatorReportSnapshot[];
}>;

export type AnalysisAgentAutoEvaluatorGate = Readonly<{
  id: AnalysisAgentAutoEvaluatorGateId;
  passed: boolean;
  ruleIds: readonly string[];
}>;

export type AnalysisAgentAutoEvaluatorResult = Readonly<{
  evalSetVersion: typeof ANALYSIS_AGENT_EVAL_SET_VERSION;
  caseId: AnalysisAgentEvalCase["id"];
  passed: boolean;
  gates: readonly AnalysisAgentAutoEvaluatorGate[];
}>;

const ReportSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

const ObservationSchema = z.strictObject({
  providerDispatched: z.boolean(),
  terminalStatus: z.enum(["succeeded", "failed", "waiting-input"]),
  selectedFallbackResult: z.boolean(),
  reportsBefore: z.array(ReportSnapshotSchema),
  reportsAfter: z.array(ReportSnapshotSchema),
});

const DETERMINISTIC_RULE_IDS = new Set<VocPositioningValidationRuleId>([
  "voc-identity-mismatch",
  "voc-status-mismatch",
  "voc-theme-label-mismatch",
  "voc-theme-priority-mismatch",
  "voc-theme-metrics-mismatch",
  "voc-theme-evidence-mismatch",
]);

const EVIDENCE_RULE_IDS = new Set<VocPositioningValidationRuleId>([
  "voc-evidence-missing-for-reference",
  "voc-forged-theme-reference",
  "voc-theme-evidence-mismatch",
  "voc-dangling-evidence",
  "voc-evidence-crosses-theme-boundary",
  "voc-duplicate-result-reference",
]);

const DATA_BOUNDARY_RULE_IDS = new Set<VocPositioningValidationRuleId>([
  "voc-coverage-mismatch",
  "voc-status-mismatch",
  "voc-all-missing-facts",
  "voc-decision-boundaries-mismatch",
  "voc-positioning-dimension-incomplete",
  "voc-positioning-strategy-stance-mismatch",
  "voc-price-tier-requires-validation",
]);

const FABRICATION_RULE_IDS = new Set<VocPositioningValidationRuleId>([
  "voc-identity-mismatch",
  "voc-forged-theme-judgment",
  "voc-forged-theme-reference",
  "voc-dangling-evidence",
  "voc-evidence-crosses-theme-boundary",
  "voc-theme-metrics-mismatch",
  "voc-theme-evidence-mismatch",
]);

const SAFETY_RULE_IDS = new Set<VocPositioningValidationRuleId>([
  "voc-protected-core-strategy-downgrade",
  "voc-protected-priority-downgrade",
  "voc-protected-positioning-strategy-downgrade",
  "voc-theme-priority-mismatch",
  "voc-protected-role-downgrade",
  "voc-protected-theme-judgment-missing",
  "voc-protected-action-downgrade",
  "voc-protected-theme-action-missing",
]);

export function evaluateAnalysisAgentCandidate(input: Readonly<{
  case: AnalysisAgentEvalCase;
  candidate: unknown;
  observation: unknown;
}>): AnalysisAgentAutoEvaluatorResult {
  const evalCase = input.case;
  const observationParse = ObservationSchema.safeParse(input.observation);
  const observation = observationParse.success ? observationParse.data : null;
  const blocked = evalCase.snapshot.input.kind === "dependency-blocked-input";
  const structuralRuleIds = blocked
    ? []
    : structuralValidationRuleIds(input.candidate);
  const semanticRuleIds = !blocked && structuralRuleIds.length === 0
    ? semanticValidationRuleIds(evalCase, input.candidate)
    : [];

  const missingInputMarked = blocked
    ? observation !== null &&
      input.candidate === undefined &&
      observation.providerDispatched === false &&
      observation.terminalStatus === "waiting-input" &&
      evalCase.snapshot.input.missingDependencies.includes("voc") &&
      evalCase.snapshot.input.missingDependencies.includes("keywords")
    : true;
  const fallbackEffective = observation !== null && (blocked
    ? observation.selectedFallbackResult === true &&
      observation.terminalStatus === "waiting-input"
    : observation.terminalStatus === "succeeded" ||
      observation.selectedFallbackResult === true);
  const observationRuleIds = observation === null ? ["observation-invalid"] : [];

  const gateStates: Record<AnalysisAgentAutoEvaluatorGateId, readonly string[]> = {
    "schema-valid": structuralRuleIds,
    "deterministic-values-match": matchingRules(semanticRuleIds, DETERMINISTIC_RULE_IDS),
    "evidence-resolves": matchingRules(semanticRuleIds, EVIDENCE_RULE_IDS),
    "data-boundary-preserved": matchingRules(semanticRuleIds, DATA_BOUNDARY_RULE_IDS),
    "no-fabricated-data": matchingRules(semanticRuleIds, FABRICATION_RULE_IDS),
    "safety-not-downgraded": matchingRules(semanticRuleIds, SAFETY_RULE_IDS),
    "missing-input-marked": missingInputMarked
      ? []
      : [...observationRuleIds, "missing-input-not-marked"],
    "failure-fallback-effective": fallbackEffective
      ? []
      : [...observationRuleIds, "fallback-not-effective"],
    "history-version-immutable": observation !== null &&
      historyIsImmutable(observation.reportsBefore, observation.reportsAfter)
      ? []
      : [...observationRuleIds, "history-version-mutated"],
  };

  const gates = ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS.map((id) => ({
    id,
    passed: gateStates[id].length === 0,
    ruleIds: gateStates[id],
  }));

  return {
    evalSetVersion: ANALYSIS_AGENT_EVAL_SET_VERSION,
    caseId: evalCase.id,
    passed: gates.every((gate) => gate.passed),
    gates,
  };
}

function structuralValidationRuleIds(candidate: unknown): readonly string[] {
  return VocPositioningOutputShapeSchema.safeParse(candidate).success
    ? []
    : ["schema-invalid"];
}

function semanticValidationRuleIds(
  evalCase: AnalysisAgentEvalCase,
  candidate: unknown,
): readonly VocPositioningValidationRuleId[] {
  if (evalCase.snapshot.input.kind !== "voc-positioning-input") {
    return [];
  }
  const parsed = createVocPositioningOutputSchemaFromSkillInput(
    evalCase.snapshot.input,
  ).safeParse(candidate);
  if (parsed.success) return [];

  return [...new Set(parsed.error.issues.flatMap((issue) => {
    const ruleId = issue.code === "custom"
      ? (issue as { params?: { ruleId?: unknown } }).params?.ruleId
      : undefined;
    return isVocPositioningValidationRuleId(ruleId) ? [ruleId] : [];
  }))];
}

function matchingRules(
  ruleIds: readonly VocPositioningValidationRuleId[],
  gateRules: ReadonlySet<VocPositioningValidationRuleId>,
) {
  return ruleIds.filter((ruleId) => gateRules.has(ruleId));
}

function historyIsImmutable(
  before: readonly AnalysisAgentAutoEvaluatorReportSnapshot[],
  after: readonly AnalysisAgentAutoEvaluatorReportSnapshot[],
) {
  if (!reportsHaveStableIdentity(before) || !reportsHaveStableIdentity(after)) {
    return false;
  }

  if (after.length < before.length) return false;
  for (const [index, prior] of before.entries()) {
    const current = after[index];
    if (
      current === undefined ||
      current.id !== prior.id ||
      current.version !== prior.version ||
      current.contentDigest !== prior.contentDigest
    ) {
      return false;
    }
  }

  const maxBeforeVersion = Math.max(0, ...before.map((report) => report.version));
  let lastVersion = maxBeforeVersion;
  for (const report of after.slice(before.length)) {
    if (report.version <= maxBeforeVersion || report.version <= lastVersion) {
      return false;
    }
    lastVersion = report.version;
  }
  return true;
}

function reportsHaveStableIdentity(
  reports: readonly AnalysisAgentAutoEvaluatorReportSnapshot[],
) {
  const ids = new Set<string>();
  const versions = new Set<number>();
  let lastVersion = 0;
  for (const report of reports) {
    if (
      report.id.length === 0 ||
      !Number.isInteger(report.version) ||
      report.version <= 0 ||
      report.version <= lastVersion ||
      !/^[0-9a-f]{64}$/.test(report.contentDigest) ||
      ids.has(report.id) ||
      versions.has(report.version)
    ) {
      return false;
    }
    ids.add(report.id);
    versions.add(report.version);
    lastVersion = report.version;
  }
  return true;
}
