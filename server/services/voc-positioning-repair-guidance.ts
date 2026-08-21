import {
  parseVocDeterministicPreprocessingResult,
  type VocDeterministicPreprocessingResult,
} from "../domain/voc/preprocess-voc-snapshot";
import {
  expectedProtectedRole,
  isVocPositioningValidationRuleId,
} from "../domain/voc/voc-positioning-contracts";
import { VOC_DIMENSIONS } from "../domain/voc/theme-normalization";
import type { SafeValidationIssue } from "../runtime/safe-validation-issues";

const MAX_PROTECTED_THEMES = 32;
const MAX_PROTECTED_METRICS = 128;
const MAX_PROTECTED_EVIDENCE = 128;
const MAX_SERIALIZED_GUIDANCE_CHARS = 23_900;

export function createVocPositioningRepairGuidance(
  input: unknown,
  issues: readonly SafeValidationIssue[],
): readonly string[] | null {
  if (
    issues.some((issue) =>
      !issue.ruleId || !isVocPositioningValidationRuleId(issue.ruleId)
    )
  ) {
    return null;
  }

  let facts: VocDeterministicPreprocessingResult;
  try {
    facts = parseVocDeterministicPreprocessingResult(input);
  } catch {
    return null;
  }
  const protectedThemes = facts.dimensions.flatMap((dimension) =>
    dimension.themes
      .filter((theme) => theme.priority.level === "P0" || theme.priority.level === "P1")
      .map((theme) => ({ dimension: dimension.key, theme })),
  );
  const metricCount = protectedThemes.reduce(
    (count, item) => count + item.theme.metrics.length,
    0,
  );
  const evidenceCount = protectedThemes.reduce(
    (count, item) => count + item.theme.evidenceIds.length,
    0,
  );
  if (
    protectedThemes.length === 0 ||
    protectedThemes.length > MAX_PROTECTED_THEMES ||
    metricCount > MAX_PROTECTED_METRICS ||
    evidenceCount > MAX_PROTECTED_EVIDENCE
  ) {
    return null;
  }

  const payload = {
    allowedThemeReferenceDimensions: [...VOC_DIMENSIONS],
    R: protectedThemes.map(({ dimension, theme }) => {
      const safetyOrP0 = theme.priority.safetyRule !== null || theme.priority.level === "P0";
      return {
        identity: { dimension, themeKey: theme.key },
        judgmentEcho: {
          label: theme.label,
          priority: theme.priority.level,
          role: expectedProtectedRole(dimension, theme),
          metrics: theme.metrics.map((metric) => ({
            evidenceId: metric.evidenceId,
            sourceId: metric.sourceId,
            asin: metric.asin,
            capturedAt: metric.capturedAt,
            mentionCount: metric.mentionCount,
            sampleCount: metric.sampleCount,
            mentionPct: metric.mentionPct,
          })),
          evidenceIds: [...theme.evidenceIds],
        },
        allowedEvidenceIds: [...theme.evidenceIds],
        action: {
          priorityMustNotBeLowerThan: theme.priority.level,
          ...(safetyOrP0
            ? {
                requiredActionTypes: ["avoid", "redesign"],
                requiredValidationDomains: ["compliance"],
              }
            : {}),
        },
      };
    }),
    positioningStrategyByStance: {
      "supported-by-voc": ["retain", "redesign", "avoid"],
      "requires-validation": ["differentiate", "validate"],
      "not-assessed": ["validate"],
    },
    protectedPositioningStrategy: {
      "supported-by-voc": ["avoid", "redesign"],
      otherwise: ["validate"],
    },
    requirements: {
      judgmentIdentities: "exactly-R",
      actionThemeRefUnion: "superset-of-R",
      replaceThemeJudgmentsFromRWhenMissing: true,
      extendActionsFromRUntilCoverageIsComplete: true,
      repairReferencedStructuresUsingOnlyR: true,
      everyEvidenceIdMustBelongToAReferencedTheme: true,
      everyThemeRefMustHaveAtLeastOneAllowedEvidenceId: true,
      deterministicEchoFieldsMustBeCopiedExactly: [
        "label",
        "priority",
        "role",
        "metrics",
        "evidenceIds",
      ],
      applicableReferencedStructures: [
        "coreConclusion",
        "positioning",
        "actions",
        "checklists",
        "nextValidations",
      ],
    },
    failureFocus: issues.map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      ruleId: issue.ruleId,
    })),
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_SERIALIZED_GUIDANCE_CHARS) return null;
  return Object.freeze(["VOC_REPAIR_GUIDANCE_V1", serialized]);
}
