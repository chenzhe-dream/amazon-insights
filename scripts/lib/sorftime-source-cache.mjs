import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {
  sourceIdentity, cacheTtl, estimateSorftimeCost, assertSourceResponse,
  attachSourceMetadata, SorftimeQuotaError, SorftimeSourceWaitError,
} from './sorftime-source-policy.mjs';
export {sourceIdentity,sourceMetadata,estimateSorftimeCost} from './sorftime-source-policy.mjs';

/** @typedef {{provider?:'sorftime'|'sellerSprite'|'sif', key:string, endpoint:string, tool:string, args:Record<string,any>, jobId?:string|null, signal?:AbortSignal, forceRefresh?:boolean}} SourceRequest */
/** @param {{pool:import('pg').Pool, now?:()=>number}} options */
export function createSorftimeSourceCache({pool,now=Date.now}) {
  async function fresh(client, id) {
    const result=await client.query('SELECT payload,fetched_at FROM sorftime_source_cache WHERE cache_key=$1 AND expires_at>$2',[id,new Date(now())]);
    return result.rows[0];
  }
  async function event(client,identity,spec,kind) {
    await client.query('INSERT INTO sorftime_source_events(cache_key,credential_scope,operation,kind,estimated_units,job_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [identity.id,identity.credentialScope,identity.operation,kind,kind==='dispatch'?estimateSorftimeCost(identity.operation,spec.args):0,spec.jobId??null,new Date(now())]);
  }
  return {
    /** @param {SourceRequest} spec @param {(context:{recordAttempt:()=>Promise<void>})=>Promise<any>} execute */
    async run(spec,execute) {
      const identity=sourceIdentity(spec);
      const cacheable=cacheTtl(spec.tool,{},spec.provider)>0;
      spec.signal?.throwIfAborted();
      const client=await pool.connect();
      // Positive signed bigint advisory key, independent from governor/migration lock namespaces.
      const lock=BigInt('0x'+identity.id.slice(0,15)).toString();
      let locked=false, broken=false;
      try {
        const refresh=spec.jobId?await client.query('SELECT not_before FROM sorftime_source_refresh_scopes WHERE job_id=$1',[spec.jobId]):null;
        const notBefore=refresh?.rows[0]?.not_before;
        const hit=async()=>{
          if(spec.forceRefresh||!cacheable)return null;
          const row=await fresh(client,identity.id);
          if(!row)return null;
          if(notBefore&&new Date(row.fetched_at)<new Date(notBefore))return null;
          await event(client,identity,spec,'hit');
          return attachSourceMetadata(row.payload,{fetchedAt:new Date(row.fetched_at).toISOString(),cacheHit:true,cacheKey:identity.id});
        };
        const cached=await hit(); if(cached)return cached;
        const deadline=Date.now()+60_000;
        while(!locked) {
          spec.signal?.throwIfAborted();
          locked=(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[lock])).rows[0].locked;
          if(!locked) {
            if(Date.now()>=deadline)throw new SorftimeSourceWaitError();
            await delay(30,undefined,{signal:spec.signal});
          }
        }
        spec.signal?.throwIfAborted();
        const afterWait=await hit();if(afterWait)return afterWait;
        const pauses=await client.query('SELECT reason FROM sorftime_source_pauses WHERE pause_key=ANY($1::text[]) AND until_at>$2',
          [[identity.credentialScope,identity.id],new Date(now())]);
        if(pauses.rows.some(r=>r.reason==='quota')) {
          await event(client,identity,spec,'quota-blocked');throw new SorftimeQuotaError(spec.provider);
        }
        if(pauses.rows.length)throw new SorftimeSourceWaitError();
        try {
          const payload=await execute({recordAttempt:async()=>{
            spec.signal?.throwIfAborted();
            // Recheck the credential just before every physical retry as other keys can trip it.
            const paused=await client.query("SELECT 1 FROM sorftime_source_pauses WHERE pause_key=$1 AND reason='quota' AND until_at>$2",[identity.credentialScope,new Date(now())]);
            if(paused.rowCount)throw new SorftimeQuotaError(spec.provider);
            await event(client,identity,spec,'dispatch');
          }});
          assertSourceResponse(payload,spec.provider);
          const fetchedAt=new Date(now()).toISOString(), ttl=cacheTtl(spec.tool,payload,spec.provider);
          if(cacheable)await client.query('INSERT INTO sorftime_source_cache(cache_key,credential_scope,operation,payload,fetched_at,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at',
            [identity.id,identity.credentialScope,identity.operation,JSON.stringify(payload),fetchedAt,new Date(now()+ttl)]);
          return attachSourceMetadata(payload,{fetchedAt,cacheHit:false,cacheKey:identity.id});
        } catch(error) {
          // Local capacity and cancellation are not supplier failures. Preserve
          // their admission/retry information instead of poisoning other consumers.
          let local=Boolean(spec.signal?.aborted), cause=error;
          for(let depth=0;cause&&depth<8;depth++,cause=cause.cause) {
            if(cause.name==='ResourceGovernorAdmissionError'||cause.name==='AbortError')local=true;
          }
          if(local)throw error;
          const quota=error?.kind==='quota'||error?.cause?.kind==='quota';
          await client.query('INSERT INTO sorftime_source_pauses(pause_key,reason,until_at) VALUES($1,$2,$3) ON CONFLICT(pause_key) DO UPDATE SET reason=EXCLUDED.reason,until_at=EXCLUDED.until_at',
            [quota?identity.credentialScope:identity.id,quota?'quota':'failure',new Date(now()+(quota?3600_000:5000))]);
          await event(client,identity,spec,'failed');
          throw error;
        }
      } finally {
        if(locked)try{await client.query('SELECT pg_advisory_unlock($1::bigint)',[lock]);}catch{broken=true;}
        client.release(broken);
      }
    },
    /** @param {SourceRequest[]} requests */
    async estimate(requests) {
      const unique=new Map(requests.map(spec=>[sourceIdentity(spec).id,spec]));
      let hits=0,estimatedUnits=0,unknownCostRequests=0;
      for(const [id,spec] of unique) {
        const row=!spec.forceRefresh&&cacheTtl(spec.tool,{},spec.provider)?await fresh(pool,id):null;
        const refresh=spec.jobId?await pool.query('SELECT not_before FROM sorftime_source_refresh_scopes WHERE job_id=$1',[spec.jobId]):null;
        if(row&&(!refresh?.rows[0]||new Date(row.fetched_at)>=new Date(refresh.rows[0].not_before))){hits++;continue;}
        const units=estimateSorftimeCost(sourceIdentity(spec).operation,spec.args);
        if(units===null)unknownCostRequests++;else estimatedUnits+=units;
      }
      return {requested:requests.length,uniqueRequests:unique.size,cacheHits:hits,networkRequests:unique.size-hits,estimatedUnits,unknownCostRequests,billingConfirmed:false};
    },
    /** Explicit operator action after replenishment, scoped to the credential. */
    async clearQuotaPause(spec) {await pool.query("DELETE FROM sorftime_source_pauses WHERE pause_key=$1 AND reason='quota'",[sourceIdentity(spec).credentialScope]);},
  };
}

const pools=new Map();
/** @param {Readonly<Record<string,string|undefined>>} [env] */
export function sourceCacheFromEnv(env=process.env, provider='sorftime') {
  if((provider==='sorftime'?env.SORFTIME_SOURCE_CACHE_ENABLED:env.SHARED_MCP_SOURCE_CACHE_ENABLED)!=='1')return null;
  if(!env.AGENT_DATABASE_URL)throw new Error('Shared Sorftime cache requires AGENT_DATABASE_URL');
  let cache=pools.get(env.AGENT_DATABASE_URL);
  if(!cache) {
    const pool=new pg.Pool({connectionString:env.AGENT_DATABASE_URL,max:8,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,allowExitOnIdle:true});
    pool.on('error',()=>{}); // Connection loss fails active work; never print credential-bearing connection strings.
    cache=createSorftimeSourceCache({pool});pools.set(env.AGENT_DATABASE_URL,cache);
  }
  return cache;
}
