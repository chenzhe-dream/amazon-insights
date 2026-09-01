import type { StageName } from "../../shared/agent-contracts";

export type StageDependency =
  | Readonly<{ kind: "stage"; stage: StageName }>
  | Readonly<{ kind: "artifact"; artifact: "keyword-analysis" }>;

export interface StageDefinition {
  readonly name: StageName;
  readonly creationPolicy: "initial" | "on-demand";
  readonly dependencies: readonly StageDependency[];
}

function definition(
  name: StageName,
  creationPolicy: StageDefinition["creationPolicy"],
  dependencies: readonly StageDependency[],
): Readonly<StageDefinition> {
  return Object.freeze({
    name,
    creationPolicy,
    dependencies: Object.freeze(
      dependencies.map((dependency) => Object.freeze({ ...dependency })),
    ),
  });
}

export const stageDefinitions: readonly Readonly<StageDefinition>[] =
  Object.freeze([
    definition("traffic-analysis", "initial", []),
    definition("alexa-voc-normalization", "on-demand", []),
    definition("voc-positioning", "initial", []),
    definition("product-definition", "initial", [
      { kind: "stage", stage: "voc-positioning" },
      { kind: "artifact", artifact: "keyword-analysis" },
    ]),
  ]);
