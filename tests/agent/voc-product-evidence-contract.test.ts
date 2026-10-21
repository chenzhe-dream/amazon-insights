import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

import { buildKeywordAnalysisSnapshotCandidate } from "../../server/data/keyword-analysis-snapshot";
import { buildProductDefinitionInput } from "../../server/domain/product/product-definition-contracts";
import { ProductDefinitionOutputShapeSchema } from "../../shared/product-definition-output";
import { VocModelEvidenceSchema, toModelEvidenceSelection } from "../../shared/voc-evidence-contracts";
import { SkillRunner } from "../../server/runtime/skill-runner";
import { createStructuredResponseFormat } from "../../server/runtime/structured-response-format";
import { ProductDefinitionModelOutputSchema } from "../../server/services/product-definition-execution-service";
import { SkillRegistry } from "../../server/skills/registry";
import { SCOOTER_ASINS, realVocFacts, validVocPositioningOutput } from "./helpers/voc-positioning-fixture";

const CUTOFF = "2026-08-15T23:59:59.999Z";

test("buildProductDefinitionInput carries the trusted VOC evidence manifest", () => {
  const snapshotId = randomUUID();
  const voc = validVocPositioningOutput(realVocFacts(SCOOTER_ASINS, snapshotId, randomUUID()));
  const manifest = {
    schemaVersion: "voc-evidence/v1" as const,
    organizationId: randomUUID(), projectId: randomUUID(), baseSyncRunId: randomUUID(), marketplace: "US" as const,
    selectedAsins: [...SCOOTER_ASINS], sourcePolicy: "manual-only" as const, fingerprint: "a".repeat(64), sourceMode: "manual" as const,
    coverage: SCOOTER_ASINS.map(asin => ({ asin, primary: "manual" as const, manualDimensions: [], reviewDimensions: [], reviewSupplementDimensions: [], conflictDimensions: [], missingDimensions: [], manual: null, review: null })),
    keywords: { state: "ready" as const, source: null },
  };
  const keyword = buildKeywordAnalysisSnapshotCandidate({ marketplace: "US", asins: SCOOTER_ASINS, dataCutoffAt: CUTOFF, groups: [{ id: "g", label: "group", keywords: ["scooter"], demand: "high", trend: "stable", seasonality: "unknown", evidenceIds: ["k"] }], evidence: [{ id: "k", sourceId: "source", capturedAt: CUTOFF, searchVolume: 1, purchaseRate: null }],
    coverage: SCOOTER_ASINS.map(asin => ({asin,status:"empty" as const,queryWindow:{time_type:"lately",time_value:"30",listingSearch:true}})) });
  const input = buildProductDefinitionInput({
    marketplace: "US", asins: SCOOTER_ASINS, dataCutoffAt: CUTOFF, evidenceSelection: manifest,
    vocReport: { id: randomUUID(), version: 1, snapshotIds: [snapshotId], result: voc },
    keywordSnapshot: { id: randomUUID(), contentHash: keyword.contentHash, payload: keyword.payload },
  });
  assert.equal(input.evidenceSelection?.fingerprint, manifest.fingerprint);
  assert.deepEqual(input.evidenceSelection?.selectedAsins, manifest.selectedAsins);
  assert.deepEqual(input.keywords.coverage, keyword.payload.coverage);
  assert.match(input.keywords.evidenceUseRule!,/不得称为近30天流量/);
});

test("shared output schema decodes legacy reports without evidence identity", () => {
  const result = ProductDefinitionOutputShapeSchema.safeParse({});
  assert.equal(result.success, false);
  assert.equal(ProductDefinitionOutputShapeSchema.shape.evidenceSelection.isOptional(), true);
  assert.equal(ProductDefinitionOutputShapeSchema.shape.identity.shape.inputFingerprint.isOptional(), true);
});

test("shared output schema rejects structurally unsupported evidence and fallback A", () => {
  const input = scopedProductInput();
  const theme = input.voc.result.themeJudgments[0]!;
  const base = {
    schemaVersion: "1.0.0", kind: "amazon-product-definition", status: "complete",
    evidenceSelection: input.evidenceSelection,
    identity: { vocReportId: input.voc.reportId, vocReportVersion: 1, keywordSnapshotId: input.keywords.snapshotId, keywordContentHash: input.keywords.contentHash, dataCutoffAt: input.dataCutoffAt, inputFingerprint: input.evidenceSelection!.fingerprint },
    opportunity: { grade: "B", scope: "demand-and-product-definition-opportunity", projectApproval: "not-approved" },
    evidenceMatrix: [{ themeKey: theme.themeKey, keywordGroupId: "g", vocEvidenceIds: theme.evidenceIds, keywordEvidenceIds: ["k"], judgment: "dual-validation", productRole: "core-foundation", priority: "P0" }],
    finalDefinition: [{ dimension: "product-form", conclusion: "定义", vocEvidenceIds: theme.evidenceIds, keywordEvidenceIds: ["k"], action: "include", priority: "P0", validationStatus: "supported" }],
    configurationLayers: { mustHave: [], differentiation: [], optional: [], notInV1: [], p0Avoid: [] },
    keywordLanding: [{ groupId: "g", role: "core-term", productLink: "产品", listingAngle: "卖点", skuHint: "sku", evidenceIds: ["k"] }],
    priorities: [{ priority: "P0", direction: "方向", evidenceIds: ["k"], action: "include", acceptance: "验收" }],
    risks: ["cost", "profitability", "patent", "compliance", "supply-chain"].map(area => ({ area, status: "requires-validation", nextStep: "验证" })),
    commercialValidation: { cost: "requires-validation", profitability: "requires-validation", patent: "requires-validation", compliance: "requires-validation", supplyChain: "requires-validation" },
    dataBoundary: "当前最终产品定义由VOC与关键词需求交叉推导。关键词数据反映搜索需求和市场入口，VOC反映使用体验与需求缺口；机会等级仅代表需求与产品定义机会，不得视为完整立项批准。完整立项仍需验证竞争、成本利润、专利合规、MOQ、供应链和现金投入。",
  };
  assert.equal(ProductDefinitionOutputShapeSchema.safeParse({ ...base, evidenceMatrix: [{ ...base.evidenceMatrix[0], keywordGroupId: null, keywordEvidenceIds: [] }] }).success, false);
  assert.equal(ProductDefinitionOutputShapeSchema.safeParse({ ...base, finalDefinition: [{ ...base.finalDefinition[0], keywordEvidenceIds: [] }] }).success, false);
  assert.equal(ProductDefinitionOutputShapeSchema.safeParse({ ...base, evidenceSelection: { ...input.evidenceSelection, sourceMode: "review-fallback" }, opportunity: { ...base.opportunity, grade: "A" } }).success, false);
});

