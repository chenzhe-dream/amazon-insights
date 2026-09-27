import {readMarketShapeImages} from '../../services/market-shape-product-image';
import {z} from 'zod';
import type {Pool} from 'pg';
import type {MarketExecutionActor,MarketModuleRunView} from '../market-module-execution-repository';
import {MarketExecutionConflictError} from '../market-module-execution-repository';
import {PostgresQueryContext} from './query-context';
import {PostgresMarketModuleExecutionStore} from './market-module-execution-store';
import {PostgresMarketAnalysisSnapshotStore} from './market-analysis-snapshot-store';
import {inspectMarketShapeContinuation} from '../../domain/market-research/shape-price-flow';
import {readMarketShapeSorftimePool} from '../../services/market-shape-sorftime-reader';
import {readMarketShapeHistory,readMarketShapeAmountHistory} from '../../services/market-shape-history-reader';
import {readShapeCategoryDashboard} from '../../services/market-shape-category-reader';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {MarketShapeReferenceRevisionRequestSchema,MarketShapeReferenceRevisionSchema,MarketShapeReferenceRevisionDataSchema,MarketShapeReferenceRevisionIdSchema,MarketShapeReferenceRevisionHistorySchema,type MarketShapeReferenceRevisionData} from '../../../shared/market-shape-reference-revision-contracts';

