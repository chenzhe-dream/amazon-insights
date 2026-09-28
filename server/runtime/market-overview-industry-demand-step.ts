import type {MarketExecutionActor} from '../db/market-module-execution-repository';
import {OverviewIndustryDemandInputSchema,MarketOverviewIndustryDemandSchema} from '../../shared/market-overview-industry-demand';
import {MARKET_SOURCE_HANDLER_VERSION,type MarketSourceEvidence} from '../../shared/market-source-contracts';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {readMarketOverviewCatalog} from './market-overview-catalog-step';
import {collectOverviewIndustryDemand,overviewDemandSeed,parseAbaPoints,productNodeSeed,replayDemandSelection} from '../services/market-overview-industry-demand';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {ConnectorMap} from '../connectors/connector-contract';
import type {MarketStepHandler} from './market-module-step-worker';
import type {MarketModuleRunView,MarketStepError} from '../db/market-module-execution-repository';
import {overviewIndustryDemandDefinition} from '../domain/market-research/overview-flow';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const json=(v:unknown)=>MarketInputRecordSchema.shape.data.parse(v);
function invalid():never{throw new TypeError('Overview industry demand frozen evidence differs');}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
export function createOverviewIndustryDemandStep(context:PostgresQueryContext,connectors:Pick<ConnectorMap,'sellerSprite'|'sorftime'>):MarketStepHandler{return async({claim,signal})=>{
 signal.throwIfAborted();const input=OverviewIndustryDemandInputSchema.parse(claim.step.input),actor={organizationId:claim.organizationId,userId:claim.createdBy},view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
 if(!view||!step||view.run.status==='cancelled'||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId||step.status!=='running'||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash)invalid();
 same(claim.step,overviewIndustryDemandDefinition(view,input.catalogAttemptId));
 const {sources}=await readMarketOverviewCatalog(context,view,input.catalogAttemptId,signal),collected=await collectOverviewIndustryDemand({scope:view.run.scope,seed:overviewDemandSeed(sources,view.run.scope),jobId:claim.moduleRunId,connectors,signal});signal.throwIfAborted();
 const sourceRefs=collected.evidence.map(s=>`market-source:${digest(s)}`),data={collection:'overview-industry-demand',catalogAttemptId:input.catalogAttemptId,result:collected.result,sourceRefs},factory={scope:view.run.scope,kind:'overview' as const,sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'overview-industry-demand/v1',collectedAt:new Date().toISOString(),expectedRecordIds:['industry-demand'],records:[{id:'industry-demand',scope:view.run.scope,data:json(data)}]},snapshot=createMarketInputSnapshot(factory);
  const output=json({...data,inputSnapshotId:snapshot.snapshotId}),failed=collected.result.issues.length>0;
 const issue=collected.result.issues.find(i=>i.retryable)??collected.result.issues[0],code:MarketStepError['code']=issue?.code==='timeout'?'timeout':['rate-limit','upstream-temporary'].includes(issue?.code??'')?'upstream-temporary':issue?.code==='local-admission'?'local-admission':issue?.code==='authentication'?'authentication':['source-mismatch','scope-mismatch'].includes(issue?.code??'')?'scope-mismatch':issue?.code==='interrupted'?'interrupted':'invalid-data';
 return {kind:'settlement',value:{sources:collected.sources.map(json),inputs:[json(factory)],outcome:failed?{status:'failed',error:{code,retryable:issue?.retryable??false,...(collected.admission?{admission:collected.admission}:{})},output}:{status:collected.result.status==='empty'?'empty':'succeeded',output}}};
};}
export async function readOverviewIndustryDemand(context:PostgresQueryContext,view:MarketModuleRunView,catalogAttemptId:string,attemptId:string,signal:AbortSignal,baseSources:readonly MarketSourceEvidence[],readerActor?:MarketExecutionActor){
 const attempt=view.attempts.find(a=>a.id===attemptId),step=view.steps.find(s=>s.id===attempt?.stepId);if(!attempt||!step||!['succeeded','empty','failed','interrupted'].includes(attempt.status))invalid();
 same(step.inputHash,digest(overviewIndustryDemandDefinition(view,catalogAttemptId)));
 if(!attempt.output){if(!['failed','interrupted'].includes(attempt.status))invalid();return MarketOverviewIndustryDemandSchema.parse({status:'failed',seed:null,referenceMonth:view.run.scope.toMonth,series:[],issues:[{operation:'overview-industry-demand',code:String(obj(attempt.error).code??'interrupted'),retryable:true}]});}
 const output=obj(attempt.output),result=MarketOverviewIndustryDemandSchema.parse(output.result);if(output.collection!=='overview-industry-demand'||output.catalogAttemptId!==catalogAttemptId||result.referenceMonth!==view.run.scope.toMonth)invalid();
 const snapshots=new PostgresMarketAnalysisSnapshotStore(context),actor=readerActor??{organizationId:view.run.scope.organizationId,userId:view.run.createdBy},studyId=view.run.scope.researchId,saved=await snapshots.findInput({actor,studyId,id:String(output.inputSnapshotId)});if(!saved)invalid();
 same(saved.snapshot.scope,view.run.scope);if(saved.snapshot.kind!=='overview'||saved.snapshot.ruleVersion!=='overview-industry-demand/v1'||saved.snapshot.sourceVersion!==MARKET_SOURCE_HANDLER_VERSION||saved.snapshot.records.length!==1)invalid();
 const {inputSnapshotId:_,...data}=output;same(saved.snapshot.records[0],{id:'industry-demand',scope:view.run.scope,data});same(saved.snapshot.expectedRecordIds,['industry-demand']);
 const refs=output.sourceRefs;if(!Array.isArray(refs)||refs.length>9)invalid();const sources=new Map<string,MarketSourceEvidence>();for(const ref of refs){signal.throwIfAborted();if(typeof ref!=='string')invalid();const source=await snapshots.findSource({actor,studyId,id:ref});if(!source)invalid();same(source.evidence.scope,view.run.scope);if(`market-source:${digest(source.evidence)}`!==ref||!['category_keywords','keyword_research','product_node','aba_research_trend'].includes(source.evidence.operation)||source.evidence.requestIdentity.nodeIdPath!==view.run.scope.nodeIdPath||source.evidence.fetchedAt>saved.snapshot.collectedAt||source.evidence.provider!==(source.evidence.operation==='category_keywords'?'sorftime':'sellerSprite'))invalid();sources.set(ref,source.evidence);}
 let expectedSeed=overviewDemandSeed(baseSources,view.run.scope);const nodeSources=[...sources.values()].filter(s=>s.operation==='product_node');if(!expectedSeed&&nodeSources.length===1)expectedSeed=productNodeSeed(nodeSources[0].payload,view.run.scope);same(result.seed,expectedSeed);
 const allSources=[...sources.values()],selected=replayDemandSelection(expectedSeed,allSources);same(result.series.map(s=>s.keyword),selected.map(s=>s.keyword));
 if(new Set(allSources.map(s=>`${s.operation}/${s.requestIdentity.keyword??''}/${s.requestIdentity.page??''}`)).size!==allSources.length)invalid();
 for(const source of allSources){if(source.operation==='category_keywords'&&![1,2].includes(Number(source.requestIdentity.page)))invalid();if(source.operation==='aba_research_trend'&&!selected.some(s=>s.keyword===source.requestIdentity.keyword))invalid();}
 same(result.status,result.series.some(s=>s.points.length)?result.issues.length||result.series.some(s=>s.status!=='ready')?'partial':'ready':result.issues.length?'failed':'empty');
 if((attempt.status==='failed')!==(result.issues.length>0)||attempt.status==='empty'&&result.status!=='empty')invalid();
 for(const series of result.series){same(series.searches,series.points.at(-1)?.value??selected.find(s=>s.keyword===series.keyword)?.searches??null);if(series.status==='failed'&&(!series.errorCode||!result.issues.some(i=>i.operation==='aba_research_trend'&&i.code===series.errorCode)))invalid();if(series.status!=='failed'&&series.errorCode!==null)invalid();}
 for(const series of result.series){if(!series.sourceRef){if(series.status!=='failed')invalid();continue;}const source=sources.get(series.sourceRef);if(!source||source.provider!=='sellerSprite'||source.operation!=='aba_research_trend'||source.requestIdentity.keyword!==series.keyword)invalid();same(series.points,parseAbaPoints(source.payload,result.referenceMonth));if(series.status!==(series.points.length?'ready':'empty'))invalid();}
 return result;
}
