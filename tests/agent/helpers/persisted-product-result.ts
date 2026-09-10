import { PRODUCT_DEFINITION_DATA_BOUNDARY } from "../../../shared/product-definition-output";
export const persistedResult = {
  schemaVersion: "1.0.0",
  kind: "amazon-product-definition",
  status: "complete",
  identity: {
    vocReportId: "11111111-1111-4111-8111-111111111111",
    vocReportVersion: 1,
    keywordSnapshotId: "22222222-2222-4222-8222-222222222222",
    keywordContentHash: "a".repeat(64),
    dataCutoffAt: "2026-09-10T00:00:00.000Z",
  },
  opportunity: { grade: "B", scope: "demand-and-product-definition-opportunity", projectApproval: "not-approved" },
  evidenceMatrix: [{
    themeKey: "durability", keywordGroupId: "durable", vocEvidenceIds: ["voc-1"],
    keywordEvidenceIds: ["kw-1"], judgment: "dual-validation", productRole: "core-foundation", priority: "P0",
  }],
  finalDefinition: [{
    dimension: "pain-point", conclusion: "PERSISTED_RESULT_MARKER", vocEvidenceIds: ["voc-1"],
    keywordEvidenceIds: ["kw-1"], action: "redesign", priority: "P0", validationStatus: "supported",
  }],
  configurationLayers: {
    mustHave: [{ item: "加固结构", evidenceIds: ["voc-1"] }], differentiation: [], optional: [], notInV1: [], p0Avoid: [],
  },
  keywordLanding: [{
    groupId: "durable", role: "feature", productLink: "加固结构", listingAngle: "耐用", skuHint: "基础款", evidenceIds: ["kw-1"],
  }],
  priorities: [{ priority: "P0", direction: "重做连接处", evidenceIds: ["voc-1", "kw-1"], action: "redesign", acceptance: "跌落测试" }],
  risks: [
    { area: "cost", status: "requires-validation", nextStep: "核算成本" },
    { area: "profitability", status: "requires-validation", nextStep: "核算利润" },
    { area: "patent", status: "requires-validation", nextStep: "完成专利检索" },
    { area: "compliance", status: "requires-validation", nextStep: "完成合规核验" },
    { area: "supply-chain", status: "requires-validation", nextStep: "验证供应链" },
  ],
  commercialValidation: {
    cost: "requires-validation", profitability: "requires-validation", patent: "requires-validation",
    compliance: "requires-validation", supplyChain: "requires-validation",
  },
  dataBoundary: PRODUCT_DEFINITION_DATA_BOUNDARY,
};
