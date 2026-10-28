import {MarketKeywordOriginalEstimateSchema} from './market-keyword-original-estimate-contracts';
import type {MarketKeywordFacts} from './market-keyword-public-contracts';
import type {ProductKeywordSearchReport} from './market-keyword-original-input';
import {buildAmazonKeywordDemandReport} from '../server/domain/market-research/keyword-original-demand';
import {buildKeywordBusinessOutputs} from '../server/domain/market-research/keyword-business-outputs';
export function originalEstimateInput(facts:MarketKeywordFacts,productSeed:string):ProductKeywordSearchReport{
 // "empty" describes the requested months, not the complete saved history.
 const keywords=facts.members.map(m=>({keyword:m.keyword,weeklySearchRank:m.pageMetrics.weeklySearchRank.value,weeklySearchVolume:m.pageMetrics.weeklySearchVolume.value,monthlySearchVolume:m.pageMetrics.monthlySearchVolume.value,cpcExactBid:m.pageMetrics.recommendedCpcUsd.value,peakSeason:m.pageMetrics.seasonality?.replace(/^Peak season of search volume:\s*/i,'').trim()||null,
 trend:['ready','partial','empty'].includes(m.trend.status)?(m.trend.historyMonths??m.trend.months).filter(p=>p.month<=facts.referenceMonth&&p.searchVolume.value!==null&&p.searchVolume.reason===null).map(p=>({month:p.month,volume:p.searchVolume.value!,abaRank:p.searchRank.value,cpc:p.recommendedBid.value})):[],yearlySearchVolume:{}}));
 return {productName:productSeed,marketplace:facts.scope.marketplace,queryMode:facts.members.some(m=>m.occurrences.some(o=>o.sourceMode==='category-keywords'))?'category_keywords':'keyword_extends',keywords,totalCount:keywords.length,fetchedPages:facts.pool.receivedPageCount,trendEnrichedCount:keywords.filter(k=>k.trend.length).length};
}
/** Local display-only recovery from saved facts; no collection or model call. */
export function recoverKeywordDisplay(facts:MarketKeywordFacts,productSeed:string){
 const report=buildAmazonKeywordDemandReport(originalEstimateInput(facts,productSeed));
 return {report:MarketKeywordOriginalEstimateSchema.shape.report.parse({...report,businessOutputs:buildKeywordBusinessOutputs(report,facts.factsId)}),totalKeywordCount:facts.members.length,notes:['历史事实按当前规则恢复展示；未重新采集。此视图不是原保存版本的冻结结论。']};
}
