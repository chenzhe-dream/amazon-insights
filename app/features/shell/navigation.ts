import type { TabId } from "../../lib/app-tabs";

export type NavGroupId = "overview-group" | "voc-group" | "keywords-group" | "projects-group";
export type NavLeaf = { id: TabId; label: string; sub: string };
export type NavGroup = { id: NavGroupId; label: string; sub: string; children: NavLeaf[] };
export type NavEntry = NavLeaf | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "children" in entry;
}

export function isOverviewFamilyTab(tabId: TabId) {
  return tabId === "overview" || tabId === "overview-images";
}

export function isVocFamilyTab(tabId: TabId) {
  return tabId === "voc" || tabId === "launch" || tabId === "voc-positioning";
}

export function isKeywordFamilyTab(tabId: TabId) {
  return tabId === "keywords" || tabId === "keyword-insight";
}

export function isProjectsFamilyTab(tabId: TabId) {
  return tabId === "projects" || tabId === "keyword-compare" || tabId === "traffic-promo" || tabId === "checklist-library";
}

export function groupIdForTab(tabId: TabId): NavGroupId | null {
  if (isOverviewFamilyTab(tabId)) return "overview-group";
  if (isVocFamilyTab(tabId)) return "voc-group";
  if (isKeywordFamilyTab(tabId)) return "keywords-group";
  if (isProjectsFamilyTab(tabId)) return "projects-group";
  return null;
}

export const navigationEntries: readonly NavEntry[] = [
  {
    id: "overview-group",
    label: "竞品概览",
    sub: "参数 · 主辅图 · 变体",
    children: [
      { id: "overview", label: "竞品参数总览", sub: "参数 · 趋势 · 变体" },
      { id: "overview-images", label: "主辅图", sub: "主图 · 辅图 · 图册对比" },
    ],
  },
  {
    id: "voc-group",
    label: "VOC",
    sub: "原始矩阵 · 洞察立项",
    children: [
      { id: "voc", label: "竞品VOC 汇总", sub: "七维 · 评论 · 综合" },
      { id: "launch", label: "竞品 VOC 洞察", sub: "摘要 · 好评 · 差评 · 未满足" },
      { id: "voc-positioning", label: "产品定义结论", sub: "定位 · 三表合并 · 优化优先级" },
    ],
  },
  {
    id: "keywords-group",
    label: "关键词调研",
    sub: "竞品词分析 · 洞察",
    children: [
      { id: "keywords", label: "竞品关键词分析", sub: "含义分类 · 流量词对比" },
      { id: "keyword-insight", label: "关键词洞察", sub: "开品结论 · 需求分层" },
    ],
  },
  { id: "definition", label: "新品定义", sub: "VOC×关键词 · 最终定义" },
  { id: "checklist", label: "立项前确认清单", sub: "合规 · 专利 · 一票否决" },
  { id: "traffic", label: "竞品流量分析", sub: "结构 · 月趋势 · 推广结论" },
  {
    id: "projects-group",
    label: "收藏夹",
    sub: "项目收藏 · 流量词对比 · 推广能力 · 确认清单",
    children: [
      { id: "projects", label: "项目收藏", sub: "对标组合 · 参数总览 · 团队共享" },
      { id: "keyword-compare", label: "流量词对比", sub: "流量词矩阵 · 竞品对比 · 搜索意图" },
      { id: "traffic-promo", label: "竞品推广能力分析", sub: "流量结构 · 广告分布 · 推广结论" },
      { id: "checklist-library", label: "项目确认清单", sub: "合规认证 · 专利排查 · 一票否决" },
    ],
  },
];
