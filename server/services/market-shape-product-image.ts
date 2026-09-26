import {z} from 'zod';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketSourceIdentityValueSchemas,type MarketSourceEvidence,type MarketSourcePayloadPath} from '../../shared/market-source-contracts';
import {MarketShapeProductImageUrlSchema,MarketShapeProductImagesPublicSchema} from '../../shared/market-shape-product-image-contracts';
import {sorftimeMarketSite} from '../../shared/market-sites';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {DeadlineError,executeOnce} from './market-keyword-collector';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
import type {MarketExecutionActor,MarketModuleRunView} from '../db/market-module-execution-repository';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Sorftime product_detail may return a URL, array, or JSON-encoded array. */
export function parseSorftimeProductMainImage(raw:unknown):string|null{
 const envelope=obj(raw),payload=obj(envelope.data??raw),value=payload.main_image;
 let candidate:unknown=value;
 if(typeof candidate==='string'&&candidate.trim().startsWith('[')){
  try{candidate=JSON.parse(candidate);}catch{return null;}
 }
 if(Array.isArray(candidate))candidate=candidate[0];
 if(typeof candidate!=='string')return null;
 const checked=MarketShapeProductImageUrlSchema.safeParse(candidate.trim());
 return checked.success?checked.data:null;
}
type CollectInput={scope:MarketAnalysisScope;asin:string;jobId:string;connector:RemoteMcpConnector;signal?:AbortSignal;now?:()=>Date;timeoutMs?:number};
type CollectResult={status:'ready'|'empty';asin:string;imageUrl:string|null;evidence:MarketSourceEvidence}|{status:'failed';failure:{code:string;retryable:boolean}};
export async function collectMarketShapeProductImage(input:CollectInput):Promise<CollectResult>{
 const scope=MarketAnalysisScopeSchema.parse(input.scope),asin=MarketSourceIdentityValueSchemas.asin.parse(input.asin),now=input.now??(()=>new Date());
 if(input.connector.id!=='sorftime'||scope.toMonth>=now().toISOString().slice(0,7))return {status:'failed',failure:{code:'configuration',retryable:false}};
 let response;
 try{response=await executeOnce(input.connector,{operation:'product_detail',input:{asin,amz_site:sorftimeMarketSite(scope.marketplace)},governorScope:{organizationId:scope.organizationId,jobId:input.jobId}},input.timeoutMs??60000,input.signal);}
 catch(error){return {status:'failed',failure:{code:error instanceof ConnectorError||error instanceof DeadlineError?error.code:'upstream-temporary',retryable:error instanceof ConnectorError?error.retryable:error instanceof DeadlineError?error.code==='timeout':true}};}
 try{
  const fetchedAt=z.object({connectorId:z.literal('sorftime'),operation:z.literal('product_detail'),fetchedAt:z.string().datetime(),attemptCount:z.number().int().positive()}).parse(response.source).fetchedAt;
  const payload=MarketInputRecordSchema.shape.data.parse(response.data),envelope=obj(payload),data=obj(envelope.data);
  if(envelope.error||envelope.success===false||envelope.code!==undefined&&!['OK',200,'200',0,'0'].includes(envelope.code as string|number))throw new TypeError('Upstream error envelope');
  const imageUrl=parseSorftimeProductMainImage(payload),paths:Record<string,MarketSourcePayloadPath[]>={asin:[['asin']],marketplace:[['amz_site']]};
  for(const [field,aliases] of Object.entries({asin:['asin','ASIN'],marketplace:['amz_site','site','marketplace']})){
   const found:MarketSourcePayloadPath[]=[];
   for(const [record,prefix] of [[envelope,[]],[data,['data']]] as [Record<string,unknown>,string[]][])for(const alias of aliases)if(Object.hasOwn(record,alias))found.push([...prefix,alias]);
   if(found.length)paths[field]=found;
  }
  const evidence=createMarketSourceEvidence({scope,provider:'sorftime',operation:'product_detail',requestIdentity:{asin,marketplace:scope.marketplace},responseIdentityPaths:paths,payload,fetchedAt,
   observationPeriod:{kind:'current',asOf:fetchedAt},units:{image:{status:'unknown',rawUnit:null,reason:'Image URL is not a numeric unit'}},
   coverage:{receivedCount:imageUrl?1:0,expectedCount:1,truncation:{status:'not-truncated'}}},now());
  return {status:imageUrl?'ready':'empty',asin,imageUrl,evidence};
 }catch{return {status:'failed',failure:{code:'invalid-data',retryable:false}};}
}

/** Replay the saved product_detail payload; never contact Sorftime on a read. */
export async function readMarketShapeImages(input:{view:MarketModuleRunView;actor:MarketExecutionActor;current:Set<string>;snapshots:PostgresMarketAnalysisSnapshotStore;asins:string[];selectionInputSnapshotId:string}){
 const {view,actor,current,snapshots}=input,scope=view.run.scope;
 const products=await Promise.all(input.asins.map(async asin=>{
  const step=view.steps.find(s=>current.has(s.stepKey)&&(s.kind as string)==='collect-product-image'&&obj(s.input).asin===asin),attempt=view.attempts.find(a=>a.id===step?.latestAttemptId);
  const base={asin,status:step?.status??(view.run.status==='cancelled'?'cancelled':'queued'),imageUrl:null,sourceRef:null,inputSnapshotId:null,fetchedAt:null,errorCode:step?.status==='failed'?String(obj(attempt?.error).code??'internal'):null};
  if(!step||!['succeeded','empty'].includes(step.status))return base;
  if(!attempt||attempt.status!==step.status||obj(step.input).selectionInputSnapshotId!==input.selectionInputSnapshotId)throw new TypeError('Product image attempt differs');
  const output=obj(attempt.output),query={actor,studyId:scope.researchId,moduleRunId:view.run.id};
  const [saved,raw]=await Promise.all([snapshots.findInput({...query,id:z.string().parse(output.inputSnapshotId)}),snapshots.findSource({...query,id:z.string().parse(output.sourceRef)})]);
  if(!saved||!raw||digest(saved.snapshot.scope)!==digest(scope)||digest(raw.evidence.scope)!==digest(scope)||raw.id!=='market-source:'+digest(raw.evidence)||raw.evidence.requestIdentity.asin!==asin||raw.evidence.requestIdentity.marketplace!==scope.marketplace||raw.evidence.operation!=='product_detail')throw new TypeError('Product image source differs');
  const result=await collectMarketShapeProductImage({scope,asin,jobId:'image-replay',now:()=>new Date(raw.evidence.fetchedAt),connector:{id:'sorftime',probe:async()=>{throw Error('No probes in replay')},execute:async()=>({data:structuredClone(raw.evidence.payload) as Record<string,unknown>,source:{connectorId:'sorftime',operation:'product_detail',fetchedAt:raw.evidence.fetchedAt,attemptCount:1}})}});
  if(result.status==='failed'||digest(result.evidence)!==digest(raw.evidence))throw new TypeError('Product image source replay differs');
  const expected=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:raw.evidence.fetchedAt,expectedRecordIds:[asin],records:[{id:asin,scope,data:{collection:'product-image',asin,imageUrl:result.imageUrl,sourceRef:raw.id}}]});
  if(digest(saved.snapshot)!==digest(expected))throw new TypeError('Product image input replay differs');
  return {...base,status:result.status,imageUrl:result.imageUrl,sourceRef:raw.id,inputSnapshotId:saved.snapshot.snapshotId,fetchedAt:raw.evidence.fetchedAt};
 }));
 return MarketShapeProductImagesPublicSchema.parse({provider:'sorftime',products});
}
