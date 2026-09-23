import { MarketSiteSchema, type MarketSite } from '../../shared/market-sites';
import type { MarketView } from './market-navigation';

export type IndependentMarketView = Exclude<MarketView, 'overview'>;
export type MarketModuleSelection = { marketplace: MarketSite; nodeIdPath: string; fromMonth: string; toMonth: string };

const keys = {
  shapes: { site: 'marketShapeSite', node: 'marketShapeNode', from: 'marketShapeFrom', month: 'marketShapeMonth' },
  keywords: { site: 'marketKeywordSite', node: 'marketKeywordNode', from: 'marketKeywordFrom', month: 'marketKeywordMonth' },
  themes: { site: 'marketThemeSite', node: 'marketThemeNode', from: 'marketThemeFrom', month: 'marketThemeMonth' },
} as const;

const validMonth = (value: string | null, latest: string) => value !== null && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value) && value <= latest;
const validNode = (value: string | null) => value !== null && (value === '' || /^\d+(?::\d+)*$/.test(value));

export function emptyMarketModuleSelection(latestMonth: string): MarketModuleSelection {
  return { marketplace: 'US', nodeIdPath: '', fromMonth: latestMonth, toMonth: latestMonth };
}

/** Generic market* keys are read only for a direct, old-style link to this module. */
export function readMarketModuleSelection(params: URLSearchParams, view: IndependentMarketView, latestMonth: string, legacyActive: boolean): MarketModuleSelection {
  const own = keys[view];
  const useLegacy = legacyActive && !params.has(own.node);
  const get = (field: keyof typeof own, legacy: string) => params.get(useLegacy ? legacy : own[field]);
  const marketplace = MarketSiteSchema.safeParse(get('site', 'marketSite')).data ?? 'US';
  const node = get('node', 'marketNode'), month = get('month', 'marketMonth'), from = get('from', 'marketFrom');
  const toMonth = validMonth(month, latestMonth) ? month! : latestMonth;
  return {
    marketplace,
    nodeIdPath: validNode(node) ? node! : '',
    fromMonth: validMonth(from, toMonth) ? from! : toMonth,
    toMonth,
  };
}

export function writeMarketModuleSelection(params: URLSearchParams, view: IndependentMarketView, selection: MarketModuleSelection): void {
  const own = keys[view];
  params.set(own.site, selection.marketplace);
  params.set(own.node, selection.nodeIdPath);
  params.set(own.from, selection.fromMonth);
  params.set(own.month, selection.toMonth);
}

export const marketModuleSelectionQueryKeys = Object.values(keys).flatMap(value => Object.values(value));
export const marketModuleNodeQueryKey = (view: IndependentMarketView) => keys[view].node;
