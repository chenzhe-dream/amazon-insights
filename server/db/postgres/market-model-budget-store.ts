import type { Pool } from 'pg';
import { z } from 'zod';
import { MarketModelExecutionAuthoritySchema, type MarketModelExecutionAuthority } from '../../../shared/market-execution-subject';
import type { MarketModelBudgetAuditRepository, MarketModelLedgerUsage, MarketBudgetReservationRecord, ReserveMarketModelBudgetInput, TransitionMarketModelBudgetInput, SettleMarketModelBudgetInput } from '../market-model-budget-repository';
import { AgentRunAttemptSchema } from '../../../shared/agent-contracts';
import { ModelBudgetDataError, ModelBudgetExecutionAuthorityLostError, ModelBudgetReservationConflictError, ModelBudgetReservationNotFoundError, ModelBudgetStateConflictError, type ModelBudgetAmount, type ModelBudgetUsage } from '../model-budget-repository';
import { BudgetExceededError, type BudgetScope } from '../../runtime/budget-policy';
import { StaticModelBudgetLimitProvider } from '../../runtime/model-budget-coordinator';
import { marketBudgetReservationRequestSchema } from '../../runtime/market-model-budget-coordinator';
import { PostgresMarketAgentRunStore } from './market-agent-run-store';
import { PostgresQueryContext } from './query-context';

type Row=Record<string,unknown>;
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amountSchema=z.object({inputTokens:integer,outputTokens:integer,costMicros:integer}).strict().refine(a=>Number.isSafeInteger(a.inputTokens+a.outputTokens));
const transitionSchema=z.object({reservationId:z.string().uuid(),transitionedAt:z.string().datetime(),authority:MarketModelExecutionAuthoritySchema}).strict();
const authorityColumns={organizationId:'organization_id',studyId:'market_study_id',moduleRunId:'market_module_run_id',stepId:'market_step_id',attemptId:'market_attempt_id',agentRunId:'market_agent_run_id',claimToken:'market_claim_token',leaseOwnerId:'market_lease_owner_id',leaseGeneration:'market_lease_generation',dataCutoffAt:'market_data_cutoff_at'} as const;
function iso(value:unknown):string {if(!(value instanceof Date)&&typeof value!=='string')throw new ModelBudgetDataError();return z.string().datetime().parse(new Date(value).toISOString());}
function stored(value:unknown):number {if(typeof value!=='string'&&typeof value!=='number')throw new ModelBudgetDataError();const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new ModelBudgetDataError();return n;}
function amount(row:Row,prefix:'actual'|'projected'):ModelBudgetAmount {return amountSchema.parse({inputTokens:stored(row[`${prefix}_input_tokens`]),outputTokens:stored(row[`${prefix}_output_tokens`]),costMicros:stored(row[`${prefix}_cost_micros`])});}
function map(row:Row):MarketBudgetReservationRecord {
  const nullable=(key:string)=>row[key]===null?null:iso(row[key]);
  return {kind:'market-module-run',id:z.string().uuid().parse(row.id),organizationId:z.string().uuid().parse(row.organization_id),studyId:z.string().uuid().parse(row.market_study_id),moduleRunId:z.string().uuid().parse(row.market_module_run_id),stepId:z.string().uuid().parse(row.market_step_id),attemptId:z.string().uuid().parse(row.market_attempt_id),agentRunId:z.string().uuid().parse(row.market_agent_run_id),
    idempotencyKey:z.string().parse(row.idempotency_key),requestFingerprint:z.string().parse(row.request_fingerprint),utcDay:row.utc_day instanceof Date?row.utc_day.toISOString().slice(0,10):z.string().parse(row.utc_day),state:z.enum(['reserved','dispatched','released','settled']).parse(row.state),projected:amount(row,'projected'),actual:row.state==='settled'?amount(row,'actual'):null,
    leaseExpiresAt:nullable('lease_expires_at'),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),dispatchedAt:nullable('dispatched_at'),settledAt:nullable('settled_at'),releasedAt:nullable('released_at')};
}
function sameAmount(a:ModelBudgetAmount,b:ModelBudgetAmount){return a.inputTokens===b.inputTokens&&a.outputTokens===b.outputTokens&&a.costMicros===b.costMicros;}
function assertIdentity(row:Row,authority:MarketModelExecutionAuthority) {
  for(const [field,column] of Object.entries(authorityColumns)) {
    const actual=field==='dataCutoffAt'?iso(row[column]):row[column];
    if(actual!==authority[field as keyof typeof authority])throw new ModelBudgetExecutionAuthorityLostError();
  }
}
function sum(rows:Row[]):ModelBudgetUsage {
  let tokens=BigInt(0),cost=BigInt(0);
  for(const row of rows){const a=amount(row,row.state==='settled'?'actual':'projected');tokens+=BigInt(a.inputTokens)+BigInt(a.outputTokens);cost+=BigInt(a.costMicros);}
  if(tokens>BigInt(Number.MAX_SAFE_INTEGER)||cost>BigInt(Number.MAX_SAFE_INTEGER))throw new ModelBudgetDataError();
  return {tokens:Number(tokens),costMicros:Number(cost)};
}

