import { z } from 'zod';
import type { Pool } from 'pg';
import { MarketAnalysisScopeSchema, type MarketAnalysisScope, type MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { createMarketInputSnapshot } from '../../domain/market-research/snapshot';
import { createMarketSourceEvidence } from '../../domain/market-research/source-evidence';
import { canonicalJsonSha256 } from '../../runtime/model-request-accounting';
import { PostgresQueryContext } from './query-context';

type Actor=Readonly<{organizationId:string;userId:string}>;
type FindInput={actor:Actor;studyId:string;id:string};
type SaveInput={actor:Actor;studyId:string;input:unknown;now:string};
type StoredStudy={id:string;scope:MarketAnalysisScope;createdBy:string;createdAt:string};
type StudyRow={id:string;organization_id:string;scope_json:unknown;scope_hash:string;created_by:string;created_at:string|Date};
type DocumentRow={id:string;organization_id:string;study_id:string;document_json:unknown;document_hash:string;stored_by:string;stored_at:string|Date};
type DocumentKind='input'|'source';
const uuid=z.string().uuid();
const timestamp=z.string().datetime();
export class MarketAnalysisStorageError extends Error {constructor(){super('Market research scope is unavailable, conflicting or invalid');}}
function actor(value:Actor):Actor{return {organizationId:uuid.parse(value.organizationId),userId:uuid.parse(value.userId)};}
function date(value:string|Date):string{return timestamp.parse(value instanceof Date?value.toISOString():new Date(value).toISOString());}
function study(row:StudyRow):StoredStudy {
  const scope=MarketAnalysisScopeSchema.parse(row.scope_json);
  if(scope.organizationId!==row.organization_id||scope.researchId!==row.id||canonicalJsonSha256(scope)!==row.scope_hash)throw new MarketAnalysisStorageError();
  return {id:row.id,scope,createdBy:row.created_by,createdAt:date(row.created_at)};
}
function document<T extends {scope:MarketAnalysisScope}>(row:DocumentRow):{id:string;document:T;storedBy:string;storedAt:string} {
  const value=row.document_json as T;
  if(!value||typeof value!=='object'||canonicalJsonSha256(value)!==row.document_hash||value.scope?.organizationId!==row.organization_id||value.scope?.researchId!==row.study_id)throw new MarketAnalysisStorageError();
  return {id:row.id,document:value,storedBy:row.stored_by,storedAt:date(row.stored_at)};
}

/** Isolated market storage; runtime repository/service assembly is a separate handoff step. */
export class PostgresMarketAnalysisSnapshotStore {
  private readonly queries:PostgresQueryContext;
  constructor(context:Pool|PostgresQueryContext){this.queries=context instanceof PostgresQueryContext?context:new PostgresQueryContext(context);}
  private async active(identity:Actor):Promise<boolean>{
    const result=await this.queries.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[identity.userId,identity.organizationId]);
    return !!result.rowCount;
  }
  async createStudy(input:{actor:Actor;scope:unknown;idempotencyKey:string;now:string}):Promise<{study:StoredStudy;created:boolean}>{
    const identity=actor(input.actor),scope=MarketAnalysisScopeSchema.parse(input.scope);
    uuid.parse(input.idempotencyKey);timestamp.parse(input.now);
    if(scope.organizationId!==identity.organizationId||scope.toMonth>=input.now.slice(0,7))throw new MarketAnalysisStorageError();
    const hash=canonicalJsonSha256(scope);
    return this.queries.transaction(async()=>{
      if(!await this.active(identity))throw new MarketAnalysisStorageError();
      const inserted=await this.queries.query<StudyRow>(`INSERT INTO market_analysis_studies(id,organization_id,created_by,idempotency_key,scope_json,scope_hash,created_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,[scope.researchId,identity.organizationId,identity.userId,input.idempotencyKey,JSON.stringify(scope),hash,input.now]);
      if(inserted.rows[0])return {study:study(inserted.rows[0]),created:true};
      const existing=await this.queries.query<StudyRow>('SELECT * FROM market_analysis_studies WHERE organization_id=$1 AND idempotency_key=$2',[identity.organizationId,input.idempotencyKey]);
      if(!existing.rows[0]||existing.rows[0].scope_hash!==hash)throw new MarketAnalysisStorageError();
      return {study:study(existing.rows[0]),created:false};
    });
  }
  async findStudy(input:{actor:Actor;id:string}):Promise<StoredStudy|null>{
    const identity=actor(input.actor);uuid.parse(input.id);
    const result=await this.queries.query<StudyRow>(`SELECT s.* FROM market_analysis_studies s WHERE s.organization_id=$1 AND s.id=$2
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=$3 AND u.organization_id=$1 AND u.status='active')`,[identity.organizationId,input.id,identity.userId]);
    return result.rows[0]?study(result.rows[0]):null;
  }
  private async save(input:SaveInput,kind:DocumentKind){
    const identity=actor(input.actor);uuid.parse(input.studyId);timestamp.parse(input.now);
    const value=kind==='input'?createMarketInputSnapshot(input.input,new Date(input.now)):createMarketSourceEvidence(input.input,new Date(input.now));
    if(value.scope.organizationId!==identity.organizationId||value.scope.researchId!==input.studyId)throw new MarketAnalysisStorageError();
    const hash=canonicalJsonSha256(value);
    const id=kind==='input'?(value as MarketInputSnapshot).snapshotId:`market-source:${hash}`;
    const table=kind==='input'?'market_analysis_inputs':'market_analysis_sources';
    return this.queries.transaction(async()=>{
      if(!await this.active(identity))throw new MarketAnalysisStorageError();
      const research=await this.queries.query<StudyRow>('SELECT * FROM market_analysis_studies WHERE organization_id=$1 AND id=$2',[identity.organizationId,input.studyId]);
      if(!research.rows[0]||canonicalJsonSha256(study(research.rows[0]).scope)!==canonicalJsonSha256(value.scope))throw new MarketAnalysisStorageError();
      const inserted=await this.queries.query<DocumentRow>(`INSERT INTO ${table}(id,organization_id,study_id,stored_by,stored_at,document_json,document_hash)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING RETURNING *`,[id,identity.organizationId,input.studyId,identity.userId,input.now,JSON.stringify(value),hash]);
      const row=inserted.rows[0]??(await this.queries.query<DocumentRow>(`SELECT * FROM ${table} WHERE id=$1 AND organization_id=$2 AND study_id=$3`,[id,identity.organizationId,input.studyId])).rows[0];
      if(!row||row.document_hash!==hash)throw new MarketAnalysisStorageError();
      return {row,created:!!inserted.rows[0]};
    });
  }
  async saveInput(input:SaveInput){
    const saved=await this.save(input,'input');const result=document<MarketInputSnapshot>(saved.row);
    return {snapshot:result.document,storedBy:result.storedBy,storedAt:result.storedAt,created:saved.created};
  }
  async saveSource(input:SaveInput){
    const saved=await this.save(input,'source');const result=document<MarketSourceEvidence>(saved.row);
    return {id:result.id,evidence:result.document,storedBy:result.storedBy,storedAt:result.storedAt,created:saved.created};
  }
  private async find(input:FindInput,kind:DocumentKind):Promise<DocumentRow|null>{
    const identity=actor(input.actor);uuid.parse(input.studyId);
    z.string().regex(kind==='input'?/^market-input:[a-f0-9]{64}$/:/^market-source:[a-f0-9]{64}$/).parse(input.id);
    const table=kind==='input'?'market_analysis_inputs':'market_analysis_sources';
    const result=await this.queries.query<DocumentRow>(`SELECT d.* FROM ${table} d JOIN market_analysis_studies s ON s.id=d.study_id AND s.organization_id=d.organization_id
      WHERE d.organization_id=$1 AND d.study_id=$2 AND d.id=$3
      AND s.scope_json = d.document_json->'scope'
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=$4 AND u.organization_id=$1 AND u.status='active')`,[identity.organizationId,input.studyId,input.id,identity.userId]);
    return result.rows[0]??null;
  }
  async findInput(input:FindInput){const row=await this.find(input,'input');if(!row)return null;const result=document<MarketInputSnapshot>(row);return {snapshot:result.document,storedBy:result.storedBy,storedAt:result.storedAt};}
  async findSource(input:FindInput){const row=await this.find(input,'source');if(!row)return null;const result=document<MarketSourceEvidence>(row);return {id:result.id,evidence:result.document,storedBy:result.storedBy,storedAt:result.storedAt};}
}
