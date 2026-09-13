import {MarketKeywordRunResponseSchema,MarketKeywordFactsSchema} from '../../../shared/market-keyword-public-contracts';
import {canonicalJsonSha256 as digest} from '../../../server/runtime/model-request-accounting';
export const keywordRunId='72000000-0000-4000-8000-000000000001', keywordUserId='72000000-0000-4000-8000-000000000002';
export function keywordReconciledPageRun(){
 const sample=keywordDiscoveryPageRun(),{run}=sample;run.params.analysisMode='global-reconciliation/v1';
 const unknown={status:'unknown' as const,candidateIds:[],reason:'no-candidates',evidence:[]};
 run.reconciliation={version:'keyword-reconciliation-report/v1',moduleRunId:run.id,inputSnapshotId:run.facts!.pool.semanticInputSnapshotId,status:'partial',completedRounds:1,resultHash:'a'.repeat(64),
  catalog:[{candidateId:'global-lamp',dimension:'W1',label:'灯具',definition:'原词明确提到 lamp',evidence:[]}],
  decisions:run.facts!.members.map((m,i)=>({keywordId:m.keywordId,W1:{status:'supported',candidateIds:['global-lamp'],reason:null,evidence:[{refId:`word-${i}`,start:m.keyword.indexOf('lamp'),end:m.keyword.indexOf('lamp')+4,quote:'lamp'}]},W2:unknown,W3:unknown,W4:unknown,cluster:unknown}))};
 return MarketKeywordRunResponseSchema.parse(sample);
}
export function keywordPageRun(){
 const scope={organizationId:keywordUserId,researchId:'72000000-0000-4000-8000-000000000003',marketplace:'US',nodeIdPath:'1:2:3',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD'};
 const hash='a'.repeat(64),missing={value:null,reason:'missing'};
 const basis={version:'market-keyword-facts/v1',moduleRunId:keywordRunId,scope,referenceMonth:'2026-08',
  pool:{attemptId:keywordRunId,rawInputSnapshotId:`market-input:${hash}`,semanticInputSnapshotId:`market-input:${hash}`,basisHash:hash,dataCutoffAt:'2026-09-01T00:00:00.000Z',plannedPageCount:1,receivedPageCount:1,missingPages:[],emptyPages:[],fullPages:[],collectionCoverage:'complete',exhaustive:false,maxMembers:100,uniqueObservedMemberCount:2,omittedMemberIds:[],conflictingMemberIds:[],duplicateMemberCount:0,memberLimitReached:false,selectionPolicy:'seed-page-source-order/first-observation/v1'},
  members:[0,1].map(i=>({keywordId:`keyword:${i}`,keyword:i?'floor lamp':'shelf lamp',sourceRef:`market-source:${hash}`,occurrences:[],
   pageMetrics:{monthlySearchVolume:{value:999,reason:null},weeklySearchVolume:missing,weeklySearchRank:missing,recommendedCpcUsd:{value:1.25,reason:null},period:'unspecified-source-window'},
   trend:{status:'empty',stepId:null,attemptId:null,inputSnapshotId:null,sourceRef:null,fetchedAt:null,cpcCurrency:null,months:[]},
   reference:{searchVolume:i?null:0,yoyGrowth:null,recentGrowth:null,actualCpcUsd:null,actualCpcReason:'source-provides-recommended-bid-only'}})),
  semantics:{status:'unavailable',unavailableKeywordIds:['keyword:0','keyword:1'],unknownDimensionCount:0,unknownClusterCount:0,batches:[]}};
 const facts=MarketKeywordFactsSchema.parse({...basis,factsId:`market-keyword-facts:${digest(basis)}`});
 return MarketKeywordRunResponseSchema.parse({run:{id:keywordRunId,scope,status:'partial',createdAt:'2026-09-13T00:00:00.000Z',
  params:{plannedPages:[{seed:'shelf lamp',page:1}],maxMembers:100,catalog:{task:'market-keyword-semantics',dictionaryVersion:'manual/v1',categoryContext:'层架灯',dimensionLabels:{W1:[{labelId:'shelf',label:'层架灯',definition:'明确含shelf'}],W2:[],W3:[],W4:[]},clusterCatalog:[]}},steps:[],facts,history:[]}});
}
export function keywordDiscoveryPageRun(){
 const sample=keywordPageRun(),{run}=sample,facts=run.facts!,unknown={status:'unknown' as const,reason:'insufficient-evidence' as const,evidence:[]};
 run.params.catalog.discoveryMode='labels-and-clusters/v1';
 facts.semantics={status:'validated',unavailableKeywordIds:[],unknownDimensionCount:6,unknownClusterCount:2,batches:facts.members.map((m,i)=>{
  const batchId=i?keywordUserId:keywordRunId,evidence=[{refId:`word-${i}`,start:0,end:m.keyword.length,quote:m.keyword}];
  return {stepId:batchId,attemptId:batchId,agentRunId:batchId,bindingId:batchId,inputDigest:'a'.repeat(64),output:{schemaVersion:'1.0.0',task:'market-keyword-semantics',batchId,inputDigest:'a'.repeat(64),keywords:[{keywordId:m.keywordId,W1:{status:'supported',labelIds:['new-label'],evidence},W2:unknown,W3:unknown,W4:unknown,cluster:unknown}],proposals:[],synonymRelations:[],labelProposals:[{dimension:'W1',labelId:'new-label',label:i?'落地灯':'层架灯',definition:i?'本批词明确提及 floor lamp':'本批词明确提及 shelf lamp',evidence}]}};
 })};
 const {factsId:_old,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 return MarketKeywordRunResponseSchema.parse(sample);
}