/** Both subjects use one physical ledger and admission lock. A late settlement never grants execution authority. */
export class PostgresMarketModelBudgetStore implements MarketModelBudgetAuditRepository {
  readonly #q:PostgresQueryContext;
  readonly #audit:PostgresMarketAgentRunStore;
  constructor(context:Pool|PostgresQueryContext){this.#q=context instanceof PostgresQueryContext?context:new PostgresQueryContext(context);this.#audit=new PostgresMarketAgentRunStore(this.#q);}
  async #execute<T>(fn:()=>Promise<T>):Promise<T>{try{return await this.#q.transaction(fn);}catch(error){
    if(error instanceof BudgetExceededError||error instanceof ModelBudgetDataError||error instanceof ModelBudgetExecutionAuthorityLostError||error instanceof ModelBudgetReservationConflictError||error instanceof ModelBudgetReservationNotFoundError||error instanceof ModelBudgetStateConflictError||error instanceof TypeError||error instanceof z.ZodError)throw error;
    const code=(error as {code?:string})?.code;if(code==='23503'||code==='23505')throw new ModelBudgetReservationConflictError();throw new ModelBudgetDataError();
  }}
  async #active(authority:MarketModelExecutionAuthority){try{await this.#audit.assertAgentRunClaim(authority);}catch{throw new ModelBudgetExecutionAuthorityLostError();}}
  async #now(){return iso((await this.#q.query('SELECT clock_timestamp() AS at')).rows[0].at);}
  async #lock(){await this.#q.query('LOCK TABLE model_budget_reservations IN SHARE ROW EXCLUSIVE MODE');}
  async #expire(){await this.#q.query("UPDATE model_budget_reservations SET state='released',lease_expires_at=NULL,released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE state='reserved' AND lease_expires_at<=clock_timestamp()");}
  async #row(id:string,authority:MarketModelExecutionAuthority){const row=(await this.#q.query<Row>("SELECT *, utc_day::text AS utc_day FROM model_budget_reservations WHERE id=$1 AND subject_kind='market-module-run' FOR UPDATE",[id])).rows[0];if(!row)throw new ModelBudgetReservationNotFoundError();assertIdentity(row,authority);return row;}
  async #readAuthority(a:MarketModelExecutionAuthority){
    const row=(await this.#q.query<Row>('SELECT * FROM market_agent_runs WHERE id=$1',[a.agentRunId])).rows[0];
    if(!row||row.organization_id!==a.organizationId||row.study_id!==a.studyId||row.module_run_id!==a.moduleRunId||row.step_id!==a.stepId||row.attempt_id!==a.attemptId||row.execution_claim_token!==a.claimToken||row.execution_claim_owner_id!==a.leaseOwnerId||row.execution_claim_generation!==a.leaseGeneration||iso(row.data_cutoff_at)!==a.dataCutoffAt)throw new ModelBudgetExecutionAuthorityLostError();
  }
  async #usage(authority:MarketModelExecutionAuthority,now:string){
    const rows=(await this.#q.query<Row>("SELECT *, utc_day::text AS utc_day FROM model_budget_reservations WHERE state<>'released' AND organization_id=$1 AND (market_module_run_id=$2 OR utc_day=$3::date)",[authority.organizationId,authority.moduleRunId,now.slice(0,10)])).rows;
    return {run:sum(rows.filter(r=>r.market_module_run_id===authority.moduleRunId)),organizationUtcDay:sum(rows.filter(r=>(r.utc_day instanceof Date?r.utc_day.toISOString().slice(0,10):r.utc_day)===now.slice(0,10)))};
  }
  async resolveSubject(value:MarketModelExecutionAuthority){return this.#execute(async()=>{const a=MarketModelExecutionAuthoritySchema.parse(value);await this.#active(a);return {organizationId:a.organizationId,studyId:a.studyId,moduleRunId:a.moduleRunId};});}
  async reserve(value:ReserveMarketModelBudgetInput){return this.#execute(async()=>{
    const {id,reservedAt,leaseExpiresAt,limits,...request}=value;
    const i=marketBudgetReservationRequestSchema.parse(request),a=i.authority;z.string().uuid().parse(id);z.string().datetime().parse(reservedAt);z.string().datetime().parse(leaseExpiresAt);
    const ttl=Date.parse(leaseExpiresAt)-Date.parse(reservedAt);if(!Number.isSafeInteger(ttl)||ttl<1||ttl>300_000)throw new TypeError('Invalid market budget lease duration');
    const policy=new StaticModelBudgetLimitProvider(limits).getLimits();
    await this.#active(a);await this.#lock();await this.#expire();const now=await this.#now();
    const existing=(await this.#q.query<Row>("SELECT *, utc_day::text AS utc_day FROM model_budget_reservations WHERE subject_kind='market-module-run' AND market_module_run_id=$1 AND idempotency_key=$2",[a.moduleRunId,i.idempotencyKey])).rows[0];
    if(existing){assertIdentity(existing,a);if(existing.request_fingerprint!==i.requestFingerprint||!sameAmount(amount(existing,'projected'),i.projected)||existing.market_request_ordinal!==i.request.ordinal||existing.market_attempt_kind!==i.request.kind||existing.market_transient_retry_count!==i.request.transientRetryCount||existing.market_format_repair!==i.request.formatRepair)throw new ModelBudgetReservationConflictError();await this.#active(a);return {reservation:map(existing),created:false};}
    const previous=(await this.#q.query<{ordinal:number|null}>('SELECT max(market_request_ordinal) AS ordinal FROM model_budget_reservations WHERE market_agent_run_id=$1',[a.agentRunId])).rows[0].ordinal;
    if(i.request.ordinal!==(previous===null?0:previous+1))throw new ModelBudgetReservationConflictError();
    const usage=await this.#usage(a,now),projected={tokens:i.projected.inputTokens+i.projected.outputTokens,costMicros:i.projected.costMicros};
    for(const [scope,used,limit] of [['call',{tokens:0,costMicros:0},policy.call],['run',usage.run,policy.run],['daily',usage.organizationUtcDay,policy.organizationUtcDay]] as const){
      for(const [metric,max] of [['tokens','maxTokens'],['costMicros','maxCostMicros']] as const)if(BigInt(used[metric])+BigInt(projected[metric])>BigInt(limit[max]))throw new BudgetExceededError(scope as BudgetScope,metric,used[metric],projected[metric],limit[max]);
    }
    const fields:Record<string,unknown>={id,idempotency_key:i.idempotencyKey,request_fingerprint:i.requestFingerprint,subject_kind:a.kind,organization_id:a.organizationId,utc_day:now.slice(0,10),state:'reserved',projected_input_tokens:i.projected.inputTokens,projected_output_tokens:i.projected.outputTokens,projected_cost_micros:i.projected.costMicros,lease_expires_at:new Date(Date.parse(now)+ttl).toISOString(),created_at:now,updated_at:now,
      ...Object.fromEntries(Object.entries(authorityColumns).map(([key,column])=>[column,a[key as keyof typeof a]])),market_request_ordinal:i.request.ordinal,market_attempt_kind:i.request.kind,market_transient_retry_count:i.request.transientRetryCount,market_format_repair:i.request.formatRepair};
    const keys=Object.keys(fields),values=Object.values(fields);
    const row=(await this.#q.query<Row>(`INSERT INTO model_budget_reservations(${keys.join(',')}) VALUES(${keys.map((_,n)=>`$${n+1}`).join(',')}) RETURNING *, utc_day::text AS utc_day`,values)).rows[0];
    await this.#active(a);if(Date.parse(String(map(row).leaseExpiresAt))<=Date.parse(await this.#now()))throw new ModelBudgetExecutionAuthorityLostError();return {reservation:map(row),created:true};
  });}
  async getUsage(value:{authority:MarketModelExecutionAuthority;asOf:string}){return this.#execute(async()=>{
    const a=MarketModelExecutionAuthoritySchema.parse(value.authority);z.string().datetime().parse(value.asOf);
    // Usage remains readable for this exact immutable audit after completion or cancellation.
    await this.#readAuthority(a);
    await this.#lock();await this.#expire();return this.#usage(a,await this.#now());
  });}
  async getAgentUsage(value:MarketModelExecutionAuthority):Promise<MarketModelLedgerUsage>{return this.#execute(async()=>{
    const a=MarketModelExecutionAuthoritySchema.parse(value);await this.#readAuthority(a);
    const rows=(await this.#q.query<Row>("SELECT * FROM model_budget_reservations WHERE subject_kind='market-module-run' AND market_agent_run_id=$1 ORDER BY market_request_ordinal",[a.agentRunId])).rows;
    // All reservations participate in crash recovery; only dispatched requests count as model calls.
    const sent=rows.filter(row=>row.state==='dispatched'||row.state==='settled');
    const complete=sent.length>0&&sent.every(row=>row.state==='settled');
    if(complete)sum(sent);
    const attempts=sent.map((row,index)=>{if(row.market_request_ordinal!==index)throw new ModelBudgetDataError();return AgentRunAttemptSchema.parse({ordinal:row.market_request_ordinal,kind:row.market_attempt_kind,transientRetryCount:row.market_transient_retry_count,formatRepair:row.market_format_repair,accounting:row.state==='settled'?'settled':'projected',errorClassification:'unavailable'});});
    const total=(field:keyof ModelBudgetAmount)=>{if(!complete)return null;const n=sent.reduce((sum,row)=>sum+BigInt(amount(row,'actual')[field]),BigInt(0));if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new ModelBudgetDataError();return Number(n);};
    return {source:'request-ledger',reservationCount:rows.length,usageCompleteness:complete?'complete':sent.some(row=>row.state==='settled')?'partial':'unavailable',inputTokens:total('inputTokens'),outputTokens:total('outputTokens'),estimatedCostMicros:total('costMicros'),responseId:sent.reduce<string|null>((latest,row)=>row.response_id===null?latest:z.string().min(1).max(500).parse(row.response_id),null),attempts};
  });}
  async dispatch(value:TransitionMarketModelBudgetInput){return this.#execute(async()=>{
    const i=transitionSchema.parse(value);await this.#active(i.authority);await this.#lock();await this.#expire();const row=await this.#row(i.reservationId,i.authority);
    if(row.state==='dispatched')return {reservation:map(row),transitioned:false};
    if(row.state==='released')return {reservation:map(row),transitioned:false};
    if(row.state!=='reserved')throw new ModelBudgetStateConflictError();
    const updated=(await this.#q.query<Row>("UPDATE model_budget_reservations SET state='dispatched',lease_expires_at=NULL,dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state='reserved' AND lease_expires_at>clock_timestamp() RETURNING *, utc_day::text AS utc_day",[i.reservationId])).rows[0];
    if(!updated)throw new ModelBudgetExecutionAuthorityLostError();await this.#active(i.authority);return {reservation:map(updated),transitioned:true};
  });}
  async release(value:TransitionMarketModelBudgetInput){return this.#execute(async()=>{
    const i=transitionSchema.parse(value);await this.#lock();const row=await this.#row(i.reservationId,i.authority);
    if(row.state==='released')return {reservation:map(row),transitioned:false};if(row.state!=='reserved')throw new ModelBudgetStateConflictError();
    const updated=(await this.#q.query<Row>("UPDATE model_budget_reservations SET state='released',lease_expires_at=NULL,released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *, utc_day::text AS utc_day",[i.reservationId])).rows[0];return {reservation:map(updated),transitioned:true};
  });}
  async settle(value:SettleMarketModelBudgetInput){return this.#execute(async()=>{
    const {actual:raw,responseId,...rest}=value,i=transitionSchema.parse(rest),actual=amountSchema.parse(raw);if(responseId!==undefined)z.string().min(1).max(500).parse(responseId);
    // Accounting-only: check the original reservation claim, never a replacement worker's claim.
    await this.#lock();const row=await this.#row(i.reservationId,i.authority);
    if(row.state==='settled'){if(!sameAmount(amount(row,'actual'),actual)||row.response_id!==(responseId??null))throw new ModelBudgetReservationConflictError();return {reservation:map(row),transitioned:false};}
    if(row.state!=='dispatched')throw new ModelBudgetStateConflictError();
    const updated=(await this.#q.query<Row>("UPDATE model_budget_reservations SET state='settled',actual_input_tokens=$2,actual_output_tokens=$3,actual_cost_micros=$4,response_id=$5,settled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *, utc_day::text AS utc_day",[i.reservationId,actual.inputTokens,actual.outputTokens,actual.costMicros,responseId??null])).rows[0];return {reservation:map(updated),transitioned:true};
  });}
}
