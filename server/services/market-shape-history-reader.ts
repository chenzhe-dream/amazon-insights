import {z} from 'zod';
import {ProductHistoryPublicSchema} from '../../shared/market-product-history-contracts';
import type {MarketExecutionActor,MarketModuleRunView} from '../db/market-module-execution-repository';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {collectMarketProductHistory,productHistoryPeriods} from './market-product-history-collector';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Current attempts only, with replay against immutable JSON; never a remote collector. */
export async function readMarketShapeHistory(input:{view:MarketModuleRunView;actor:MarketExecutionActor;current:Set<string>;snapshots:PostgresMarketAnalysisSnapshotStore;asins:string[];selectionInputSnapshotId:string}){
 const {view,actor,current,snapshots}=input,scope=view.run.scope;
 const products=await Promise.all(input.asins.map(async asin=>{
  const step=view.steps.find(s=>current.has(s.stepKey)&&s.kind==='collect-product-history'&&obj(s.input).asin===asin);
  const attempt=view.attempts.find(a=>a.id===step?.latestAttemptId);
  const base={asin,status:step?.status??(view.run.status==='cancelled'?'cancelled':'queued'),points:[],periods:productHistoryPeriods([],scope.toMonth),sourceRef:null,inputSnapshotId:null,fetchedAt:null,errorCode:step?.status==='failed'?String(obj(attempt?.error).code??'internal'):null};
  if(!step||!['succeeded','empty'].includes(step.status))return base;
  if(!attempt||attempt.status!==step.status||obj(step.input).selectionInputSnapshotId!==input.selectionInputSnapshotId)throw new TypeError('Historical attempt differs');
  const output=obj(attempt.output),query={actor,studyId:scope.researchId,moduleRunId:view.run.id};
  const [saved,raw]=await Promise.all([snapshots.findInput({...query,id:z.string().parse(output.inputSnapshotId)}),snapshots.findSource({...query,id:z.string().parse(output.sourceRef)})]);
  if(!saved||!raw||digest(saved.snapshot.scope)!==digest(scope)||digest(raw.evidence.scope)!==digest(scope)||raw.id!=='market-source:'+digest(raw.evidence)||raw.evidence.requestIdentity.asin!==asin||raw.evidence.requestIdentity.marketplace!==scope.marketplace)throw new TypeError('Historical source differs');
  const result=await collectMarketProductHistory({scope,asin,jobId:'history-replay',now:()=>new Date(raw.evidence.fetchedAt),connector:{id:'sorftime',probe:async()=>{throw Error('No probes in replay')},execute:async()=>({data:structuredClone(raw.evidence.payload) as Record<string,unknown>,source:{connectorId:raw.evidence.provider,operation:raw.evidence.operation,fetchedAt:raw.evidence.fetchedAt,attemptCount:1}})}});
  if(result.status==='failed'||digest(result.evidence)!==digest(raw.evidence))throw new TypeError('Historical source replay differs');
  const expected=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:raw.evidence.fetchedAt,expectedRecordIds:[asin],records:[{id:asin,scope,data:{collection:'product-history',asin,metric:'SalesVolume',points:result.points,sourceRef:raw.id}}]});
  if(digest(saved.snapshot)!==digest(expected))throw new TypeError('Historical input replay differs');
  return {...base,status:result.status,points:result.points,periods:productHistoryPeriods(result.points,scope.toMonth),sourceRef:raw.id,inputSnapshotId:saved.snapshot.snapshotId,fetchedAt:raw.evidence.fetchedAt};
 }));
 return ProductHistoryPublicSchema.parse({provider:'sorftime',metric:'SalesVolume',referenceMonth:scope.toMonth,products});
}
