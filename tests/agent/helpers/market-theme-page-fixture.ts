// Synthetic HTTP/UI evidence only; this fixture is not a provider or model quality sample.
import { MarketThemeRunResponseSchema, MarketThemeReportEntrySchema } from '../../../shared/market-module-contracts';
import { MarketThemeDetailResponseSchema } from '../../../shared/market-theme-detail-contracts';
import { MarketThemeEvidenceResponseSchema } from '../../../shared/market-theme-evidence-contracts';
export const themeRunId='60000000-0000-4000-8000-000000000001';
export const themeScope={organizationId:'018f1f5c-60f0-4b7a-8000-000000000002',researchId:'60000000-0000-4000-8000-000000000002',marketplace:'US',nodeIdPath:'228013:495224:3736561:1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'};
export function themeEntry(old=false){return MarketThemeReportEntrySchema.parse({attemptId:`60000000-0000-4000-8000-00000000000${old?3:4}`,current:!old,report:{
  reportVersion:'market-theme-report/v1',moduleRunId:themeRunId,scope:themeScope,versions:{source:'synthetic/v1',rule:'synthetic/v1',mapping:'synthetic/v1',planner:'synthetic/v1',model:'synthetic/v1',prompt:'synthetic/v1',configuration:'synthetic/v1'},
  basis:'rules',basisAttemptId:'60000000-0000-4000-8000-000000000005',inputSnapshotId:`market-input:${'a'.repeat(64)}`,resultHash:'b'.repeat(64),dataCutoffAt:old?'2026-09-12T06:00:00.000Z':'2026-09-12T07:00:00.000Z',selectedAsins:['B0THEME001','B0THEME002'],selectionBasis:'provider-row-order',bsrTopVerified:false,
  metricKind:'customers_say_topic_share',reviewDeduplication:'unavailable',status:'partial',dataReady:true,semanticsReady:false,
  counts:{requestedCount:3,selectedCount:2,successfulCount:1,emptyCount:0,failedCount:1,missingCount:0,expectedMemberCount:2,validatedMemberCount:2,mappedMemberCount:0,unknownCount:2,unavailableCount:0,reconciliationRequired:false},
  reasons:['selection-shortfall','source-results-missing','unknown-themes'],reportHash:(old?'c':'d').repeat(64)}});}
export function themeRun(running=false){return MarketThemeRunResponseSchema.parse({run:{id:themeRunId,scope:themeScope,status:running?'running':'partial',createdAt:'2026-09-12T05:00:00.000Z',planRevision:2,params:{memberCount:3,poolSize:100,newProductMonths:6},
  steps:[{id:'60000000-0000-4000-8000-000000000006',kind:'collect-customer-themes',status:running?'running':'failed',latestAttemptId:'60000000-0000-4000-8000-000000000007',attemptCount:1,current:true,canRetry:!running,asin:'B0THEME002',errorCode:running?null:'timeout'}],
  currentReport:running?null:themeEntry(),latestSavedReport:running?themeEntry(true):themeEntry(),history:running?[themeEntry(true)]:[themeEntry(),themeEntry(true)]}});}
