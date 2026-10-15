import type {MarketAnalysisScope} from '../../shared/market-analysis-contracts';
export function assertShapeHistoryScope(expected:MarketAnalysisScope,actual:MarketAnalysisScope){
 for(const key of ['organizationId','researchId','marketplace','nodeIdPath','fromMonth','toMonth','currency'] as const){
  if(expected[key]!==actual[key])throw new Error('历史报告与当前任务范围不一致，未展示该版本。');
 }
}
