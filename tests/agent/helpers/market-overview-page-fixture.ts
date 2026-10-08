import {MarketOverviewRunResponseSchema,MarketOverviewDetailsResponseSchema} from '../../../shared/market-overview-report-contracts';
import type {MarketAnalysisScope} from '../../../shared/market-analysis-contracts';
import {normalizeMarketOverviewDistribution} from '../../../server/domain/market-research/overview-distributions';
export const overviewRunId='70000000-0000-4000-8000-000000000001',overviewStudyId='70000000-0000-4000-8000-000000000002';
export const overviewScope:MarketAnalysisScope={organizationId:'70000000-0000-4000-8000-000000000003',researchId:overviewStudyId,marketplace:'US',currency:'USD',nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08'};
const sourceRef=`market-source:${'a'.repeat(64)}`,inputId=`market-input:${'b'.repeat(64)}`,metricId='2026-08/totalUnits';
export function overviewEntry(old=false){return {attemptId:old?'70000000-0000-4000-8000-000000000004':'70000000-0000-4000-8000-000000000005',current:!old,report:{
  reportVersion:'market-overview-report/v1',moduleRunId:overviewRunId,scope:overviewScope,versions:{source:'source/v1',rule:'rule/v3',mapping:'rule/v3',planner:'market-overview-flow/v2',model:'model/v1',prompt:'prompt/v1',configuration:'config/v1'},
  task:'overview-report',catalogAttemptId:'70000000-0000-4000-8000-000000000006',phase:old?'numeric':'window-results',windowAttemptId:old?null:'70000000-0000-4000-8000-000000000007',preparationAttemptIds:[],modelAttemptIds:[],numericInputSnapshotId:inputId,
  dataCutoffAt:'2026-09-12T06:00:00.000Z',sourceRefs:[sourceRef],dataReady:true,analysisStatus:'partial',windowStatus:old?'pending':'partial',expectedWindowCount:2,rejectedCount:0,failures:[],
  modelResults:old?[]:[{attemptId:'70000000-0000-4000-8000-000000000008',bindingId:'70000000-0000-4000-8000-000000000009',status:'succeeded',errorCode:null,agentRunId:'70000000-0000-4000-8000-000000000010',output:{schemaVersion:'1.0.0',task:'market-overview-explanation',batchId:'70000000-0000-4000-8000-000000000011',inputDigest:'c'.repeat(64),findings:[{findingId:'observed',mode:'observed',factIds:[`fact:${metricId}`],evidenceRefs:[sourceRef]}],risks:[],validationTasks:[]}}],
  coverage:[{dimension:'sample-scale',status:'available',availableMetrics:['totalUnits'],missingMetrics:[]},{dimension:'price-distribution',status:'not-integrated',availableMetrics:[],missingMetrics:[]}],
  reasons:['explanation-partial','full-overview-dimensions-not-integrated','cross-window-synthesis-not-integrated'],reportHash:(old?'d':'e').repeat(64)}};}
export function overviewRun(running=false){const current=overviewEntry(),old=overviewEntry(true);return MarketOverviewRunResponseSchema.parse({run:{id:overviewRunId,scope:overviewScope,status:running?'running':'partial',createdAt:'2026-09-12T05:00:00.000Z',planRevision:3,params:{headTopN:10,newProductMonths:6},
  steps:[{id:'70000000-0000-4000-8000-000000000012',kind:'model-batch',status:running?'running':'failed',latestAttemptId:'70000000-0000-4000-8000-000000000013',attemptCount:1,current:true,canRetry:!running,asin:null,errorCode:running?null:'timeout'}],
  currentReport:running?old:current,latestSavedReport:current,history:[old,current]}});}
export function overviewDetails(old=false){const value=old?17:42,unit={status:'known',unit:'count',rawUnit:'count'};return MarketOverviewDetailsResponseSchema.parse({entry:overviewEntry(old),numbers:{months:[{month:'2026-08',metrics:{totalUnits:{state:'known',value,unit,reason:null,observations:[{sourceRef,field:'totalUnits',raw:value,value,unit,reason:null}]}},sourceRefs:[sourceRef],failures:[]}],trendGaps:[]},
  semantic:{task:'market-overview-explanation',metrics:[{metricId,state:'known',value,unit,period:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},sourceRefs:[sourceRef],formulaVersion:'rule/v3',numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}}],gaps:[],facts:[{factId:`fact:${metricId}`,kind:'value',metricRefs:[metricId],sourceRefs:[sourceRef],statementTemplateId:'overview.sample.totalUnits.value/v1'}],interpretationOptions:[],validationOptions:[]}});}
export function overviewDistributionDetails(old=false){
  const result=overviewDetails(old),distribution=normalizeMarketOverviewDistribution('market_price_distribution',{data:[{label:'0-15',asins:['B000000001'],products:1,units:old?10:20,revenue:50,unitsRatio:0.001},{label:'15-30',asins:['B000000002'],products:1,units:old?30:20,revenue:100,unitsRatio:0.999}]});
  result.numbers.distributions=[{month:'2026-08',operation:'market_price_distribution',status:'partial',sourceRef,fetchedAt:'2026-09-12T06:00:00.000Z',scopeBasis:'request-bound',distribution,issues:[{code:'identity-request-bound',retryable:false}]},
    {month:'2026-08',operation:'market_product_demand_trend',status:'empty',sourceRef,fetchedAt:'2026-09-12T06:00:00.000Z',scopeBasis:'request-bound',distribution:null,issues:[]}];return result;
}


export function overviewAnalysisDetails(){
 const detail=overviewDistributionDetails(),semantic=detail.semantic!;if(semantic.task!=='market-overview-explanation')throw Error('Expected overview');
 const f=semantic.facts[0],m=semantic.metrics[0];m.value=0;const total=detail.numbers.months[0].metrics.totalUnits;total.value=0;total.observations.forEach(o=>{o.value=0;o.raw=0;});m.period={kind:'unknown',reason:'Source did not confirm the requested month'};
 semantic.gaps=[{gapId:'period-missing',metricId:m.metricId,reason:'period-incompatible',sourceRefs:[sourceRef]}];
 semantic.analysisBrief={mode:'dimension',scopeStatement:'只描述返回样本',dimensions:[{id:'sample',label:'样本成交',factIds:[f.factId],gapIds:['period-missing']}],factLabels:[{factId:f.factId,label:'返回样本销量'}]};
 const statement={parts:[{kind:'text' as const,text:'当前片段不足以判断整体市场需求'}],factIds:[f.factId],gapIds:['period-missing']};
 const output=detail.entry.report.modelResults[0].output!;output.findings=[];
 output.analysis={dimensions:[{dimensionId:'sample',data:{...statement,parts:[{kind:'fact-label',factId:f.factId},{kind:'text',text:'为'},{kind:'metric',metricId:m.metricId}]},meaning:{...statement,parts:[{kind:'text',text:'该结果仅反映返回样本，不能推断需求消失'}]},conclusion:statement,limitations:[{...statement,parts:[{kind:'text',text:'来源没有确认月份，暂不进行趋势比较'}]}],verification:[{...statement,parts:[{kind:'text',text:'核对来源月份与样本覆盖后再比较'}]}]}],summary:{decision:'insufficient-evidence',statement}};
 return MarketOverviewDetailsResponseSchema.parse(detail);
}
