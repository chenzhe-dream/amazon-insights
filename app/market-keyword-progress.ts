import type {MarketKeywordRunResponse} from '../shared/market-keyword-public-contracts';
export function keywordCollectionProgress(run:MarketKeywordRunResponse['run']):string {
 const trends=run.steps.filter(step=>step.current&&step.kind==='collect-keyword-trend');
 if(!trends.length){
  if(run.status==='queued')return '等待采集';
  if(run.status==='running')return '正在采集关键词并汇总词池';
  return '趋势任务尚未生成';
 }
 const completed=trends.filter(step=>step.status==='succeeded'||step.status==='empty').length;
 const empty=trends.filter(step=>step.status==='empty').length;
 return `趋势已完成 ${completed}/${trends.length}（其中 ${empty} 词研究月份无搜索量，其他月份历史仍保留）`;
}
