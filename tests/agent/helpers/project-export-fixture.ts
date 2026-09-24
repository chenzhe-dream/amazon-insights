import { ProjectableSyncStageSchema } from "../../../shared/agent-contracts";

export const exportOrganizationId = "22222222-2222-4222-8222-222222222222";
export const exportSessionIdentity = "s".repeat(43);
export const exportSourceId = "33333333-3333-4333-8333-333333333333";
export function exportProjectFixture() {
  return { id: "10000000-0000-4000-8000-000000000001", sourceProjectId: exportSourceId,
    kind: "analysis" as const, slug: "test-lamps", name: "历史灯具项目", marketplace: "US" as const,
    asins: ["B01E6CX34C", "B07Y4PJJR4", "B07WFC14VR"], majorCategory: null, categoryLabel: null,
    note: null, createdBy: null, latestAnalystName: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
}
export function exportSessionFixture() {
  return { authenticated: true, sessionIdentity: exportSessionIdentity, visibleModules: ["overview"],
    canViewUserPresence: false, user: { id: "66666666-6666-4666-8666-666666666666",
      organizationId: exportOrganizationId, email: "reader@example.test", displayName: "测试用户",
      role: "member", status: "active", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" } };
}
export function exportSourceProjectFixture() {
  return { id: exportSourceId, organizationId: exportOrganizationId, name: "来源项目", marketplace: "US",
    asins: exportProjectFixture().asins, createdBy: "66666666-6666-4666-8666-666666666666",
    currentRunId: "44444444-4444-4444-8444-444444444444", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
}
export function exportTranslationFixture(asin: string) {
  return { asin, sourceHash: "", state: "unavailable", points: [], original: [], sourceComplete: false, message: "暂无可翻译的卖点原文" };
}
export function exportVersionFixture() {
  const project = exportProjectFixture();
  return { versionId: "11111111-1111-4111-8111-111111111111",
    organizationId: exportOrganizationId, projectId: exportSourceId,
    runId: "44444444-4444-4444-8444-444444444444", jobId: "55555555-5555-4555-8555-555555555555",
    marketplace: project.marketplace, asins: project.asins,
    catalog: project.asins.map((asin, i) => ({ asin, brand: "测试品牌" + i, title: "灯具样例" + i,
      image: "https://m.media-amazon.com/images/I/test.jpg", price: i === 0 ? 25.99 : null,
      sales: null, rating: null, reviews: null, rank: null, subRank: null, rankCategory: "Home & Kitchen",
      subRankCategory: "Candle Lamps", buyBoxSeller: "", fulfillment: "", packageSize: "", packageWeight: "",
      specifications: ["颜色：蓝色"], launch: "", variants: null, features: [] })),
    catalogEvidence: { sourceKind: "generated-file", sourceRef: "app/competitor-data.ts#refreshedCatalog",
      sourceSha256: "b".repeat(64), sourceUpdatedAt: "2026-09-23T05:44:00Z", capturedAt: "2026-09-23T06:00:00Z" },
    stageOutputs: Object.fromEntries(ProjectableSyncStageSchema.options.map(stage => [stage,
      { stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }])),
    gaps: [], contentHash: "a".repeat(64), sourceCompletedAt: "2026-09-23T05:00:00Z", publishedAt: "2026-09-23T06:00:00Z" };
}

export function exportRuntimeFixture() {
  const version=exportVersionFixture();
  return {catalog:version.catalog,keywords:{analysisByAsin:{},enrichmentByKeyword:{}},reviews:{analysisByAsin:{},ratingByAsin:{}},
    salesTrend:{trendByAsin:{}},fba:{feeByAsin:{}},listing:{contentByAsin:{}},category:{trendByNode:{}},
    childSales:{rowsByAsin:{}},priceStrategy:{strategyByAsin:{}},imageRemarks:{remarksByAsin:{},outcomesByAsin:{}},
    variants:{families:[]},variantOrders:{families:[]},xydcOrderProgress:null,
    exportScope:{projectId:exportSourceId,organizationId:exportOrganizationId,marketplace:"US",asins:version.asins,
      readAt:new Date().toISOString(),contentHash:"c".repeat(64)}};
}