const uuid=z.string().uuid(),actorSchema=z.object({organizationId:uuid,userId:uuid}).strict();
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const bindingSchema=z.object({sourceRefs:z.array(z.string().regex(/^market-source:[a-f0-9]{64}$/)).max(1000),inputRefs:z.array(z.string().regex(/^market-input:[a-f0-9]{64}$/)).max(1000),attempts:z.array(z.object({id:uuid,outputHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(1000)}).strict();
type Row={organization_id:string;study_id:string;run_id:string;revision_id:string;parent_revision_id:string|null;ordinal:number;stored_by:string;stored_at:Date|string;request_json:unknown;request_hash:string;revision_json:unknown;revision_hash:string;binding_json:unknown;binding_hash:string};
function invalid():never{throw new MarketExecutionConflictError();}
function same(a:unknown,b:unknown){if(digest(a)!==digest(b))invalid();}
function refs(data:MarketShapeReferenceRevisionData){return [
 ...data.pool.sourceRefs,
 ...(data.productImages?.products.map(p=>p.sourceRef)??[]),
 ...data.productHistory.products.map(p=>p.sourceRef),
 ...data.productAmountHistory.products.map(p=>p.sourceRef),
 ...data.categoryDashboard.sources.map(s=>s.sourceRef),
].filter((r):r is string=>r!==null).sort();}

/** V4 manual versions save exact public source values and never recollect on find. */
export class PostgresMarketShapeReferenceRevisionStore{
 private readonly context:PostgresQueryContext;
 private readonly steps:PostgresMarketModuleExecutionStore;
 private readonly snapshots:PostgresMarketAnalysisSnapshotStore;
 constructor(context:Pool|PostgresQueryContext){
  this.context=context instanceof PostgresQueryContext?context:new PostgresQueryContext(context);
  this.steps=new PostgresMarketModuleExecutionStore(this.context);
  this.snapshots=new PostgresMarketAnalysisSnapshotStore(this.context);
 }
 private async view(actor:MarketExecutionActor,moduleRunId:string){
  const view=await this.steps.findModuleRun({actor,moduleRunId});
  return view?.run.moduleKind==='shape-price'&&obj(view.run.params).flow==='market-shape-price-flow/rules-v4'&&view.run.versions.source==='market-source-handlers/v1'?view:null;
 }
 private async capture(actor:MarketExecutionActor,view:MarketModuleRunView){
  const current=new Set(inspectMarketShapeContinuation(view,new Date().toISOString()).currentStepKeys);
  const pool=await readMarketShapeSorftimePool({view,actor,current,snapshots:this.snapshots});
  if(!pool||pool.publicPool.products.length===0)invalid();
  const common={view,actor,current,snapshots:this.snapshots,asins:pool.publicPool.products.map(p=>p.asin),selectionInputSnapshotId:pool.snapshot.snapshotId};
  const productHistory=await readMarketShapeHistory(common);
  const productAmountHistory=await readMarketShapeAmountHistory(common);
  const categoryDashboard=await readShapeCategoryDashboard({view,actor,current,snapshots:this.snapshots});
  const data=MarketShapeReferenceRevisionDataSchema.parse({calculationVersion:'shape-known-coverage/2',scope:view.run.scope,pool:pool.publicPool,productImages:await readMarketShapeImages(common),productHistory,productAmountHistory,categoryDashboard});
  const attempts=view.steps.filter(s=>current.has(s.stepKey)&&['succeeded','empty'].includes(s.status)).map(s=>view.attempts.find(a=>a.id===s.latestAttemptId)).filter((a):a is NonNullable<typeof a>=>!!a);
  const binding=bindingSchema.parse({
   sourceRefs:[...new Set(attempts.map(a=>obj(a.output).sourceRef).filter((v):v is string=>typeof v==='string'))].sort(),
   inputRefs:[...new Set([pool.snapshot.snapshotId,...attempts.map(a=>obj(a.output).inputSnapshotId).filter((v):v is string=>typeof v==='string'),...attempts.map(a=>obj(a.output).selectionInputSnapshotId).filter((v):v is string=>typeof v==='string')])].sort(),
   attempts:attempts.map(a=>({id:a.id,outputHash:digest(a.output)})).sort((a,b)=>a.id.localeCompare(b.id)),
  });
  if(refs(data).some(r=>!binding.sourceRefs.includes(r)))invalid();
  return {data,binding};
 }
 private async restore(actor:MarketExecutionActor,view:MarketModuleRunView,row:Row){
  const request=MarketShapeReferenceRevisionRequestSchema.parse(row.request_json),revision=MarketShapeReferenceRevisionSchema.parse(row.revision_json),binding=bindingSchema.parse(row.binding_json);
  if(row.organization_id!==actor.organizationId||row.run_id!==view.run.id||row.study_id!==view.run.scope.researchId||row.stored_by!==revision.authorId||row.revision_id!==revision.revisionId||row.parent_revision_id!==request.expectedParentRevisionId||row.parent_revision_id!==revision.parentRevisionId||row.ordinal!==revision.ordinal||new Date(row.stored_at).toISOString()!==revision.createdAt)invalid();
  same(row.request_hash,digest({actor:{organizationId:row.organization_id,userId:row.stored_by},moduleRunId:row.run_id,request}));
  same(row.revision_hash,digest(revision));same(row.binding_hash,digest(binding));
  const revisionBody=Object.fromEntries(Object.entries(revision).filter(([key])=>key!=='revisionId'));
  same(revision.revisionId,`market-shape-revision:${digest(revisionBody)}`);
  same(revision.data.scope,view.run.scope);
  if(refs(revision.data).some(r=>!binding.sourceRefs.includes(r)))invalid();
  const selected=new Set(revision.data.pool.products.map(p=>p.asin));
  if(revision.selectedAsins.some(asin=>!selected.has(asin)))invalid();
  for(const item of binding.attempts){const attempt=view.attempts.find(a=>a.id===item.id);if(!attempt||digest(attempt.output)!==item.outputHash)invalid();}
  const query={actor,studyId:view.run.scope.researchId};
  for(const id of binding.sourceRefs){const source=await this.snapshots.findSource({...query,id});if(!source||source.id!==id||`market-source:${digest(source.evidence)}`!==id||digest(source.evidence.scope)!==digest(view.run.scope))invalid();}
  for(const id of binding.inputRefs){const snapshot=await this.snapshots.findInput({...query,id});if(!snapshot||snapshot.snapshot.snapshotId!==id||digest(snapshot.snapshot.scope)!==digest(view.run.scope))invalid();}
  return {revision};
 }
 async save(input:{actor:MarketExecutionActor;moduleRunId:string;request:unknown;idempotencyKey:string}){
  const actor=actorSchema.parse(input.actor),moduleRunId=uuid.parse(input.moduleRunId),key=uuid.parse(input.idempotencyKey),request=MarketShapeReferenceRevisionRequestSchema.parse(input.request),requestHash=digest({actor,moduleRunId,request});
  return this.context.transaction(async()=>{
   const active=await this.context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[actor.userId,actor.organizationId]);if(!active.rowCount)invalid();
   await this.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE',[moduleRunId,actor.organizationId]);
   const view=await this.view(actor,moduleRunId);if(!view)invalid();
   const prior=(await this.context.query<Row>('SELECT * FROM market_shape_reference_revisions WHERE organization_id=$1 AND idempotency_key=$2',[actor.organizationId,key])).rows[0];
   if(prior){if(prior.run_id!==moduleRunId||prior.request_hash!==requestHash)invalid();return {...await this.restore(actor,view,prior),created:false};}
   if(view.run.status==='cancelled')invalid();
   const latest=(await this.context.query<Row>('SELECT * FROM market_shape_reference_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 1',[actor.organizationId,moduleRunId])).rows[0];
   if((latest?.revision_id??null)!==request.expectedParentRevisionId)invalid();
   const {data,binding}=await this.capture(actor,view),available=new Set(data.pool.products.map(p=>p.asin));
   if(request.selectedAsins.some(asin=>!available.has(asin)))invalid();
   const createdAt=new Date().toISOString(),ordinal=(latest?.ordinal??0)+1;
   const body={parentRevisionId:request.expectedParentRevisionId,ordinal,createdAt,authorId:actor.userId,selectedAsins:request.selectedAsins,assignments:request.assignments,note:request.note,data};
   const revision=MarketShapeReferenceRevisionSchema.parse({revisionId:`market-shape-revision:${digest(body)}`,...body});
   const inserted=await this.context.query<Row>(`INSERT INTO market_shape_reference_revisions(organization_id,study_id,run_id,revision_id,parent_revision_id,ordinal,stored_by,stored_at,idempotency_key,request_json,request_hash,revision_json,revision_hash,binding_json,binding_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14::jsonb,$15) RETURNING *`,
    [actor.organizationId,view.run.scope.researchId,moduleRunId,revision.revisionId,request.expectedParentRevisionId,ordinal,actor.userId,createdAt,key,JSON.stringify(request),requestHash,JSON.stringify(revision),digest(revision),JSON.stringify(binding),digest(binding)]);
   if(!inserted.rowCount)invalid();
   return {created:true,revision};
  });
 }
 async find(input:{actor:MarketExecutionActor;moduleRunId:string;revisionId?:string}){
  const actor=actorSchema.parse(input.actor),moduleRunId=uuid.parse(input.moduleRunId),revisionId=MarketShapeReferenceRevisionIdSchema.optional().parse(input.revisionId);
  const view=await this.view(actor,moduleRunId);if(!view)return null;
  const row=(await this.context.query<Row>('SELECT * FROM market_shape_reference_revisions WHERE organization_id=$1 AND run_id=$2 AND ($3::text IS NULL OR revision_id=$3) ORDER BY ordinal DESC LIMIT 1',[actor.organizationId,moduleRunId,revisionId??null])).rows[0];
  return row?this.restore(actor,view,row):null;
 }
 async findSummary(input:{actor:MarketExecutionActor;moduleRunId:string}){
  const actor=actorSchema.parse(input.actor),moduleRunId=uuid.parse(input.moduleRunId),view=await this.view(actor,moduleRunId);if(!view)return null;
  const row=(await this.context.query<Row>('SELECT revision_json,revision_hash FROM market_shape_reference_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 1',[actor.organizationId,moduleRunId])).rows[0];if(!row)return null;
  const revision=MarketShapeReferenceRevisionSchema.parse(row.revision_json);same(row.revision_hash,digest(revision));same(revision.data.scope,view.run.scope);
  const {data:_data,...summary}=revision;return {revision:summary};
 }
 async list(input:{actor:MarketExecutionActor;moduleRunId:string}){
  const actor=actorSchema.parse(input.actor),moduleRunId=uuid.parse(input.moduleRunId),view=await this.view(actor,moduleRunId);if(!view)return [];
  const rows=(await this.context.query<Row>('SELECT revision_id,ordinal,stored_at FROM market_shape_reference_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 100',[actor.organizationId,moduleRunId])).rows;
  return MarketShapeReferenceRevisionHistorySchema.parse(rows.map(r=>({revisionId:r.revision_id,ordinal:r.ordinal,createdAt:new Date(r.stored_at).toISOString()})));
 }
}
