import { z } from "zod";

import { Sha256Schema } from "../../shared/agent-contracts";
import {
  parseVocDeterministicPreprocessingResult,
  type VocDeterministicPreprocessingResult,
} from "../domain/voc/preprocess-voc-snapshot";
import {
  expectedProtectedRole,
  VocPositioningOutputShapeSchema,
  type VocPositioningOutput,
} from "../domain/voc/voc-positioning-contracts";
import { VOC_DIMENSIONS } from "../domain/voc/theme-normalization";
import type { SafeValidationIssue } from "../runtime/safe-validation-issues";
import type { NamedOutputRepairPatchContract } from "../runtime/skill-runner";

const MAX_PATCH_OPERATIONS = 10;
const MAX_PATCH_CHARS = 12_000;
const MAX_GUIDANCE_CHARS = 23_900;

const ThemeReferenceSchema = z.strictObject({
  dimension: z.enum(VOC_DIMENSIONS),
  themeKey: z.string().min(1).max(500),
});
const ValidationDomainSchema = z.enum([
  "market",
  "price",
  "cost",
  "compliance",
  "patent",
  "supply-chain",
  "user",
]);
const ActionTypeSchema = z.enum([
  "retain",
  "redesign",
  "avoid",
  "differentiate",
  "validate",
]);

const ReplaceReferencesOperationSchema = z.strictObject({
  op: z.literal("replace-references"),
  target: z.enum(["actions", "nextValidations"]),
  index: z.number().int().nonnegative().max(99),
  themeRefs: z.array(ThemeReferenceSchema).min(1).max(32),
  evidenceIds: z.array(Sha256Schema).min(1).max(128),
});
const ReplaceActionConstraintsOperationSchema = z.strictObject({
  op: z.literal("replace-action-constraints"),
  index: z.number().int().nonnegative().max(99),
  actionType: ActionTypeSchema,
  validationDomains: z.array(ValidationDomainSchema).max(7),
});
const ReplacePositioningStrategyOperationSchema = z.strictObject({
  op: z.literal("replace-positioning-strategy"),
  index: z.number().int().nonnegative().max(9),
  strategy: z.enum(["retain", "redesign", "differentiate", "avoid", "validate"]),
});
const UpsertProtectedJudgmentOperationSchema = z.strictObject({
  op: z.literal("upsert-protected-judgment"),
  identity: ThemeReferenceSchema,
});
const UpsertProtectedActionOperationSchema = z.strictObject({
  op: z.literal("upsert-protected-action"),
  identity: ThemeReferenceSchema,
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  actionType: ActionTypeSchema,
  validationDomains: z.array(ValidationDomainSchema).max(7),
});

const VocPositioningRepairPatchSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("voc-positioning-repair-patch"),
  operations: z.array(z.discriminatedUnion("op", [
    ReplaceReferencesOperationSchema,
    ReplaceActionConstraintsOperationSchema,
    ReplacePositioningStrategyOperationSchema,
    UpsertProtectedJudgmentOperationSchema,
    UpsertProtectedActionOperationSchema,
  ])).min(1).max(MAX_PATCH_OPERATIONS),
});

type RepairPatch = z.infer<typeof VocPositioningRepairPatchSchema>;
type RepairOperation = RepairPatch["operations"][number];
type ThemeReference = z.infer<typeof ThemeReferenceSchema>;
type ThemeFact = VocDeterministicPreprocessingResult["dimensions"][number]["themes"][number];
type ThemeEntry = Readonly<{
  dimension: VocDeterministicPreprocessingResult["dimensions"][number]["key"];
  theme: ThemeFact;
}>;

type RepairAuthority = Readonly<{
  referenceTargets: ReadonlySet<string>;
  actionConstraintIndexes: ReadonlySet<number>;
  positioningStrategyIndexes: ReadonlySet<number>;
  missingJudgmentCount: number;
  missingActionCount: number;
}>;

