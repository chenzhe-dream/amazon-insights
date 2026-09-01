import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalysisOrchestrator,
  findRunnableStages,
  markDownstreamStale,
  type OrchestrationPlan,
  type PlannedStage,
} from "../../server/orchestrator/analysis-orchestrator";
import { stageDefinitions } from "../../server/orchestrator/stage-definitions";
import type { StageName } from "../../shared/agent-contracts";

function stage(
  name: StageName,
  status: PlannedStage["status"] = "queued",
  resultVersion: string | null = null,
): PlannedStage {
  return Object.freeze({ name, status, resultVersion });
}

function plan(overrides: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return Object.freeze({
    stages: Object.freeze([
      stage("traffic-analysis"),
      stage("voc-positioning"),
      stage("product-definition"),
    ]),
    artifacts: Object.freeze({
      keywordAnalysis: Object.freeze({ available: false, version: null }),
    }),
    selection: Object.freeze({ kind: "all" as const }),
    ...overrides,
  });
}

test("the static graph keeps keyword analysis outside the four Agent stages", () => {
  assert.deepEqual(
    stageDefinitions.map((definition) => definition.name),
    [
      "traffic-analysis",
      "alexa-voc-normalization",
      "voc-positioning",
      "product-definition",
    ],
  );
  assert.deepEqual(stageDefinitions[3]?.dependencies, [
    { kind: "stage", stage: "voc-positioning" },
    { kind: "artifact", artifact: "keyword-analysis" },
  ]);
  assert.ok(Object.isFrozen(stageDefinitions));
});

test("a queued Alexa normalization stage is independently runnable", () => {
  assert.deepEqual(findRunnableStages(plan({
    stages: Object.freeze([stage("alexa-voc-normalization")]),
  })), ["alexa-voc-normalization"]);
});

test("traffic and VOC are runnable together at the start", () => {
  const input = plan();
  const runnable = findRunnableStages(input);

  assert.deepEqual(runnable, ["traffic-analysis", "voc-positioning"]);
  assert.ok(Object.isFrozen(runnable));
  assert.equal(input.stages[0]?.status, "queued");
});

test("product definition waits for both successful VOC and keyword analysis", () => {
  const vocOnly = plan({
    stages: Object.freeze([
      stage("traffic-analysis", "succeeded", "traffic-v1"),
      stage("voc-positioning", "succeeded", "voc-v1"),
      stage("product-definition"),
    ]),
  });
  assert.deepEqual(findRunnableStages(vocOnly), []);

  const keywordOnly = plan({
    stages: Object.freeze([
      stage("traffic-analysis", "failed"),
      stage("voc-positioning", "queued"),
      stage("product-definition"),
    ]),
    artifacts: Object.freeze({
      keywordAnalysis: Object.freeze({ available: true, version: "kw-v1" }),
    }),
  });
  assert.deepEqual(findRunnableStages(keywordOnly), ["voc-positioning"]);

  const complete = plan({
    stages: Object.freeze([
      stage("traffic-analysis", "failed"),
      stage("voc-positioning", "succeeded", "voc-v1"),
      stage("product-definition"),
    ]),
    artifacts: Object.freeze({
      keywordAnalysis: Object.freeze({ available: true, version: "kw-v1" }),
    }),
  });
  assert.deepEqual(findRunnableStages(complete), ["product-definition"]);
});

test("an independent stage failure preserves successful stages and their results", () => {
  const input = plan({
    stages: Object.freeze([
      stage("traffic-analysis", "failed"),
      stage("voc-positioning", "succeeded", "voc-v1"),
      stage("product-definition"),
    ]),
    artifacts: Object.freeze({
      keywordAnalysis: Object.freeze({ available: true, version: "kw-v1" }),
    }),
  });

  assert.deepEqual(findRunnableStages(input), ["product-definition"]);
  assert.deepEqual(input.stages[1], {
    name: "voc-positioning",
    status: "succeeded",
    resultVersion: "voc-v1",
  });
});

test("a single-stage rerun plans only the selected stage", () => {
  const input = plan({
    stages: Object.freeze([
      stage("traffic-analysis", "succeeded", "traffic-v1"),
      stage("voc-positioning", "succeeded", "voc-v1"),
      stage("product-definition", "succeeded", "product-v1"),
    ]),
    artifacts: Object.freeze({
      keywordAnalysis: Object.freeze({ available: true, version: "kw-v1" }),
    }),
    selection: Object.freeze({
      kind: "stage-rerun" as const,
      stage: "voc-positioning" as const,
    }),
  });

  const orchestrator = new AnalysisOrchestrator();
  assert.deepEqual(orchestrator.findRunnableStages(input), ["voc-positioning"]);
});

for (const changedDependency of [
  { kind: "stage" as const, stage: "voc-positioning" as const },
  { kind: "artifact" as const, artifact: "keyword-analysis" as const },
]) {
  test(`${changedDependency.kind} changes mark product definition stale without deleting its prior result`, () => {
    const input = plan({
      stages: Object.freeze([
        stage("traffic-analysis", "succeeded", "traffic-v1"),
        stage("voc-positioning", "succeeded", "voc-v1"),
        stage("product-definition", "succeeded", "product-v1"),
      ]),
      artifacts: Object.freeze({
        keywordAnalysis: Object.freeze({ available: true, version: "kw-v1" }),
      }),
    });

    const result = markDownstreamStale(input.stages, [changedDependency]);

    assert.notEqual(result, input.stages);
    assert.deepEqual(result[2], {
      name: "product-definition",
      status: "stale",
      resultVersion: "product-v1",
    });
    assert.equal(input.stages[2]?.status, "succeeded");
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result[2]));
  });
}
