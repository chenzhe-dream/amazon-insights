import {originalTrendGrowth,originalLifecycle,ORIGINAL_THREE_MONTH_FORMULA} from './keyword-original-trend';
import {MarketKeywordFactsSchema,type MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
import {MarketKeywordRevisionCatalogSchema,type MarketKeywordRevisionCatalog} from '../../../shared/market-keyword-revision-contracts';
import {MarketKeywordReconciliationReportSchema,type MarketKeywordReconciliationReport} from '../../../shared/market-keyword-reconciliation-contracts';
import {MarketKeywordRuleReportSchema,KEYWORD_RULE_REPORT_VERSION,KEYWORD_THREE_MONTH_FORMULA_VERSION,type MarketKeywordRuleReport} from '../../../shared/market-keyword-rule-report-contracts';
import {KEYWORD_SCORING_RULE_VERSION,type KeywordMetricEvidence,type KeywordScoringMetric} from '../../../shared/market-keyword-scoring-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {buildMarketKeywordRevision} from './keyword-revision';
import {aggregateKeywordClusters} from './keyword-clusters';
import {scoreKeywordDemandClusters} from './keyword-scoring';
import {buildKeywordOriginalClassification} from './keyword-original-classification';
import type {MarketKeywordOriginalClassification} from '../../../shared/market-keyword-original-contracts';
type Input={facts:MarketKeywordFacts;classification:null|{kind:'manual';revision:MarketKeywordRevisionCatalog}|{kind:'global';report:MarketKeywordReconciliationReport}|{kind:'local';report:MarketKeywordOriginalClassification}};
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
 const original=facts.members.some(member=>member.trend.historyMonths!==undefined);
 const threeMonthFormula=original?ORIGINAL_THREE_MONTH_FORMULA:KEYWORD_THREE_MONTH_FORMULA_VERSION;
 const members=unique(facts.members.map(m=>m.keywordId),'facts member');
 const mappings:{keywordId:string;clusterId:string}[]=[],labels=new Map<string,string>();
 let classification:MarketKeywordRuleReport['classification']={kind:'none',identity:null};
 if(input.classification?.kind==='local'){
  const report=input.classification.report,rebuilt=buildKeywordOriginalClassification(facts,report.productSeed);
  if(digest(report)!==digest(rebuilt))throw new TypeError('Local classification binding mismatch');
  classification={kind:'local',identity:report.identity};
  for(const c of report.classification.clusters)labels.set(c.clusterId,c.label);
  for(const a of report.classification.assignments)if(a.clusterId!==null)mappings.push({keywordId:a.keywordId,clusterId:a.clusterId});
 }else if(input.classification?.kind==='manual'){
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
  // A verified empty research month can still have valid older observations.
  const usable=source!==null&&(trend.status==='ready'||trend.status==='partial'||trend.status==='empty');
  const comparisons=trend.comparisonMonths;
  if(comparisons&&comparisons.referenceMonth!==facts.referenceMonth)throw new TypeError('Comparison reference month mismatch');
  const read=(month:string)=>{
   const displayed=trend.months.find(m=>m.month===month)?.searchVolume,comparison=comparisons?.months.find(m=>m.month===month)?.searchVolume;
   if(displayed&&comparison&&digest(displayed)!==digest(comparison))throw new TypeError('Conflicting comparison month evidence');
   const historical=trend.historyMonths?.find(m=>m.month===month)?.searchVolume;
   if(historical&&[displayed,comparison].some(v=>v&&digest(v)!==digest(historical)))throw new TypeError('Conflicting historical month evidence');
   const measurement=historical??comparison??displayed;
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
  const historical=()=>{const points=trend.historyMonths??trend.months;for(const point of points)read(point.month);return points;};
  const windowGrowth=(kind:'history'|'three-month')=>({...originalTrendGrowth(usable?historical():[],facts.referenceMonth,kind),source});
  const historyGrowth=original?windowGrowth('history'):change(12),threeGrowth=original?windowGrowth('three-month'):change(3);
  return {keywordId:member.keywordId,keyword:member.keyword,clusterId:mapped.get(member.keywordId)??null,w5:{searchVolume:{value:current,reason:current===null?'missing-completed-month-volume':null,unit:'count',referenceMonth:facts.referenceMonth,currentValue:current,baselineMonth:null,baselineValue:null,formulaVersion:'calendar-month-total/v1',source},yoyGrowth:historyGrowth,recentGrowth:change(1),threeMonthGrowth:threeGrowth,threeMonthLabel:original?'近3月合计较前3月':'较3个月前',seasonality:{status:'unavailable',reason:'verified-seasonality-rule-evidence-unavailable'},lifecycle:original?originalLifecycle(historyGrowth.value,threeGrowth.value):{status:'unavailable',reason:'verified-lifecycle-rule-evidence-unavailable'}}};
 });
 const scoringMembers=keywords.map(k=>{
  const metric=(field:'searchVolume'|'yoyGrowth'|'recentGrowth',name:string,unit:KeywordMetricEvidence['unit'],method:string):KeywordScoringMetric=>{const v=k.w5[field];return v.value===null?missing(v.reason!):{value:v.value,evidence:evidence([k.keywordId],name,unit,method,v.formulaVersion),missingReason:null};};
  return {id:k.keywordId,text:k.keyword,searchVolume:metric('searchVolume','monthly-searches','count','calendar-month-total'),cpc:missing('source-provides-recommended-bid-only'),yoyGrowth:metric('yoyGrowth','yoy-growth','fraction',original?'equal-history-window-change':'year-over-year-change'),recentGrowth:metric('recentGrowth','monthly-growth','fraction','month-over-month-change')};
 });
 // Preserve original-member weighting and field-specific denominators for both formula versions.
 const threeMonth=aggregateKeywordClusters({keywords:keywords.map(k=>({id:k.keywordId,text:k.keyword,searchVolume:k.w5.searchVolume.value,cpc:null,yoyGrowth:k.w5.threeMonthGrowth.value,recentGrowth:null})),mappings});
 const factByMember=new Map(facts.members.map(member=>[member.keywordId,member]));
 const hasVerifiedMemberAba=(memberIds:readonly string[])=>memberIds.some(id=>{const aba=factByMember.get(id)?.aba;return aba!==undefined&&(aba.status==='ready'||aba.status==='partial')&&aba.referenceMonth===facts.referenceMonth&&aba.inputSnapshotId!==null&&aba.sourceRef!==null&&aba.fetchedAt!==null&&aba.member!==null&&aba.member.top3ClickShare.value!==null;});
 const metrics=threeMonth.clusters.map(cluster=>({clusterId:cluster.clusterId!,memberIds:cluster.memberIds,threeMonthGrowth:cluster.yoyGrowth.value===null?missing('no-positive-volume-with-three-month-growth'):{value:cluster.yoyGrowth.value,evidence:evidence(cluster.memberIds.filter(id=>{const k=keywords.find(k=>k.keywordId===id)!;return k.w5.searchVolume.value!==null&&k.w5.searchVolume.value>0&&k.w5.threeMonthGrowth.value!==null;}),'three-month-growth','fraction','three-month-change',threeMonthFormula),missingReason:null},supplyDemandRatio:missing('supply-demand-not-collected'),abaTop3Share:missing(hasVerifiedMemberAba(cluster.memberIds)?'aba-top3-cluster-aggregation-method-not-verified':'aba-top3-not-collected'),spr:missing('spr-not-collected'),suggestedBid:missing('recommended-bid-currency-unconfirmed'),averagePrice:missing('mapped-product-prices-not-collected'),w5:{diagnosis:null,evidence:null,missingReason:'verified-lifecycle-rule-evidence-unavailable'}}));
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
  const lifecycle=score.memberIds.every(id=>keywords.find(k=>k.keywordId===id)!.w5.lifecycle.status==='computed')?originalLifecycle(scored.aggregation.clusters.find(c=>c.clusterId===clusterId)!.yoyGrowth.value,m.threeMonthGrowth.value):{status:'unavailable' as const,reason:'incomplete-member-lifecycle-coverage'};
  const label=labels.get(clusterId)??clusterId;
  const development={status:score.keywordValidationTier===null?'hypothesis' as const:'ranked' as const,direction:`${label} 主需求验证`,evidenceKeywordIds:score.memberIds,priority:score.keywordValidationTier,feasibility:score.pvs===null?'竞争、成本与价值输入不足，可行性待验证':score.quadrant==='red-ocean'?'需验证差异化卖点':score.quadrant==='opportunity-gap'?'可验证小单或变体方案':'可验证标准产品方案',validationMethod:score.pvs===null?'先补齐评分输入；用访谈与关键词对应的使用任务验证需求，不据此直接投入生产':'通过概念测试与小规模需求验证核对购买意愿',effort:score.pvs===null?'待验证；先做资料核对与访谈':'按验证结果确定投入，暂不推定预算'};
  return {...(original?{lifecycle,development}:{}),clusterId,label:labels.get(clusterId)??clusterId,threeMonthGrowth:{metric:m.threeMonthGrowth,coverage},metrics:publicMetrics,score:{...score,ranks,limitations:[...score.limitations,...(coverage.unknownValueCount?['partial-member-three-month-coverage']:[])]},missingInputs:Object.entries(publicMetrics).filter(([,v])=>v.value===null).map(([key])=>key)};
 });
 const basis={version:original?'market-keyword-rule-report/v3':KEYWORD_RULE_REPORT_VERSION,factsId,moduleRunId:facts.moduleRunId,scope:facts.scope,referenceMonth:facts.referenceMonth,ruleVersion:KEYWORD_SCORING_RULE_VERSION,threeMonthFormulaVersion:threeMonthFormula,classification,rankPools,keywords,aggregation:scored.aggregation,clusters,limitations:['fixed-keyword-pool-not-unique-searchers','source-facts-version-identifies-projection-not-provider-method','recommended-bid-not-actual-cpc','recommended-bid-currency-unconfirmed',...(original?['seasonality-diagnosis-unavailable','lifecycle-not-structural-decline']:['seasonality-and-lifecycle-unavailable']),...(facts.pool.collectionCoverage!=='complete'||facts.pool.memberLimitReached?['partial-source-pool']:[])],interpretation:scored.interpretation,priceScoreMeaning:scored.priceScoreMeaning};
 return MarketKeywordRuleReportSchema.parse({...basis,reportId:`market-keyword-rule-report:${digest({report:basis,classificationSource:input.classification})}`});
}
