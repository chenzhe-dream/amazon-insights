import {z} from 'zod';
import type {MarketKeywordFacts} from './market-keyword-public-contracts';
import type {MarketKeywordRuleReport} from './market-keyword-rule-report-contracts';

export const MARKET_KEYWORD_SCORE_INPUT_AUDIT_VERSION='market-keyword-score-input-audit/v1' as const;
const id=z.string().min(1).max(240),month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const path=z.array(z.union([z.string(),z.number().int().nonnegative()]));
const observation=z.object({
 value:z.number().finite().nonnegative().nullable(),status:id,reason:id.nullable(),
 sourceRef:z.string().regex(/^market-source:[a-f0-9]{64}$/).nullable(),inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/).nullable(),
 referenceMonth:month.nullable(),currency:z.literal('USD').nullable(),sourcePath:path.nullable(),factsPath:path,
}).strict();
export const KeywordScoreInputAuditFieldSchema=z.enum(['threeMonthGrowth','supplyDemandRatio','abaTop3Share','spr','suggestedBid','averagePrice']);
export const MarketKeywordScoreInputAuditSchema=z.object({
 version:z.literal(MARKET_KEYWORD_SCORE_INPUT_AUDIT_VERSION),auditId:z.string().regex(/^market-keyword-score-input-audit:[a-f0-9]{64}$/),
 factsId:z.string().regex(/^market-keyword-facts:[a-f0-9]{64}$/),reportId:z.string().regex(/^market-keyword-rule-report:[a-f0-9]{64}$/),
 moduleRunId:z.string().uuid(),referenceMonth:month,ruleVersion:id,
 members:z.array(z.object({keywordId:id,keyword:z.string(),pageRecommendedBid:observation,trendRecommendedBid:observation,abaClick:observation,abaConversion:observation}).strict()).max(2000),
 clusters:z.array(z.object({clusterId:id,memberIds:z.array(id).max(2000),inputs:z.array(z.object({
  field:KeywordScoreInputAuditFieldSchema,value:z.number().finite().nullable(),reason:id.nullable(),requiredInput:z.string().min(1),
  blockers:z.array(id),knownMemberIds:z.array(id).max(2000),
 }).strict()).length(6)}).strict()).max(2000),
 formulas:z.array(z.object({id,label:z.string().min(1),expression:z.string().min(1)}).strict()).max(20),
 limitations:z.array(z.string().min(1)),
}).strict();
export type MarketKeywordScoreInputAudit=z.infer<typeof MarketKeywordScoreInputAuditSchema>;
export type KeywordScoreInputAuditObservation=MarketKeywordScoreInputAudit['members'][number]['abaClick'];

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Public response binding only: no classification, aggregation or scoring in the browser. */
export function assertKeywordScoreInputAuditBinding(audit:MarketKeywordScoreInputAudit,facts:MarketKeywordFacts,report:MarketKeywordRuleReport):void{
 if(audit.factsId!==facts.factsId||audit.reportId!==report.reportId||report.factsId!==facts.factsId||audit.moduleRunId!==facts.moduleRunId||report.moduleRunId!==facts.moduleRunId||audit.referenceMonth!==facts.referenceMonth||report.referenceMonth!==facts.referenceMonth||audit.ruleVersion!==report.ruleVersion)throw new TypeError('Keyword score input audit binding mismatch');
 if(!same(audit.members.map(m=>m.keywordId),facts.members.map(m=>m.keywordId))||audit.clusters.length!==report.clusters.length)throw new TypeError('Keyword audit member binding mismatch');
 for(const [i,member] of audit.members.entries()){
  const fact=facts.members[i],trendIndex=fact.trend.months.findIndex(m=>m.month===facts.referenceMonth),trend=fact.trend.months[trendIndex],aba=fact.aba;
  const trendReady=['ready','partial'].includes(fact.trend.status)&&fact.trend.sourceRef!==null&&fact.trend.inputSnapshotId!==null&&fact.trend.fetchedAt!==null;
  const abaReady=aba&&['ready','partial'].includes(aba.status)&&aba.sourceRef!==null&&aba.inputSnapshotId!==null&&aba.fetchedAt!==null;
  if(member.keyword!==fact.keyword)throw new TypeError('Keyword audit member binding mismatch');
  const observations=[
   {actual:member.pageRecommendedBid,source:fact.sourceRef,snapshot:fact.occurrences.find(o=>o.sourceRef===fact.sourceRef)?.inputSnapshotId??null,value:fact.pageMetrics.recommendedCpcUsd.reason===null?fact.pageMetrics.recommendedCpcUsd.value:null,status:fact.pageMetrics.recommendedCpcUsd.value===null?'missing':'saved',month:null,currency:'USD',path:null,factsPath:['members',i,'pageMetrics','recommendedCpcUsd']},
   {actual:member.trendRecommendedBid,source:fact.trend.sourceRef,snapshot:fact.trend.inputSnapshotId,value:trendReady&&trend?.recommendedBid.reason===null?trend.recommendedBid.value:null,status:fact.trend.status,month:facts.referenceMonth,currency:null,path:null,factsPath:trendIndex<0?['members',i,'trend','months']:['members',i,'trend','months',trendIndex,'recommendedBid']},
   ...(['abaClick','abaConversion'] as const).map(key=>{const field=key==='abaClick'?'top3ClickShare':'top3ConversionShare',metric=aba?.member?.[field];return {actual:member[key],source:aba?.sourceRef??null,snapshot:aba?.inputSnapshotId??null,value:abaReady&&metric?.reason===null?metric.value:null,status:aba?.status??'not-requested',month:facts.referenceMonth,currency:null,path:metric?.path??null,factsPath:['members',i,'aba','member',field]};}),
  ];
  for(const o of observations)if(o.actual.sourceRef!==o.source||o.actual.inputSnapshotId!==o.snapshot||o.actual.value!==o.value||o.actual.status!==o.status||o.actual.referenceMonth!==o.month||o.actual.currency!==o.currency||!same(o.actual.sourcePath,o.path)||!same(o.actual.factsPath,o.factsPath))throw new TypeError('Keyword audit evidence binding mismatch');
 }
 const byId=new Map(audit.members.map(m=>[m.keywordId,m]));
 for(const [i,cluster] of audit.clusters.entries()){
  const saved=report.clusters[i],members=new Set(saved.score.memberIds);
  if(cluster.clusterId!==saved.clusterId||!same(cluster.memberIds,saved.score.memberIds)||new Set(cluster.inputs.map(f=>f.field)).size!==6)throw new TypeError('Keyword audit cluster member binding mismatch');
  for(const field of cluster.inputs){
   if(field.value!==saved.metrics[field.field].value||field.reason!==saved.metrics[field.field].missingReason||new Set(field.knownMemberIds).size!==field.knownMemberIds.length||field.knownMemberIds.some(id=>!members.has(id)))throw new TypeError('Keyword audit metric binding mismatch');
   const known=field.field==='abaTop3Share'?cluster.memberIds.filter(id=>byId.get(id)?.abaClick.value!==null):field.field==='suggestedBid'?cluster.memberIds.filter(id=>{const m=byId.get(id);return m&&(m.pageRecommendedBid.value!==null||m.trendRecommendedBid.value!==null);}):field.field==='threeMonthGrowth'?saved.metrics.threeMonthGrowth.evidence?.recordIds??[]:[];
   if(!same(field.knownMemberIds,known))throw new TypeError('Keyword audit coverage binding mismatch');
  }
 }
}
