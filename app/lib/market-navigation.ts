import { marketModuleNodeQueryKey, marketModuleSelectionQueryKeys } from './market-module-selection';

export const marketNavigation = [
  { view: "overview", visualDim: "market-overview", label: "市场总览", sub: "规模 · 趋势 · 垄断" },
  { view: "shapes", visualDim: "market-structure", label: "商品形态及价格带", sub: "形态 · 价格带 · TOP销量 · 上架" },
  { view: "keywords", visualDim: "market-traffic", label: "类目关键词洞察", sub: "搜索需求 · 词洞察 · CPC" },
  { view: "themes", visualDim: "market-review-insight", label: "类目买家评论见解", sub: "TOP20 · Customers Say · 主题聚合" },
  { view: "favorites", visualDim: "projects", label: "调研收藏夹", sub: "项目归类 · 报告汇总 · 团队共享" },
] as const;

export type MarketScreen = typeof marketNavigation[number]["view"];
export type MarketView = Exclude<MarketScreen,"favorites">;
export function marketScreenFromParam(value:string|null):MarketScreen{return value==="favorites"?"favorites":marketViewFromParam(value)}

export function marketViewFromParam(value: string | null): MarketView {
  return (marketNavigation.find(item => item.view === value && item.view !== "favorites")?.view as MarketView | undefined) ?? "overview";
}

export function marketViewHref(view: MarketScreen, current: { toString(): string }): string {
  const source = new URLSearchParams(current.toString());
  const params = new URLSearchParams({ tab: "market-overview" });
  if (view !== "overview") params.set("themeView", view);
  // Market navigation is independent of competitor projects and sync jobs.
  for (const key of ["marketFavorite", "webArtifact", "marketNode", "marketMonth", "marketFrom", "marketHead", "marketNew", "marketSite", ...marketModuleSelectionQueryKeys, "overviewRun", "shapeRun", "keywordRun", "themeRun", "linkedBatch", "linkedApply", "linkedScopeApplied"]) {
    const value = source.get(key);
    if (value !== null) params.set(key, value);
  }
  if (view !== 'overview' && view !== 'favorites' && !params.has(marketModuleNodeQueryKey(view))) params.set(marketModuleNodeQueryKey(view), '');
  for (const key of ['favoriteCategory','favoriteModule','favoritePage']) {
    const value=source.get(key);if(value!==null)params.set(key,value);
  }
  if(view==='favorites'&&source.get('themeView')!=='favorites'){
    const from=marketViewFromParam(source.get('themeView'));
    const node=source.get(from==='overview'?'marketNode':marketModuleNodeQueryKey(from));
    if(node&&/^\d+(?::\d+)*$/.test(node)){
      params.set('favoriteCategory',node.split(':').at(-1)!);
      params.set('favoriteModule',from);
    }
  }
  return `/?${params}`;
}
