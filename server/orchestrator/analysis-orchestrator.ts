import type {
  RunStageStatus,
  StageName,
} from "../../shared/agent-contracts";
import {
  stageDefinitions,
  type StageDependency,
} from "./stage-definitions";

export interface PlannedStage {
  readonly name: StageName;
  readonly status: RunStageStatus;
  readonly resultVersion: string | null;
}

export type KeywordAnalysisArtifact =
  | Readonly<{ available: false; version: null }>
  | Readonly<{ available: true; version: string }>;

export type StageSelection =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "stage-rerun"; stage: StageName }>;

export interface OrchestrationPlan {
  readonly stages: readonly PlannedStage[];
  readonly artifacts: Readonly<{
    keywordAnalysis: KeywordAnalysisArtifact;
  }>;
  readonly selection: StageSelection;
}

function dependencySatisfied(
  dependency: StageDependency,
  plan: OrchestrationPlan,
  stagesByName: ReadonlyMap<StageName, PlannedStage>,
): boolean {
  if (dependency.kind === "stage") {
    return stagesByName.get(dependency.stage)?.status === "succeeded";
  }
  if (dependency.artifact === "keyword-analysis") {
    return plan.artifacts.keywordAnalysis.available;
  }
  return false;
}

function isNormallyRunnable(stage: PlannedStage): boolean {
  return stage.status === "queued" || stage.status === "stale";
}

function isRerunnable(stage: PlannedStage): boolean {
  return stage.status !== "running" && stage.status !== "cancelled";
}

export function findRunnableStages(
  plan: OrchestrationPlan,
): readonly StageName[] {
  const stagesByName = new Map(
    plan.stages.map((stage) => [stage.name, stage] as const),
  );
  const runnable: StageName[] = [];

  for (const definition of stageDefinitions) {
    const stage = stagesByName.get(definition.name);
    if (!stage) continue;

    const selected =
      plan.selection.kind === "all"
        ? isNormallyRunnable(stage)
        : plan.selection.stage === stage.name && isRerunnable(stage);
    if (!selected) continue;
    if (
      definition.dependencies.every((dependency) =>
        dependencySatisfied(dependency, plan, stagesByName),
      )
    ) {
      runnable.push(stage.name);
    }
  }

  return Object.freeze(runnable);
}

function dependencyKey(dependency: StageDependency): string {
  return dependency.kind === "stage"
    ? `stage:${dependency.stage}`
    : `artifact:${dependency.artifact}`;
}

export function markDownstreamStale(
  stages: readonly PlannedStage[],
  changedDependencies: readonly StageDependency[],
): readonly PlannedStage[] {
  const changed = new Set(changedDependencies.map(dependencyKey));
  const staleStages = new Set<StageName>();

  for (const definition of stageDefinitions) {
    if (
      definition.dependencies.some((dependency) =>
        changed.has(dependencyKey(dependency)),
      )
    ) {
      staleStages.add(definition.name);
      changed.add(`stage:${definition.name}`);
    }
  }

  return Object.freeze(
    stages.map((stage) =>
      Object.freeze({
        ...stage,
        status:
          staleStages.has(stage.name) && stage.status === "succeeded"
            ? ("stale" as const)
            : stage.status,
      }),
    ),
  );
}

export class AnalysisOrchestrator {
  findRunnableStages(plan: OrchestrationPlan): readonly StageName[] {
    return findRunnableStages(plan);
  }

  markDownstreamStale(
    stages: readonly PlannedStage[],
    changedDependencies: readonly StageDependency[],
  ): readonly PlannedStage[] {
    return markDownstreamStale(stages, changedDependencies);
  }
}
