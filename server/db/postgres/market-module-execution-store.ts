import {readMarketOverviewSynthesisReport} from '../../runtime/market-overview-synthesis-report-reader';
import {isMarketShapeExplanationFlow} from '../../domain/market-research/shape-explanation-flow';
import {readMarketShapeExplanationReport} from '../../runtime/market-shape-explanation-report-reader';
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { MarketAnalysisScopeSchema, MarketInputRecordSchema } from "../../../shared/market-analysis-contracts";
import {
  MARKET_MODULE_KINDS, MARKET_STEP_KINDS, MARKET_STEP_ERROR_CODES, MarketExecutionConflictError,
  type MarketModuleExecutionRepository, type MarketModuleRun, type MarketModuleRunView,
  type MarketStepClaim, type MarketStepDefinition, type MarketExecutionStep, type MarketExecutionAttempt,
  type MarketStepSettlementReceipt, type MarketRetryReceipt, type MarketCancelReceipt,
} from "../market-module-execution-repository";
import { canonicalJsonSha256 } from "../../runtime/model-request-accounting";
import { PostgresQueryContext } from "./query-context";
import { PostgresMarketAnalysisSnapshotStore } from "./market-analysis-snapshot-store";
import { isMarketThemeFlow, marketThemeFlowInitialSteps, inspectMarketThemeContinuation } from '../../domain/market-research/customer-theme-flow';
import { loadMarketThemeEvaluationHistory } from './market-theme-evaluation-history';
import { createMarketThemeReport, MarketThemeReportStepInputSchema } from '../../domain/market-research/customer-theme-report';
import { canCompleteMarketThemeRun } from '../../domain/market-research/customer-theme-run-status';
import {isMarketOverviewFlow,marketOverviewFlowInitialSteps} from '../../domain/market-research/overview-flow';
import {isMarketAutomaticFlow,inspectMarketContinuation} from '../../domain/market-research/module-flow';
import {readMarketOverviewReport} from '../../runtime/market-overview-report-reader';

const uuid = z.string().uuid();
const uuid4 = uuid.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
const label = z.string().min(1).max(240).refine(value => value.trim() === value);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const json = MarketInputRecordSchema.shape.data;
const actorSchema = z.object({ organizationId: uuid, userId: uuid }).strict();
const refSchema = z.object({ kind: z.enum(["input", "source", "step-output"]), id: label }).strict();
const stepSchema = z.object({ stepKey:label,kind:z.enum(MARKET_STEP_KINDS),subject:json,input:json,inputRefs:z.array(refSchema).max(2_000) }).strict();
const versionsSchema = z.object({source:label,rule:label,mapping:label,planner:label,model:label.nullable(),prompt:label.nullable(),configuration:label.nullable()}).strict();
const requestSchema = z.object({scope:MarketAnalysisScopeSchema,moduleKind:z.enum(MARKET_MODULE_KINDS),params:json,versions:versionsSchema,collectionRevision:label,initialSteps:z.array(stepSchema).min(1).max(2_000)}).strict();
const createSchema = requestSchema.extend({actor:actorSchema,idempotencyKey:uuid4});
const claimSchema = z.object({organizationId:uuid,studyId:uuid,moduleRunId:uuid4,stepId:uuid4,attemptId:uuid4,createdBy:uuid,leaseOwnerId:uuid4,leaseGeneration:z.number().int().positive(),inputHash:hash,leaseUntil:z.string().datetime(),step:stepSchema}).strict();
const leaseMs = z.number().int().min(10).max(120_000);
const errorSchema = z.object({code:z.enum(MARKET_STEP_ERROR_CODES),retryable:z.boolean()}).strict();
const outcomeSchema = z.union([
  z.object({status:z.enum(["succeeded","empty"]),output:json}).strict(),
  z.object({status:z.literal("failed"),error:errorSchema,diagnostic:json.optional()}).strict(),
]);
const settlementSchema = z.object({claim:claimSchema,outcome:outcomeSchema,sources:z.array(json).max(2_000).default([]),inputs:z.array(json).max(2_000).default([]),children:z.array(stepSchema).max(2_000).default([])}).strict();
const retrySchema = z.object({actor:actorSchema,moduleRunId:uuid4,steps:z.array(z.object({stepId:uuid4,failedAttemptId:uuid4}).strict()).min(1).max(2_000),idempotencyKey:uuid4}).strict();
const cancelSchema = z.object({actor:actorSchema,moduleRunId:uuid4,idempotencyKey:uuid4}).strict();
const receiptSchema = z.object({status:z.literal("committed"),attemptId:uuid4,sourceIds:z.array(label),inputIds:z.array(label),childStepIds:z.array(uuid4)}).strict();
class LeaseLostError extends Error {}
const automaticCodes = new Set(["upstream-temporary","timeout","interrupted"]);
type RunRow={id:string;organization_id:string;study_id:string;created_by:string;request_json:unknown;request_fingerprint:string;status:MarketModuleRun["status"];created_at:Date|string;cancelled_at:Date|string|null;plan_revision:number;latest_report_attempt_id:string|null};
type StepRow={id:string;organization_id:string;study_id:string;run_id:string;definition_json:unknown;input_hash:string;kind:MarketStepDefinition["kind"];status:MarketExecutionStep["status"];attempt_count:number;retry_round:number;round_attempt_count:number;latest_attempt_id:string|null;lease_owner_id:string|null;lease_generation:number;lease_until:Date|string|null};
type AttemptRow={id:string;step_id:string;attempt_number:number;retry_round:number;lease_generation:number;lease_owner_id:string;input_hash:string;status:MarketExecutionAttempt["status"];output_json:MarketExecutionAttempt["output"];error_json:MarketExecutionAttempt["error"];output_hash:string|null;completion_hash:string|null;receipt_json:unknown};
const iso=(date:Date|string)=>new Date(date).toISOString();
function bounded(value:unknown):void {
  const checked=json.safeParse(value);
  if(!checked.success || Buffer.byteLength(JSON.stringify(checked.data),"utf8")>8_000_000)throw new MarketExecutionConflictError();
}
function mapRun(row:RunRow):MarketModuleRun {
  const request=requestSchema.parse(row.request_json);
  if(canonicalJsonSha256(request)!==row.request_fingerprint || request.scope.organizationId!==row.organization_id || request.scope.researchId!==row.study_id)throw new MarketExecutionConflictError();
  return {id:row.id,scope:request.scope,moduleKind:request.moduleKind,params:request.params,versions:request.versions,collectionRevision:request.collectionRevision,requestFingerprint:row.request_fingerprint,status:row.status,createdBy:row.created_by,createdAt:iso(row.created_at),planRevision:row.plan_revision,latestReportAttemptId:row.latest_report_attempt_id};
}
function mapStep(row:StepRow):MarketExecutionStep {
  const definition=stepSchema.parse(row.definition_json);
  if(canonicalJsonSha256(definition)!==row.input_hash)throw new MarketExecutionConflictError();
  return {...definition,id:row.id,inputHash:row.input_hash,status:row.status,attemptCount:row.attempt_count,retryRound:row.retry_round,latestAttemptId:row.latest_attempt_id};
}
function mapAttempt(row:AttemptRow):MarketExecutionAttempt {
  if(row.output_hash!==null && canonicalJsonSha256(row.output_json)!==row.output_hash)throw new MarketExecutionConflictError();
  if((row.status==="succeeded"||row.status==="empty") && row.output_hash===null)throw new MarketExecutionConflictError();
  return {id:row.id,stepId:row.step_id,attemptNumber:row.attempt_number,retryRound:row.retry_round,leaseGeneration:row.lease_generation,status:row.status,output:row.output_json,error:row.error_json};
}

