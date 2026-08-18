import { z } from "zod";

import { EntityIdSchema } from "../../shared/agent-contracts";
import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS,
} from "./analysis-agent-evaluation-contract";

export { ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS } from "./analysis-agent-evaluation-contract";

export const ANALYSIS_AGENT_MODULE_MODES = [
  "legacy-primary",
  "agent-shadow",
] as const;

const AnalysisAgentModuleSchema = z.literal("voc-positioning");
const AnalysisAgentModuleModeSchema = z.enum(ANALYSIS_AGENT_MODULE_MODES);
const HumanRatingScoresSchema = z.strictObject(
  Object.fromEntries(
    ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.map((dimension) => [
      dimension,
      z.number().int().min(1).max(5),
    ]),
  ) as Record<(typeof ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS)[number], z.ZodNumber>,
);

export const AnalysisAgentHumanRatingSchema = z.strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  actorUserId: EntityIdSchema,
  module: AnalysisAgentModuleSchema,
  evalSetVersion: z.string().min(1).max(100),
  caseId: z.enum(REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS),
  skill: z.strictObject({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  model: z.strictObject({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
  }),
  reportId: EntityIdSchema,
  scores: HumanRatingScoresSchema,
  comment: z.string().trim().min(1).max(2_000).optional(),
  createdAt: z.string().datetime(),
});

export const AnalysisAgentModuleModeEventSchema = z.strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  actorUserId: EntityIdSchema,
  module: AnalysisAgentModuleSchema,
  mode: AnalysisAgentModuleModeSchema,
  reason: z.string().trim().min(1).max(1_000),
  createdAt: z.string().datetime(),
});

export type AnalysisAgentHumanRating = Readonly<
  z.infer<typeof AnalysisAgentHumanRatingSchema>
>;
export type AnalysisAgentModuleModeEvent = Readonly<
  z.infer<typeof AnalysisAgentModuleModeEventSchema>
>;
export type AnalysisAgentModule = AnalysisAgentModuleModeEvent["module"];
export type AnalysisAgentModuleMode = AnalysisAgentModuleModeEvent["mode"];

export interface AnalysisAgentEvaluationControlRepository {
  appendAnalysisAgentHumanRating(
    rating: AnalysisAgentHumanRating,
  ): Promise<AnalysisAgentHumanRating>;
  listAnalysisAgentHumanRatings(input: Readonly<{
    organizationId: string;
    module: AnalysisAgentModule;
  }>): Promise<readonly AnalysisAgentHumanRating[]>;
  appendAnalysisAgentModuleMode(
    event: AnalysisAgentModuleModeEvent,
  ): Promise<AnalysisAgentModuleModeEvent>;
  findLatestAnalysisAgentModuleMode(input: Readonly<{
    organizationId: string;
    module: AnalysisAgentModule;
  }>): Promise<AnalysisAgentModuleModeEvent | null>;
}

export class AnalysisAgentEvaluationControlSubjectNotFoundError extends Error {
  constructor() {
    super("Evaluation actor not found");
    this.name = "AnalysisAgentEvaluationControlSubjectNotFoundError";
  }
}

function freezeRecord<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      freezeRecord(nested);
    }
  }
  return Object.freeze(value);
}

export function createAnalysisAgentHumanRating(
  input: unknown,
): AnalysisAgentHumanRating {
  return freezeRecord(AnalysisAgentHumanRatingSchema.parse(input));
}

export function createAnalysisAgentModuleModeEvent(
  input: unknown,
): AnalysisAgentModuleModeEvent {
  return freezeRecord(AnalysisAgentModuleModeEventSchema.parse(input));
}

export type AnalysisAgentModuleModeResolution = Readonly<{
  module: AnalysisAgentModule;
  mode: AnalysisAgentModuleMode;
  source: "event" | "default" | "read-error";
}>;

export async function resolveAnalysisAgentModuleMode(
  repository: Pick<AnalysisAgentEvaluationControlRepository, "findLatestAnalysisAgentModuleMode">,
  input: Readonly<{ organizationId: string; module: AnalysisAgentModule }>,
): Promise<AnalysisAgentModuleModeResolution> {
  try {
    const event = await repository.findLatestAnalysisAgentModuleMode(input);
    return Object.freeze({
      module: input.module,
      mode: event?.mode ?? "legacy-primary",
      source: event ? "event" : "default",
    });
  } catch {
    return Object.freeze({
      module: input.module,
      mode: "legacy-primary",
      source: "read-error",
    });
  }
}

const ModeControlSchema = z.discriminatedUnion("source", [
  z.strictObject({
    module: AnalysisAgentModuleSchema,
    mode: AnalysisAgentModuleModeSchema,
    source: z.literal("event"),
  }),
  z.strictObject({
    module: AnalysisAgentModuleSchema,
    mode: z.literal("legacy-primary"),
    source: z.enum(["default", "read-error"]),
  }),
]);

export function selectAnalysisAgentModuleResult<TLegacy, TAgent>(input: Readonly<{
  control?: unknown;
  legacyResult: TLegacy;
  agentResult?: TAgent;
}>) {
  const parsedControl = ModeControlSchema.safeParse(input.control);
  const mode: AnalysisAgentModuleMode = parsedControl.success
    ? parsedControl.data.mode
    : "legacy-primary";
  return Object.freeze({
    mode,
    publicPrimary: Object.freeze({
      kind: "legacy" as const,
      result: input.legacyResult,
    }),
    shadowComparison:
      mode === "agent-shadow" && input.agentResult !== undefined
        ? Object.freeze({ kind: "agent" as const, result: input.agentResult })
        : null,
  });
}
