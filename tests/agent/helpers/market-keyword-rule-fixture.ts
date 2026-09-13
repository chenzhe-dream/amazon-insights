import {keywordReconciledPageRun,keywordUserId} from './market-keyword-page-fixture';
import {canonicalJsonSha256 as digest} from '../../../server/runtime/model-request-accounting';
import {buildMarketKeywordRevision} from '../../../server/domain/market-research/keyword-revision';
import {buildMarketKeywordRuleReport} from '../../../server/domain/market-research/keyword-rule-report';

/** Synthetic browser fixture, never a real source or model-quality sample. */
export function keywordRuleFixture(options:{aba?:boolean}={}){
 const response=keywordReconciledPageRun(),run=response.run,facts=run.facts!;
 for(const [i,member] of facts.members.entries()){
  const values=i?[100,0,50,50]:[50,100,100,200],months=['2025-08','2026-05','2026-07','2026-08'];
  member.trend={status:'ready',stepId:run.id,attemptId:run.id,inputSnapshotId:`market-input:${String(i+1).repeat(64)}`,sourceRef:`market-source:${String(i+1).repeat(64)}`,fetchedAt:'2026-09-01T00:00:00.000Z',cpcCurrency:null,months:months.map((month,j)=>({month,searchVolume:{value:values[j],reason:null},searchRank:{value:null,reason:'missing'},recommendedBid:{value:2,reason:null},yoyGrowth:{value:null,reason:'missing-baseline',baselineMonth:`${Number(month.slice(0,4))-1}${month.slice(4)}`,baselineValue:null,formulaVersion:'calendar-month-growth/v1'},recentGrowth:{value:null,reason:'missing-baseline',baselineMonth:month,baselineValue:null,formulaVersion:'calendar-month-growth/v1'}}))};
  member.reference={...member.reference,searchVolume:i?50:200,yoyGrowth:i?-.5:3,recentGrowth:i?0:1};
  if(options.aba){
   const oldId=member.keywordId;member.keywordId=`kw_${digest(member.keyword)}`;
   run.reconciliation!.decisions.find(d=>d.keywordId===oldId)!.keywordId=member.keywordId;
   facts.semantics.unavailableKeywordIds=facts.semantics.unavailableKeywordIds.map(id=>id===oldId?member.keywordId:id);
   member.aba={status:i?'failed':'partial',stepId:run.id,attemptId:run.id,inputSnapshotId:i?null:`market-input:${'a'.repeat(64)}`,sourceRef:i?null:`market-source:${'a'.repeat(64)}`,fetchedAt:i?null:'2026-09-01T00:00:00.000Z',referenceMonth:facts.referenceMonth,sourceScope:'exact-keyword-marketplace',nodeBinding:'not-provided',
    member:i?null:{keyword:member.keyword,memberId:member.keywordId,referenceMonth:facts.referenceMonth,keywordPath:['keywords',0,'keyword'],monthPath:['keywords',0,'dates',0],searchVolume:{value:300,reason:null,path:['keywords',0,'volumes',0]},top3ClickShare:{value:0,reason:null,path:['keywords',0,'top3_click_shares',0]},top3ConversionShare:{value:null,reason:'missing-value',path:['keywords',0,'top3_conversion_shares',0]}}};
  }
 }
 const {factsId:_old,...basis}=facts;void _old;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const global=run.reconciliation!;global.catalog.push({candidateId:'all-lamps',dimension:'cluster',label:'灯具需求',definition:'合成夹具：两词按灯具归组',evidence:[]});
 for(const decision of global.decisions)decision.cluster={status:'supported',candidateIds:['all-lamps'],reason:null,evidence:[]};
 global.resultHash=digest(global.decisions);
 run.ruleReport=buildMarketKeywordRuleReport({facts,classification:{kind:'global',report:global}});
 const request={factsId:facts.factsId,expectedParentRevisionId:null,labels:{W1:[],W2:[],W3:[],W4:[]},clusters:[{clusterId:'human-lamps',label:'人工灯具组',definition:'合成业务分类'}],assignments:facts.members.map(m=>({keywordId:m.keywordId,W1:[],W2:[],W3:[],W4:[],clusterId:'human-lamps'})),note:'规则报告浏览器夹具'};
 const catalog=buildMarketKeywordRevision({facts,request,authorId:keywordUserId,createdAt:'2026-09-13T00:00:00.000Z'});
 const revision={ordinal:1,catalog,ruleReport:buildMarketKeywordRuleReport({facts,classification:{kind:'manual',revision:catalog}})};
 return {response,request,revision};
}
