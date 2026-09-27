import { EntityIdSchema, GetProjectResponseSchema, LocalDataProjectResponseSchema } from "../../shared/agent-contracts";
import { AnalysisFavoritesResponseSchema } from "../../shared/analysis-project-favorite-contracts";
import { SellingTranslationResponse } from "../../shared/selling-point-translation-contracts";
import { readOriginalSellingPoints } from "../../shared/selling-point-source";
import { localAgentFetch, localAgentErrorMessage } from "../lib/local-agent-browser";
import { readWebSession } from "../lib/web-auth-session";
import type { CurrentProjectDisplayVersion } from "../lib/project-display-version-browser";
import { connectedExportModules, visibleExportSections, type ExportSectionId } from "./module-catalog";
import type { SnapshotSelection } from "./snapshot-navigation-catalog";

export type ExportIdentity = Readonly<{ sessionIdentity: string; organizationId: string }>;
export type ExportRequest = ExportIdentity & Readonly<{
  libraryProjectId: string; moduleIds: readonly ExportSectionId[]; selection?: SnapshotSelection; signal: AbortSignal;
}>;
export type PreparedProjectExport = Readonly<{
  sourceProjectId: string;
  project: { id: string; name: string; marketplace: string; asins: readonly string[] };
  capturedAt: string;
  sourceLabel: string;
}>;
export type ExportFetcher = (path: string, init?: RequestInit) => Promise<Response>;
export const exportFetcher: ExportFetcher = (path, init) => path.startsWith("/api/")
  ? fetch(path, { ...init, credentials: "same-origin" }) : localAgentFetch(path, init);

export function scopedFetcher(request: ExportRequest, fetcher: ExportFetcher): ExportFetcher {
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
export async function verifyExportSession(request: ExportRequest, fetcher: ExportFetcher) {
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
export async function readExportEligibility(request: ExportRequest, fetcher: ExportFetcher) {
  if (!request.moduleIds.length) throw new Error("请至少选择一个模块");
  if (request.moduleIds.some(id => !connectedExportModules.includes(id))) throw new Error("所选模块尚未接入导出");
  await verifyExportSession(request, fetcher);
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
export async function verifyExportEligibility(request: ExportRequest, prepared: Pick<PreparedProjectExport, "sourceProjectId" | "project">, fetcher: ExportFetcher = exportFetcher) {
  const read = scopedFetcher(request, fetcher);
  const current = await readExportEligibility(request, read);
  if (current.sourceProjectId !== prepared.sourceProjectId || current.project.id !== prepared.project.id
      || current.project.marketplace !== prepared.project.marketplace
      || JSON.stringify([...current.project.asins].sort()) !== JSON.stringify([...prepared.project.asins].sort())) {
    throw new Error("项目来源已变化，请重新打开导出");
  }
  await verifyExportSession(request, read);
}

export async function readExportSellingTranslations(version: CurrentProjectDisplayVersion, asins: readonly string[], read: ExportFetcher) {
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
  return points;
}
