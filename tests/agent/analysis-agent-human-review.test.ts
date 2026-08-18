import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  createAnalysisAgentHumanRating,
  createAnalysisAgentModuleModeEvent,
  resolveAnalysisAgentModuleMode,
  selectAnalysisAgentModuleResult,
  type AnalysisAgentEvaluationControlRepository,
} from "../../server/evaluation/analysis-agent-human-review";

const ratingInput = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  actorUserId: "10000000-0000-4000-8000-000000000003",
  module: "voc-positioning" as const,
  evalSetVersion: "openspec-9.1.0",
  caseId: "scooter-complete" as const,
  skill: {
    id: "define-amazon-voc-positioning",
    version: "1.0.0",
    contentHash: "a".repeat(64),
  },
  model: { provider: "fixture", model: "deterministic" },
  reportId: "10000000-0000-4000-8000-000000000004",
  scores: Object.fromEntries(
    ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.map((dimension) => [dimension, 4]),
  ),
  comment: "Business reviewer baseline",
  createdAt: "2026-08-18T10:00:00.000Z",
};

test("human ratings require exactly the six closed dimensions with scores from 1 to 5", () => {
  const rating = createAnalysisAgentHumanRating(ratingInput);
  assert.deepEqual(Object.keys(rating.scores).sort(), [...ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS].sort());
  assert.ok(Object.isFrozen(rating));

  const { accuracy: _omitted, ...missingScore } = ratingInput.scores;
  assert.throws(
    () => createAnalysisAgentHumanRating({ ...ratingInput, scores: missingScore }),
    /required|invalid/i,
  );
  assert.throws(
    () => createAnalysisAgentHumanRating({
      ...ratingInput,
      scores: { ...ratingInput.scores, "future-dimension": 4 },
    }),
    /unrecognized|invalid/i,
  );
  assert.throws(
    () => createAnalysisAgentHumanRating({
      ...ratingInput,
      scores: { ...ratingInput.scores, accuracy: 6 },
    }),
    /too_big|invalid/i,
  );
});

test("9.3 module mode contract rejects agent-primary", () => {
  assert.throws(
    () => createAnalysisAgentModuleModeEvent({
      id: "10000000-0000-4000-8000-000000000011",
      organizationId: ratingInput.organizationId,
      actorUserId: ratingInput.actorUserId,
      module: "voc-positioning",
      mode: "agent-primary",
      reason: "not eligible in 9.3",
      createdAt: "2026-08-18T10:01:00.000Z",
    }),
    /invalid|option/i,
  );
});

test("result selection defaults and fails closed to the legacy public result", () => {
  const legacy = { source: "legacy", title: "deterministic" };
  const agent = { source: "agent", title: "candidate" };

  for (const control of [
    undefined,
    null,
    { mode: "agent-primary" },
    { mode: "damaged" },
    {
      module: "voc-positioning",
      mode: "agent-shadow",
      source: "event",
      unexpected: true,
    },
  ]) {
    assert.deepEqual(
      selectAnalysisAgentModuleResult({ control, legacyResult: legacy, agentResult: agent }),
      {
        mode: "legacy-primary",
        publicPrimary: { kind: "legacy", result: legacy },
        shadowComparison: null,
      },
    );
  }
});

test("agent-shadow retains an agent comparison while the public result stays legacy", () => {
  createAnalysisAgentModuleModeEvent({
    id: "10000000-0000-4000-8000-000000000012",
    organizationId: ratingInput.organizationId,
    actorUserId: ratingInput.actorUserId,
    module: "voc-positioning",
    mode: "agent-shadow",
    reason: "background comparison",
    createdAt: "2026-08-18T10:01:00.000Z",
  });
  const selected = selectAnalysisAgentModuleResult({
    control: {
      module: "voc-positioning",
      mode: "agent-shadow",
      source: "event",
    },
    legacyResult: "legacy",
    agentResult: "agent",
  });
  assert.deepEqual(selected, {
    mode: "agent-shadow",
    publicPrimary: { kind: "legacy", result: "legacy" },
    shadowComparison: { kind: "agent", result: "agent" },
  });

  const rolledBack = selectAnalysisAgentModuleResult({
    control: {
      module: "voc-positioning",
      mode: "legacy-primary",
      source: "event",
    },
    legacyResult: "legacy",
    agentResult: "agent",
  });
  assert.equal(rolledBack.mode, "legacy-primary");
  assert.equal(rolledBack.shadowComparison, null);
});

test("mode reads fail closed when repository access throws", async () => {
  const repository = {
    findLatestAnalysisAgentModuleMode: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as AnalysisAgentEvaluationControlRepository;

  assert.deepEqual(
    await resolveAnalysisAgentModuleMode(repository, {
      organizationId: ratingInput.organizationId,
      module: "voc-positioning",
    }),
    { module: "voc-positioning", mode: "legacy-primary", source: "read-error" },
  );
});
