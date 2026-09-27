import {z} from 'zod';
import type {MarketExecutionActor,MarketModuleRunView} from '../db/market-module-execution-repository';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {parseSorftimeProductMainImage} from './market-shape-product-image';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export async function readThemeSavedImages(input:{view:MarketModuleRunView;actor:MarketExecutionActor;store:PostgresMarketAnalysisSnapshotStore;attemptIds:unknown;selectionId:string;cutoff:string}){
 const {view,actor,store,selectionId,cutoff}=input,ids=z.array(z.string().uuid()).max(20).parse(input.attemptIds??[]);
 if(new Set(ids).size!==ids.length)throw Error('Duplicate image attempts');
 const images=new Map<string,{source?:{ref:string;snapshotId:string;payload:unknown};missingReason?:string}>();
 for(const id of ids){
  const a=view.attempts.find(a=>a.id===id),s=view.steps.find(s=>s.id===a?.stepId),asin=z.string().regex(/^[A-Z0-9]{10}$/).parse(obj(s?.input).asin);
  if(!a||!s||s.kind!=='collect-product-image'||obj(s.input).selectionInputSnapshotId!==selectionId||images.has(asin)||!['succeeded','empty','failed','interrupted'].includes(a.status))throw Error('Image attempt binding differs');
  if(a.status==='failed'||a.status==='interrupted'){images.set(asin,{missingReason:'商品图片补充失败，可在任务进度中重试'});continue;}
  const out=obj(a.output),query={actor,studyId:view.run.scope.researchId};
  const source=await store.findSource({...query,id:z.string().parse(out.sourceRef)}),saved=await store.findInput({...query,id:z.string().parse(out.inputSnapshotId)});
  if(!source||!saved||source.id!==`market-source:${digest(source.evidence)}`||digest(source.evidence.scope)!==digest(view.run.scope)||digest(saved.snapshot.scope)!==digest(view.run.scope)||source.evidence.provider!=='sorftime'||source.evidence.operation!=='product_detail'||source.evidence.requestIdentity.asin!==asin||Date.parse(source.evidence.fetchedAt)>Date.parse(cutoff))throw Error('Image source differs');
  const record=saved.snapshot.records.find(r=>r.id===asin),image=parseSorftimeProductMainImage(source.evidence.payload);
  if(!record||saved.snapshot.records.length!==1||obj(record.data).collection!=='product-image'||obj(record.data).sourceRef!==source.id||obj(record.data).imageUrl!==image||out.selectionInputSnapshotId!==selectionId)throw Error('Image projection differs');
  images.set(asin,{source:{ref:source.id,snapshotId:saved.snapshot.snapshotId,payload:source.evidence.payload}});
 }
 return images;
}
