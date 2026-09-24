import {z} from 'zod';
import {SHAPE_CATEGORY_METRICS,type ShapeCategorySource} from '../../shared/market-shape-category-contracts';
import {buildShapeCategoryDashboard,collectShapeCategory} from './market-shape-category-collector';
import type {MarketExecutionActor,MarketModuleRunView} from '../db/market-module-execution-repository';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export async function readShapeCategoryDashboard({view,actor,current,snapshots}:{view:MarketModuleRunView;actor:MarketExecutionActor;current:Set<string>;snapshots:PostgresMarketAnalysisSnapshotStore}){
 const scope=view.run.scope;
 const sources=await Promise.all(SHAPE_CATEGORY_METRICS.map(async (metric):Promise<ShapeCategorySource>=>{
  const step=view.steps.find(s=>current.has(s.stepKey)&&s.kind==='collect-shape-category'&&obj(s.input).metric===metric),attempt=view.attempts.find(a=>a.id===step?.latestAttemptId);
  if(!step||!['succeeded','empty'].includes(step.status))return {metric,status:step?.status as ShapeCategorySource['status']??(view.run.status==='cancelled'?'cancelled':'queued'),points:[],stats:null,sourceRef:null,fetchedAt:null};
  if(!attempt||attempt.status!==step.status)throw Error('Category attempt differs');
  const output=obj(attempt.output),query={actor,studyId:scope.researchId};
  const [saved,raw]=await Promise.all([snapshots.findInput({...query,id:z.string().parse(output.inputSnapshotId)}),snapshots.findSource({...query,id:z.string().parse(output.sourceRef)})]);
  if(!saved||!raw||digest(saved.snapshot.scope)!==digest(scope)||digest(raw.evidence.scope)!==digest(scope)||raw.id!=='market-source:'+digest(raw.evidence)||output.metric!==metric||output.selectionInputSnapshotId!==obj(step.input).selectionInputSnapshotId)throw Error('Category source differs');
  const replay=await collectShapeCategory({scope,metric,jobId:'category-read-replay',now:()=>new Date(raw.evidence.fetchedAt),connector:{id:'sorftime',probe:async()=>{throw Error('No read probes')},execute:async()=>({data:structuredClone(raw.evidence.payload) as Record<string,unknown>,source:{connectorId:raw.evidence.provider,operation:raw.evidence.operation,fetchedAt:raw.evidence.fetchedAt,attemptCount:1}})}});
  if(replay.status==='failed'||digest(replay.evidence)!==digest(raw.evidence))throw Error('Category evidence replay differs');
  const expected=createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:raw.evidence.fetchedAt,expectedRecordIds:[metric],records:[{id:metric,scope,data:{collection:'shape-category',metric,points:replay.points,stats:replay.stats,sourceRef:raw.id}}]});
  if(digest(saved.snapshot)!==digest(expected))throw Error('Category input replay differs');
  return {metric,status:replay.status,points:replay.points,stats:replay.stats,sourceRef:raw.id,fetchedAt:raw.evidence.fetchedAt};
 }));
 return buildShapeCategoryDashboard(sources,scope.currency,scope.toMonth);
}
