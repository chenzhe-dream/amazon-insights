import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS,
  type AnalysisAgentAutoEvaluatorResult,
} from "../../server/evaluation/analysis-agent-auto-evaluator";
import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  createAnalysisAgentHumanRating,
} from "../../server/evaluation/analysis-agent-human-review";
import {
  analysisAgentReleaseCandidateDigest,
  createAnalysisAgentReleaseDecision,
  createAnalysisAgentReleaseCandidate,
  evaluateAnalysisAgentRelease,
  resolveAnalysisAgentReleaseDecision,
  selectReleasedAnalysisAgentModuleResult,
  type AnalysisAgentReleaseDecisionRepository,
} from "../../server/evaluation/analysis-agent-release-gate";
import { REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS } from "../../server/evaluation/analysis-agent-evaluation-contract";
import { validAnalysisAgentVocResult } from "./helpers/analysis-agent-release-fixture";

const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000001";
const ACTOR_ID = "30000000-0000-4000-8000-000000000002";
const SKILL = {
  id: "define-amazon-voc-positioning",
  version: "1.0.0",
  contentHash: "a".repeat(64),
};
const MODEL = { provider: "openai", model: "gpt-release-fixture" };

type AutoEvidence = AnalysisAgentAutoEvaluatorResult & Readonly<{
  candidateDigest: string;
}>;

function candidate() {
  return createAnalysisAgentReleaseCandidate({
    schemaVersion: "1.0.0",
    organizationId: ORGANIZATION_ID,
    module: "voc-positioning",
    skill: SKILL,
    model: MODEL,
    evalSetVersion: "openspec-9.1.0",
  });
}

function autoResult(
  caseId: typeof REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS[number],
  overrides: Partial<AutoEvidence> = {},
): AutoEvidence {
  return {
    candidateDigest: analysisAgentReleaseCandidateDigest(candidate()),
    evalSetVersion: "openspec-9.1.0",
    caseId,
    passed: true,
    gates: ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS.map((id) => ({
      id,
      passed: true,
      ruleIds: [],
    })),
    ...overrides,
  };
}

function allAutoResults() {
  return REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.map((caseId) => autoResult(caseId));
}

function rating(
  caseId: typeof REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS[number],
  index: number,
  overrides: Record<string, unknown> = {},
) {
  return createAnalysisAgentHumanRating({
    id: `30000000-0000-4000-8000-${(100 + index).toString().padStart(12, "0")}`,
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    module: "voc-positioning",
    evalSetVersion: "openspec-9.1.0",
    caseId,
    skill: SKILL,
    model: MODEL,
    reportId: `30000000-0000-4000-8000-${(200 + index).toString().padStart(12, "0")}`,
    scores: Object.fromEntries(
      ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.map((dimension) => [dimension, 4]),
    ),
    createdAt: "2026-08-18T12:00:00.000Z",
    ...overrides,
  });
}

function allRatings() {
  return REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS.map((caseId, index) =>
    rating(caseId, index + 1),
  );
}

function savedVocReport() {
  return {
    schemaVersion: "1.0.0",
    id: "30000000-0000-4000-8000-000000000301",
    runId: "30000000-0000-4000-8000-000000000302",
    agentRunId: "30000000-0000-4000-8000-000000000303",
    version: 1,
    stage: "voc-positioning",
    status: "complete",
    skill: SKILL,
    snapshotIds: ["30000000-0000-4000-8000-000000000304"],
    model: { ...MODEL, responseId: "response-release-fixture" },
    dataCutoffAt: "2026-08-18T12:00:00.000Z",
    evidence: [{
      id: "evidence-voc-release",
      type: "report",
      sourceId: "30000000-0000-4000-8000-000000000304",
      capturedAt: "2026-08-18T12:00:00.000Z",
    }],
    result: validAnalysisAgentVocResult(),
    createdAt: "2026-08-18T12:05:00.000Z",
  };
}

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateAnalysisAgentRelease({
    id: "30000000-0000-4000-8000-000000000010",
    actorUserId: ACTOR_ID,
    createdAt: "2026-08-18T12:30:00.000Z",
    candidate: candidate(),
    autoResults: allAutoResults(),
    humanRatings: allRatings(),
    ...overrides,
  });
}

