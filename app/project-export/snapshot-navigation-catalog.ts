import type { ModuleKey } from "../../shared/module-visibility-contracts";
import { connectedExportModules, type ExportSectionId, visibleExportSections } from "./module-catalog";

type SnapshotPage = Readonly<{
  id: string;
  label: string;
  sub: string;
  module: ModuleKey;
  sourceId: ExportSectionId;
}>;

type SnapshotGroup = Readonly<{
  id: string;
  label: string;
  sub: string;
  tone: "blue" | "teal" | "red" | "orange" | "green";
  kind: "submenu" | "direct";
  pages: readonly SnapshotPage[];
}>;

// The export's sole page-level navigation catalog. Labels and order match app/page.tsx allNav.
export const snapshotNavigationGroups = [
  { id: "overview-group", label: "竞品概览", sub: "参数 · 主辅图 · 变体", tone: "blue", kind: "submenu", pages: [
    { id: "overview", label: "竞品参数总览", sub: "参数 · 趋势 · 变体", module: "overview", sourceId: "competitor-overview" },
    { id: "images", label: "主辅图", sub: "主图 · 辅图 · 图册对比", module: "overview", sourceId: "listing-images" },
  ] },
  { id: "voc-group", label: "VOC", sub: "原始矩阵 · 洞察立项", tone: "teal", kind: "submenu", pages: [
    { id: "voc-summary", label: "竞品VOC 汇总", sub: "七维 · 评论 · 综合", module: "voc", sourceId: "voc" },
    { id: "voc-insight", label: "竞品 VOC 洞察", sub: "摘要 · 好评 · 差评 · 未满足", module: "voc", sourceId: "voc" },
    { id: "voc-positioning", label: "产品定义结论", sub: "定位 · 三表合并 · 优化优先级", module: "voc", sourceId: "voc" },
  ] },
  { id: "keywords-group", label: "关键词调研", sub: "竞品词分析 · 洞察", tone: "red", kind: "submenu", pages: [
    { id: "keyword-analysis", label: "竞品关键词分析", sub: "含义分类 · 流量词对比", module: "keywords", sourceId: "keywords" },
    { id: "keyword-insight", label: "关键词洞察", sub: "开品结论 · 需求分层", module: "keywords", sourceId: "keywords" },
  ] },
  { id: "definition", label: "新品定义", sub: "VOC×关键词 · 最终定义", tone: "orange", kind: "direct", pages: [
    { id: "definition", label: "新品定义", sub: "VOC×关键词 · 最终定义", module: "definition", sourceId: "definition" },
  ] },
  { id: "checklist", label: "立项前确认清单", sub: "合规 · 专利 · 一票否决", tone: "green", kind: "direct", pages: [
    { id: "checklist", label: "立项前确认清单", sub: "合规 · 专利 · 一票否决", module: "checklist", sourceId: "checklist" },
  ] },
  { id: "traffic", label: "竞品流量分析", sub: "结构 · 月趋势 · 推广结论", tone: "blue", kind: "direct", pages: [
    { id: "traffic", label: "竞品流量分析", sub: "结构 · 月趋势 · 推广结论", module: "traffic", sourceId: "traffic" },
  ] },
] as const satisfies readonly SnapshotGroup[];

export type SnapshotPageId = (typeof snapshotNavigationGroups)[number]["pages"][number]["id"];
export type SnapshotSelection = Readonly<{
  pageIds: readonly SnapshotPageId[];
  includeVariants: boolean;
}>;
export type ResolvedSnapshotSelection = Readonly<{
  pageIds: readonly SnapshotPageId[];
  moduleIds: readonly ExportSectionId[];
  includeVariants: boolean;
}>;

type CatalogPage = (typeof snapshotNavigationGroups)[number]["pages"][number];
const orderedPages = snapshotNavigationGroups.reduce<CatalogPage[]>((pages, group) => {
  pages.push(...group.pages);
  return pages;
}, []);
const pageById = new Map<string, CatalogPage>(orderedPages.map(page => [page.id, page]));

export function visibleSnapshotNavigation(visibleModules: readonly ModuleKey[] | undefined) {
  const availableSources = new Set(visibleExportSections(visibleModules)
    .filter(section => connectedExportModules.includes(section.id))
    .map(section => section.id));
  return snapshotNavigationGroups.flatMap(group => {
    const pages = group.pages.filter(page => availableSources.has(page.sourceId));
    return pages.length ? [{ ...group, pages }] : [];
  });
}

export function resolveSnapshotSelection(
  selection: SnapshotSelection,
  visibleModules: readonly ModuleKey[] | undefined,
): ResolvedSnapshotSelection {
  if (!selection || !Array.isArray(selection.pageIds) || typeof selection.includeVariants !== "boolean") {
    throw new Error("无效的快照页面选择");
  }
  const requested = new Set<SnapshotPageId>();
  for (const id of selection.pageIds) {
    if (typeof id !== "string" || !pageById.has(id)) throw new Error(`未知的快照页面: ${String(id)}`);
    requested.add(id as SnapshotPageId);
  }
  const available = new Set(visibleSnapshotNavigation(visibleModules).flatMap(group => group.pages.map(page => page.id)));
  for (const id of requested) {
    if (!available.has(id)) throw new Error(`快照页面不可用或无权限: ${id}`);
  }

  const pageIds = orderedPages.filter(page => requested.has(page.id)).map(page => page.id);
  const includeVariants = selection.includeVariants && requested.has("overview") && connectedExportModules.includes("variants-orders");
  const moduleIds: ExportSectionId[] = [];
  for (const page of orderedPages) {
    if (!requested.has(page.id)) continue;
    if (!moduleIds.includes(page.sourceId)) moduleIds.push(page.sourceId);
    if (page.id === "overview" && includeVariants) moduleIds.push("variants-orders");
  }
  return { pageIds, moduleIds, includeVariants };
}