/** Fixed market-step storage only; worker/HTTP/model assembly is a separate layer. */
export class PostgresMarketModuleExecutionStore implements MarketModuleExecutionRepository {
  private readonly queries:PostgresQueryContext;
  constructor(context:Pool|PostgresQueryContext){this.queries=context instanceof PostgresQueryContext?context:new PostgresQueryContext(context);}
  private async active(actor:z.infer<typeof actorSchema>):Promise<boolean>{
    return !!(await this.queries.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[actor.userId,actor.organizationId])).rowCount;
  }
  private async inputRefs(definition:MarketStepDefinition,run:RunRow,completingAttemptId?:string):Promise<void>{
    const seen=new Set<string>();
    for(const ref of definition.inputRefs){
      const key=`${ref.kind}:${ref.id}`;if(seen.has(key))throw new MarketExecutionConflictError();seen.add(key);
      if(ref.kind==="step-output"){
        uuid4.parse(ref.id);
        // The parent's completion and child insertion share this transaction.
        if(ref.id===completingAttemptId)continue;
        const found=await this.queries.query("SELECT id FROM market_analysis_step_attempts WHERE id=$1 AND organization_id=$2 AND run_id=$3 AND status IN ('succeeded','empty')",[ref.id,run.organization_id,run.id]);
        if(!found.rowCount)throw new MarketExecutionConflictError();
      }else{
        if(!new RegExp(`^market-${ref.kind}:[a-f0-9]{64}$`).test(ref.id))throw new MarketExecutionConflictError();
        const snapshots=new PostgresMarketAnalysisSnapshotStore(this.queries);
        const input={actor:{organizationId:run.organization_id,userId:run.created_by},studyId:run.study_id,id:ref.id};
        const found=ref.kind==="input"?await snapshots.findInput(input):await snapshots.findSource(input);
        if(!found)throw new MarketExecutionConflictError();
      }
    }
  }
  private async insertSteps(run:RunRow,definitions:MarketStepDefinition[],parentId:string|null=null,completingAttemptId?:string):Promise<string[]>{
    const keys=new Set<string>(),ids:string[]=[];
    for(const definition of definitions){
      if(keys.has(definition.stepKey))throw new MarketExecutionConflictError();keys.add(definition.stepKey);
      await this.inputRefs(definition,run,completingAttemptId);
      const digest=canonicalJsonSha256(definition);
      const inserted=await this.queries.query<{id:string}>(`INSERT INTO market_analysis_steps(id,organization_id,study_id,run_id,step_key,kind,definition_json,input_hash,status,parent_step_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'queued',$9) ON CONFLICT(run_id,step_key) DO NOTHING RETURNING id`,[randomUUID(),run.organization_id,run.study_id,run.id,definition.stepKey,definition.kind,JSON.stringify(definition),digest,parentId]);
      if(inserted.rows[0])ids.push(inserted.rows[0].id);
      else{
        const existing=await this.queries.query<{id:string;input_hash:string}>("SELECT id,input_hash FROM market_analysis_steps WHERE run_id=$1 AND step_key=$2",[run.id,definition.stepKey]);
        if(existing.rows[0]?.input_hash!==digest)throw new MarketExecutionConflictError();ids.push(existing.rows[0].id);
      }
    }
    return ids;
  }
  async createModuleRun(value:unknown):Promise<{run:MarketModuleRun;created:boolean}>{
    bounded(value);const {actor,idempotencyKey,...request}=createSchema.parse(value);
    request.initialSteps.sort((a,b)=>a.stepKey<b.stepKey?-1:a.stepKey>b.stepKey?1:0);
    if(isMarketThemeFlow(request) && canonicalJsonSha256(request.initialSteps)!==canonicalJsonSha256(marketThemeFlowInitialSteps(request)))throw new MarketExecutionConflictError();
    if(isMarketOverviewFlow(request) && canonicalJsonSha256(request.initialSteps)!==canonicalJsonSha256(marketOverviewFlowInitialSteps(request)))throw new MarketExecutionConflictError();
    const fingerprint=canonicalJsonSha256(request);
    if(actor.organizationId!==request.scope.organizationId)throw new MarketExecutionConflictError();
    return this.queries.transaction(async()=>{
      if(!await this.active(actor))throw new MarketExecutionConflictError();
      const study=await this.queries.query<{scope_json:unknown;complete:boolean}>("SELECT scope_json,(scope_json->>'toMonth')<to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS complete FROM market_analysis_studies WHERE organization_id=$1 AND id=$2",[actor.organizationId,request.scope.researchId]);
      if(!study.rows[0]?.complete || canonicalJsonSha256(study.rows[0].scope_json)!==canonicalJsonSha256(request.scope))throw new MarketExecutionConflictError();
      const command=await this.queries.query<{run_id:string;request_hash:string}>("SELECT run_id,request_hash FROM market_analysis_commands WHERE organization_id=$1 AND kind='create' AND idempotency_key=$2",[actor.organizationId,idempotencyKey]);
      if(command.rows[0]&&command.rows[0].request_hash!==fingerprint)throw new MarketExecutionConflictError();
      const inserted=await this.queries.query<RunRow>(`INSERT INTO market_analysis_module_runs(id,organization_id,study_id,created_by,request_json,request_fingerprint,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,'queued') ON CONFLICT(organization_id,request_fingerprint) DO NOTHING RETURNING *`,[randomUUID(),actor.organizationId,request.scope.researchId,actor.userId,JSON.stringify(request),fingerprint]);
      const row=inserted.rows[0]??(await this.queries.query<RunRow>("SELECT * FROM market_analysis_module_runs WHERE organization_id=$1 AND request_fingerprint=$2",[actor.organizationId,fingerprint])).rows[0];
      if(!row)throw new MarketExecutionConflictError();
      const receipt={moduleRunId:row.id};
      await this.queries.query("INSERT INTO market_analysis_commands(id,organization_id,run_id,actor_id,kind,idempotency_key,request_hash,receipt_json) VALUES($1,$2,$3,$4,'create',$5,$6,$7::jsonb) ON CONFLICT(organization_id,kind,idempotency_key) DO NOTHING",[randomUUID(),actor.organizationId,row.id,actor.userId,idempotencyKey,fingerprint,JSON.stringify(receipt)]);
      const saved=await this.queries.query<{run_id:string;request_hash:string}>("SELECT run_id,request_hash FROM market_analysis_commands WHERE organization_id=$1 AND kind='create' AND idempotency_key=$2",[actor.organizationId,idempotencyKey]);
      if(saved.rows[0]?.run_id!==row.id||saved.rows[0].request_hash!==fingerprint)throw new MarketExecutionConflictError();
      if(inserted.rows[0])await this.insertSteps(row,request.initialSteps);
      return {run:mapRun(row),created:!!inserted.rows[0]};
    });
  }
  async findModuleRun(value:unknown):Promise<MarketModuleRunView|null>{
    const {actor,moduleRunId}=z.object({actor:actorSchema,moduleRunId:uuid4}).strict().parse(value);
    const result=await this.queries.query<RunRow>(`SELECT r.* FROM market_analysis_module_runs r JOIN market_analysis_studies s ON s.id=r.study_id AND s.organization_id=r.organization_id WHERE r.id=$1 AND r.organization_id=$2 AND r.request_json->'scope'=s.scope_json AND EXISTS(SELECT 1 FROM users u WHERE u.id=$3 AND u.organization_id=$2 AND u.status='active')`,[moduleRunId,actor.organizationId,actor.userId]);
    if(!result.rows[0])return null;
    const steps=await this.queries.query<StepRow>("SELECT * FROM market_analysis_steps WHERE run_id=$1 AND organization_id=$2 ORDER BY step_key,id",[moduleRunId,actor.organizationId]);
    const attempts=await this.queries.query<AttemptRow>("SELECT * FROM market_analysis_step_attempts WHERE run_id=$1 AND organization_id=$2 ORDER BY started_at,id",[moduleRunId,actor.organizationId]);
    return {run:mapRun(result.rows[0]),steps:steps.rows.map(mapStep),attempts:attempts.rows.map(mapAttempt)};
  }
  async claimStep(value:unknown):Promise<MarketStepClaim|null>{
    const input=z.object({leaseOwnerId:uuid4,leaseMs,moduleRunId:uuid4.optional(),kinds:z.array(z.enum(MARKET_STEP_KINDS)).min(1).optional(),
      moduleKindsByStepKind:z.partialRecord(z.enum(MARKET_STEP_KINDS),z.array(z.enum(MARKET_MODULE_KINDS)).min(1)).optional(),
      flowVersionsByStepKind:z.partialRecord(z.enum(MARKET_STEP_KINDS),z.array(z.string().min(1).max(240)).min(1).max(20)).optional()}).strict().parse(value);
    return this.queries.transaction(async()=>{
      const candidates=await this.queries.query<RunRow>(`SELECT r.* FROM market_analysis_module_runs r WHERE r.cancelled_at IS NULL AND ($1::uuid IS NULL OR r.id=$1) AND EXISTS(SELECT 1 FROM users u WHERE u.id=r.created_by AND u.organization_id=r.organization_id AND u.status='active') AND EXISTS(SELECT 1 FROM market_analysis_steps s WHERE s.run_id=r.id AND ($2::text[] IS NULL OR s.kind=ANY($2)) AND ($3::jsonb IS NULL OR NOT ($3::jsonb ? s.kind) OR ($3::jsonb -> s.kind) ? (r.request_json->>'moduleKind')) AND ($4::jsonb IS NULL OR NOT ($4::jsonb ? s.kind) OR ($4::jsonb -> s.kind) ? (r.request_json->'params'->>'flow')) AND ((s.status='queued' AND s.next_attempt_at<=clock_timestamp()) OR (s.status='running' AND s.lease_until<=clock_timestamp()))) ORDER BY r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,[input.moduleRunId??null,input.kinds??null,input.moduleKindsByStepKind?JSON.stringify(input.moduleKindsByStepKind):null,input.flowVersionsByStepKind?JSON.stringify(input.flowVersionsByStepKind):null]);
      const run=candidates.rows[0];if(!run)return null;
      mapRun(run);if(!await this.active({organizationId:run.organization_id,userId:run.created_by}))return null;
      const expired=await this.queries.query<StepRow>("SELECT * FROM market_analysis_steps WHERE run_id=$1 AND status='running' AND lease_until<=clock_timestamp() FOR UPDATE",[run.id]);
      for(const row of expired.rows){
        const retry=row.kind!=="model-batch" && row.round_attempt_count<3;
        await this.queries.query("UPDATE market_analysis_step_attempts SET status='interrupted',finished_at=clock_timestamp(),error_json=$2::jsonb WHERE id=$1 AND status='running'",[row.latest_attempt_id,JSON.stringify({code:"interrupted",retryable:true})]);
        await this.queries.query("UPDATE market_analysis_steps SET status=$2,lease_owner_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+($3*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1",[row.id,retry?"queued":"failed",row.round_attempt_count===1?5:30]);
      }
      if(expired.rows.length && isMarketAutomaticFlow(mapRun(run))){
        const current=await this.findModuleRun({actor:{organizationId:run.organization_id,userId:run.created_by},moduleRunId:run.id});
        if(!current)throw new MarketExecutionConflictError();
        const now=(await this.queries.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
        const planned=inspectMarketContinuation(current,now).children;
        if(planned.length){await this.insertSteps(run,planned);await this.queries.query('UPDATE market_analysis_module_runs SET plan_revision=plan_revision+1 WHERE id=$1',[run.id]);}
      }
      const candidate=await this.queries.query<StepRow>("SELECT * FROM market_analysis_steps WHERE run_id=$1 AND status='queued' AND round_attempt_count<3 AND next_attempt_at<=clock_timestamp() AND ($2::text[] IS NULL OR kind=ANY($2)) AND ($3::jsonb IS NULL OR NOT ($3::jsonb ? kind) OR ($3::jsonb -> kind) ? $4::text) AND ($5::jsonb IS NULL OR NOT ($5::jsonb ? kind) OR ($5::jsonb -> kind) ? ($6::jsonb->'params'->>'flow')) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",[run.id,input.kinds??null,input.moduleKindsByStepKind?JSON.stringify(input.moduleKindsByStepKind):null,mapRun(run).moduleKind,input.flowVersionsByStepKind?JSON.stringify(input.flowVersionsByStepKind):null,JSON.stringify(run.request_json)]);
      const step=candidate.rows[0];if(!step){await this.refreshRun(run.id);return null;}
      const definition=mapStep(step),attemptId=randomUUID();
      await this.queries.query("INSERT INTO market_analysis_step_attempts(id,organization_id,study_id,run_id,step_id,attempt_number,retry_round,lease_owner_id,lease_generation,input_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running')",[attemptId,run.organization_id,run.study_id,run.id,step.id,step.attempt_count+1,step.retry_round,input.leaseOwnerId,step.lease_generation+1,step.input_hash]);
      const updated=await this.queries.query<{lease_until:Date}>("UPDATE market_analysis_steps SET status='running',attempt_count=attempt_count+1,round_attempt_count=round_attempt_count+1,lease_owner_id=$2,lease_generation=lease_generation+1,lease_until=clock_timestamp()+($3*interval '1 millisecond'),latest_attempt_id=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING lease_until",[step.id,input.leaseOwnerId,input.leaseMs,attemptId]);
      await this.refreshRun(run.id);
      return {organizationId:run.organization_id,studyId:run.study_id,moduleRunId:run.id,stepId:step.id,attemptId,createdBy:run.created_by,leaseOwnerId:input.leaseOwnerId,leaseGeneration:step.lease_generation+1,inputHash:step.input_hash,leaseUntil:iso(updated.rows[0].lease_until),step:{stepKey:definition.stepKey,kind:definition.kind,subject:definition.subject,input:definition.input,inputRefs:definition.inputRefs}};
    });
  }
  private async refreshRun(id:string):Promise<void>{
    const refreshed=await this.queries.query<RunRow>(`UPDATE market_analysis_module_runs r SET status=CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' WHEN EXISTS(SELECT 1 FROM market_analysis_steps WHERE run_id=r.id AND status='running') THEN 'running' WHEN EXISTS(SELECT 1 FROM market_analysis_steps WHERE run_id=r.id AND status='queued') THEN 'queued' WHEN EXISTS(SELECT 1 FROM market_analysis_steps WHERE run_id=r.id AND status IN ('succeeded','empty')) THEN 'partial' ELSE 'failed' END,updated_at=clock_timestamp() WHERE id=$1 RETURNING r.*`,[id]);
    const run=refreshed.rows[0];
    if(run)await this.completeShapeReport(run);
    if(run?.status==='partial'&&run.latest_report_attempt_id&&isMarketThemeFlow(mapRun(run))){
      const view=await this.findModuleRun({actor:{organizationId:run.organization_id,userId:run.created_by},moduleRunId:id});
      if(view&&canCompleteMarketThemeRun(view,inspectMarketThemeContinuation(view,new Date().toISOString()).currentStepKeys))
        await this.queries.query("UPDATE market_analysis_module_runs SET status='succeeded' WHERE id=$1",[id]);
    }
  }
  private async completeShapeReport(run:RunRow):Promise<void>{
    if(run.status!=='partial'||!run.latest_report_attempt_id||!isMarketShapeExplanationFlow(mapRun(run)))return;
    const view=await this.findModuleRun({actor:{organizationId:run.organization_id,userId:run.created_by},moduleRunId:run.id});if(!view)return;
    const frontier=inspectMarketContinuation(view,new Date().toISOString()),current=new Set(frontier.currentStepKeys);
    const report=view.steps.find(s=>s.kind==='report'&&s.latestAttemptId===run.latest_report_attempt_id&&current.has(s.stepKey));
    if(report?.status==='succeeded'&&!frontier.children.length&&view.steps.filter(s=>current.has(s.stepKey)).every(s=>s.status==='succeeded'))
      await this.queries.query("UPDATE market_analysis_module_runs SET status='succeeded' WHERE id=$1",[run.id]);
  }
  async renewStep(value:unknown):Promise<boolean>{
    bounded(value);const {claim,leaseMs:duration}=z.object({claim:claimSchema,leaseMs}).strict().parse(value);
    if(canonicalJsonSha256(claim.step)!==claim.inputHash)return false;
    return this.queries.transaction(async()=>{
      if(!await this.active({organizationId:claim.organizationId,userId:claim.createdBy}))return false;
      const result=await this.queries.query(`UPDATE market_analysis_steps s SET lease_until=GREATEST(s.lease_until,clock_timestamp()+($9*interval '1 millisecond')),updated_at=clock_timestamp() FROM market_analysis_module_runs r WHERE s.id=$1 AND s.organization_id=$2 AND s.run_id=$3 AND s.latest_attempt_id=$4 AND s.lease_owner_id=$5 AND s.lease_generation=$6 AND s.input_hash=$7 AND s.study_id=$8 AND s.status='running' AND s.lease_until>clock_timestamp() AND r.id=s.run_id AND r.created_by=$10 AND r.cancelled_at IS NULL`,[claim.stepId,claim.organizationId,claim.moduleRunId,claim.attemptId,claim.leaseOwnerId,claim.leaseGeneration,claim.inputHash,claim.studyId,duration,claim.createdBy]);
      return !!result.rowCount;
    });
  }

  async settleAndEnqueue(value:unknown):Promise<MarketStepSettlementReceipt>{
    bounded(value);
    const input=settlementSchema.parse(value),{claim}=input;let outcome=input.outcome;
    const lost:MarketStepSettlementReceipt={status:"lease-lost",attemptId:claim.attemptId,sourceIds:[],inputIds:[],childStepIds:[]};
    if(canonicalJsonSha256(claim.step)!==claim.inputHash)return lost;
    if(outcome.status==="failed" && (input.sources.length||input.inputs.length||input.children.length))throw new MarketExecutionConflictError();
    // A renewal changes leaseUntil but does not change the attempt or its logical completion.
    const {leaseUntil:ignoredDeadline,...identity}=claim;void ignoredDeadline;
    const completionHash=canonicalJsonSha256({...input,claim:identity});
    try {
      return await this.queries.transaction(async()=>{
        const actor={organizationId:claim.organizationId,userId:claim.createdBy};
        if(!await this.active(actor))return lost;
        const result=await this.queries.query<RunRow>("SELECT * FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 AND study_id=$3 AND created_by=$4 FOR UPDATE",[claim.moduleRunId,claim.organizationId,claim.studyId,claim.createdBy]);
        const run=result.rows[0];if(!run)return lost;mapRun(run);
        const attempts=await this.queries.query<AttemptRow>("SELECT * FROM market_analysis_step_attempts WHERE id=$1 AND organization_id=$2 AND run_id=$3 AND step_id=$4 FOR UPDATE",[claim.attemptId,claim.organizationId,run.id,claim.stepId]);
        const attempt=attempts.rows[0];
        if(!attempt||attempt.lease_owner_id!==claim.leaseOwnerId||attempt.lease_generation!==claim.leaseGeneration||attempt.input_hash!==claim.inputHash)return lost;
        if(attempt.completion_hash!==null){
          if(attempt.completion_hash!==completionHash)throw new MarketExecutionConflictError();
          const receipt=receiptSchema.parse(attempt.receipt_json);
          return {...receipt,status:"already-committed"};
        }
        if(run.cancelled_at!==null||attempt.status!=="running")return lost;
        const steps=await this.queries.query<StepRow & {deadline:string;lease_active:boolean}>("SELECT *,lease_until::text AS deadline,lease_until>clock_timestamp() AS lease_active FROM market_analysis_steps WHERE id=$1 AND organization_id=$2 AND run_id=$3 FOR UPDATE",[claim.stepId,claim.organizationId,run.id]);
        const step=steps.rows[0];
        if(!step||!step.lease_active||step.status!=="running"||step.latest_attempt_id!==claim.attemptId||step.lease_owner_id!==claim.leaseOwnerId||step.lease_generation!==claim.leaseGeneration||step.input_hash!==claim.inputHash)return lost;
        mapStep(step);
        const now=(await this.queries.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();
        let accepted=input;
        const automated=isMarketAutomaticFlow(mapRun(run));
        if(automated){
          const current=await this.findModuleRun({actor,moduleRunId:run.id});if(!current)throw new MarketExecutionConflictError();
          if(!inspectMarketContinuation(current,now).currentStepKeys.includes(claim.step.stepKey)){
            // Fence derived work against the current immutable source/model frontier.
            // Paid model audit history is retained by its own transaction; an old
            // attempt cannot publish inputs or fan out children for the new basis.
            outcome={status:'empty',output:{superseded:true,originalStatus:outcome.status}};
            accepted={...input,outcome,sources:[],inputs:[],children:[]};
          }
        }
        const snapshots=new PostgresMarketAnalysisSnapshotStore(this.queries);
        let publishReport=false;
        if(isMarketThemeFlow(mapRun(run)) && step.kind==='report' && outcome.status!=='failed' && !(outcome.output as {superseded?:boolean})?.superseded){
          // Rebuild inside the run lock, before accepting either the attempt or
          // latest pointer. A client cannot publish a forged completion envelope.
          const reportInput=MarketThemeReportStepInputSchema.parse(claim.step.input);
          const basis=await snapshots.findInput({actor,studyId:claim.studyId,id:reportInput.inputSnapshotId});
          const current=await this.findModuleRun({actor,moduleRunId:run.id});
          if(!basis||!current)throw new MarketExecutionConflictError();
          const history=reportInput.basis==='reconciliation-evaluation'?await loadMarketThemeEvaluationHistory(this.queries,actor,current,reportInput.evaluationAttemptId,basis.snapshot):[];
          const report=createMarketThemeReport(current,claim.step,basis.snapshot,history);
          if(canonicalJsonSha256(report)!==canonicalJsonSha256(outcome.output)||outcome.status!==(report.dataReady?'succeeded':'empty')||
            accepted.sources.length||accepted.inputs.length||accepted.children.length)throw new MarketExecutionConflictError();
          publishReport=true;
        }
        if(isMarketOverviewFlow(mapRun(run))&&step.kind==='report'&&outcome.status!=='failed'&&!(outcome.output as {superseded?:boolean})?.superseded){
          const current=await this.findModuleRun({actor,moduleRunId:run.id});if(!current)throw new MarketExecutionConflictError();
          const reader=(claim.step.input as {phase?:string}).phase==='overview-synthesis-report'?readMarketOverviewSynthesisReport:readMarketOverviewReport;
          const {report}=await reader(this.queries,current,claim.step,new AbortController().signal);
          if(canonicalJsonSha256(report)!==canonicalJsonSha256(outcome.output)||outcome.status!==(report.dataReady?'succeeded':'empty')||accepted.sources.length||accepted.inputs.length||accepted.children.length)throw new MarketExecutionConflictError();
          publishReport=true;
        }
        if(isMarketShapeExplanationFlow(mapRun(run))&&step.kind==='report'&&outcome.status!=='failed'&&!(outcome.output as {superseded?:boolean})?.superseded){
          const current=await this.findModuleRun({actor,moduleRunId:run.id});if(!current)throw new MarketExecutionConflictError();
          const {report}=await readMarketShapeExplanationReport(this.queries,current,claim.step,new AbortController().signal);
          if(canonicalJsonSha256(report)!==canonicalJsonSha256(outcome.output)||outcome.status!=='succeeded'||accepted.sources.length||accepted.inputs.length||accepted.children.length)throw new MarketExecutionConflictError();
          publishReport=true;
        }
        const sourceIds:string[]=[],inputIds:string[]=[];
        for(const source of accepted.sources){
          const saved=await snapshots.saveSource({actor,studyId:claim.studyId,input:source,now});sourceIds.push(saved.id);
        }
        for(const snapshot of accepted.inputs){
          const saved=await snapshots.saveInput({actor,studyId:claim.studyId,input:snapshot,now});inputIds.push(saved.snapshot.snapshotId);
        }
        const childStepIds=await this.insertSteps(run,accepted.children,step.id,claim.attemptId);
        const retry=outcome.status==="failed"&&outcome.error.retryable&&automaticCodes.has(outcome.error.code)&&step.kind!=="model-batch"&&step.round_attempt_count<3;
        if(automated){
          const current=await this.findModuleRun({actor,moduleRunId:run.id});if(!current)throw new MarketExecutionConflictError();
          current.steps=current.steps.map(s=>s.id===step.id?{...s,status:retry?'queued':outcome.status}:s);
          current.attempts=current.attempts.map(a=>a.id===claim.attemptId?{...a,status:outcome.status,output:outcome.status==='failed'?null:outcome.output,error:outcome.status==='failed'?outcome.error:null}:a);
          childStepIds.push(...await this.insertSteps(run,inspectMarketContinuation(current,now).children,step.id,claim.attemptId));
        }
        const receipt:MarketStepSettlementReceipt={status:"committed",attemptId:claim.attemptId,sourceIds,inputIds,childStepIds};
        const output=outcome.status==="failed"?null:outcome.output;
        const error=outcome.status==="failed"?outcome.error:null;
        const diagnostic=outcome.status==="failed"?(outcome.diagnostic??null):null;
        await this.queries.query("UPDATE market_analysis_step_attempts SET status=$2,output_json=$3::jsonb,output_hash=$4,error_json=$5::jsonb,diagnostic_json=$6::jsonb,completion_hash=$7,receipt_json=$8::jsonb,finished_at=clock_timestamp() WHERE id=$1",[claim.attemptId,outcome.status,JSON.stringify(output),outcome.status==="failed"?null:canonicalJsonSha256(output),JSON.stringify(error),JSON.stringify(diagnostic),completionHash,JSON.stringify(receipt)]);
        await this.queries.query("UPDATE market_analysis_steps SET status=$2,lease_owner_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+($3*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1",[step.id,retry?"queued":outcome.status,step.round_attempt_count===1?5:30]);
        if(publishReport)await this.queries.query('UPDATE market_analysis_module_runs SET latest_report_attempt_id=$2 WHERE id=$1',[run.id,claim.attemptId]);
        if(childStepIds.length)await this.queries.query("UPDATE market_analysis_module_runs SET plan_revision=plan_revision+1 WHERE id=$1",[run.id]);
        await this.refreshRun(run.id);
        // Throwing here rolls back snapshots, children, output and terminal state together.
        const valid=await this.queries.query<{valid:boolean}>("SELECT clock_timestamp()<$1::timestamptz AS valid",[step.deadline]);
        if(!valid.rows[0].valid)throw new LeaseLostError();
        return receipt;
      });
    }catch(error){if(error instanceof LeaseLostError)return lost;throw error;}
  }

  private async commandRun(actor:z.infer<typeof actorSchema>,moduleRunId:string):Promise<RunRow>{
    if(!await this.active(actor))throw new MarketExecutionConflictError();
    const found=await this.queries.query<RunRow>("SELECT * FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE",[moduleRunId,actor.organizationId]);
    if(!found.rows[0])throw new MarketExecutionConflictError();mapRun(found.rows[0]);return found.rows[0];
  }
  private async previousCommand(actor:z.infer<typeof actorSchema>,runId:string,kind:"retry-failed"|"cancel",key:string,digest:string):Promise<unknown|undefined>{
    const found=await this.queries.query<{run_id:string;request_hash:string;receipt_json:unknown}>("SELECT run_id,request_hash,receipt_json FROM market_analysis_commands WHERE organization_id=$1 AND kind=$2 AND idempotency_key=$3",[actor.organizationId,kind,key]);
    const row=found.rows[0];if(!row)return undefined;
    if(row.run_id!==runId||row.request_hash!==digest)throw new MarketExecutionConflictError();
    return row.receipt_json;
  }
  private async saveCommand(actor:z.infer<typeof actorSchema>,runId:string,kind:"retry-failed"|"cancel",key:string,digest:string,receipt:MarketRetryReceipt|MarketCancelReceipt):Promise<void>{
    await this.queries.query("INSERT INTO market_analysis_commands(id,organization_id,run_id,actor_id,kind,idempotency_key,request_hash,receipt_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(organization_id,kind,idempotency_key) DO NOTHING",[randomUUID(),actor.organizationId,runId,actor.userId,kind,key,digest,JSON.stringify(receipt)]);
    // A competing command on a different run may share the organization-wide key.
    await this.previousCommand(actor,runId,kind,key,digest);
  }
  async retryFailedSteps(value:unknown):Promise<MarketRetryReceipt>{
    bounded(value);const {actor,moduleRunId,steps,idempotencyKey}=retrySchema.parse(value);
    steps.sort((a,b)=>a.stepId<b.stepId?-1:a.stepId>b.stepId?1:0);
    if(new Set(steps.map(s=>s.stepId)).size!==steps.length)throw new MarketExecutionConflictError();
    const digest=canonicalJsonSha256({moduleRunId,steps});
    return this.queries.transaction(async()=>{
      const run=await this.commandRun(actor,moduleRunId);
      const previous=await this.previousCommand(actor,run.id,"retry-failed",idempotencyKey,digest);
      if(previous!==undefined)return z.object({moduleRunId:uuid4,stepIds:z.array(uuid4)}).strict().parse(previous);
      if(run.cancelled_at!==null)throw new MarketExecutionConflictError();
      for(const selected of steps){
        const found=await this.queries.query<StepRow>("SELECT * FROM market_analysis_steps WHERE id=$1 AND run_id=$2 AND organization_id=$3 FOR UPDATE",[selected.stepId,run.id,actor.organizationId]);
        const row=found.rows[0];
        if(!row||row.status!=="failed"||row.latest_attempt_id!==selected.failedAttemptId)throw new MarketExecutionConflictError();
        await this.queries.query("UPDATE market_analysis_steps SET status='queued',retry_round=retry_round+1,round_attempt_count=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[row.id]);
      }
      const receipt:MarketRetryReceipt={moduleRunId:run.id,stepIds:steps.map(s=>s.stepId)};
      await this.saveCommand(actor,run.id,"retry-failed",idempotencyKey,digest,receipt);
      await this.refreshRun(run.id);return receipt;
    });
  }
  async cancelModuleRun(value:unknown):Promise<MarketCancelReceipt>{
    bounded(value);const {actor,moduleRunId,idempotencyKey}=cancelSchema.parse(value);
    const digest=canonicalJsonSha256({moduleRunId});
    return this.queries.transaction(async()=>{
      const run=await this.commandRun(actor,moduleRunId);
      const previous=await this.previousCommand(actor,run.id,"cancel",idempotencyKey,digest);
      if(previous!==undefined)return z.object({moduleRunId:uuid4,cancelled:z.literal(true)}).strict().parse(previous);
      if(run.cancelled_at===null){
        await this.queries.query("UPDATE market_analysis_step_attempts SET status='cancelled',error_json=$2::jsonb,finished_at=clock_timestamp() WHERE run_id=$1 AND status='running'",[run.id,JSON.stringify({code:"cancelled",retryable:false})]);
        await this.queries.query("UPDATE market_analysis_steps SET status='cancelled',lease_generation=lease_generation+CASE WHEN status='running' THEN 1 ELSE 0 END,lease_owner_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE run_id=$1 AND status IN ('queued','running')",[run.id]);
        await this.queries.query("UPDATE market_analysis_module_runs SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[run.id]);
      }
      const receipt:MarketCancelReceipt={moduleRunId:run.id,cancelled:true};
      await this.saveCommand(actor,run.id,"cancel",idempotencyKey,digest,receipt);return receipt;
    });
  }
}
