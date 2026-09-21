import type {UsageAnalyticsRepository} from "../usage-analytics-repository";
import {PostgresQueryContext} from "./query-context";
import {UsageBatchSchema,USAGE_MAX_AGE_MS,usageEmptyMetrics,type UsageBatch,type UsageScope,type UsageQuery,type UsageEvent,type UsageReport,type UsagePerson} from "../../../shared/usage-analytics-contracts";
import {aggregateUsageEvents,beijingDate,usageRange} from "../../services/usage-analytics-service";
export class UsageStoreError extends Error { constructor(public statusCode:number,message:string){super(message)} }
const iso=(value:unknown)=>value?new Date(String(value)).toISOString():null;
export class PostgresUsageAnalyticsStore implements UsageAnalyticsRepository {
  constructor(private readonly db:PostgresQueryContext){}
  async ingest(scope:UsageScope,input:UsageBatch,receivedAt:string){
    const batch=UsageBatchSchema.parse(input),now=Date.parse(receivedAt);
    if(batch.accountKey!==JSON.stringify([scope.organizationId,scope.userId]))throw new UsageStoreError(400,"USAGE_ACCOUNT_CHANGED");
    if(Date.parse(batch.observedAt)>now+60_000)throw new UsageStoreError(400,"USAGE_TIME_OUT_OF_RANGE");
    const times=batch.events.flatMap(e=>e.kind==="duration"?[e.startedAt,e.endedAt]:[e.at]);
    if(times.some(t=>Date.parse(t)>now+60_000||Date.parse(t)<now-USAGE_MAX_AGE_MS))throw new UsageStoreError(400,"USAGE_TIME_OUT_OF_RANGE");
    return this.db.transaction(async()=>{
      const session=await this.db.query(
        "SELECT u.id, EXISTS(SELECT 1 FROM auth_identities a WHERE a.user_id=u.id AND a.provider='dingtalk') AS bound FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.id=$2 AND u.organization_id=$3 AND u.status='active' AND s.revoked_at IS NULL AND s.expires_at>$4::timestamptz FOR UPDATE OF s",
        [scope.sessionId,scope.userId,scope.organizationId,receivedAt]);
      if(!session.rowCount)throw new UsageStoreError(401,"AUTHENTICATION_REQUIRED");
      if(!session.rows[0].bound)return null;
      await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[scope.organizationId+":"+scope.userId]);
      const payload=batch.events.map(e=>({event_id:e.eventId,page_key:e.pageKey,occurred_at:e.kind==="duration"?e.startedAt:e.at,ended_at:e.kind==="duration"?e.endedAt:e.at,payload:e}));
      const inserted=await this.db.query(
        "INSERT INTO usage_events(organization_id,user_id,session_id,event_id,tab_id,page_key,occurred_at,ended_at,payload,received_at) SELECT $1,$2,$3,x.event_id,$4,x.page_key,x.occurred_at,x.ended_at,x.payload,$5::timestamptz FROM jsonb_to_recordset($6::jsonb) AS x(event_id text,page_key text,occurred_at timestamptz,ended_at timestamptz,payload jsonb) ON CONFLICT DO NOTHING RETURNING event_id",
        [scope.organizationId,scope.userId,scope.sessionId,batch.tabId,receivedAt,JSON.stringify(payload)]);
      const conflict=await this.db.query(
        "SELECT 1 FROM usage_events e JOIN jsonb_to_recordset($3::jsonb) AS x(event_id text,payload jsonb) ON e.event_id=x.event_id WHERE e.organization_id=$1 AND e.user_id=$2 AND e.payload<>x.payload LIMIT 1",
        [scope.organizationId,scope.userId,JSON.stringify(payload)]);
      if(conflict.rowCount)throw new UsageStoreError(409,"USAGE_EVENT_CONFLICT");
      if(inserted.rowCount){
        const days=[...new Set(aggregateUsageEvents(batch.events).map(r=>r.day))];
        for(const day of days){
          const range=usageRange({period:"day",date:day});
          const raw=await this.db.query("SELECT payload FROM usage_events WHERE organization_id=$1 AND user_id=$2 AND occurred_at >= $3::timestamptz - interval '10 minutes' AND occurred_at<$4::timestamptz AND ended_at >= $3::timestamptz",[scope.organizationId,scope.userId,range.start,range.end]);
          const daily=aggregateUsageEvents(raw.rows.map(r=>r.payload as UsageEvent)).filter(r=>r.day===day);
          await this.db.query(
            "INSERT INTO usage_daily_stats(organization_id,user_id,day,scope,page_key,visits,clicks,visible_ms,active_ms,last_activity_at,updated_at) SELECT $1,$2,x.day::date,x.scope,x.page_key,x.visits,x.clicks,x.visible_ms,x.active_ms,x.last_activity_at,$3::timestamptz FROM jsonb_to_recordset($4::jsonb) AS x(day text,scope text,page_key text,visits bigint,clicks bigint,visible_ms bigint,active_ms bigint,last_activity_at timestamptz) ON CONFLICT(organization_id,user_id,day,scope,page_key) DO UPDATE SET visits=EXCLUDED.visits,clicks=EXCLUDED.clicks,visible_ms=EXCLUDED.visible_ms,active_ms=EXCLUDED.active_ms,last_activity_at=EXCLUDED.last_activity_at,updated_at=EXCLUDED.updated_at",
            [scope.organizationId,scope.userId,receivedAt,JSON.stringify(daily.map(r=>({day:r.day,scope:r.scope,page_key:r.pageKey,visits:r.visits,clicks:r.clicks,visible_ms:r.visibleMs,active_ms:r.activeMs,last_activity_at:r.lastActivityAt})))]);
        }
      }
      const observed=new Date(Math.min(now,Date.parse(batch.observedAt))).toISOString();
      await this.db.query("UPDATE sessions SET last_seen_at=GREATEST(last_seen_at,$2::timestamptz) WHERE id=$1",[scope.sessionId,observed]);
      return{acknowledgedEventIds:batch.events.map(e=>e.eventId),receivedAt};
    });
  }
  async searchPeople(organizationId:string,q:string,limit:number){
    // strpos treats % and _ literally; all parameters stay bound.
    const result=await this.db.query("SELECT u.id,u.display_name FROM users u JOIN auth_identities a ON a.user_id=u.id AND a.provider='dingtalk' WHERE u.organization_id=$1 AND (strpos(lower(u.display_name),lower($2))>0 OR strpos(lower(u.id),lower($2))>0) ORDER BY lower(u.display_name),u.id LIMIT $3",[organizationId,q.trim(),limit+1]);
    return{people:result.rows.slice(0,limit).map(r=>({userId:r.id,displayName:r.display_name,personLabel:r.id,bindingStatus:"dingtalk" as const})),hasMore:result.rows.length>limit};
  }
  async report(organizationId:string,query:UsageQuery,asOf:string):Promise<UsageReport>{
    const range=usageRange(query);
    const users=await this.db.query("SELECT u.id,u.display_name,(SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id=u.id) AS last_activity_at,(SELECT e.page_key FROM usage_events e WHERE e.organization_id=$1 AND e.user_id=u.id ORDER BY e.occurred_at DESC LIMIT 1) AS last_page_key FROM users u JOIN auth_identities a ON a.user_id=u.id AND a.provider='dingtalk' WHERE u.organization_id=$1 AND ($2::text IS NULL OR u.id=$2) ORDER BY lower(u.display_name),u.id",[organizationId,query.userId??null]);
    const stats=await this.db.query("SELECT d.* FROM usage_daily_stats d JOIN users u ON u.id=d.user_id AND u.organization_id=d.organization_id JOIN auth_identities a ON a.user_id=u.id AND a.provider='dingtalk' WHERE d.organization_id=$1 AND d.day >= $2::date AND d.day < $3::date AND ($4::text IS NULL OR d.user_id=$4) AND ($5::text IS NULL OR (d.scope='page' AND d.page_key=$5))",[organizationId,beijingDate(Date.parse(range.start)),beijingDate(Date.parse(range.end)),query.userId??null,query.pageKey??null]);
    const started=await this.db.query("SELECT applied_at FROM schema_migrations WHERE name='usage_analytics'");
    const totals={...usageEmptyMetrics(),userCount:0};
    const people=users.rows.map(r=>({...usageEmptyMetrics(),userId:r.id,displayName:r.display_name,personLabel:r.id,bindingStatus:"dingtalk" as const,lastActivityAt:iso(r.last_activity_at),lastPageKey:r.last_page_key??null}));
    const peopleMap=new Map(people.map(p=>[p.userId,p]));
    const pages=new Map<string,UsageReport["pages"][number]&{ids:Set<string>}>();
    for(const r of stats.rows){
      const values={visits:Number(r.visits),clicks:Number(r.clicks),visibleMs:Number(r.visible_ms),activeMs:Number(r.active_ms)};
      if(r.scope==="user"||query.pageKey){const user=peopleMap.get(r.user_id);if(user)for(const k of ["visits","clicks","visibleMs","activeMs"] as const)user[k]+=values[k]}
      if(r.scope==="page"){
        if(!pages.has(r.page_key))pages.set(r.page_key,{...usageEmptyMetrics(),pageKey:r.page_key,userCount:0,ids:new Set()});
        const page=pages.get(r.page_key)!;for(const k of ["visits","clicks","visibleMs","activeMs"] as const)page[k]+=values[k];
        if(values.visits||values.clicks||values.visibleMs)page.ids.add(r.user_id);
      }
    }
    for(const person of people){for(const k of ["visits","clicks","visibleMs","activeMs"] as const)totals[k]+=person[k];if(person.visits||person.clicks||person.visibleMs)totals.userCount++}
    return{range,asOf,timeZone:"Asia/Shanghai",collectionStartedAt:iso(started.rows[0]?.applied_at),totals,users:people,pages:[...pages.values()].map(({ids,...page})=>({...page,userCount:ids.size}))};
  }
}
