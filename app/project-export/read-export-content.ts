import { EntityIdSchema, GetProjectResponseSchema, LocalDataProjectResponseSchema } from "../../shared/agent-contracts";
import { AnalysisFavoritesResponseSchema } from "../../shared/analysis-project-favorite-contracts";
import { SellingTranslationResponse } from "../../shared/selling-point-translation-contracts";
import { readOriginalSellingPoints } from "../../shared/selling-point-source";
import { localAgentFetch, localAgentErrorMessage } from "../lib/local-agent-browser";
import { readWebSession } from "../lib/web-auth-session";
import { readCurrentProjectDisplayVersion, type CurrentProjectDisplayVersion } from "../lib/project-display-version-browser";
import { visibleExportSections, type ExportSectionId } from "./module-catalog";
import type { ExportBlock, PreparedExportContent } from "./export-contracts";
import { buildOverviewExportSection } from "./overview-export-section";
import { buildListingImagesExportSection } from "./listing-images-export-section";
import { buildKeywordsExportSection } from "./keywords-export-section";
import { readVariantsExportSection } from "./read-variants-export";
import { readVocExportSection } from "./voc-export-section";
import { readDefinitionExportSection } from "./definition-export-section";
import { readChecklistExportSection } from "./checklist-export-section";
import { readTrafficExportSection } from "./read-traffic-export";
import type { ExportModuleContext } from "./export-module-context";
import type { ExportSection } from "./export-contracts";

export type ExportIdentity = Readonly<{ sessionIdentity: string; organizationId: string }>;
export type ExportRequest = ExportIdentity & Readonly<{
  libraryProjectId: string; moduleIds: readonly ExportSectionId[]; signal: AbortSignal;
}>;
export type PreparedProjectExport = PreparedExportContent & Readonly<{ sourceProjectId: string }>;
export type ExportFetcher = (path: string, init?: RequestInit) => Promise<Response>;
export const connectedExportModules: readonly ExportSectionId[] = [
  "competitor-overview", "variants-orders", "listing-images", "voc", "keywords", "definition", "checklist", "traffic",
];
const exportFetcher: ExportFetcher = (path, init) => path.startsWith("/api/")
  ? fetch(path, { ...init, credentials: "same-origin" }) : localAgentFetch(path, init);

function scopedFetcher(request: ExportRequest, fetcher: ExportFetcher): ExportFetcher {
  return async (path, init) => {
    request.signal.throwIfAborted();
    const response = await fetcher(path, { ...init, method: "GET", cache: "no-store", signal: request.signal });
    request.signal.throwIfAborted();
    return response;
  };
}
async function json(fetcher: ExportFetcher, path: string, label: string): Promise<unknown> {
  const response = await fetcher(path);
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(localAgentErrorMessage(body, label + "读取失败"));
  return body;
}
async function session(request: ExportRequest, fetcher: ExportFetcher) {
  request.signal.throwIfAborted();
  const identity = await readWebSession(fetcher).catch(() => {
    request.signal.throwIfAborted();
    throw new Error("登录状态读取失败，请重试");
  });
  if (!identity || identity.sessionIdentity !== request.sessionIdentity
      || identity.user.organizationId !== request.organizationId) throw new Error("登录会话已变化，请重新打开导出");
  const allowed = visibleExportSections(identity.visibleModules).map(item => item.id);
  if (request.moduleIds.some(id => !allowed.includes(id))) throw new Error("所选模块的查看权限已变化");
}
async function eligibility(request: ExportRequest, fetcher: ExportFetcher) {
  if (!request.moduleIds.length) throw new Error("请至少选择一个模块");
  if (request.moduleIds.some(id => !connectedExportModules.includes(id))) throw new Error("所选模块尚未接入导出");
  await session(request, fetcher);
  const favorites = AnalysisFavoritesResponseSchema.parse(await json(fetcher, "/v1/local-data/project-favorites", "收藏"));
  if (!favorites.projectIds.includes(request.libraryProjectId)) throw new Error("项目已取消收藏，请重新打开导出");
  const { project } = LocalDataProjectResponseSchema.parse(await json(fetcher,
    `/v1/local-data/projects/${encodeURIComponent(request.libraryProjectId)}`, "项目"));
  if (project.id !== request.libraryProjectId || project.kind !== "analysis") throw new Error("项目归属不匹配");
  const sourceProjectId = project.sourceProjectId ?? project.id;
  if (!EntityIdSchema.safeParse(sourceProjectId).success) throw new Error("历史项目没有可核验的来源分析项目，无法导出");
  const { project: source } = GetProjectResponseSchema.parse(await json(fetcher,
    `/v1/projects/${encodeURIComponent(sourceProjectId)}`, "来源分析项目"));
  if (source.id !== sourceProjectId || source.organizationId !== request.organizationId
      || source.marketplace !== project.marketplace || project.asins.some(asin => !source.asins.includes(asin))) {
    throw new Error("来源分析项目与收藏范围不匹配");
  }
  return { project, source, sourceProjectId };
}
export async function verifyExportEligibility(request: ExportRequest, prepared: PreparedProjectExport, fetcher: ExportFetcher = exportFetcher) {
  const read = scopedFetcher(request, fetcher);
  const current = await eligibility(request, read);
  if (current.sourceProjectId !== prepared.sourceProjectId || current.project.id !== prepared.project.id
      || current.project.marketplace !== prepared.project.marketplace
      || JSON.stringify([...current.project.asins].sort()) !== JSON.stringify([...prepared.project.asins].sort())) {
    throw new Error("项目来源已变化，请重新打开导出");
  }
  await session(request, read);
}

