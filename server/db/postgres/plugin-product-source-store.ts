import {z} from 'zod';
import {PluginCategoryPoolSourceSchema,type PluginCategoryPoolSource} from '../../../shared/plugin-category-pool-contracts';
import {
  PluginCollectionSourceSchema, PluginWorkerJobSchema, PluginSiteSchema,
  type PluginWorkerJob,
} from '../../../shared/plugin-collection-contracts';
import {canonicalJsonSha256} from '../../runtime/model-request-accounting';
import type {PostgresQueryContext} from './query-context';
import {PluginSavedSourceScopeSchema,type PluginSavedSource} from '../../../shared/plugin-saved-source-contracts';

type PluginSource = z.infer<typeof PluginCollectionSourceSchema>;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const timestamp = z.string().datetime({offset:true});
const lookupSchema = z.object({
  organizationId:z.string().min(1).max(200), userId:z.string().min(1).max(200),
  marketplace:PluginSiteSchema, asin:z.string().regex(/^[A-Z0-9]{10}$/),
  now:z.date().optional(), notBefore:timestamp.optional(),
});
export const PluginProductSourceRecordSchema = z.object({
  snapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/), jobId:z.string().uuid(), node:z.string().regex(/^\d+$/),
  marketplace:PluginSiteSchema, asin:z.string().regex(/^[A-Z0-9]{10}$/), collectedAt:timestamp,
  basic:z.record(z.string(),z.unknown()), history:z.record(z.string(),z.unknown()),
});
export type PluginProductSourceRecord = Readonly<z.infer<typeof PluginProductSourceRecordSchema>>;
interface SnapshotRow {
  snapshot_id:string; job_id:string; organization_id:string; user_id:string; node:string;
  marketplace:string; collected_at:Date; source:unknown; content_sha256:string;
}

