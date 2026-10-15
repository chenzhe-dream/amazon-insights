import {originalEstimateInput} from '../../../shared/market-keyword-display-projection';
export {originalEstimateInput} from '../../../shared/market-keyword-display-projection';
import {MarketKeywordFactsSchema,type MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
import {MarketKeywordOriginalEstimateSchema} from '../../../shared/market-keyword-original-estimate-contracts';
import type {ProductKeywordSearchReport} from '../../../shared/market-keyword-original-input';
import type {MarketKeywordRevisionCatalog} from '../../../shared/market-keyword-revision-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {buildAmazonKeywordDemandReport} from './keyword-original-demand';
import {buildKeywordBusinessOutputs} from './keyword-business-outputs';
import {buildMarketKeywordRevision} from './keyword-revision';

/** Source-page volume is intentionally NOT assigned a reference month. */
export function buildKeywordOriginalEstimate({facts:raw,productSeed,revision}:{facts:MarketKeywordFacts;productSeed:string;revision?:MarketKeywordRevisionCatalog}){
 const facts=MarketKeywordFactsSchema.parse(raw),{factsId,...factBasis}=facts;
 if(factsId!==`market-keyword-facts:${digest(factBasis)}`)throw new TypeError('Estimate facts identity mismatch');
 const input=originalEstimateInput(facts,productSeed);
 if(revision){
  if(digest(revision.facts)!==digest(facts))throw new TypeError('Estimate revision facts mismatch');
  const rebuilt=buildMarketKeywordRevision({facts,request:{...revision.classification,factsId,expectedParentRevisionId:revision.revision.parentRevisionId,note:revision.revision.note},authorId:revision.revision.authorId,createdAt:revision.revision.createdAt});
  if(digest(rebuilt)!==digest(revision))throw new TypeError('Estimate revision identity mismatch');
  input.manualGroups=Object.fromEntries(revision.classification.assignments.map(a=>[facts.members.find(m=>m.keywordId===a.keywordId)!.keyword,a.clusterId===null?null:{id:a.clusterId,name:revision.classification.clusters.find(c=>c.clusterId===a.clusterId)!.label,features:a.W4.map(id=>revision.classification.labels.W4.find(l=>l.labelId===id)!.label)}]));
  input.manualDimensions=Object.fromEntries(revision.classification.assignments.map(a=>{
   const labels={W1:a.W1.map(id=>revision.classification.labels.W1.find(l=>l.labelId===id)!.label),W2:a.W2.map(id=>revision.classification.labels.W2.find(l=>l.labelId===id)!.label),W3:a.W3.map(id=>revision.classification.labels.W3.find(l=>l.labelId===id)!.label),W4:a.W4.map(id=>revision.classification.labels.W4.find(l=>l.labelId===id)!.label)};
   return [facts.members.find(m=>m.keywordId===a.keywordId)!.keyword,labels] as const;
  }));
 }
 // Omit optional undefined properties exactly as JSON transport does.
 const report=JSON.parse(JSON.stringify(buildAmazonKeywordDemandReport(input))) as ReturnType<typeof buildAmazonKeywordDemandReport>;
 const reportWithBusinessOutputs={...report,businessOutputs:buildKeywordBusinessOutputs(report,factsId)};
 const basis={version:'keyword-original-estimate/v1' as const,factsId,classificationId:revision?.revision.revisionId??null,sampleVolumeBasis:'source-page-monthly-volume/unspecified-window' as const,totalKeywordCount:facts.members.length,excludedKeywordIds:facts.members.filter(m=>!m.keyword||m.pageMetrics.monthlySearchVolume.value===null).map(m=>m.keywordId),
 notes:['派生规则 keyword-derived/20261015.1：按固定事实和当前所选分类版本重算；未覆盖原始事实或原历史分类。','原版估算：S3、S5 固定 50 分，S4 包含 50 分占位；不是实测竞争或利润。','规模使用来源页月搜索量，来源未注明统计月份；与参考月趋势搜索量分别保留。','评分按原版在小簇归并前计算；归并后规模更新，评分与评分占比保留归并前结果。','历史增长按原版已有月份观察点比较；不补缺月，缺增长使用原版回退规则。','14项业务输出逐项绑定保存关键词事实；缺少竞争、价格、利润、VOC或合规证据时明确标记待验证。'],report:reportWithBusinessOutputs};
 return MarketKeywordOriginalEstimateSchema.parse({...basis,estimateId:`keyword-original-estimate:${digest(basis)}`});
}
