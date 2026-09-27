import {z} from 'zod';
import type {Pool} from 'pg';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../market-module-execution-repository';
import {PostgresQueryContext} from './query-context';
import {PostgresMarketModuleExecutionStore} from './market-module-execution-store';
import {MARKET_SHAPE_SORFTIME_FLOW_VERSION} from '../../domain/market-research/shape-price-flow';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {MarketShapeDraftContentSchema,MarketShapeDraftResponseSchema,MarketShapeDraftSaveRequestSchema,type MarketShapeDraft} from '../../../shared/market-shape-draft-contracts';

const uuid=z.string().uuid();
type DraftRow={version:number;content_json:unknown;content_hash:string;updated_at:Date|string};
type ReceiptRow={request_hash:string;response_json:unknown};
const empty:MarketShapeDraft={version:0,items:[],catalogLabels:[],updatedAt:null};

/** Actor/category draft state. The run proves access and supplies a canonical scope, never a storage key. */
export class PostgresMarketShapeDraftStore {
  private readonly context:PostgresQueryContext;
  private readonly steps:PostgresMarketModuleExecutionStore;
  constructor(context:Pool|PostgresQueryContext){
    this.context=context instanceof PostgresQueryContext?context:new PostgresQueryContext(context);
    this.steps=new PostgresMarketModuleExecutionStore(this.context);
  }
  private async identity(actor:MarketExecutionActor,moduleRunId:string){
    uuid.parse(actor.userId);uuid.parse(moduleRunId);
    const view=await this.steps.findModuleRun({actor,moduleRunId});
    if(!view||view.run.moduleKind!=='shape-price'||(view.run.params as {flow?:unknown}).flow!==MARKET_SHAPE_SORFTIME_FLOW_VERSION)throw new MarketExecutionConflictError();
    return {organizationId:actor.organizationId,userId:actor.userId,marketplace:view.run.scope.marketplace,nodeIdPath:view.run.scope.nodeIdPath};
  }
  private read(row:DraftRow|undefined):MarketShapeDraft{
    if(!row)return empty;
    const content=MarketShapeDraftContentSchema.parse(row.content_json);
    if(row.content_hash!==digest(content))throw new MarketExecutionConflictError();
    return {version:row.version,...content,updatedAt:new Date(row.updated_at).toISOString()};
  }
  async find(input:{actor:MarketExecutionActor;moduleRunId:string}){
    const key=await this.identity(input.actor,input.moduleRunId);
    const row=(await this.context.query<DraftRow>('SELECT version,content_json,content_hash,updated_at FROM market_shape_drafts WHERE organization_id=$1 AND user_id=$2 AND marketplace=$3 AND node_id_path=$4',Object.values(key))).rows[0];
    return MarketShapeDraftResponseSchema.parse({draft:this.read(row)});
  }
  async save(input:{actor:MarketExecutionActor;moduleRunId:string;request:unknown;idempotencyKey:string}){
    const request=MarketShapeDraftSaveRequestSchema.parse(input.request),idempotencyKey=uuid.parse(input.idempotencyKey);
    return this.context.transaction(async()=>{
      // Serialize retries before checking the receipt, including a retry racing the first commit.
      await this.context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${input.actor.organizationId}:${input.actor.userId}:${idempotencyKey}`]);
      // Keep the user and run authorization stable for the duration of this write.
      const active=(await this.context.query<{id:string}>("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[input.actor.userId,input.actor.organizationId])).rows[0];
      const run=(await this.context.query<{id:string}>('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[input.moduleRunId,input.actor.organizationId])).rows[0];
      if(!active||!run)throw new MarketExecutionConflictError();
      const key=await this.identity(input.actor,input.moduleRunId);
      const requestHash=digest({key,request});
      const receipt=(await this.context.query<ReceiptRow>('SELECT request_hash,response_json FROM market_shape_draft_receipts WHERE organization_id=$1 AND user_id=$2 AND idempotency_key=$3',[key.organizationId,key.userId,idempotencyKey])).rows[0];
      if(receipt){if(receipt.request_hash!==requestHash)throw new MarketExecutionConflictError();return MarketShapeDraftResponseSchema.parse(receipt.response_json);}
      const content=MarketShapeDraftContentSchema.parse({items:request.items,catalogLabels:request.catalogLabels});
      await this.context.query(`INSERT INTO market_shape_drafts(organization_id,user_id,marketplace,node_id_path,version,content_json,content_hash,updated_at)
        VALUES($1,$2,$3,$4,0,$5::jsonb,$6,clock_timestamp()) ON CONFLICT DO NOTHING`,[...Object.values(key),JSON.stringify({items:[],catalogLabels:[]}),digest({items:[],catalogLabels:[]})]);
      const current=(await this.context.query<DraftRow>('SELECT version,content_json,content_hash,updated_at FROM market_shape_drafts WHERE organization_id=$1 AND user_id=$2 AND marketplace=$3 AND node_id_path=$4 FOR UPDATE',Object.values(key))).rows[0];
      if(!current||this.read(current).version!==request.expectedVersion)throw new MarketExecutionConflictError();
      const updated=(await this.context.query<DraftRow>(`UPDATE market_shape_drafts SET version=version+1,content_json=$5::jsonb,content_hash=$6,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND user_id=$2 AND marketplace=$3 AND node_id_path=$4 RETURNING version,content_json,content_hash,updated_at`,[...Object.values(key),JSON.stringify(content),digest(content)])).rows[0];
      if(!updated)throw new MarketExecutionConflictError();
      const response=MarketShapeDraftResponseSchema.parse({draft:this.read(updated)});
      await this.context.query('INSERT INTO market_shape_draft_receipts(organization_id,user_id,idempotency_key,request_hash,response_json,created_at) VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp())',[key.organizationId,key.userId,idempotencyKey,requestHash,JSON.stringify(response)]);
      return response;
    });
  }
}
