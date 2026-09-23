import { marketModuleNodeQueryKey, marketModuleSelectionQueryKeys } from './market-module-selection';

export const marketNavigation = [
  { view: "overview", label: "市场总览", sub: "类目采集 · 基础指标" },
  { view: "shapes", label: "商品形态及价格带", sub: "商品形态 · 价格分布" },
  { view: "keywords", label: "类目关键词洞察", sub: "搜索需求 · 关键词分析" },
  { view: "themes", label: "类目买家评论见解", sub: "买家主题 · 评论洞察" },
] as const;

export type MarketView = typeof marketNavigation[number]["view"];

export function marketViewFromParam(value: string | null): MarketView {
  return marketNavigation.find(item => item.view === value)?.view ?? "overview";
}

export function marketViewHref(view: MarketView, current: { toString(): string }): string {
  const source = new URLSearchParams(current.toString());
  const params = new URLSearchParams({ tab: "market-overview" });
  if (view !== "overview") params.set("themeView", view);
  // Market navigation is independent of competitor projects and sync jobs.
  for (const key of ["webArtifact", "marketNode", "marketMonth", "marketFrom", "marketHead", "marketNew", "marketSite", ...marketModuleSelectionQueryKeys, "overviewRun", "shapeRun", "keywordRun", "themeRun"]) {
    const value = source.get(key);
    if (value !== null) params.set(key, value);
  }
  if (view !== 'overview' && !params.has(marketModuleNodeQueryKey(view))) params.set(marketModuleNodeQueryKey(view), '');
  return `/?${params}`;
}
