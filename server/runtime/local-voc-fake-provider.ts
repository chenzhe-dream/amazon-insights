import { randomUUID } from "node:crypto";

import type {
  VocPositioningInput,
  VocPositioningOutput,
} from "../domain/voc/voc-positioning-contracts";
import type {
  ModelProvider,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "./model-provider";

const POSITIONING_DIMENSIONS = [
  "target-audience", "core-scenario", "core-pain", "product-form",
  "base-function", "differentiator", "material-structure", "color-sku",
  "price-tier", "core-selling-point",
] as const;

/** Explicit local-only provider for the repeatable browser smoke path. */
export class LocalVocFakeProvider implements ModelProvider {
  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const input = request.input as VocPositioningInput;
    const themes = input.dimensions.flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    );
    const fallback = themes[0];
    if (!fallback || !fallback.theme.evidenceIds[0]) {
      throw new Error("Local VOC fixture requires deterministic evidence");
    }
    const required = themes.filter(({ theme }) =>
      theme.priority.level === "P0" || theme.priority.level === "P1",
    );
    const protectedTheme = fallback.theme.priority.safetyRule !== null || fallback.theme.priority.level === "P0";
    const ref = { dimension: fallback.dimension, themeKey: fallback.theme.key };
    const evidenceId = fallback.theme.evidenceIds[0];
    const output: VocPositioningOutput = {
      schemaVersion: "1.0.0",
      kind: "voc-positioning-analysis-result",
      status: input.coverage.every((source) => source.status === "available") ? "complete" : "partial",
      identity: {
        snapshotId: input.snapshot.id,
        contentHash: input.snapshot.contentHash,
        factsDigest: input.factsDigest,
        dataCutoffAt: input.snapshot.dataCutoffAt,
      },
      coverage: input.coverage.map(({ sourceId, status, missingAsins }) => ({ sourceId, status, missingAsins })),
      coreConclusion: {
        strategy: protectedTheme ? "avoid-protected-failure" : "retain-verified-value",
        themeRefs: [ref], evidenceIds: [evidenceId],
      },
      positioning: POSITIONING_DIMENSIONS.map((dimension) => ({
        dimension,
        stance: dimension === "price-tier" ? "requires-validation" : "supported-by-voc",
        strategy: dimension === "price-tier" ? "validate" : protectedTheme ? "avoid" : "retain",
        priority: fallback.theme.priority.level,
        themeRefs: [ref], evidenceIds: [evidenceId],
      })),
      themeJudgments: required.map(({ dimension, theme }) => ({
        themeKey: theme.key, label: theme.label, dimension,
        role: theme.priority.safetyRule !== null || theme.priority.level === "P0"
          ? "new-product-avoidance"
          : dimension === "unmet" ? "differentiation-breakthrough"
          : dimension === "negatives" || dimension === "attention" ? "retain-and-redesign"
          : "core-retention",
        priority: theme.priority.level,
        metrics: theme.metrics.map((metric) => ({
          evidenceId: metric.evidenceId, sourceId: metric.sourceId, asin: metric.asin,
          capturedAt: metric.capturedAt, mentionCount: metric.mentionCount,
          sampleCount: metric.sampleCount, mentionPct: metric.mentionPct,
        })),
        evidenceIds: theme.evidenceIds,
      })),
      actions: required.map(({ dimension, theme }, index) => ({
        id: `action-${index + 1}`, priority: theme.priority.level,
        actionType: theme.priority.safetyRule !== null || theme.priority.level === "P0"
          ? "avoid" : dimension === "unmet" ? "differentiate" : "retain",
        validationDomains: ["cost", "compliance"],
        themeRefs: [{ dimension, themeKey: theme.key }], evidenceIds: theme.evidenceIds,
      })),
      checklists: { mustKeep: [], mustAvoid: [], differentiationOpportunities: [] },
      nextValidations: [{
        domain: "cost", reason: "implementation-feasibility", themeRefs: [ref], evidenceIds: [evidenceId],
      }],
      decisionBoundaries: {
        marketSize: "not-assessed", salesForecast: "not-assessed", profitability: "not-assessed",
        projectApproval: "not-assessed", price: "requires-validation", cost: "requires-validation",
        compliance: "requires-validation", patent: "requires-validation", supplyChain: "requires-validation",
      },
    };
    return { value: request.outputSchema.parse(output) as T, responseId: `local-voc-${randomUUID()}`, inputTokens: 500, outputTokens: 250 };
  }
}
