export {projectOverviewProductDemand} from '../domain/market-research/overview-product-demand';
import {OverviewExternalInputSchema,MarketOverviewExternalDataSchema,type MarketOverviewExternalData} from '../../shared/market-overview-external';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {MARKET_SOURCE_HANDLER_VERSION,type MarketSourceEvidence} from '../../shared/market-source-contracts';
import type {ConnectorMap} from '../connectors/connector-contract';
import type {MarketModuleRunView,MarketStepError} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {overviewExternalDefinition,overviewExternalFrontier} from '../domain/market-research/overview-external-plan';
import {collectOverviewExternal,projectOverviewExternal,overviewExternalAsins} from '../services/market-overview-external-collector';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import {readMarketOverviewCatalog} from './market-overview-catalog-step';
import type {MarketStepHandler} from './market-module-step-worker';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const json=(v:unknown)=>MarketInputRecordSchema.shape.data.parse(v);
function invalid():never{throw new TypeError('Overview external frozen source differs');}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
export function createOverviewExternalStep(context:PostgresQueryContext,connectors:Pick<ConnectorMap,'sellerSprite'|'sorftime'>):MarketStepHandler{return async({claim,signal})=>{
 signal.throwIfAborted();const stage=OverviewExternalInputSchema.parse(claim.step.input),actor={organizationId:claim.organizationId,userId:claim.createdBy},view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
 if(!view||!step||view.run.status==='cancelled'||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId||step.status!=='running'||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash||obj(view.run.params).flow!=='market-overview-flow/rules-v4')invalid();
 same(claim.step,overviewExternalDefinition(stage));if(!overviewExternalFrontier(view,stage.catalogAttemptId).currentStepKeys.includes(step.stepKey))invalid();
 const {sources}=await readMarketOverviewCatalog(context,view,stage.catalogAttemptId,signal);
 if(stage.kind==='profits')same(stage.asins,overviewExternalAsins(sources,view.run.scope).slice(stage.batch!*40,stage.batch!*40+40));
 const result=await collectOverviewExternal({scope:view.run.scope,stage,connectors,jobId:claim.moduleRunId,signal});signal.throwIfAborted();
 if(result.status==='failed'){
  const code:MarketStepError['code']=result.code==='timeout'?'timeout':result.code==='local-admission'?'local-admission':result.code==='authentication'?'authentication':['rate-limit','upstream-temporary'].includes(result.code)?'upstream-temporary':'invalid-data';
  return {kind:'settlement',value:{outcome:{status:'failed',error:{code,retryable:result.retryable}}}};
 }
 const data={collection:'overview-external',stage,...result.result,sourceRef:`market-source:${digest(result.evidence)}`},factory={scope:view.run.scope,kind:'overview' as const,sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'overview-external/v1',collectedAt:result.evidence.fetchedAt,expectedRecordIds:['external'],records:[{id:'external',scope:view.run.scope,data:json(data)}]},snapshot=createMarketInputSnapshot(factory);
 return {kind:'settlement',value:{sources:[json(result.proposal)],inputs:[json(factory)],outcome:{status:result.result.receivedCount?'succeeded':'empty',output:json({...data,inputSnapshotId:snapshot.snapshotId})}}};
};}
export async function readOverviewExternal(context:PostgresQueryContext,view:MarketModuleRunView,catalogAttemptId:string,attemptIds:string[],signal:AbortSignal,baseSources:readonly MarketSourceEvidence[]){
 if(obj(view.run.params).flow!=='market-overview-flow/rules-v4')invalid();
 const requestedAsins=overviewExternalAsins(baseSources,view.run.scope),snapshots=new PostgresMarketAnalysisSnapshotStore(context),actor={organizationId:view.run.scope.organizationId,userId:view.run.createdBy};
 const series=():MarketOverviewExternalData['salesTrend']=>({status:'not-collected',points:[],sourceRefs:[],errorCode:null});
 const sales=series(),prices=series(),profits:MarketOverviewExternalData['asinProfits']={status:'not-collected',items:{},requestedAsins,missingAsins:requestedAsins,sourceRefs:[],errorCode:null};
 const keys=new Set<string>(),profitPages=new Map<number,number>(),profitTotal=new Map<number,number>();let profitFailed=false,profitCollected=false;
 for(const id of attemptIds){
  signal.throwIfAborted();const attempt=view.attempts.find(a=>a.id===id),step=view.steps.find(s=>s.id===attempt?.stepId);if(!attempt||!step||!['succeeded','empty','failed','interrupted'].includes(attempt.status))invalid();
  const stage=OverviewExternalInputSchema.parse(step.input);if(stage.catalogAttemptId!==catalogAttemptId||keys.has(step.stepKey))invalid();keys.add(step.stepKey);same(step.inputHash,digest(overviewExternalDefinition(stage)));
  if(stage.kind==='profits'){same(stage.asins,requestedAsins.slice(stage.batch!*40,stage.batch!*40+40));profitCollected=true;}
  if(attempt.status==='failed'||attempt.status==='interrupted'){
   const code=String(obj(attempt.error).code??'interrupted');if(stage.kind==='profits'){profitFailed=true;profits.errorCode=code;}else{const target=stage.kind==='sales'?sales:prices;target.status='failed';target.errorCode=code;}continue;
  }
  const output=obj(attempt.output),ref=String(output.sourceRef),source=await snapshots.findSource({actor,studyId:view.run.scope.researchId,id:ref}),saved=await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:String(output.inputSnapshotId)});
  if(!source||!saved)invalid();same(source.evidence.scope,view.run.scope);same(ref,`market-source:${digest(source.evidence)}`);
  const evidence=source.evidence,operation=stage.kind==='profits'?'competitor_lookup':'category_trend';
  if(evidence.operation!==operation||evidence.provider!==(stage.kind==='profits'?'sellerSprite':'sorftime')||evidence.requestIdentity.nodeIdPath!==view.run.scope.nodeIdPath||evidence.requestIdentity.month!==view.run.scope.toMonth||stage.kind==='profits'&&evidence.requestIdentity.page!==stage.page)invalid();
  if(stage.kind!=='profits'&&evidence.units.value?.rawUnit!==(stage.kind==='sales'?'SalesCount':'AvgPrice'))invalid();
  const result=projectOverviewExternal(stage,evidence.payload,view.run.scope.toMonth),data={collection:'overview-external',stage,...result,sourceRef:ref};same(output,{...data,inputSnapshotId:saved.snapshot.snapshotId});
  same(saved.snapshot,createMarketInputSnapshot({scope:view.run.scope,kind:'overview',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'overview-external/v1',collectedAt:evidence.fetchedAt,expectedRecordIds:['external'],records:[{id:'external',scope:view.run.scope,data:json(data)}]}));
  if((attempt.status==='empty')!==(result.receivedCount===0))invalid();
  if(stage.kind==='profits'){profits.sourceRefs.push(ref);for(const [asin,item]of Object.entries(result.items))if(!Object.hasOwn(profits.items,asin))profits.items[asin]=item;profitPages.set(stage.batch!,Math.max(profitPages.get(stage.batch!)??0,stage.page!));profitTotal.set(stage.batch!,result.pages);}
  else{const target=stage.kind==='sales'?sales:prices;target.points=result.points;target.status=result.points.length?'ready':'empty';target.sourceRefs=[ref];}
 }
 // The original algorithm uses at most 24 completed volume months, month-joins prices and rounds amounts to integers.
 sales.points=sales.points.slice(-24);const priceMap=new Map(prices.points.map(p=>[p.month,p.value]));
 const amount=series();amount.sourceRefs=[...sales.sourceRefs,...prices.sourceRefs];amount.points=sales.points.flatMap(p=>priceMap.has(p.month)?[{month:p.month,value:Math.round(p.value*priceMap.get(p.month)!)}]:[]);
 amount.errorCode=sales.errorCode??prices.errorCode;
 amount.status=amount.points.length?(amount.points.length<sales.points.length?'partial':'ready'):[sales.status,prices.status].includes('failed')?'failed':[sales.status,prices.status].includes('not-collected')?'not-collected':'empty';
 if(amount.points.length<sales.points.length&&!amount.errorCode)amount.errorCode=prices.status==='not-collected'?'prices-not-collected':'price-month-missing';
 profits.missingAsins=requestedAsins.filter(a=>!Object.hasOwn(profits.items,a)||profits.items[a].profit===null);
 const hasItems=Object.keys(profits.items).length>0,cap=[...profitPages].some(([batch,page])=>page>=50&&(profitTotal.get(batch)??0)>page);
 profits.status=hasItems?profits.missingAsins.length||profitFailed?'partial':'ready':profitFailed?'failed':profitCollected?'empty':'not-collected';
 if(!profits.errorCode&&profits.missingAsins.length)profits.errorCode=cap?'profit-page-budget-exhausted':profitCollected?'requested-asins-missing':'profit-not-collected';
 return MarketOverviewExternalDataSchema.parse({referenceMonth:view.run.scope.toMonth,salesTrend:sales,salesAmountTrend:amount,asinProfits:profits});
}
