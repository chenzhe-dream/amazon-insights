import {MarketKeywordFactsSchema,type MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
import {MarketKeywordRevisionCatalogSchema,type MarketKeywordRevisionCatalog} from '../../../shared/market-keyword-revision-contracts';
import {MarketKeywordReconciliationReportSchema,type MarketKeywordReconciliationReport} from '../../../shared/market-keyword-reconciliation-contracts';
import {MarketKeywordRuleReportSchema,KEYWORD_RULE_REPORT_VERSION,KEYWORD_THREE_MONTH_FORMULA_VERSION,type MarketKeywordRuleReport} from '../../../shared/market-keyword-rule-report-contracts';
import {KEYWORD_SCORING_RULE_VERSION,type KeywordMetricEvidence,type KeywordScoringMetric} from '../../../shared/market-keyword-scoring-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {buildMarketKeywordRevision} from './keyword-revision';
import {aggregateKeywordClusters} from './keyword-clusters';
import {scoreKeywordDemandClusters} from './keyword-scoring';
type Input={facts:MarketKeywordFacts;classification:null|{kind:'manual';revision:MarketKeywordRevisionCatalog}|{kind:'global';report:MarketKeywordReconciliationReport}};
function unique(ids:readonly string[],name:string){if(new Set(ids).size!==ids.length)throw new TypeError(`Duplicate ${name}`);return new Set(ids);}
function prior(month:string,offset:number){const [y,m]=month.split('-').map(Number),n=y*12+m-1-offset;return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;}
const missing=(reason:string):KeywordScoringMetric=>({value:null,evidence:null,missingReason:reason});
/** Derive only from already source-validated facts; hashes bind content, not the truth of external data. */
export function buildMarketKeywordRuleReport(input:Input):MarketKeywordRuleReport{
 const facts=MarketKeywordFactsSchema.parse(input.facts),{factsId,...factsBasis}=facts;
 if(factsId!==`market-keyword-facts:${digest(factsBasis)}`)throw new TypeError('Facts identity mismatch');
 if(facts.referenceMonth!==facts.scope.toMonth||facts.referenceMonth>=facts.pool.dataCutoffAt.slice(0,7))throw new TypeError('Rule report requires completed scope reference month');
 for(const member of facts.members){const aba=member.aba;if(!aba)continue;
  if(aba.referenceMonth!==facts.referenceMonth||(aba.member&&(aba.member.memberId!==member.keywordId||aba.member.keyword!==member.keyword||aba.member.referenceMonth!==facts.referenceMonth)))throw new TypeError('ABA member binding mismatch');
 }
 const members=unique(facts.members.map(m=>m.keywordId),'facts member');
 const mappings:{keywordId:string;clusterId:string}[]=[],labels=new Map<string,string>();
 let classification:MarketKeywordRuleReport['classification']={kind:'none',identity:null};
 if(input.classification?.kind==='manual'){
  const revision=MarketKeywordRevisionCatalogSchema.parse(input.classification.revision);
  if(digest(revision.facts)!==digest(facts))throw new TypeError('Classification facts mismatch');
  const rebuilt=buildMarketKeywordRevision({facts,request:{...revision.classification,factsId,expectedParentRevisionId:revision.revision.parentRevisionId,note:revision.revision.note},authorId:revision.revision.authorId,createdAt:revision.revision.createdAt});
  if(digest(rebuilt)!==digest(revision))throw new TypeError('Revision identity mismatch');
  classification={kind:'manual',identity:revision.revision.revisionId};
  for(const c of revision.classification.clusters)labels.set(c.clusterId,c.label);
  for(const a of revision.classification.assignments)if(a.clusterId!==null)mappings.push({keywordId:a.keywordId,clusterId:a.clusterId});
 }else if(input.classification?.kind==='global'){
  const report=MarketKeywordReconciliationReportSchema.parse(input.classification.report);
  if(report.moduleRunId!==facts.moduleRunId||(report.inputSnapshotId!==null&&report.inputSnapshotId!==facts.pool.semanticInputSnapshotId))throw new TypeError('Global classification binding mismatch');
  classification={kind:'global',identity:report.resultHash};
  const candidates=unique(report.catalog.map(c=>c.candidateId),'global candidate');
  const decisions=unique(report.decisions.map(d=>d.keywordId),'global decision');
  if([...decisions].some(id=>!members.has(id)))throw new TypeError('Foreign global keyword');
  if(report.decisions.length||report.status==='ready'){
   if(decisions.size!==members.size||report.inputSnapshotId!==facts.pool.semanticInputSnapshotId)throw new TypeError('Global classification must cover every original keyword');
   for(const c of report.catalog)if(c.dimension==='cluster')labels.set(c.candidateId,c.label);
   for(const d of report.decisions){
    for(const dimension of ['W1','W2','W3','W4','cluster'] as const){const choice=d[dimension];unique(choice.candidateIds,'global assignment');for(const id of choice.candidateIds)if(!candidates.has(id)||!report.catalog.some(c=>c.candidateId===id&&c.dimension===dimension))throw new TypeError('Foreign global candidate');}
    if(d.cluster.status==='supported'){
     if(d.cluster.candidateIds.length!==1)throw new TypeError('Global cluster must be single supported candidate');
     if((report.status==='ready'||report.status==='partial')&&report.resultHash!==null)mappings.push({keywordId:d.keywordId,clusterId:d.cluster.candidateIds[0]});
    }
   }
  }
 }
 const mapped=new Map(mappings.map(m=>[m.keywordId,m.clusterId]));
 const snapshotSources=new Map<string,string>();
 const scope={...facts.scope,fromMonth:facts.referenceMonth,toMonth:facts.referenceMonth};
 const evidence=(recordIds:string[],metric:string,unit:KeywordMetricEvidence['unit'],method:string,methodVersion:string):KeywordMetricEvidence=>({scope,snapshotId:factsId,sourceVersion:facts.version,recordIds,metric,unit,method,methodVersion});
 const keywords:MarketKeywordRuleReport['keywords']=facts.members.map(member=>{
  unique(member.trend.months.map(m=>m.month),'trend month');
  const trend=member.trend;
  if(trend.inputSnapshotId!==null&&trend.sourceRef!==null){const previous=snapshotSources.get(trend.inputSnapshotId);if(previous&&previous!==trend.sourceRef)throw new TypeError('Conflicting trend snapshot source references');snapshotSources.set(trend.inputSnapshotId,trend.sourceRef);}
  const source=trend.inputSnapshotId&&trend.sourceRef&&trend.fetchedAt?{inputSnapshotId:trend.inputSnapshotId,sourceRef:trend.sourceRef,fetchedAt:trend.fetchedAt,referenceMonth:facts.referenceMonth,unit:'count' as const,method:'calendar-month-total' as const,sourceVersion:facts.version}:null;
  const usable=source!==null&&(trend.status==='ready'||trend.status==='partial');
  const comparisons=trend.comparisonMonths;
  if(comparisons&&comparisons.referenceMonth!==facts.referenceMonth)throw new TypeError('Comparison reference month mismatch');
  const read=(month:string)=>{
   const displayed=trend.months.find(m=>m.month===month)?.searchVolume,comparison=comparisons?.months.find(m=>m.month===month)?.searchVolume;
   if(displayed&&comparison&&digest(displayed)!==digest(comparison))throw new TypeError('Conflicting comparison month evidence');
   const measurement=comparison??displayed;
   if(!usable||!measurement||measurement.reason!==null||measurement.value===null)return null;
   if(!Number.isSafeInteger(measurement.value))throw new TypeError('Search volume must be a safe integer count');return measurement.value;
  };
  const current=read(facts.referenceMonth);
  const change=(offset:number):MarketKeywordRuleReport['keywords'][number]['w5']['threeMonthGrowth']=>{
   const baselineMonth=prior(facts.referenceMonth,offset);let baselineValue=read(baselineMonth);
   // Legacy facts already retain source-verified YoY/MoM baseline counts inside
   // their growth records, even when the month falls outside the displayed range.
   const reference=trend.months.find(m=>m.month===facts.referenceMonth),legacy=offset===12?reference?.yoyGrowth:offset===1?reference?.recentGrowth:undefined;
   if(usable&&legacy&&legacy.baselineValue!==null){
    if(legacy.baselineMonth!==baselineMonth||!Number.isSafeInteger(legacy.baselineValue))throw new TypeError('Invalid retained comparison baseline');
    if(baselineValue!==null&&baselineValue!==legacy.baselineValue)throw new TypeError('Conflicting retained comparison baseline');
    if(comparisons&&baselineValue===null)throw new TypeError('Retained baseline conflicts with explicit missing comparison');
    if(!comparisons&&baselineValue===null)baselineValue=legacy.baselineValue;
    const expected=current===null?null:legacy.baselineValue===0?null:current/legacy.baselineValue-1;
    if(legacy.value!==expected)throw new TypeError('Retained comparison growth mismatch');
   }
   const reason=current===null?'missing-current':baselineValue===null?'missing-baseline':baselineValue===0?'zero-baseline':null;
   return {value:reason===null?current!/baselineValue!-1:null,reason,unit:'fraction',referenceMonth:facts.referenceMonth,currentValue:current,baselineMonth,baselineValue,formulaVersion:offset===3?KEYWORD_THREE_MONTH_FORMULA_VERSION:'calendar-month-growth/v1',source};
  };
  return {keywordId:member.keywordId,keyword:member.keyword,clusterId:mapped.get(member.keywordId)??null,w5:{searchVolume:{value:current,reason:current===null?'missing-completed-month-volume':null,unit:'count',referenceMonth:facts.referenceMonth,currentValue:current,baselineMonth:null,baselineValue:null,formulaVersion:'calendar-month-total/v1',source},yoyGrowth:change(12),recentGrowth:change(1),threeMonthGrowth:change(3),threeMonthLabel:'较3个月前',seasonality:{status:'unavailable',reason:'verified-seasonality-rule-evidence-unavailable'},lifecycle:{status:'unavailable',reason:'verified-lifecycle-rule-evidence-unavailable'}}};
 });
 const scoringMembers=keywords.map(k=>{
  const metric=(field:'searchVolume'|'yoyGrowth'|'recentGrowth',name:string,unit:KeywordMetricEvidence['unit'],method:string):KeywordScoringMetric=>{const v=k.w5[field];return v.value===null?missing(v.reason!):{value:v.value,evidence:evidence([k.keywordId],name,unit,method,v.formulaVersion),missingReason:null};};
  return {id:k.keywordId,text:k.keyword,searchVolume:metric('searchVolume','monthly-searches','count','calendar-month-total'),cpc:missing('source-provides-recommended-bid-only'),yoyGrowth:metric('yoyGrowth','yoy-growth','fraction','year-over-year-change'),recentGrowth:metric('recentGrowth','monthly-growth','fraction','month-over-month-change')};
 });
 // Reuse the existing original-member weighting and field-specific denominator for M-3.
 const threeMonth=aggregateKeywordClusters({keywords:keywords.map(k=>({id:k.keywordId,text:k.keyword,searchVolume:k.w5.searchVolume.value,cpc:null,yoyGrowth:k.w5.threeMonthGrowth.value,recentGrowth:null})),mappings});
 const factByMember=new Map(facts.members.map(member=>[member.keywordId,member]));
 const hasVerifiedMemberAba=(memberIds:readonly string[])=>memberIds.some(id=>{const aba=factByMember.get(id)?.aba;return aba!==undefined&&(aba.status==='ready'||aba.status==='partial')&&aba.referenceMonth===facts.referenceMonth&&aba.inputSnapshotId!==null&&aba.sourceRef!==null&&aba.fetchedAt!==null&&aba.member!==null&&aba.member.top3ClickShare.value!==null;});
 const metrics=threeMonth.clusters.map(cluster=>({clusterId:cluster.clusterId!,memberIds:cluster.memberIds,threeMonthGrowth:cluster.yoyGrowth.value===null?missing('no-positive-volume-with-three-month-growth'):{value:cluster.yoyGrowth.value,evidence:evidence(cluster.memberIds.filter(id=>{const k=keywords.find(k=>k.keywordId===id)!;return k.w5.searchVolume.value!==null&&k.w5.searchVolume.value>0&&k.w5.threeMonthGrowth.value!==null;}),'three-month-growth','fraction','three-month-change',KEYWORD_THREE_MONTH_FORMULA_VERSION),missingReason:null},supplyDemandRatio:missing('supply-demand-not-collected'),abaTop3Share:missing(hasVerifiedMemberAba(cluster.memberIds)?'aba-top3-cluster-aggregation-method-not-verified':'aba-top3-not-collected'),spr:missing('spr-not-collected'),suggestedBid:missing('recommended-bid-currency-unconfirmed'),averagePrice:missing('mapped-product-prices-not-collected'),w5:{diagnosis:null,evidence:null,missingReason:'verified-lifecycle-rule-evidence-unavailable'}}));
 const scored=scoreKeywordDemandClusters({scope,snapshotId:factsId,sourceVersion:facts.version,mappingVersion:classification.identity??'unassigned/v1',ruleVersion:KEYWORD_SCORING_RULE_VERSION,abaShareKind:'top3-click-share',keywords:scoringMembers,mappings,clusterMetrics:metrics,comparisonClusterIds:metrics.map(m=>m.clusterId),excludedClusters:[]});
 const rankPools:MarketKeywordRuleReport['rankPools']=[];
 const internedRankPools=new WeakMap<readonly string[],WeakMap<readonly string[],string>>();
 const clusters=scored.clusters.map(score=>{
  const ranks=Object.fromEntries(Object.entries(score.ranks).map(([field,rank])=>{const {comparisonClusterIds,missingClusterIds,...values}=rank;
   let byMissing=internedRankPools.get(comparisonClusterIds);if(!byMissing){byMissing=new WeakMap();internedRankPools.set(comparisonClusterIds,byMissing);}
   let id=byMissing.get(missingClusterIds);if(!id){const pool={comparisonClusterIds:[...comparisonClusterIds],missingClusterIds:[...missingClusterIds]};id=`rank-pool:${digest(pool)}`;if(!rankPools.some(p=>p.id===id))rankPools.push({id,...pool});byMissing.set(missingClusterIds,id);}
   return [field,{...values,comparisonPoolId:id}];})) as MarketKeywordRuleReport['clusters'][number]['score']['ranks'];
  const m=metrics.find(m=>m.clusterId===score.clusterId)!,coverage=threeMonth.clusters.find(c=>c.clusterId===score.clusterId)!.yoyGrowth;
  const {clusterId,memberIds:_members,w5:_w5,...publicMetrics}=m;
  return {clusterId,label:labels.get(clusterId)??clusterId,threeMonthGrowth:{metric:m.threeMonthGrowth,coverage},metrics:publicMetrics,score:{...score,ranks,limitations:[...score.limitations,...(coverage.unknownValueCount?['partial-member-three-month-coverage']:[])]},missingInputs:Object.entries(publicMetrics).filter(([,v])=>v.value===null).map(([key])=>key)};
 });
 const basis={version:KEYWORD_RULE_REPORT_VERSION,factsId,moduleRunId:facts.moduleRunId,scope:facts.scope,referenceMonth:facts.referenceMonth,ruleVersion:KEYWORD_SCORING_RULE_VERSION,threeMonthFormulaVersion:KEYWORD_THREE_MONTH_FORMULA_VERSION,classification,rankPools,keywords,aggregation:scored.aggregation,clusters,limitations:['fixed-keyword-pool-not-unique-searchers','source-facts-version-identifies-projection-not-provider-method','recommended-bid-not-actual-cpc','recommended-bid-currency-unconfirmed','seasonality-and-lifecycle-unavailable',...(facts.pool.collectionCoverage!=='complete'||facts.pool.memberLimitReached?['partial-source-pool']:[])],interpretation:scored.interpretation,priceScoreMeaning:scored.priceScoreMeaning};
 return MarketKeywordRuleReportSchema.parse({...basis,reportId:`market-keyword-rule-report:${digest({report:basis,classificationSource:input.classification})}`});
}