async function readSellingPoints(version: CurrentProjectDisplayVersion, asins: readonly string[], read: ExportFetcher): Promise<ExportBlock[]> {
  const readAll = () => Promise.all(asins.map(async asin => {
    const product = version.catalog.find(item => item && typeof item === "object" && "asin" in item && item.asin === asin);
    const expected = readOriginalSellingPoints(product && typeof product === "object" ? product : {});
    const unavailable = (message: string) => SellingTranslationResponse.parse({
      asin, sourceHash: "", state: "unavailable", ...expected, points: [], message,
    });
    if (version.marketplace !== "US") return unavailable("当前站点尚未支持中文卖点翻译，保留已有原文");
    const response = await read(`/v1/projects/${version.projectId}/selling-point-translations/${asin}?versionId=${encodeURIComponent(version.versionId)}`);
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = body && typeof body === "object" && "error" in body
        && body.error && typeof body.error === "object" && "code" in body.error ? body.error.code : null;
      if (response.status === 503 && code === "CONFIGURATION_ERROR") return unavailable("翻译服务尚未配置，保留已有原文");
      if (response.status === 503 && code === "INFRASTRUCTURE_ERROR") return unavailable("已有中文翻译暂时无法读取，保留已有原文");
      throw new Error(localAgentErrorMessage(body, "主要卖点读取失败"));
    }
    const data = SellingTranslationResponse.parse(body);
    if (data.asin !== asin) throw new Error("主要卖点来源不匹配");
    if (JSON.stringify(expected.original) !== JSON.stringify(data.original)
        || (data.state === "ready" && data.points.length !== data.original.length)
        || data.sourceComplete !== expected.sourceComplete) {
      throw new Error("主要卖点与快照原文不匹配，请重新准备");
    }
    return data;
  }));
  const points = await readAll();
  const checked = await readAll();
  if (JSON.stringify(points) !== JSON.stringify(checked)) throw new Error("主要卖点在读取期间变化，请重试");
  return [{ kind: "table", title: "主要卖点（已有中文翻译与原文）", columns: ["ASIN", "中文卖点", "对应原文", "状态"],
    rows: points.flatMap(item => item.state === "ready" ? item.points.map((point, index) =>
      [{ text: item.asin }, { text: point }, { text: item.original[index] },
        { text: item.sourceComplete ? "已翻译" : "历史原文仅保留部分卖点" }]) :
      [[{ text: item.asin }, { text: item.message || "暂无已生成的中文卖点" },
        { text: item.original.join("\n") || "—" }, { text: ({ missing: "暂无中文翻译", pending: "翻译中（本次保留原文）", failed: "翻译未完成（保留原文）", unavailable: "中文翻译不可用" } as const)[item.state] }]]) }];
}
export async function readExportContent(request: ExportRequest, fetcher: ExportFetcher = exportFetcher): Promise<PreparedProjectExport> {
  const read = scopedFetcher(request, fetcher);
  const { project, source, sourceProjectId } = await eligibility(request, read);
  const version = await readCurrentProjectDisplayVersion({
    organizationId: request.organizationId, projectId: sourceProjectId, marketplace: source.marketplace, asins: source.asins,
  }, read);
  const scopedVersion = version ? { ...version, asins: [...project.asins],
    catalog: version.catalog.filter(item => item && typeof item === "object" && "asin" in item && project.asins.includes(String(item.asin))),
    gaps: version.gaps.filter(item => project.asins.includes(item.asin)) } : null;
  const context: ExportModuleContext = {
    projectId: sourceProjectId, organizationId: request.organizationId, marketplace: project.marketplace,
    asins: project.asins, sourceAsins: source.asins, currentRunId: source.currentRunId,
    version: scopedVersion, capturedAt: new Date().toISOString(), sharedReads: new Map(),
  };
  const readers: Record<ExportSectionId, () => Promise<ExportSection> | ExportSection> = {
    "competitor-overview": async () => {
      if (!scopedVersion) return {id:"competitor-overview",title:"竞品概览",status:"missing",
        blocks:[{kind:"text",text:"暂无已发布的竞品概览结果；导出不会自动发起分析。"}]};
      const section=buildOverviewExportSection(scopedVersion);
      return {...section,blocks:[...section.blocks,...await readSellingPoints(scopedVersion,project.asins,read)]};
    },
    "variants-orders": () => readVariantsExportSection(context,read),
    "listing-images": () => buildListingImagesExportSection(context),
    voc: () => readVocExportSection(context,read),
    keywords: () => buildKeywordsExportSection(context),
    definition: () => readDefinitionExportSection(context,read),
    checklist: () => readChecklistExportSection(context,read),
    traffic: () => readTrafficExportSection(context,read),
  };
  const labels = new Map(visibleExportSections(undefined).map(section=>[section.id,section.label]));
  const sections = await Promise.all(request.moduleIds.map(async id => {
    try { return await readers[id](); }
    catch(error) { throw new Error(`${labels.get(id)}：${error instanceof Error?error.message:"读取失败，请重试"}`); }
  }));
  await session(request, read);
  request.signal.throwIfAborted();
  return structuredClone({
    schemaVersion: "1", sourceProjectId,
    project: { id: project.id, name: project.name, marketplace: project.marketplace, asins: project.asins },
    capturedAt: new Date().toISOString(),
    sourceLabel: version ? `基础报告 ${version.versionId} · 来源完成 ${version.sourceCompletedAt}；各模块补充来源与时间见正文` : "暂无已发布基础报告；其他已有来源与时间见各模块",
    sections,
  });
}