export function createVocPositioningRepairPatchContract(
  input: unknown,
): NamedOutputRepairPatchContract {
  const facts = parseVocDeterministicPreprocessingResult(input);
  const themes = facts.dimensions.flatMap((dimension) =>
    dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
  );
  const themeByIdentity = new Map(
    themes.map((entry) => [identityOf({
      dimension: entry.dimension,
      themeKey: entry.theme.key,
    }), entry]),
  );
  const protectedThemes = themes.filter(({ theme }) =>
    theme.priority.level === "P0" || theme.priority.level === "P1"
  );

  return {
    name: "VocPositioningRepairPatch_1_0_0",
    schema: VocPositioningRepairPatchSchema,
    canHandle(output, issues) {
      if (!VocPositioningOutputShapeSchema.safeParse(output).success) return false;
      return buildPatchGuidance(
        output,
        issues,
        protectedThemes,
        themeByIdentity,
      ) !== null;
    },
    guidance(output, issues) {
      return buildPatchGuidance(
        output,
        issues,
        protectedThemes,
        themeByIdentity,
      );
    },
    apply(output, candidate, issues) {
      const original = VocPositioningOutputShapeSchema.parse(output);
      const patch = VocPositioningRepairPatchSchema.parse(candidate);
      if (JSON.stringify(patch).length > MAX_PATCH_CHARS) {
        throw new TypeError("VOC repair patch exceeded its bounded size");
      }
      const authority = createAuthority(issues);
      if (authority === null) {
        throw new TypeError("VOC repair patch has no registered safe authority");
      }
      return applyPatch(
        original,
        patch,
        authority,
        themeByIdentity,
        protectedThemes,
      );
    },
  };
}

function buildPatchGuidance(
  output: unknown,
  issues: readonly SafeValidationIssue[],
  protectedThemes: readonly ThemeEntry[],
  themeByIdentity: ReadonlyMap<string, ThemeEntry>,
): readonly string[] | null {
  const shaped = VocPositioningOutputShapeSchema.safeParse(output);
  const authority = createAuthority(issues);
  if (!shaped.success || authority === null) return null;
  const presentJudgments = new Set(
    shaped.data.themeJudgments.map((judgment) => identityOf({
      dimension: judgment.dimension,
      themeKey: judgment.themeKey,
    })),
  );
  const presentActions = new Set(
    shaped.data.actions.flatMap((action) => action.themeRefs.map(identityOf)),
  );
  const payload = {
    contract: "VOC_REPAIR_PATCH_V1",
    requirements: [
      "Return only the declared patch object.",
      "Use only listed operations and exact indexes or identities.",
      "Do not modify or infer any field outside those operations.",
    ],
    authority: {
      replaceReferences: [...authority.referenceTargets],
      replaceActionConstraints: [...authority.actionConstraintIndexes],
      replacePositioningStrategy: [...authority.positioningStrategyIndexes],
      upsertProtectedJudgment: authority.missingJudgmentCount,
      upsertProtectedAction: authority.missingActionCount,
    },
    missingProtectedJudgments: protectedThemes
      .filter((entry) => !presentJudgments.has(identityOfEntry(entry)))
      .map(({ dimension, theme }) => ({ dimension, themeKey: theme.key })),
    missingProtectedActions: protectedThemes
      .filter((entry) => !presentActions.has(identityOfEntry(entry)))
      .map(({ dimension, theme }) => ({
        identity: { dimension, themeKey: theme.key },
        priority: theme.priority.level,
        allowedEvidenceIds: [...theme.evidenceIds],
        ...(isSafetyOrP0(theme)
          ? {
              requiredActionTypes: ["avoid", "redesign"],
              requiredValidationDomains: ["compliance"],
            }
          : {}),
      })),
    referencedTargets: [...authority.referenceTargets].map((target) => {
      const [collection, rawIndex] = target.split(":");
      const index = Number(rawIndex);
      const item = collection === "actions"
        ? shaped.data.actions[index]
        : shaped.data.nextValidations[index];
      return {
        target: collection,
        index,
        exactThemeRefs: item?.themeRefs ?? [],
        allowedEvidenceByTheme: (item?.themeRefs ?? []).map((reference) => ({
          identity: reference,
          evidenceIds: themeByIdentity.get(identityOf(reference))?.theme.evidenceIds ?? [],
        })),
      };
    }),
    failureFocus: issues.map(({ path, ruleId }) => ({ path: [...path], ruleId })),
  };
  const serialized = JSON.stringify(payload);
  return serialized.length <= MAX_GUIDANCE_CHARS
    ? Object.freeze(["VOC_REPAIR_GUIDANCE_V1", "VOC_REPAIR_PATCH_V1", serialized])
    : null;
}