test("complete automatic and per-dimension human gates approve a stable release candidate", () => {
  const first = evaluate();
  const reordered = evaluate({
    autoResults: allAutoResults().reverse().map((result) => ({
      ...result,
      gates: [...result.gates].reverse(),
    })),
    humanRatings: allRatings().reverse(),
  });

  assert.equal(first.status, "approved");
  assert.deepEqual(first.failureCodes, []);
  assert.equal(first.candidateDigest, analysisAgentReleaseCandidateDigest(candidate()));
  assert.match(first.candidateDigest, /^[0-9a-f]{64}$/);
  assert.match(first.autoResultsDigest, /^[0-9a-f]{64}$/);
  assert.match(first.humanRatingsDigest, /^[0-9a-f]{64}$/);
  assert.equal(first.autoResultsDigest, reordered.autoResultsDigest);
  assert.equal(first.humanRatingsDigest, reordered.humanRatingsDigest);
  assert.deepEqual(first.ratingIds, reordered.ratingIds);
  assert.ok(Object.isFrozen(first));
  assert.throws(
    () => createAnalysisAgentReleaseDecision({ ...first, ratingIds: [] }),
    /rating/i,
  );
  assert.throws(
    () => createAnalysisAgentReleaseCandidate({
      ...candidate(),
      evalSetVersion: "openspec-fabricated",
    }),
    /evalSetVersion|invalid/i,
  );
});

test("automatic results require five unique cases and nine unique passing gates with empty rules", () => {
  const missing = evaluate({ autoResults: allAutoResults().slice(1) });
  assert.equal(missing.status, "rejected");
  assert.ok(missing.failureCodes.includes("auto-case-coverage-invalid"));

  const duplicated = evaluate({
    autoResults: [...allAutoResults(), autoResult("scooter-complete")],
  });
  assert.ok(duplicated.failureCodes.includes("auto-case-coverage-invalid"));

  const incompleteGates = allAutoResults();
  incompleteGates[0] = { ...incompleteGates[0]!, gates: incompleteGates[0]!.gates.slice(1) };
  assert.ok(evaluate({ autoResults: incompleteGates }).failureCodes.includes("auto-gate-coverage-invalid"));

  const failedGate = allAutoResults();
  failedGate[0] = {
    ...failedGate[0]!,
    gates: failedGate[0]!.gates.map((gate, index) => index === 0
      ? { ...gate, passed: false, ruleIds: ["schema-invalid"] }
      : gate),
  };
  assert.ok(evaluate({ autoResults: failedGate }).failureCodes.includes("auto-gate-failed"));

  const hiddenRule = allAutoResults();
  hiddenRule[0] = {
    ...hiddenRule[0]!,
    gates: hiddenRule[0]!.gates.map((gate, index) => index === 0
      ? { ...gate, ruleIds: ["unexpected-rule"] }
      : gate),
  };
  assert.ok(evaluate({ autoResults: hiddenRule }).failureCodes.includes("auto-gate-failed"));

  const wrongEvalSet = allAutoResults();
  wrongEvalSet[0] = { ...wrongEvalSet[0]!, evalSetVersion: "openspec-old" as never };
  assert.ok(evaluate({ autoResults: wrongEvalSet }).failureCodes.includes("auto-candidate-mismatch"));

  const wrongCandidate = allAutoResults();
  wrongCandidate[0] = { ...wrongCandidate[0]!, candidateDigest: "f".repeat(64) };
  assert.ok(evaluate({ autoResults: wrongCandidate }).failureCodes.includes("auto-candidate-mismatch"));
});

test("human approval requires five unique candidate-matched ratings and every dimension at least four", () => {
  assert.ok(evaluate({ humanRatings: allRatings().slice(1) }).failureCodes.includes("human-case-coverage-invalid"));
  assert.ok(evaluate({ humanRatings: [...allRatings(), allRatings()[0]!] }).failureCodes.includes("human-case-coverage-invalid"));

  const duplicateReport = allRatings();
  duplicateReport[1] = createAnalysisAgentHumanRating({
    ...duplicateReport[1]!,
    reportId: duplicateReport[0]!.reportId,
  });
  assert.ok(evaluate({ humanRatings: duplicateReport }).failureCodes.includes("human-case-coverage-invalid"));

  const lowDimension = allRatings();
  lowDimension[0] = createAnalysisAgentHumanRating({
    ...lowDimension[0]!,
    scores: { ...lowDimension[0]!.scores, accuracy: 3 },
  });
  assert.ok(evaluate({ humanRatings: lowDimension }).failureCodes.includes("human-score-below-threshold"));

  const wrongCandidate = allRatings();
  wrongCandidate[0] = createAnalysisAgentHumanRating({
    ...wrongCandidate[0]!,
    model: { provider: "openai", model: "different-model" },
  });
  assert.ok(evaluate({ humanRatings: wrongCandidate }).failureCodes.includes("human-candidate-mismatch"));
});

