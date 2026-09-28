import {MarketKeywordFactsSchema,type MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
import {MarketKeywordRuleReportSchema,type MarketKeywordRuleReport} from '../../../shared/market-keyword-rule-report-contracts';
import {MARKET_KEYWORD_SCORE_INPUT_AUDIT_VERSION,MarketKeywordScoreInputAuditSchema,assertKeywordScoreInputAuditBinding,type MarketKeywordScoreInputAudit,type KeywordScoreInputAuditObservation} from '../../../shared/market-keyword-score-input-audit-contracts';
import {KEYWORD_SCORING_RULE_VERSION} from '../../../shared/market-keyword-scoring-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

const fields=['threeMonthGrowth','supplyDemandRatio','abaTop3Share','spr','suggestedBid','averagePrice'] as const;
const requirements:Record<typeof fields[number],string>={
 threeMonthGrowth:'同一原词参考月与三个月前的完整月搜索量，以及正参考月搜索量权重。',
 supplyDemandRatio:'供需比的正式来源与供给分母、参考月份、原词关联键及簇级聚合方法。',
 abaTop3Share:'同一参考月的成员级 ABA 点击份额，以及经验证的成员到簇聚合方法；转化份额不替代点击份额。',
 spr:'SPR 的正式来源、指标定义、参考月份、原词关联键及簇级聚合方法。',
 suggestedBid:'明确参考月份、确认币种的推荐竞价及簇级聚合方法；来源页 USD 竞价窗口未注明，趋势竞价币种未确认。',
 averagePrice:'关键词到商品的映射、对应参考月的商品价格与币种，以及均价分母和簇级聚合方法。',
};
const formulas:MarketKeywordScoreInputAudit['formulas']=[
 {id:'calendar-growth',label:'日历增长',expression:'同比 = 当前月 / 去年同月 − 1；环比 = 当前月 / 上月 − 1；较3个月前 = 当前月 / 三个月前单月 − 1。基期为零或缺失时不计算。'},
 {id:'member-weighting',label:'成员权重',expression:'簇增长 = Σ(原词参考月搜索量 × 已知增长) / Σ(有该增长且搜索量为正的原词搜索量)。每项单独确定有效分母。'},
 {id:'growth',label:'综合增长',expression:'两项可用时：0.6 × 同比 + 0.4 × 较3个月前；只有一项时采用该项并标记覆盖不完整；都缺失时保留未知。'},
 {id:'mid-rank',label:'mid-rank 分位',expression:'高值优先：100 × (较低值个数 + 0.5 × 同值个数) / 有效样本数。低值优先改用较高值个数；缺失值不入比较池。单样本或全相等为50，但无区分能力。'},
 {id:'components',label:'S1–S5 分项',expression:'S1 = 搜索量分位；S2 = 综合增长分位；S3 = 0.6 × 供需比分位 + 0.4 × 低 ABA 点击份额分位；S4 = 0.5 × 低 SPR 分位 + 0.5 × 低推荐竞价分位；S5 = 商品均价分位。'},
 {id:'pvs',label:'PVS',expression:'PVS = 0.28 × S1 + 0.22 × S2 + 0.20 × S3 + 0.18 × S4 + 0.12 × S5；任一分项缺失即待验证，不补分、不重分配权重。售价分项不是毛利。'},
];

/** Read-only explanation of already verified facts/report. Never collects, regroups or scores. */
export function buildMarketKeywordScoreInputAudit(input:{facts:MarketKeywordFacts;report:MarketKeywordRuleReport}):MarketKeywordScoreInputAudit{
 const facts=MarketKeywordFactsSchema.parse(input.facts),report=MarketKeywordRuleReportSchema.parse(input.report);
 const {factsId,...basis}=facts;
 if(factsId!==`market-keyword-facts:${digest(basis)}`||report.factsId!==factsId||report.moduleRunId!==facts.moduleRunId||report.referenceMonth!==facts.referenceMonth||digest(report.scope)!==digest(facts.scope))throw new TypeError('Keyword audit facts/report binding mismatch');
 const factIds=facts.members.map(m=>m.keywordId),assigned=new Map(report.keywords.map(m=>[m.keywordId,m.clusterId]));
 if(new Set(factIds).size!==factIds.length||new Set(report.keywords.map(m=>m.keywordId)).size!==factIds.length||report.keywords.length!==factIds.length||factIds.some(id=>!assigned.has(id)))throw new TypeError('Keyword audit original member binding mismatch');
 const clusterIds=new Set(report.clusters.map(c=>c.clusterId));
 if(clusterIds.size!==report.clusters.length||report.clusters.length!==report.aggregation.clusters.length||[...assigned.values()].some(id=>id!==null&&!clusterIds.has(id)))throw new TypeError('Keyword audit cluster member binding mismatch');
 for(const cluster of report.clusters){
  // Facts keep source order while aggregateKeywordClusters uses code-point ID order.
  // Compare exact membership sets, then preserve the saved score's order in the audit.
  const expected=report.keywords.filter(k=>k.clusterId===cluster.clusterId).map(k=>k.keywordId).sort(),aggregate=report.aggregation.clusters.find(c=>c.clusterId===cluster.clusterId);
  if(cluster.score.clusterId!==cluster.clusterId||digest([...cluster.score.memberIds].sort())!==digest(expected)||!aggregate||digest([...aggregate.memberIds].sort())!==digest(expected))throw new TypeError('Keyword audit cluster member binding mismatch');
 }
 const members:MarketKeywordScoreInputAudit['members']=facts.members.map((member,index)=>{
  const trend=member.trend,trendIndex=trend.months.findIndex(m=>m.month===facts.referenceMonth),point=trend.months[trendIndex],aba=member.aba;
  if(aba&&(aba.referenceMonth!==facts.referenceMonth||(aba.member&&(aba.member.memberId!==member.keywordId||aba.member.keyword!==member.keyword||aba.member.referenceMonth!==facts.referenceMonth))))throw new TypeError('Keyword audit ABA evidence binding mismatch');
  const trendReady=['ready','partial'].includes(trend.status)&&trend.sourceRef!==null&&trend.inputSnapshotId!==null&&trend.fetchedAt!==null;
  const abaReady=aba&&['ready','partial'].includes(aba.status)&&aba.sourceRef!==null&&aba.inputSnapshotId!==null&&aba.fetchedAt!==null;
  const abaObservation=(field:'top3ClickShare'|'top3ConversionShare'):KeywordScoreInputAuditObservation=>{
   const metric=aba?.member?.[field],known=!!abaReady&&metric?.value!==undefined&&metric.value!==null&&metric.reason===null;
   return {value:known?metric!.value:null,status:aba?.status??'not-requested',reason:known?null:metric?.reason??(aba?.status==='ready'||aba?.status==='partial'?'missing-source-binding':aba?.status??'not-requested'),sourceRef:aba?.sourceRef??null,inputSnapshotId:aba?.inputSnapshotId??null,referenceMonth:facts.referenceMonth,currency:null,sourcePath:metric?.path??null,factsPath:['members',index,'aba','member',field]};
  };
  return {keywordId:member.keywordId,keyword:member.keyword,
   pageRecommendedBid:{value:member.pageMetrics.recommendedCpcUsd.reason===null?member.pageMetrics.recommendedCpcUsd.value:null,status:member.pageMetrics.recommendedCpcUsd.value===null?'missing':'saved',reason:member.pageMetrics.recommendedCpcUsd.reason,sourceRef:member.sourceRef,inputSnapshotId:member.occurrences.find(o=>o.sourceRef===member.sourceRef)?.inputSnapshotId??null,referenceMonth:null,currency:'USD',sourcePath:null,factsPath:['members',index,'pageMetrics','recommendedCpcUsd']},
   trendRecommendedBid:{value:trendReady&&point?.recommendedBid.reason===null?point.recommendedBid.value:null,status:trend.status,reason:trendReady?(point?.recommendedBid.reason??(point?'currency-unconfirmed':'missing-reference-month')):'missing-source-binding',sourceRef:trend.sourceRef,inputSnapshotId:trend.inputSnapshotId,referenceMonth:facts.referenceMonth,currency:null,sourcePath:null,factsPath:trendIndex<0?['members',index,'trend','months']:['members',index,'trend','months',trendIndex,'recommendedBid']},
   abaClick:abaObservation('top3ClickShare'),abaConversion:abaObservation('top3ConversionShare'),
  };
 });
 const byId=new Map(members.map(m=>[m.keywordId,m]));
 const clusters:MarketKeywordScoreInputAudit['clusters']=report.clusters.map(cluster=>({clusterId:cluster.clusterId,memberIds:[...cluster.score.memberIds],inputs:fields.map(field=>{
  const metric=cluster.metrics[field];
  const knownMemberIds=field==='abaTop3Share'?cluster.score.memberIds.filter(id=>byId.get(id)!.abaClick.value!==null):field==='suggestedBid'?cluster.score.memberIds.filter(id=>{const m=byId.get(id)!;return m.pageRecommendedBid.value!==null||m.trendRecommendedBid.value!==null;}):field==='threeMonthGrowth'?[...(metric.evidence?.recordIds??[])]:[];
  const bidBlockers=[...(cluster.score.memberIds.some(id=>byId.get(id)!.pageRecommendedBid.value!==null)?['source-window-unspecified']:[]),...(cluster.score.memberIds.some(id=>byId.get(id)!.trendRecommendedBid.value!==null)?['currency-unconfirmed']:[])];
  const blockers:string[]=metric.value!==null?[]:field==='suggestedBid'?[...(bidBlockers.length?bidBlockers:['source-not-collected']),'cluster-aggregation-unverified']:field==='abaTop3Share'?knownMemberIds.length?['cluster-aggregation-unverified']:['member-click-share-unavailable','cluster-aggregation-unverified']:field==='threeMonthGrowth'?['missing-comparable-positive-volume']:field==='averagePrice'?['keyword-product-mapping-unavailable','source-not-collected']:['source-not-collected','cluster-aggregation-unverified'];
  return {field,value:metric.value,reason:metric.missingReason,requiredInput:field==='threeMonthGrowth'&&report.threeMonthFormulaVersion==='three-month-sum-growth/v1'?'同一原词截至参考月连续6个完整月，近3月合计与前3月合计，以及正参考月搜索量权重。':requirements[field],blockers,knownMemberIds};
 })}));
 const output={version:MARKET_KEYWORD_SCORE_INPUT_AUDIT_VERSION,factsId,reportId:report.reportId,moduleRunId:facts.moduleRunId,referenceMonth:facts.referenceMonth,ruleVersion:report.ruleVersion,members,clusters,
  formulas:report.ruleVersion===KEYWORD_SCORING_RULE_VERSION?formulas.map(formula=>report.threeMonthFormulaVersion!=='three-month-sum-growth/v1'?formula:formula.id==='calendar-growth'?{id:'original-window-growth',label:'等长历史窗口增长',expression:'历史增长 = 近N月合计 / 前N月合计 − 1（N为6–12，窗口连续）；三个月增长 = 近3月合计 / 前3月合计 − 1；环比 = 当前月 / 上月 − 1。缺月或基期为零不计算。'}:formula.id==='growth'?{...formula,expression:'两项可用时：0.6 × 等长历史窗口增长 + 0.4 × 三个月合计增长；评分仅有一项时标记覆盖不完整。生命周期要求两项齐全，不以0填缺项。'}:formula):[],limitations:['这是已保存来源的输入核对，不是新增评分或来源采集。','已知成员观察不代表簇级指标可用；推荐竞价不是实际 CPC。','供需比、SPR 与关联商品均价尚未进入当前关键词事实链。']};
 const audit=MarketKeywordScoreInputAuditSchema.parse({...output,auditId:`market-keyword-score-input-audit:${digest(output)}`});
 assertKeywordScoreInputAuditBinding(audit,facts,report);return audit;
}
