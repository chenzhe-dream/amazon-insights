import type { ProductDefinitionInput } from "../../../server/domain/product/product-definition-contracts";
import { PRODUCT_DEFINITION_DATA_BOUNDARY } from "../../../server/domain/product/product-definition-contracts";
export function validProductOutput(input: ProductDefinitionInput) {
  const theme = input.voc.result.themeJudgments[0]!;
  const keyword = input.keywords.groups[0]!;
  return {
    schemaVersion: "1.0.0",
    kind: "amazon-product-definition",
    status: "complete",
    identity: {
      vocReportId: input.voc.reportId,
      vocReportVersion: input.voc.version,
      keywordSnapshotId: input.keywords.snapshotId,
      keywordContentHash: input.keywords.contentHash,
      dataCutoffAt: input.dataCutoffAt,
    },
    opportunity: {
      grade: "A",
      scope: "demand-and-product-definition-opportunity",
      projectApproval: "not-approved",
    },
    evidenceMatrix: [{
      themeKey: theme.themeKey,
      keywordGroupId: keyword.id,
      vocEvidenceIds: theme.evidenceIds,
      keywordEvidenceIds: keyword.evidenceIds,
      judgment: "dual-validation",
      productRole: "core-foundation",
      priority: theme.priority,
    }],
    finalDefinition: [{
      dimension: "product-form",
      conclusion: "保留VOC核心价值，并以已验证关键词词群承接需求。",
      vocEvidenceIds: theme.evidenceIds,
      keywordEvidenceIds: keyword.evidenceIds,
      action: "validate",
      priority: theme.priority,
      validationStatus: "requires-validation",
    }],
    configurationLayers: {
      mustHave: [{ item: "核心体验", evidenceIds: theme.evidenceIds }],
      differentiation: [{ item: "体验差异化", evidenceIds: theme.evidenceIds }],
      optional: [],
      notInV1: [],
      p0Avoid: [],
    },
    keywordLanding: [{
      groupId: keyword.id,
      role: "core-term",
      productLink: "核心产品形态",
      listingAngle: "需求匹配",
      skuHint: "single-core-sku",
      evidenceIds: keyword.evidenceIds,
    }],
    priorities: [{
      priority: theme.priority,
      direction: "保留并验证核心体验",
      evidenceIds: [...theme.evidenceIds, ...keyword.evidenceIds],
      action: "validate",
      acceptance: "完成样品与用户验证",
    }],
    risks: [
      { area: "cost", status: "requires-validation", nextStep: "验证成本结构" },
      { area: "profitability", status: "requires-validation", nextStep: "验证单位经济性" },
      { area: "patent", status: "requires-validation", nextStep: "完成知识产权检索" },
      { area: "compliance", status: "requires-validation", nextStep: "完成适用标准验证" },
      { area: "supply-chain", status: "requires-validation", nextStep: "验证供应与交付能力" },
    ],
    commercialValidation: {
      cost: "requires-validation",
      profitability: "requires-validation",
      patent: "requires-validation",
      compliance: "requires-validation",
      supplyChain: "requires-validation",
    },
    dataBoundary: PRODUCT_DEFINITION_DATA_BOUNDARY,
  };
}


export function runtimeEnv(databasePath: string) {
  return {
    OPENAI_API_KEY: "fixture-key",
    AGENT_VOC_MODEL: "fixture-model",
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "2000",
    AGENT_VOC_TIMEOUT_MS: "5000",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_CALL_MAX_TOKENS: "100000",
    AGENT_VOC_CALL_MAX_COST_MICROS: "1000000",
    AGENT_VOC_RUN_MAX_TOKENS: "100000",
    AGENT_VOC_RUN_MAX_COST_MICROS: "1000000",
    AGENT_VOC_DAILY_MAX_TOKENS: "1000000",
    AGENT_VOC_DAILY_MAX_COST_MICROS: "10000000",
    AGENT_VOC_WORKER_OWNER_ID: "product-runtime-worker",
    AGENT_VOC_WORKER_LEASE_MS: "120000",
    AGENT_VOC_WORKER_HEARTBEAT_MS: "60000",
    AGENT_VOC_WORKER_POLL_MS: "10",
    AGENT_VOC_WORKER_STOP_TIMEOUT_MS: "1000",
    AGENT_VOC_RETRY_MAX_ATTEMPTS: "1",
    AGENT_VOC_RETRY_INITIAL_DELAY_MS: "10",
    AGENT_VOC_RETRY_MAX_DELAY_MS: "10",
    AGENT_VOC_RETRY_JITTER_RATIO: "0",
    AGENT_SQLITE_PATH: databasePath,
  };
}