function createAuthority(
  issues: readonly SafeValidationIssue[],
): RepairAuthority | null {
  if (issues.length === 0) return null;
  const referenceTargets = new Set<string>();
  const actionConstraintIndexes = new Set<number>();
  const positioningStrategyIndexes = new Set<number>();
  let missingJudgmentCount = 0;
  let missingActionCount = 0;

  for (const issue of issues) {
    const path = issue.path;
    switch (issue.ruleId) {
      case "voc-evidence-crosses-theme-boundary":
      case "voc-evidence-missing-for-reference":
      case "voc-dangling-evidence":
      case "voc-duplicate-result-reference": {
        const collection = path[0];
        const index = path[1];
        const field = path[2];
        if (
          (collection !== "actions" && collection !== "nextValidations") ||
          typeof index !== "number" ||
          field !== "evidenceIds"
        ) return null;
        referenceTargets.add(`${collection}:${index}`);
        break;
      }
      case "voc-protected-action-downgrade": {
        if (
          path[0] !== "actions" || typeof path[1] !== "number" ||
          path[2] !== "actionType"
        ) return null;
        actionConstraintIndexes.add(path[1]);
        break;
      }
      case "voc-positioning-strategy-stance-mismatch":
      case "voc-protected-positioning-strategy-downgrade": {
        if (
          path[0] !== "positioning" || typeof path[1] !== "number" ||
          path[2] !== "strategy"
        ) return null;
        positioningStrategyIndexes.add(path[1]);
        break;
      }
      case "voc-protected-theme-judgment-missing":
        if (path.length !== 1 || path[0] !== "themeJudgments") return null;
        missingJudgmentCount += 1;
        break;
      case "voc-protected-theme-action-missing":
        if (path.length !== 1 || path[0] !== "actions") return null;
        missingActionCount += 1;
        break;
      default:
        return null;
    }
  }

  return Object.freeze({
    referenceTargets,
    actionConstraintIndexes,
    positioningStrategyIndexes,
    missingJudgmentCount,
    missingActionCount,
  });
}

function applyPatch(
  original: VocPositioningOutput,
  patch: RepairPatch,
  authority: RepairAuthority,
  themeByIdentity: ReadonlyMap<string, ThemeEntry>,
  protectedThemes: readonly ThemeEntry[],
): VocPositioningOutput {
  const output = structuredClone(original);
  const usedTargets = new Set<string>();
  let judgmentUpserts = 0;
  let actionUpserts = 0;

  for (const operation of patch.operations) {
    const operationTarget = operationIdentity(operation);
    if (usedTargets.has(operationTarget)) {
      throw new TypeError("VOC repair patch contains conflicting operations");
    }
    usedTargets.add(operationTarget);

    switch (operation.op) {
      case "replace-references": {
        const authorityKey = `${operation.target}:${operation.index}`;
        if (!authority.referenceTargets.has(authorityKey)) {
          throw new TypeError("VOC repair patch targeted an unauthorized reference path");
        }
        const target = output[operation.target][operation.index];
        if (!target) throw new TypeError("VOC repair patch reference index does not exist");
        if (!sameReferences(target.themeRefs, operation.themeRefs)) {
          throw new TypeError("VOC repair patch cannot change issue-unrelated theme references");
        }
        assertEvidenceMatchesReferences(operation.themeRefs, operation.evidenceIds, themeByIdentity);
        target.themeRefs = operation.themeRefs;
        target.evidenceIds = operation.evidenceIds;
        break;
      }
      case "replace-action-constraints": {
        if (!authority.actionConstraintIndexes.has(operation.index)) {
          throw new TypeError("VOC repair patch targeted unauthorized action constraints");
        }
        const action = output.actions[operation.index];
        if (!action) throw new TypeError("VOC repair patch action index does not exist");
        assertProtectedActionConstraints(
          action.themeRefs,
          operation.actionType,
          operation.validationDomains,
          themeByIdentity,
        );
        action.actionType = operation.actionType;
        action.validationDomains = operation.validationDomains;
        break;
      }
      case "replace-positioning-strategy": {
        if (!authority.positioningStrategyIndexes.has(operation.index)) {
          throw new TypeError("VOC repair patch targeted an unauthorized positioning strategy");
        }
        const positioning = output.positioning[operation.index];
        if (!positioning) throw new TypeError("VOC repair patch positioning index does not exist");
        positioning.strategy = operation.strategy;
        break;
      }
      case "upsert-protected-judgment": {
        if (++judgmentUpserts > authority.missingJudgmentCount) {
          throw new TypeError("VOC repair patch exceeded missing judgment authority");
        }
        const entry = requireMissingProtectedTheme(
          operation.identity,
          protectedThemes,
          output.themeJudgments.map((judgment) => ({
            dimension: judgment.dimension,
            themeKey: judgment.themeKey,
          })),
        );
        const role = expectedProtectedRole(entry.dimension, entry.theme);
        if (role === null) throw new TypeError("VOC protected judgment role was unavailable");
        output.themeJudgments.push({
          themeKey: entry.theme.key,
          label: entry.theme.label,
          dimension: entry.dimension,
          role,
          priority: entry.theme.priority.level,
          metrics: entry.theme.metrics.map((metric) => ({
            evidenceId: metric.evidenceId,
            sourceId: metric.sourceId,
            asin: metric.asin,
            capturedAt: metric.capturedAt,
            mentionCount: metric.mentionCount,
            sampleCount: metric.sampleCount,
            mentionPct: metric.mentionPct,
          })),
          evidenceIds: [...entry.theme.evidenceIds],
        });
        break;
      }
      case "upsert-protected-action": {
        if (++actionUpserts > authority.missingActionCount) {
          throw new TypeError("VOC repair patch exceeded missing action authority");
        }
        const entry = requireMissingProtectedTheme(
          operation.identity,
          protectedThemes,
          output.actions.flatMap((action) => action.themeRefs),
        );
        if (output.actions.some((action) => action.id === operation.id)) {
          throw new TypeError("VOC repair patch cannot reuse an existing action id");
        }
        assertProtectedActionConstraints(
          [operation.identity],
          operation.actionType,
          operation.validationDomains,
          themeByIdentity,
        );
        output.actions.push({
          id: operation.id,
          priority: entry.theme.priority.level,
          actionType: operation.actionType,
          validationDomains: operation.validationDomains,
          themeRefs: [operation.identity],
          evidenceIds: [...entry.theme.evidenceIds],
        });
        break;
      }
    }
  }

  return output;
}

