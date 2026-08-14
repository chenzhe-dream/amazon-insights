import type { StageName } from "../../shared/agent-contracts";

export type StageDependency =
  | Readonly<{ kind: "stage"; stage: StageName }>
  | Readonly<{ kind: "artifact"; artifact: "keyword-analysis" }>;

export interface StageDefinition {
  readonly name: StageName;
  readonly dependencies: readonly StageDependency[];
}

function definition(
  name: StageName,
  dependencies: readonly StageDependency[],
): Readonly<StageDefinition> {
  return Object.freeze({
    name,
    dependencies: Object.freeze(
      dependencies.map((dependency) => Object.freeze({ ...dependency })),
    ),
  });
}

export const stageDefinitions: readonly Readonly<StageDefinition>[] =
  Object.freeze([
    definition("traffic-analysis", []),
    definition("voc-positioning", []),
    definition("product-definition", [
      { kind: "stage", stage: "voc-positioning" },
      { kind: "artifact", artifact: "keyword-analysis" },
    ]),
  ]);