test("actual SkillRunner accepts model-safe evidence and receives no tenant identity", async () => {
  const manifest = {
    schemaVersion: "voc-evidence/v1" as const,
    organizationId: randomUUID(), projectId: randomUUID(), baseSyncRunId: randomUUID(), marketplace: "US" as const,
    selectedAsins: [...SCOOTER_ASINS], sourcePolicy: "manual-only" as const, fingerprint: "c".repeat(64), sourceMode: "manual" as const,
    coverage: SCOOTER_ASINS.map(asin => ({ asin, primary: "manual" as const, manualDimensions: [], reviewDimensions: [], reviewSupplementDimensions: [], conflictDimensions: [], missingDimensions: [], manual: null, review: null })),
    keywords: { state: "ready" as const, source: null },
  };
  const evidenceSelection = toModelEvidenceSelection(manifest);
  assert.equal("organizationId" in evidenceSelection, false);
  assert.equal("projectId" in evidenceSelection, false);
  assert.equal("baseSyncRunId" in evidenceSelection, false);

  const registry = await SkillRegistry.open(path.resolve("skills-src"));
  const runner = new SkillRunner({
    registry,
    provider: {} as never,
    providerName: "safe-projection-test",
    budgetCoordinator: {
      reserve: async () => { throw new Error("not called by prepare"); },
      dispatch: async () => { throw new Error("not called by prepare"); },
      release: async () => { throw new Error("not called by prepare"); },
      settle: async () => { throw new Error("not called by prepare"); },
    },
  });
  await runner.prepare({
    skill: { id: "define-amazon-product-from-voc-keywords", version: "1.1.0" },
    inputContract: { name: "ProductDefinitionInput@1.0.0", schema: z.strictObject({ evidenceSelection: VocModelEvidenceSchema }), allowedFields: ["evidenceSelection"] },
    outputContract: { name: "ProductDefinitionOutput@1.0.0", schema: z.strictObject({ ok: z.boolean() }) },
    input: { evidenceSelection },
    snapshotIds: [randomUUID()],
    model: { name: "fixture", estimatedInputTokens: 10, maxOutputTokens: 10, timeoutMs: 1_000, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
  });
});

test("product model output contract produces a strict structured response format", () => {
  const response = createStructuredResponseFormat(ProductDefinitionModelOutputSchema, "ProductDefinitionOutput@1.0.0");
  assert.equal(response.format.strict, true);
});

function scopedProductInput() {
  const snapshotId = randomUUID();
  const voc = validVocPositioningOutput(realVocFacts(SCOOTER_ASINS, snapshotId, randomUUID()));
  const keyword = buildKeywordAnalysisSnapshotCandidate({ marketplace: "US", asins: SCOOTER_ASINS, dataCutoffAt: CUTOFF, groups: [{ id: "g", label: "group", keywords: ["scooter"], demand: "high", trend: "stable", seasonality: "unknown", evidenceIds: ["k"] }], evidence: [{ id: "k", sourceId: "source", capturedAt: CUTOFF, searchVolume: 1, purchaseRate: null }] });
  return buildProductDefinitionInput({
    marketplace: "US", asins: SCOOTER_ASINS, dataCutoffAt: CUTOFF,
    evidenceSelection: {
      schemaVersion: "voc-evidence/v1", organizationId: randomUUID(), projectId: randomUUID(), baseSyncRunId: randomUUID(), marketplace: "US",
      selectedAsins: [...SCOOTER_ASINS], sourcePolicy: "manual-only", fingerprint: "d".repeat(64), sourceMode: "manual",
      coverage: SCOOTER_ASINS.map(asin => ({ asin, primary: "manual" as const, manualDimensions: [], reviewDimensions: [], reviewSupplementDimensions: [], conflictDimensions: [], missingDimensions: [], manual: null, review: null })),
      keywords: { state: "ready", source: null },
    },
    vocReport: { id: randomUUID(), version: 1, snapshotIds: [snapshotId], result: voc },
    keywordSnapshot: { id: randomUUID(), contentHash: keyword.contentHash, payload: keyword.payload },
  });
}