test("agent becomes public primary only when control decision candidate and report provenance all match", () => {
  const decision = evaluate();
  const releaseCandidate = candidate();
  const candidateDigest = analysisAgentReleaseCandidateDigest(releaseCandidate);
  const valid = {
    control: {
      module: "voc-positioning",
      mode: "agent-primary",
      source: "event",
      releaseDecisionId: decision.id,
      candidateDigest,
    },
    releaseDecision: decision,
    candidate: releaseCandidate,
    agentReport: savedVocReport(),
    legacyResult: "legacy-result",
  };

  assert.deepEqual(selectReleasedAnalysisAgentModuleResult(valid), {
    mode: "agent-primary",
    publicPrimary: { kind: "agent", result: validAnalysisAgentVocResult() },
    shadowComparison: null,
  });

  for (const mutation of [
    { releaseDecision: undefined },
    { candidate: undefined },
    { agentReport: undefined },
    { control: { ...valid.control, candidateDigest: "f".repeat(64) } },
    { releaseDecision: { ...decision, status: "rejected", failureCodes: ["auto-gate-failed"] } },
    { agentReport: { ...valid.agentReport, status: "stale" } },
    { agentReport: { ...valid.agentReport, stage: "traffic-analysis" } },
    { agentReport: { ...valid.agentReport, result: {} } },
    { agentReport: { ...valid.agentReport, result: { kind: "traffic-analysis-result" } } },
    { agentReport: { ...valid.agentReport, model: { ...MODEL, model: "different-model" } } },
    { control: { ...valid.control, unexpected: true } },
  ]) {
    assert.equal(
      selectReleasedAnalysisAgentModuleResult({ ...valid, ...mutation }).publicPrimary.kind,
      "legacy",
    );
  }
});

test("legacy and shadow modes remain fail-closed before or after a release decision", () => {
  const common = {
    releaseDecision: evaluate(),
    candidate: candidate(),
    agentReport: savedVocReport(),
    legacyResult: "legacy-result",
  };
  assert.deepEqual(selectReleasedAnalysisAgentModuleResult({
    ...common,
    control: { module: "voc-positioning", mode: "legacy-primary", source: "read-error" },
  }), {
    mode: "legacy-primary",
    publicPrimary: { kind: "legacy", result: "legacy-result" },
    shadowComparison: null,
  });
  assert.deepEqual(selectReleasedAnalysisAgentModuleResult({
    ...common,
    control: { module: "voc-positioning", mode: "agent-shadow", source: "event" },
  }), {
    mode: "agent-shadow",
    publicPrimary: { kind: "legacy", result: "legacy-result" },
    shadowComparison: { kind: "agent", result: validAnalysisAgentVocResult() },
  });
});

test("release decision read errors resolve to no decision and keep legacy public", async () => {
  const repository = {
    findAnalysisAgentReleaseDecision: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as AnalysisAgentReleaseDecisionRepository;
  const releaseDecision = await resolveAnalysisAgentReleaseDecision(repository, {
    organizationId: ORGANIZATION_ID,
    decisionId: "30000000-0000-4000-8000-000000000010",
  });
  assert.equal(releaseDecision, null);
  const releaseCandidate = candidate();
  assert.equal(selectReleasedAnalysisAgentModuleResult({
    control: {
      module: "voc-positioning",
      mode: "agent-primary",
      source: "event",
      releaseDecisionId: "30000000-0000-4000-8000-000000000010",
      candidateDigest: analysisAgentReleaseCandidateDigest(releaseCandidate),
    },
    releaseDecision,
    candidate: releaseCandidate,
    agentReport: {
      stage: "voc-positioning",
      skill: SKILL,
      model: MODEL,
      result: "agent-result",
    },
    legacyResult: "legacy-result",
  }).publicPrimary.kind, "legacy");
});