function assertIdentity(value:Record<string,unknown>, expected:Record<string,string>) {
  for (const [key, identity] of Object.entries(expected)) {
    if (Object.hasOwn(value,key) && value[key] !== identity) throw new TypeError(`Plugin source ${key} identity mismatch`);
  }
}
function validatedSource(raw:PluginSource, job:Pick<PluginWorkerJob,'id'|'organizationId'|'userId'|'node'>):PluginSource {
  // Validate optional explicit ownership before Zod strips unknown transport fields.
  assertIdentity(raw as unknown as Record<string,unknown>,{
    jobId:job.id, organizationId:job.organizationId, userId:job.userId, node:job.node,
  });
  canonicalJsonSha256(raw); // Reject undefined, NaN, cycles and other lossy JSON values.
  const source = PluginCollectionSourceSchema.parse(raw);
  for (const map of [source.basic,source.history]) {
    for (const [asin,row] of Object.entries(map)) {
      assertIdentity(row,{asin,site:source.site,marketplace:source.site,amz_site:source.site});
    }
  }
  return source;
}
function contentHash(job:Pick<PluginWorkerJob,'id'|'organizationId'|'userId'|'node'>, source:PluginSource) {
  // Job progress may advance after collection; it is not part of source identity.
  return canonicalJsonSha256({jobId:job.id,organizationId:job.organizationId,userId:job.userId,node:job.node,source});
}
function freezeDeep<T>(value:T):T {
  if(value && typeof value === 'object') {
    for(const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export class PostgresPluginProductSourceStore {
  constructor(private readonly context:PostgresQueryContext) {}

  /** Historical inventory only. Does not renew freshness or depend on a collection worker. */
  async listSavedSources(input:{organizationId:string;userId:string;site:string;node:string}):Promise<PluginSavedSource[]>{
    const {site,node}=PluginSavedSourceScopeSchema.parse({site:input.site,node:input.node});
    const rows=await this.context.query<{snapshot_id:string}>(`SELECT snapshot_id FROM plugin_product_source_snapshots
      WHERE organization_id=$1 AND user_id=$2 AND marketplace=$3 AND node=$4
      ORDER BY collected_at DESC, imported_at DESC, snapshot_id DESC LIMIT 20`,[input.organizationId,input.userId,site,node]);
    const sources:PluginSavedSource[]=[];
    for(const row of rows.rows){
      const saved=await this.findSnapshot({...input,snapshotId:row.snapshot_id});
      if(!saved||saved.source.frozenCohort||saved.source.site!==site||saved.source.node!==node)continue;
      const count=(records:Record<string,Record<string,unknown>>)=>saved.source.asins.filter(asin=>Object.keys(records[asin]??{}).length>0).length;
      sources.push({snapshotId:saved.snapshotId,jobId:saved.jobId,site,node,collectedAt:saved.source.collectedAt,products:saved.source.asins.length,basicRecords:count(saved.source.basic),historyRecords:count(saved.source.history)});
    }
    return sources;
  }

  /** Read immutable report evidence by its binding, without cache freshness fallback. */
  async findSnapshot(input:{organizationId:string;userId:string;snapshotId:string}):Promise<Readonly<{snapshotId:string;jobId:string;source:PluginSource}>|null>{
    const parsed=z.object({organizationId:z.string().min(1),userId:z.string().min(1),snapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/)}).safeParse(input);
    if(!parsed.success)return null;
    const {organizationId,userId,snapshotId}=parsed.data;
    const result=await this.context.query<SnapshotRow>('SELECT * FROM plugin_product_source_snapshots WHERE snapshot_id=$1 AND organization_id=$2 AND user_id=$3',[snapshotId,organizationId,userId]);
    const row=result.rows[0];if(!row)return null;
    try{
      const job={id:row.job_id,organizationId:row.organization_id,userId:row.user_id,node:row.node},source=validatedSource(row.source as PluginSource,job);
      if(row.content_sha256!==contentHash(job,source)||row.snapshot_id!==`plugin-source:${row.content_sha256}`||canonicalJsonSha256(row.source)!==canonicalJsonSha256(source)||source.site!==row.marketplace||Date.parse(source.collectedAt)!==new Date(row.collected_at).getTime())return null;
      return freezeDeep({snapshotId:row.snapshot_id,jobId:row.job_id,source});
    }catch{return null;}
  }

  async findCategoryPool(input:{organizationId:string;userId:string;marketplace:string;node:string;poolSize:number;savedOnly?:boolean;now?:Date;notBefore?:string}):Promise<PluginCategoryPoolSource|null>{
    const parsed=lookupSchema.omit({asin:true}).extend({savedOnly:z.boolean().optional(),node:z.string().regex(/^\d+$/),poolSize:z.number().int().min(1).max(150)}).safeParse(input);
    if(!parsed.success)return null;
    const scope=parsed.data,now=scope.now??new Date(),oldest=new Date(Math.max(('savedOnly' in scope && scope.savedOnly ? 0 : now.getTime()-MAX_AGE_MS),scope.notBefore?Date.parse(scope.notBefore):-Infinity));
    const rows=await this.context.query<SnapshotRow>(`SELECT * FROM plugin_product_source_snapshots
      WHERE organization_id=$1 AND user_id=$2 AND marketplace=$3 AND node=$4
       AND collected_at >= $5 AND collected_at <= $6
      ORDER BY collected_at DESC,imported_at DESC,snapshot_id DESC`,[scope.organizationId,scope.userId,scope.marketplace,scope.node,oldest,now]);
    for(const row of rows.rows){
      try{
        const job={id:row.job_id,organizationId:row.organization_id,userId:row.user_id,node:row.node},source=validatedSource(row.source as PluginSource,job);
        if(source.frozenCohort||row.content_sha256!==contentHash(job,source)||row.snapshot_id!==`plugin-source:${row.content_sha256}`||canonicalJsonSha256(row.source)!==canonicalJsonSha256(source)||source.site!==row.marketplace||Date.parse(source.collectedAt)!==new Date(row.collected_at).getTime())continue;
        const discovery=source.summary.discovery as {provider?:unknown}|undefined;
        const membershipProvider=discovery?.provider==='amazon-page'||discovery?.provider==='sorftime'?discovery.provider:'unknown';
        return freezeDeep(PluginCategoryPoolSourceSchema.parse({snapshotId:row.snapshot_id,jobId:row.job_id,node:row.node,marketplace:source.site,collectedAt:source.collectedAt,asins:source.asins,basic:source.basic,membershipProvider}));
      }catch{/* Corrupt snapshots cannot become a category membership source. */}
    }
    return null;
  }

  async importSnapshot(input:{job:PluginWorkerJob;source:PluginSource}):Promise<Readonly<{snapshotId:string}>> {
    const job=PluginWorkerJobSchema.parse(input.job);
    // Zod unknown values retain object references. Detach the full source before
    // the first await so caller mutations cannot change immutable evidence.
    const source=JSON.parse(JSON.stringify(validatedSource(input.source,job))) as PluginSource;
    if(source.site!==(job.site??'US'))throw new TypeError('Plugin job and source site mismatch');
    if(Date.parse(source.collectedAt)>Date.now()) throw new TypeError('Plugin collection time is in the future');
    const hash=contentHash(job,source);
    return this.context.transaction(async () => {
      const inserted=await this.context.query<{snapshot_id:string}>(`
        INSERT INTO plugin_product_source_snapshots
          (snapshot_id,job_id,organization_id,user_id,node,marketplace,collected_at,source,content_sha256)
        VALUES ($1,$2,$3,$4,$5,$9,$6,$7::jsonb,$8)
        ON CONFLICT (job_id) DO NOTHING RETURNING snapshot_id`,
      [`plugin-source:${hash}`,job.id,job.organizationId,job.userId,job.node,source.collectedAt,JSON.stringify(source),hash,source.site]);
      if(inserted.rows[0]) return Object.freeze({snapshotId:inserted.rows[0].snapshot_id});
      const existing=await this.context.query<SnapshotRow>(
        'SELECT * FROM plugin_product_source_snapshots WHERE job_id = $1',[job.id]);
      const row=existing.rows[0];
      if(!row || row.content_sha256!==hash || row.organization_id!==job.organizationId || row.user_id!==job.userId || row.node!==job.node || canonicalJsonSha256(row.source)!==canonicalJsonSha256(source)) {
        throw new Error('Plugin source immutable snapshot conflict');
      }
      return Object.freeze({snapshotId:row.snapshot_id});
    });
  }

  async findProduct(input:{organizationId:string;userId:string;marketplace:string;asin:string;now?:Date;notBefore?:string}):Promise<PluginProductSourceRecord|null> {
    const parsed=lookupSchema.safeParse(input);
    if(!parsed.success) return null;
    const scope=parsed.data, now=scope.now??new Date();
    const oldest=new Date(Math.max(('savedOnly' in scope && scope.savedOnly ? 0 : now.getTime()-MAX_AGE_MS),scope.notBefore?Date.parse(scope.notBefore):-Infinity));
    const rows=await this.context.query<SnapshotRow>(`
      SELECT * FROM plugin_product_source_snapshots
      WHERE organization_id=$1 AND user_id=$2 AND marketplace=$3
        AND collected_at >= $4 AND collected_at <= $5
        AND jsonb_typeof(source->'basic'->$6) = 'object'
        AND source->'basic'->$6 <> '{}'::jsonb
      ORDER BY collected_at DESC, imported_at DESC, snapshot_id DESC`,
    [scope.organizationId,scope.userId,scope.marketplace,oldest,now,scope.asin]);
    for(const row of rows.rows) {
      try {
        const job={id:row.job_id,organizationId:row.organization_id,userId:row.user_id,node:row.node};
        const source=validatedSource(row.source as PluginSource,job);
        if(row.content_sha256!==contentHash(job,source) || row.snapshot_id!==`plugin-source:${row.content_sha256}` || canonicalJsonSha256(row.source)!==canonicalJsonSha256(source) || source.site!==row.marketplace || Date.parse(source.collectedAt)!==new Date(row.collected_at).getTime()) continue;
        const basic=source.basic[scope.asin];
        if(!source.asins.includes(scope.asin)||!basic||Object.keys(basic).length===0) continue;
        return freezeDeep(PluginProductSourceRecordSchema.parse({
          snapshotId:row.snapshot_id,jobId:row.job_id,node:row.node,marketplace:source.site,
          asin:scope.asin,collectedAt:source.collectedAt,basic,history:source.history[scope.asin]??{},
        }));
      } catch {
        // Corrupt evidence is never reusable; another older valid snapshot may be.
      }
    }
    return null;
  }
}
