import { z } from "zod";

import { StageNameSchema } from "../../shared/agent-contracts";
import { SchemaNameSchema } from "./manifest";
import type { SkillRegistry } from "./registry";

const AgentDependencySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: StageNameSchema }).strict(),
  z
    .object({ kind: z.literal("snapshot"), id: z.literal("keyword-analysis") })
    .strict(),
]);

export const AgentDefinitionSchema = z
  .object({
    id: StageNameSchema,
    skill: z
      .object({
        id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
      })
      .strict(),
    mode: z.literal("structured-analysis"),
    inputSchema: SchemaNameSchema,
    outputSchema: SchemaNameSchema,
    budget: z
      .object({
        maxInputTokens: z.number().int().min(1).max(200_000),
        maxOutputTokens: z.number().int().min(1).max(100_000),
        timeoutMs: z.number().int().min(1_000).max(300_000),
      })
      .strict(),
    dependencies: z.array(AgentDependencySchema),
  })
  .strict();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const agentDefinitions = [
  {
    id: "traffic-analysis",
    skill: { id: "analyze-amazon-competitor-traffic", version: "1.0.0" },
    mode: "structured-analysis",
    inputSchema: "CompetitorTrafficAnalysisInput@1.0.0",
    outputSchema: "CompetitorTrafficAnalysisOutput@1.0.0",
    budget: {
      maxInputTokens: 24_000,
      maxOutputTokens: 8_000,
      timeoutMs: 120_000,
    },
    dependencies: [],
  },
  {
    id: "voc-positioning",
    skill: { id: "define-amazon-voc-positioning", version: "1.0.1" },
    mode: "structured-analysis",
    inputSchema: "VocPositioningInput@1.0.0",
    outputSchema: "VocPositioningOutput@1.0.0",
    budget: {
      maxInputTokens: 24_000,
      maxOutputTokens: 8_000,
      timeoutMs: 300_000,
    },
    dependencies: [],
  },
  {
    id: "product-definition",
    skill: {
      id: "define-amazon-product-from-voc-keywords",
      version: "1.0.0",
    },
    mode: "structured-analysis",
    inputSchema: "ProductDefinitionInput@1.0.0",
    outputSchema: "ProductDefinitionOutput@1.0.0",
    budget: {
      maxInputTokens: 32_000,
      maxOutputTokens: 10_000,
      timeoutMs: 120_000,
    },
    dependencies: [
      { kind: "agent", id: "voc-positioning" },
      { kind: "snapshot", id: "keyword-analysis" },
    ],
  },
] satisfies AgentDefinition[];

function assertAcyclic(definitions: readonly AgentDefinition[]) {
  type AgentId = AgentDefinition["id"];
  const byId = new Map<AgentId, AgentDefinition>(
    definitions.map((definition) => [definition.id, definition]),
  );
  const visiting = new Set<AgentId>();
  const visited = new Set<AgentId>();

  function visit(id: AgentId) {
    if (visiting.has(id)) throw new Error(`Agent dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const definition = byId.get(id);
    if (!definition) throw new Error(`Unknown Agent dependency: ${id}`);

    visiting.add(id);
    for (const dependency of definition.dependencies) {
      if (dependency.kind === "agent") visit(dependency.id);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const definition of definitions) visit(definition.id);
}

export async function validateAgentDefinitions(
  input: unknown,
  registry: SkillRegistry,
) {
  const definitions = z.array(AgentDefinitionSchema).length(3).parse(input);
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate Agent Definition: ${definition.id}`);
    }
    ids.add(definition.id);

    const loadedSkill = await registry.load(
      definition.skill.id,
      definition.skill.version,
    );
    if (
      loadedSkill.manifest.inputSchema !== definition.inputSchema ||
      loadedSkill.manifest.outputSchema !== definition.outputSchema
    ) {
      throw new Error(
        `Agent Definition schema mismatch for ${definition.id}`,
      );
    }
  }
  assertAcyclic(definitions);
  return definitions;
}
