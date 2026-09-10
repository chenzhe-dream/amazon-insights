import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  ProductDefinitionInputSchema,
  canonicalizeProductDefinitionOutput,
  createProductDefinitionOutputSchema,
  extractVocPositioningProjection,
} from "../../server/domain/product/product-definition-contracts";
import {
  SCOOTER_ASINS,
  realVocFacts,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

test("projects both legacy VOC reports and combined Amazon insight reports", () => {
  const projection = validVocPositioningOutput(
    realVocFacts(SCOOTER_ASINS, randomUUID(), randomUUID()),
  );
  assert.deepEqual(extractVocPositioningProjection(projection), projection);
  assert.deepEqual(
    extractVocPositioningProjection({
      schemaVersion: "1.0.0",
      kind: "amazon-voc-insight-result",
      insight: {},
      positioningProjection: projection,
    }),
    projection,
  );
});

test("new evidence-scoped inputs require matching output identity and preserve nullable pending grade", () => {
  const input = evidenceScopedInput("manual");
  const candidate = canonicalizeProductDefinitionOutput(validOutput(input), input) as Record<string, unknown>;
  const parsed = createProductDefinitionOutputSchema(input).parse(candidate);
  assert.equal(parsed.identity.inputFingerprint, input.evidenceSelection?.fingerprint);
  assert.deepEqual(parsed.evidenceSelection, input.evidenceSelection);

  const pending = {
    ...candidate,
    opportunity: { grade: null, pendingReason: "证据不足，等待验证", scope: "demand-and-product-definition-opportunity", projectApproval: "not-approved" },
  };
  assert.equal(createProductDefinitionOutputSchema(input).parse(pending).opportunity.grade, null);
  assert.throws(() => createProductDefinitionOutputSchema(input).parse({
    ...pending,
    opportunity: { ...(pending.opportunity as object), pendingReason: "" },
  }));
});

test("review fallback cannot produce a final A opportunity grade", () => {
  const input = evidenceScopedInput("review-fallback");
  const candidate = canonicalizeProductDefinitionOutput(validOutput(input), input);
  assert.throws(() => createProductDefinitionOutputSchema(input).parse(candidate), /fallback|grade/i);
});

test("evidence matrix and final definition enforce conditional evidence semantics", () => {
  const input = evidenceScopedInput("manual");
  const base = canonicalizeProductDefinitionOutput(validOutput(input), input) as ReturnType<typeof validOutput>;
  const vocOnly = {
    ...base,
    opportunity: { ...base.opportunity, grade: "B" as const },
    evidenceMatrix: [{ ...base.evidenceMatrix[0], judgment: "voc-only" as const, keywordGroupId: null, keywordEvidenceIds: [] }],
    finalDefinition: [{ ...base.finalDefinition[0], validationStatus: "requires-validation" as const, keywordEvidenceIds: [] }],
  };
  assert.equal(createProductDefinitionOutputSchema(input).safeParse(vocOnly).success, true);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...vocOnly,
    evidenceMatrix: [{ ...vocOnly.evidenceMatrix[0], judgment: "dual-validation", keywordGroupId: null }],
  }).success, false);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...vocOnly,
    finalDefinition: [{ ...vocOnly.finalDefinition[0], validationStatus: "supported" }],
  }).success, false);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...vocOnly,
    evidenceMatrix: [{ ...vocOnly.evidenceMatrix[0], vocEvidenceIds: [], keywordEvidenceIds: [] }],
  }).success, false);
});

test("configuration and priority evidence must belong to trusted VOC or keyword inputs", () => {
  const input = evidenceScopedInput("manual");
  const base = canonicalizeProductDefinitionOutput(validOutput(input), input) as ReturnType<typeof validOutput>;
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...base,
    configurationLayers: { ...base.configurationLayers, mustHave: [{ item: "伪造功能", evidenceIds: ["invented"] }] },
  }).success, false);
  assert.equal(createProductDefinitionOutputSchema(input).safeParse({
    ...base,
    priorities: [{ ...base.priorities[0], evidenceIds: ["invented"] }],
  }).success, false);
});

