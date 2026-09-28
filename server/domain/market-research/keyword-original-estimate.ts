import {MarketKeywordFactsSchema,type MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
import {MarketKeywordOriginalEstimateSchema} from '../../../shared/market-keyword-original-estimate-contracts';
import type {ProductKeywordSearchReport} from '../../../shared/market-keyword-original-input';
import type {MarketKeywordRevisionCatalog} from '../../../shared/market-keyword-revision-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {buildAmazonKeywordDemandReport} from './keyword-original-demand';
import {buildMarketKeywordRevision} from './keyword-revision';

/** Source-page volume is intentionally NOT assigned a reference month. */
export function originalEstimateInput(facts:MarketKeywordFacts,productSeed:string):ProductKeywordSearchReport{
 const keywords=facts.members.map(m=>({keyword:m.keyword,weeklySearchRank:m.pageMetrics.weeklySearchRank.value,weeklySearchVolume:m.pageMetrics.weeklySearchVolume.value,monthlySearchVolume:m.pageMetrics.monthlySearchVolume.value,cpcExactBid:m.pageMetrics.recommendedCpcUsd.value,peakSeason:m.pageMetrics.seasonality?.replace(/^Peak season of search volume:\s*/i,'').trim()||null,
 trend:['ready','partial'].includes(m.trend.status)?(m.trend.historyMonths??m.trend.months).filter(p=>p.month<=facts.referenceMonth&&p.searchVolume.value!==null&&p.searchVolume.reason===null).map(p=>({month:p.month,volume:p.searchVolume.value!,abaRank:p.searchRank.value,cpc:p.recommendedBid.value})):[],yearlySearchVolume:{}}));
 return {productName:productSeed,marketplace:facts.scope.marketplace,queryMode:'keyword_extends',keywords,totalCount:keywords.length,fetchedPages:facts.pool.receivedPageCount,trendEnrichedCount:keywords.filter(k=>k.trend.length).length};
}
export function buildKeywordOriginalEstimate({facts:raw,productSeed,revision}:{facts:MarketKeywordFacts;productSeed:string;revision?:MarketKeywordRevisionCatalog}){
 const facts=MarketKeywordFactsSchema.parse(raw),{factsId,...factBasis}=facts;
 if(factsId!==`market-keyword-facts:${digest(factBasis)}`)throw new TypeError('Estimate facts identity mismatch');
 const input=originalEstimateInput(facts,productSeed);
 if(revision){
  if(digest(revision.facts)!==digest(facts))throw new TypeError('Estimate revision facts mismatch');
  const rebuilt=buildMarketKeywordRevision({facts,request:{...revision.classification,factsId,expectedParentRevisionId:revision.revision.parentRevisionId,note:revision.revision.note},authorId:revision.revision.authorId,createdAt:revision.revision.createdAt});
  if(digest(rebuilt)!==digest(revision))throw new TypeError('Estimate revision identity mismatch');
  input.manualGroups=Object.fromEntries(revision.classification.assignments.map(a=>[facts.members.find(m=>m.keywordId===a.keywordId)!.keyword,a.clusterId===null?null:{id:a.clusterId,name:revision.classification.clusters.find(c=>c.clusterId===a.clusterId)!.label,features:a.W4.map(id=>revision.classification.labels.W4.find(l=>l.labelId===id)!.label)}]));
 }
 // Omit optional undefined properties exactly as JSON transport does.
 const report=JSON.parse(JSON.stringify(buildAmazonKeywordDemandReport(input)));
 const basis={version:'keyword-original-estimate/v1' as const,factsId,classificationId:revision?.revision.revisionId??null,sampleVolumeBasis:'source-page-monthly-volume/unspecified-window' as const,totalKeywordCount:facts.members.length,excludedKeywordIds:facts.members.filter(m=>!m.keyword||m.pageMetrics.monthlySearchVolume.value===null).map(m=>m.keywordId),
 notes:['原版估算：S3、S5 固定 50 分，S4 包含 50 分占位；不是实测竞争或利润。','规模使用来源页月搜索量，来源未注明统计月份；与参考月趋势搜索量分别保留。','评分按原版在小簇归并前计算；归并后规模更新，评分与评分占比保留归并前结果。','历史增长按原版已有月份观察点比较；不补缺月，缺增长使用原版回退规则。'],report};
 return MarketKeywordOriginalEstimateSchema.parse({...basis,estimateId:`keyword-original-estimate:${digest(basis)}`});
}