function requireMissingProtectedTheme(
  identity: ThemeReference,
  protectedThemes: readonly ThemeEntry[],
  existing: readonly ThemeReference[],
): ThemeEntry {
  const key = identityOf(identity);
  const entry = protectedThemes.find((item) => identityOfEntry(item) === key);
  if (!entry) throw new TypeError("VOC repair patch referenced a non-protected theme");
  if (existing.some((reference) => identityOf(reference) === key)) {
    throw new TypeError("VOC repair patch targeted an already-covered protected theme");
  }
  return entry;
}

function assertEvidenceMatchesReferences(
  references: readonly ThemeReference[],
  evidenceIds: readonly string[],
  themeByIdentity: ReadonlyMap<string, ThemeEntry>,
): void {
  if (new Set(references.map(identityOf)).size !== references.length) {
    throw new TypeError("VOC repair patch contains duplicate theme references");
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new TypeError("VOC repair patch contains duplicate evidence ids");
  }
  for (const reference of references) {
    const entry = themeByIdentity.get(identityOf(reference));
    if (!entry) throw new TypeError("VOC repair patch referenced an unknown theme");
    if (!entry.theme.evidenceIds.some((id) => evidenceIds.includes(id))) {
      throw new TypeError("VOC repair patch omitted evidence for a referenced theme");
    }
  }
  const allowedEvidence = new Set(references.flatMap((reference) =>
    themeByIdentity.get(identityOf(reference))?.theme.evidenceIds ?? []
  ));
  if (evidenceIds.some((id) => !allowedEvidence.has(id))) {
    throw new TypeError("VOC repair patch crossed a theme evidence boundary");
  }
}

function assertProtectedActionConstraints(
  references: readonly ThemeReference[],
  actionType: z.infer<typeof ActionTypeSchema>,
  validationDomains: readonly z.infer<typeof ValidationDomainSchema>[],
  themeByIdentity: ReadonlyMap<string, ThemeEntry>,
): void {
  const requiresSafetyControls = references.some((reference) => {
    const entry = themeByIdentity.get(identityOf(reference));
    return entry ? isSafetyOrP0(entry.theme) : false;
  });
  if (
    requiresSafetyControls &&
    (actionType !== "avoid" && actionType !== "redesign" ||
      !validationDomains.includes("compliance"))
  ) {
    throw new TypeError("VOC repair patch weakened a protected action");
  }
}

function sameReferences(
  left: readonly ThemeReference[],
  right: readonly ThemeReference[],
): boolean {
  return left.length === right.length && left.every((reference, index) =>
    identityOf(reference) === identityOf(right[index]!)
  );
}

function identityOf(reference: ThemeReference): string {
  return `${reference.dimension}\u0000${reference.themeKey}`;
}

function identityOfEntry(entry: ThemeEntry): string {
  return identityOf({ dimension: entry.dimension, themeKey: entry.theme.key });
}

function isSafetyOrP0(theme: ThemeFact): boolean {
  return theme.priority.safetyRule !== null || theme.priority.level === "P0";
}

function operationIdentity(operation: RepairOperation): string {
  switch (operation.op) {
    case "replace-references":
      return `${operation.op}:${operation.target}:${operation.index}`;
    case "replace-action-constraints":
    case "replace-positioning-strategy":
      return `${operation.op}:${operation.index}`;
    case "upsert-protected-judgment":
    case "upsert-protected-action":
      return `${operation.op}:${identityOf(operation.identity)}`;
  }
}