function evidenceScopedInput(sourceMode: "manual" | "review-fallback") {
  const snapshotId = randomUUID();
  const runId = randomUUID();
  const voc = validVocPositioningOutput(realVocFacts(SCOOTER_ASINS, snapshotId, runId));
  const vocResult = { ...voc } as Partial<typeof voc>;
  delete vocResult.identity;
  const fingerprint = "a".repeat(64);
  return ProductDefinitionInputSchema.parse({
    schemaVersion: "1.0.0", kind: "amazon-product-definition-input", marketplace: "US",
    asins: SCOOTER_ASINS, dataCutoffAt: "2026-08-15T23:59:59.999Z",
    evidenceSelection: {
      schemaVersion: "voc-evidence/v1", organizationId: randomUUID(), projectId: randomUUID(), baseSyncRunId: randomUUID(),
      marketplace: "US", selectedAsins: SCOOTER_ASINS, sourcePolicy: sourceMode === "manual" ? "manual-only" : "manual-with-review-fallback",
      fingerprint, sourceMode, coverage: SCOOTER_ASINS.map(asin => ({ asin, primary: sourceMode === "manual" ? "manual" : "review", manualDimensions: [], reviewDimensions: [], missingDimensions: [], manual: null, review: null })),
      keywords: { state: "ready", source: null },
    },
    voc: { reportId: randomUUID(), version: 1, snapshotIds: [snapshotId], result: vocResult },
    keywords: { snapshotId: randomUUID(), contentHash: "b".repeat(64), groups: [{ id: "group-1", label: "group", keywords: ["scooter"], demand: "high", trend: "stable", seasonality: "unknown", evidenceIds: ["keyword-1"] }], evidence: [{ id: "keyword-1", sourceId: "source", capturedAt: "2026-08-15T23:59:59.999Z", searchVolume: 100, purchaseRate: null }] },
    commercialData: { cost: "missing", profitability: "missing", patent: "missing", compliance: "missing", supplyChain: "missing" },
  });
}

function validOutput(input: ReturnType<typeof evidenceScopedInput>) {
  const theme = input.voc.result.themeJudgments[0]!;
  return {
    schemaVersion: "1.0.0" as const, kind: "amazon-product-definition" as const, status: "complete" as const,
    identity: { vocReportId: input.voc.reportId, vocReportVersion: input.voc.version, keywordSnapshotId: input.keywords.snapshotId, keywordContentHash: input.keywords.contentHash, dataCutoffAt: input.dataCutoffAt },
    opportunity: { grade: "A" as const, scope: "demand-and-product-definition-opportunity" as const, projectApproval: "not-approved" as const },
    evidenceMatrix: [{ themeKey: theme.themeKey, keywordGroupId: "group-1", vocEvidenceIds: theme.evidenceIds, keywordEvidenceIds: ["keyword-1"], judgment: "dual-validation" as const, productRole: "core-foundation" as const, priority: theme.priority }],
    finalDefinition: [{ dimension: "product-form" as const, conclusion: "基于双侧证据定义产品", vocEvidenceIds: theme.evidenceIds, keywordEvidenceIds: ["keyword-1"], action: "include" as const, priority: theme.priority, validationStatus: "supported" as const }],
    configurationLayers: { mustHave: [{ item: "核心功能", evidenceIds: theme.evidenceIds }], differentiation: [], optional: [], notInV1: [], p0Avoid: [] },
    keywordLanding: [{ groupId: "group-1", role: "core-term" as const, productLink: "产品", listingAngle: "卖点", skuHint: "sku", evidenceIds: ["keyword-1"] }],
    priorities: [{ priority: "P0" as const, direction: "核心方向", evidenceIds: theme.evidenceIds, action: "include" as const, acceptance: "验收" }],
    risks: ["cost", "profitability", "patent", "compliance", "supply-chain"].map(area => ({ area, status: "requires-validation" as const, nextStep: "验证" })),
    commercialValidation: { cost: "requires-validation" as const, profitability: "requires-validation" as const, patent: "requires-validation" as const, compliance: "requires-validation" as const, supplyChain: "requires-validation" as const },
    dataBoundary: "当前最终产品定义由VOC与关键词需求交叉推导。关键词数据反映搜索需求和市场入口，VOC反映使用体验与需求缺口；机会等级仅代表需求与产品定义机会，不得视为完整立项批准。完整立项仍需验证竞争、成本利润、专利合规、MOQ、供应链和现金投入。" as const,
  };
}
