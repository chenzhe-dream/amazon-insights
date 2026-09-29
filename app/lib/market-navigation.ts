import { marketModuleNodeQueryKey, marketModuleSelectionQueryKeys } from './market-module-selection';

export const marketNavigation = [
  { view: "overview", visualDim: "market-overview", label: "市场总览", sub: "规模 · 趋势 · 垄断" },
  { view: "shapes", visualDim: "market-structure", label: "商品形态及价格带", sub: "形态 · 价格带 · TOP销量 · 上架" },
  { view: "keywords", visualDim: "market-traffic", label: "类目关键词洞察", sub: "搜索需求 · 词洞察 · CPC" },
  { view: "themes", visualDim: "market-review-insight", label: "类目买家评论见解", sub: "TOP20 · Customers Say · 主题聚合" },
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
