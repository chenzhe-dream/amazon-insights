import {isMarketShapeExplanationFlow} from './shape-explanation-flow';
import {inspectMarketShapeExplanationContinuation} from './shape-explanation-continuation';
import type {MarketModuleRunView} from '../../db/market-module-execution-repository';
import {isMarketThemeFlow,inspectMarketThemeContinuation} from './customer-theme-flow';
import {isMarketOverviewFlow,inspectMarketOverviewContinuation} from './overview-flow';
import {isMarketShapeFlow,inspectMarketShapeContinuation} from './shape-price-flow';
import {isMarketKeywordFlow,inspectMarketKeywordContinuation} from './keyword-flow';
import { buildMarketRuleBaseline } from './market-rule-baseline';
export { buildMarketRuleBaseline };
export const isMarketAutomaticFlow=(run:MarketModuleRunView['run'])=>isMarketShapeExplanationFlow(run)||isMarketThemeFlow(run)||isMarketOverviewFlow(run)||isMarketShapeFlow(run)||isMarketKeywordFlow(run);
export function inspectMarketContinuation(view:MarketModuleRunView,now:string){
  return isMarketShapeExplanationFlow(view.run)?inspectMarketShapeExplanationContinuation(view,now):isMarketOverviewFlow(view.run)?inspectMarketOverviewContinuation(view,now):isMarketShapeFlow(view.run)?inspectMarketShapeContinuation(view,now):isMarketKeywordFlow(view.run)?inspectMarketKeywordContinuation(view,now):inspectMarketThemeContinuation(view,now);
}