export function themeDetails(url:URL) {
  const old=url.pathname.includes(themeEntry(true).attemptId),entry=themeEntry(old),section=url.searchParams.get('section')??'groups',offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??20);
  const groupIndex=url.searchParams.has('groupIndex')?Number(url.searchParams.get('groupIndex')):null,denom=old?2:4;
  const totals={mention:denom,positive:2,negative:0,themeCount:2},preview=(text:string)=>({text,totalLength:text.length,truncated:false});
  const items=section==='groups'?[{kind:'group',index:offset,groupId:null,mappingStatus:'unmapped',labelZh:null,definition:null,labelOrigin:null,sourceLabel:preview(old?'旧版独有主题':offset?'第二组亮度':'新版装配主题'),memberCount:1,totals:{mention:denom/2,positive:1,negative:0,themeCount:1},topicShare:{metricKind:'customers_say_topic_share',numerator:denom/2,denominator:denom,valuePct:50,denominatorAsins:entry.report.selectedAsins}}]:
    section==='asins'?[{kind:'asin',asin:'B0THEME002',status:'failed',reason:'synthetic timeout',sourceRecordId:null,fetchedAt:null,totals:null,memberCount:0}]:
    [{kind:'member',sourceThemeId:'synthetic-theme-1',asin:'B0THEME001',sourceRecordId:'synthetic-record-1',sourceUpdatedAt:null,keyword:preview('<script>不执行</script>'),content:{text:'合成原文预览',truncated:true,totalLength:12000},mention:2,positive:1,negative:0,withinAsinShare:{metricKind:'customers_say_topic_share',numerator:2,denominator:denom,valuePct:200/denom,denominatorAsins:['B0THEME001']},decision:{sourceThemeId:'synthetic-theme-1',status:'unknown',groupId:null,reason:'未确认分类',batchId:'synthetic-batch'}}];
  return MarketThemeDetailResponseSchema.parse({report:entry,page:{section,offset,limit,groupIndex,nextOffset:section==='groups'&&offset===0?1:null,totalItems:section==='groups'?2:1,metricKind:'customers_say_topic_share',reviewDeduplication:'unavailable',sentimentOverlap:'not_assumed_disjoint',totals,display:{topN:null,totalGroupCount:2,displayedGroupCount:2,omittedGroupCount:0},items}});
}
export function themeEvidence(url:URL){const report=themeEntry(url.pathname.includes(themeEntry(true).attemptId));return MarketThemeEvidenceResponseSchema.parse({report,evidence:{
  sourceThemeId:'synthetic-theme-1',asin:'B0THEME001',sourceRecordId:'synthetic-record-1',sourceUpdatedAt:null,keyword:'<script>不执行</script>',content:'合成原文预览'+'文'.repeat(11994),sourceKind:'customers-say-summary',
  decision:{sourceThemeId:'synthetic-theme-1',status:'unknown',groupId:null,reason:'insufficient-evidence',batchId:'60000000-0000-4000-8000-000000000008'},
  analysis:{agentRunId:'60000000-0000-4000-8000-000000000009',modelAttemptId:'60000000-0000-4000-8000-000000000010',bindingId:'60000000-0000-4000-8000-000000000011',batchId:'60000000-0000-4000-8000-000000000008',
    outputDigest:'a'.repeat(64),executionFingerprint:'b'.repeat(64),status:'unknown',reason:'insufficient-evidence',labelZh:null,explanationZh:null,evidence:[{field:'keyword',refId:'synthetic-ref',sourceRef:'synthetic-source',start:8,end:11,quote:'不执行'}]}}});}

// Separate v2 rendering fixture; the original v1/history fixtures remain intact.
export function reconciledThemeEntry(){const entry=themeEntry();entry.report.reportVersion='market-theme-report/v2';entry.report.basis='reconciliation-evaluation';entry.report.reportHash='e'.repeat(64);
  entry.report.counts.mappedMemberCount=2;entry.report.counts.unknownCount=0;entry.report.semanticsReady=true;entry.report.reasons=['selection-shortfall','source-results-missing'];return MarketThemeReportEntrySchema.parse(entry);}
export function reconciledThemeRun(){const value=themeRun();value.run.currentReport=reconciledThemeEntry();value.run.latestSavedReport=reconciledThemeEntry();value.run.history=[reconciledThemeEntry(),themeEntry(true)];return MarketThemeRunResponseSchema.parse(value);}
export function reconciledThemeDetails(url:URL){const value=themeDetails(url);if(url.pathname.includes(themeEntry(true).attemptId))return value;value.report=reconciledThemeEntry();
  value.page.items=value.page.items.map(item=>item.kind==='group'?{...item,groupId:`synthetic-confirmed-${item.index}`,mappingStatus:'mapped',labelZh:item.sourceLabel?.text??'合成主题',definition:'已保存的合成主题定义',labelOrigin:'batch-proposal',sourceLabel:null}:
    item.kind==='member'?{...item,decision:{...item.decision,status:'mapped',groupId:'synthetic-confirmed-0',reason:null,batchId:'60000000-0000-4000-8000-000000000008'}}:item);
  return MarketThemeDetailResponseSchema.parse(value);}
export function reconciledThemeEvidence(url:URL){const value=themeEvidence(url);if(url.pathname.includes(themeEntry(true).attemptId))return value;value.report=reconciledThemeEntry();
  value.evidence.decision={...value.evidence.decision,status:'mapped',reason:null,groupId:'synthetic-confirmed-0'};
  value.evidence.analysis={...value.evidence.analysis!,status:'mapped',reason:null,labelZh:'合成装配主题',explanationZh:'这段合成解释来自此报告保存的归并批次。'};return MarketThemeEvidenceResponseSchema.parse(value);}
