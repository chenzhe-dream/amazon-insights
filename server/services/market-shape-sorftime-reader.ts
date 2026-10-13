import {z} from 'zod';
import type {MarketExecutionActor,MarketModuleRunView} from '../db/market-module-execution-repository';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {collectSorftimeShapePoolPage} from './market-shape-sorftime-pool';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
import {SorftimeShapePoolPublicSchema} from '../../shared/market-shape-sorftime-contracts';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
type Input={view:MarketModuleRunView;actor:MarketExecutionActor;snapshots:PostgresMarketAnalysisSnapshotStore};
export async function replaySorftimeShapePoolPages({view,actor,snapshots,pageAttemptIds}:{pageAttemptIds:string[]}&Input){
 if(!pageAttemptIds.length||new Set(pageAttemptIds).size!==pageAttemptIds.length)throw Error('Pool page attempts differ');
 const pages=await Promise.all(pageAttemptIds.map(async id=>{
  const attempt=view.attempts.find(a=>a.id===id),step=view.steps.find(s=>s.id===attempt?.stepId);
  if(!attempt||!step||step.kind!=='collect-shape-pool'||!['succeeded','empty'].includes(attempt.status))throw Error('Pool attempt unavailable');
  const input=obj(step.input),out=obj(attempt.output),query={actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id};
  const [raw,saved]=await Promise.all([snapshots.findSource({...query,id:z.string().parse(out.sourceRef)}),snapshots.findInput({...query,id:z.string().parse(out.inputSnapshotId)})]);
  if(!raw||!saved||digest(raw.evidence.scope)!==digest(view.run.scope)||raw.id!=='market-source:'+digest(raw.evidence))throw Error('Pool source scope differs');
  const result=await collectSorftimeShapePoolPage({scope:view.run.scope,jobId:'pool-replay',...(raw.evidence.operation==='category_report'?{replayOperation:'category_report' as const}:{}),poolSize:z.number().parse(input.poolSize),...(input.page===undefined?{}:{page:z.number().parse(input.page),categoryName:z.string().parse(input.categoryName)}),now:()=>new Date(raw.evidence.fetchedAt),connector:{id:'sorftime',probe:async()=>{throw Error('No replay probes')},execute:async()=>({data:structuredClone(raw.evidence.payload) as Record<string,unknown>,source:{connectorId:'sorftime',operation:raw.evidence.operation,fetchedAt:raw.evidence.fetchedAt,attemptCount:1}})}});
  if(result.status==='failed'||digest(result.evidence)!==digest(raw.evidence))throw Error('Pool source replay differs');
  const expected=createMarketInputSnapshot({scope:view.run.scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:raw.evidence.fetchedAt,expectedRecordIds:result.products.map(p=>p.asin),records:result.products.map(product=>({id:product.asin,scope:view.run.scope,data:{collection:'sorftime-shape-pool',product,sourceRef:raw.id}}))});
  if(digest(expected)!==digest(saved.snapshot)||out.productCount!==result.products.length||digest(out.productAsins)!==digest(result.products.map(p=>p.asin))||out.receivedCount!==result.receivedCount||out.categoryName!==result.categoryName)throw Error('Pool input replay differs');
  return {attempt,step,snapshot:saved.snapshot,sourceRef:raw.id,...result};
 }));
 const poolSize=z.number().int().min(1).max(300).parse(obj(view.run.params).poolSize),unique=new Map<string,typeof pages[number]['products'][number]>(),records=new Map<string,typeof pages[number]['snapshot']['records'][number]>();
 for(const page of pages)for(const product of page.products)if(!unique.has(product.asin)&&unique.size<poolSize){unique.set(product.asin,product);records.set(product.asin,page.snapshot.records.find(r=>r.id===product.asin)!);}
 const collectedAt=pages.map(p=>p.evidence.fetchedAt).sort().at(-1)!;
 const factory={scope:view.run.scope,kind:'products' as const,sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt,expectedRecordIds:[...unique.keys()],records:[...records.values()].map(r=>({id:r.id,scope:r.scope,data:r.data}))};
 return {pages,factory,snapshot:createMarketInputSnapshot(factory),publicPool:SorftimeShapePoolPublicSchema.parse({provider:'sorftime',period:'recent-30-days',fetchedAt:collectedAt,categoryName:pages[0].categoryName,products:[...unique.values()],sourceRefs:pages.map(p=>p.sourceRef),requestedSize:poolSize})};
}
export async function readMarketShapeSorftimePool(input:Input&{current:Set<string>}){
 const step=input.view.steps.find(s=>input.current.has(s.stepKey)&&obj(s.input).phase==='select-sorftime-shape-members');
 const attempt=input.view.attempts.find(a=>a.id===step?.latestAttemptId);
 if(!step||!attempt||!['succeeded','empty'].includes(step.status))return null;
 if(attempt.stepId!==step.id||attempt.status!==step.status)throw Error('Frozen selection attempt differs');
 const pageAttemptIds=z.array(z.string().uuid()).max(21).parse(obj(step.input).pageAttemptIds),result=await replaySorftimeShapePoolPages({...input,pageAttemptIds});
 if(result.pages[0].step.stepKey!=='shape-flow/anchor'||obj(step.input).referenceAttemptId!==result.pages[0].attempt.id||result.pages.some((p,i)=>p.step.latestAttemptId!==p.attempt.id||p.step.status!==p.attempt.status||!input.current.has(p.step.stepKey)||!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===p.attempt.id)||i>0&&(obj(p.step.input).page!==i||obj(p.step.input).referenceAttemptId!==result.pages[0].attempt.id)))throw Error('Frozen pool frontier differs');
 const output=obj(attempt.output),snapshot=await input.snapshots.findInput({actor:input.actor,studyId:input.view.run.scope.researchId,id:z.string().parse(output.selectionInputSnapshotId)});
 if(!snapshot||digest(snapshot.snapshot)!==digest(result.snapshot)||digest(output.selectedAsins)!==digest(result.publicPool.products.map(p=>p.asin)))throw Error('Frozen pool differs');
 return {...result,attempt,step};
}
