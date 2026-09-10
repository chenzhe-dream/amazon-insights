import { type TabId } from "../../lib/app-tabs";
import { type AnalysisProject } from "./project-library-panel";
import { clearVocRunFromSearch } from "../../lib/voc-run-browser";
import { workspaceHref } from "../../lib/workspace-url";

export const savedReportStageLabels = {
  "traffic-analysis": "流量分析",
  "voc-positioning": "VOC 定位",
  "product-definition": "产品定义",
} as const;

export const MAX_ASIN_SLOTS = 10;

export const PROJECT_REGISTRATION_FAILURE = "项目登记失败，未创建分析任务，请重试";

export function buildInputSlots(asins: string[]) {
  const slots = Array.from({ length: MAX_ASIN_SLOTS }, () => "");
  asins.forEach((asin, index) => {
    if (index < slots.length) slots[index] = asin;
  });
  return slots;
}

export function parseAsinsParam(raw: string | null): string[] | null {
  if (!raw?.trim()) return null;
  const values = raw
    .split(",")
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  if (values.length < 3) return null;
  if (values.some(value => !/^[A-Z0-9]{10}$/.test(value))) return null;
  if (new Set(values).size !== values.length) return null;
  return values.slice(0, MAX_ASIN_SLOTS);
}

export function resolveActiveAsins(raw: string | null) {
  return parseAsinsParam(raw) ?? [];
}

export function sameAsinSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const other = new Set(right);
  return left.every(item => other.has(item));
}

export function replaceAppUrl(params: URLSearchParams, basePath = "/") {
  if (typeof window === "undefined") return;
  const query = params.toString();
  const url = query ? `${basePath}?${query}` : basePath;
  window.history.replaceState(window.history.state, "", url);
}

export function buildTabHref(tabId: TabId, current: URLSearchParams | { toString(): string }, basePath = "/") {
  const params = new URLSearchParams(current.toString());
  if (tabId === "overview") params.delete("tab");
  else params.set("tab", tabId);
  params.delete("sub");
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function buildProjectLoadHref(
  project: AnalysisProject,
  current: URLSearchParams | { toString(): string },
  tabId: TabId = "overview",
) {
  let params = new URLSearchParams(current.toString());
  if (tabId === "overview") params.delete("tab");
  else params.set("tab", tabId);
  params.delete("asins");
  params.delete("project");
  params.delete("run");
  params = clearVocRunFromSearch(params);
  params.delete("syncJob");
  if (!project.slug) {
    params.set("asins", project.asins.join(","));
    params.set("project", project.id);
  }
  return workspaceHref(project.slug, params);
}

export function setProjectParam(params: URLSearchParams, projectId: string | null) {
  if (projectId) params.set("project", projectId);
  else params.delete("project");
}
