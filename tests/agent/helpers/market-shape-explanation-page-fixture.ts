import {shapeRevisionId} from './market-shape-page-fixture';
export const explanationId='72000000-0000-4000-8000-000000000001';
export const explanationStepId='72000000-0000-4000-8000-000000000002';
export const explanationAttemptId='72000000-0000-4000-8000-000000000003';
export const explanationLink=()=>({moduleRunId:explanationId,status:'running' as const,createdAt:'2026-09-13T01:00:00Z'});
export function explanationPageRun(status:'running'|'failed'|'succeeded'|'cancelled'='running',revisionId=shapeRevisionId){
 const catalogId='market-shape-explanation:'+'c'.repeat(64);
 const risk={kind:'risk' as const,parts:[{kind:'text' as const,text:'测试来源证据不足，不能据此判断市场机会。'}],evidenceRowIds:[],limitationCodes:[]};
 const verification={...risk,kind:'verification' as const};
 const riskText={kind:'risk' as const,text:risk.parts[0].text,evidenceRows:[],limitations:[]};
 const dimensions=['scope','shape','price','brand','age','month'] as const;
 const report={reportVersion:'market-shape-explanation-report/v1',moduleRunId:explanationId,revisionId,explanationCatalogId:catalogId,dataReady:true,
  explanation:{version:'market-shape-explanation-output/v1',explanationCatalogId:catalogId,revisionId,dimensions:dimensions.map(dimension=>({dimension,status:'insufficient-evidence',summary:risk,findings:[],limitations:[risk],verification:[verification]})),synthesis:{decision:'insufficient-evidence',summary:risk,limitations:[risk],verification:[verification]}},
  provenance:{inputSnapshotId:'market-input:'+'f'.repeat(64),modelAttemptId:explanationAttemptId,roundAttemptId:explanationStepId,windowAttemptId:explanationId,agentRunId:explanationAttemptId}};
 const presentation={revisionId,explanationCatalogId:catalogId,dimensions:dimensions.map(dimension=>({dimension,status:'insufficient-evidence',summary:riskText,findings:[],limitations:[riskText],verification:[{...riskText,kind:'verification'}]})),synthesis:{decision:'insufficient-evidence',summary:riskText,limitations:[riskText],verification:[{...riskText,kind:'verification'}]}};
 return {run:{id:explanationId,revisionId,status,progress:{totalWindows:12,completedWindows:status==='running'?6:12},report:['succeeded','cancelled'].includes(status)?report:null,presentation:['succeeded','cancelled'].includes(status)?presentation:null,
  steps:[{id:explanationStepId,kind:'model-batch',status:status==='cancelled'?'succeeded':status,latestAttemptId:explanationAttemptId,attemptCount:1,asin:null,current:status!=='cancelled',canRetry:status==='failed',errorCode:status==='failed'?'timeout':null}]}};
}
