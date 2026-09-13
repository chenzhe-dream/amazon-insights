import {loadMarketOverviewSynthesisEvidenceWithSourceReport} from '../../services/market-overview-synthesis-input-service';
import {loadMarketShapeSynthesisEvidence} from '../../services/market-shape-synthesis-input-service';
import {loadMarketShapeExplanationCatalog} from '../../services/market-shape-explanation-input-service';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AgentRunAttemptSchema, AgentRunTerminalMetadataSchema, ApiErrorSchema, EntityIdSchema } from '../../../shared/agent-contracts';
import { MarketInputRecordSchema, type MarketJsonValue } from '../../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { MarketExecutionSubjectSchema, MarketModelExecutionAuthoritySchema, type MarketExecutionSubject, type MarketModelExecutionAuthority } from '../../../shared/market-execution-subject';
import { MarketSemanticTaskNameSchema, type MarketSemanticRecord } from '../../../shared/market-semantic-contracts';
import { validateMarketSemanticInput } from '../../domain/market-research/semantic-validation';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { summarizeContent } from '../../runtime/redaction';
import type { RegisterSkillVersionInput, FinalizeAgentRunOutcome } from '../agent-run-repository';
import { MarketAgentRunConflictError, type MarketAgentRunRepository, type MarketAgentRunRecord, type MarketSemanticSnapshotBinding, type MarketAuditReadScope, type BeginMarketAgentRunInput } from '../market-agent-run-repository';
import { PostgresAgentRunStore } from './agent-run-store';
import { PostgresMarketAnalysisSnapshotStore } from './market-analysis-snapshot-store';
import { PostgresQueryContext } from './query-context';

type Row = Record<string, unknown>;
type OverviewSynthesisRestoration = Awaited<ReturnType<typeof loadMarketOverviewSynthesisEvidenceWithSourceReport>>;
const uuid = EntityIdSchema, hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(240), json = MarketInputRecordSchema.shape.data;
const actorSchema = z.object({ organizationId: uuid, userId: uuid }).strict();
const readSchema = z.object({ actor: actorSchema, studyId: uuid, moduleRunId: uuid }).strict();
const ttl = z.number().int().min(100).max(1_200_000);
const bindingSchema = z.object({ id: uuid, subject: MarketExecutionSubjectSchema, inputSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/),
  inputProjection: json, memberRefs: z.array(text).min(1).max(2_000), sourceRefs: z.array(text).max(2_000), selectionRevision: text, batchKey: text }).strict();
const skillSchema = z.object({ id: text, version: z.string().regex(/^\d+\.\d+\.\d+$/), contentHash: hash }).strict();
const beginSchema = z.object({ id: uuid, subject: MarketExecutionSubjectSchema, task: MarketSemanticTaskNameSchema, bindingId: uuid,
  skillVersionId: text, skill: skillSchema, inputSchema: text, outputSchema: text, executionFingerprint: hash, outputSchemaDigest: hash,
  provider: text, model: text, claimToken: uuid, claimTtlMs: ttl }).strict();
const number = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const outcomeSchema = z.object({ terminalStatus: z.enum(['succeeded','failed','budget-exceeded','cancelled']), validationStatus: z.enum(['passed','failed']),
  responseId: z.string().min(1).max(500).nullable(), output: z.record(z.string(), json).nullable(), error: ApiErrorSchema.nullable(),
  inputTokens: number.nullable(), outputTokens: number.nullable(), estimatedCostMicros: number.nullable(), durationMs: number.nullable(),
  attemptCount: z.number().int().min(0).max(4), usageCompleteness: z.enum(['complete','partial','unavailable']),
  attempts: z.array(AgentRunAttemptSchema).max(4), terminalMetadata: AgentRunTerminalMetadataSchema }).strict().superRefine((v, ctx) => {
    if (v.attemptCount !== v.attempts.length || v.attempts.some((a, i) => a.ordinal !== i) ||
      (v.inputTokens !== null && v.outputTokens !== null && !Number.isSafeInteger(v.inputTokens + v.outputTokens)) ||
      (v.terminalStatus === 'succeeded') !== (v.validationStatus === 'passed' && v.output !== null && v.error === null) ||
      (v.terminalStatus !== 'succeeded' && (v.output !== null || v.validationStatus !== 'failed')) || v.terminalMetadata.kind !== v.terminalStatus ||
      (v.usageCompleteness === 'complete' && [v.inputTokens,v.outputTokens,v.estimatedCostMicros].some(x => x === null))) {
      ctx.addIssue({code:'custom',message:'Inconsistent market model terminal accounting'});
    }
  });
function bounded(value: unknown): void { const result=json.safeParse(value); if(!result.success || Buffer.byteLength(JSON.stringify(result.data),'utf8')>8_000_000) throw new MarketAgentRunConflictError(); }
function same(a: unknown,b: unknown): void { if(digest(a)!==digest(b))throw new MarketAgentRunConflictError(); }
function iso(value: unknown): string { if(!(value instanceof Date)&&typeof value!=='string')throw new MarketAgentRunConflictError();return z.string().datetime().parse(new Date(value).toISOString()); }
function freeze<T>(value:T):T { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
function nativeIdentity(subject:MarketExecutionSubject,row:Row):void {
  if(row.organization_id!==subject.organizationId||row.study_id!==subject.studyId||row.module_run_id!==subject.moduleRunId||row.step_id!==subject.stepId||row.attempt_id!==subject.attemptId||iso(row.data_cutoff_at)!==subject.dataCutoffAt)throw new MarketAgentRunConflictError();
}
function mapAudit(row:Row):MarketAgentRunRecord {
  bounded(row.begin_identity_json); const identity=row.begin_identity_json as Omit<BeginMarketAgentRunInput,'id'|'claimToken'|'claimTtlMs'>;
  const outcome=row.outcome_json===null?null:outcomeSchema.parse(row.outcome_json);
  if(outcome && digest(outcome)!==row.outcome_hash)throw new MarketAgentRunConflictError();
  const record:MarketAgentRunRecord={schemaVersion:'market-agent-run/v1',id:uuid.parse(row.id),organizationId:uuid.parse(row.organization_id),studyId:uuid.parse(row.study_id),
    moduleRunId:uuid.parse(row.module_run_id),stepId:uuid.parse(row.step_id),attemptId:uuid.parse(row.attempt_id),bindingId:uuid.parse(row.binding_id),snapshotIds:[uuid.parse(row.binding_id)],
    task:MarketSemanticTaskNameSchema.parse(row.task),skillVersionId:text.parse(row.skill_version_id),skill:skillSchema.parse(identity.skill),
    executionFingerprint:hash.parse(row.execution_fingerprint),outputSchemaDigest:hash.parse(row.output_schema_digest),provider:text.parse(row.provider),model:text.parse(row.model),
    outputSchemaVersion:text.parse(row.output_schema_version),inputSummary:z.object({contentHash:hash,recordCount:number}).strict().parse(row.input_summary_json),
    dataCutoffAt:iso(row.data_cutoff_at),startedAt:iso(row.started_at),completedAt:row.completed_at===null?null:iso(row.completed_at),
    validationStatus:z.enum(['pending','passed','failed']).parse(row.validation_status),terminalStatus:outcome?.terminalStatus??null,outcome,
    claim:{token:uuid.parse(row.execution_claim_token),ownerId:uuid.parse(row.execution_claim_owner_id),generation:number.min(1).parse(row.execution_claim_generation),acquiredAt:iso(row.execution_claim_acquired_at),expiresAt:iso(row.execution_claim_expires_at)}};
  nativeIdentity(identity.subject,row);
  if((record.validationStatus==='pending')!==(outcome===null)||record.terminalStatus!==row.terminal_status)throw new MarketAgentRunConflictError();
  return freeze(record);
}

export class PostgresMarketAgentRunStore implements MarketAgentRunRepository {
  readonly #q:PostgresQueryContext;
  constructor(context:Pool|PostgresQueryContext){this.#q=context instanceof PostgresQueryContext?context:new PostgresQueryContext(context);}
  registerSkillVersion(input:RegisterSkillVersionInput){return new PostgresAgentRunStore(this.#q).registerSkillVersion(input);}
  async #execute<T>(callback:()=>Promise<T>):Promise<T>{try{return await callback();}catch{throw new MarketAgentRunConflictError();}}
  async #active(subject:MarketExecutionSubject) {
    const run=(await this.#q.query<Row>('SELECT * FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 AND study_id=$3 FOR UPDATE',[subject.moduleRunId,subject.organizationId,subject.studyId])).rows[0];
    if(!run||run.cancelled_at!==null)throw new MarketAgentRunConflictError();
    const actor={organizationId:subject.organizationId,userId:uuid.parse(run.created_by)};
    if(!(await this.#q.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[actor.userId,actor.organizationId])).rowCount)throw new MarketAgentRunConflictError();
    const study=await new PostgresMarketAnalysisSnapshotStore(this.#q).findStudy({actor,id:subject.studyId}); if(!study)throw new MarketAgentRunConflictError();
    bounded(run.request_json);const request=run.request_json as {scope:unknown};same(request.scope,study.scope);if(digest(request)!==run.request_fingerprint)throw new MarketAgentRunConflictError();
    const step=(await this.#q.query<Row>(`SELECT s.*,a.input_hash AS attempt_input_hash FROM market_analysis_steps s JOIN market_analysis_step_attempts a ON a.id=s.latest_attempt_id AND a.step_id=s.id AND a.run_id=s.run_id AND a.organization_id=s.organization_id
      WHERE s.id=$1 AND s.run_id=$2 AND s.organization_id=$3 AND s.study_id=$4 AND a.id=$5 AND s.status='running' AND a.status='running'
        AND s.lease_owner_id=$6 AND a.lease_owner_id=$6 AND s.lease_generation=$7 AND a.lease_generation=$7 AND s.lease_until>clock_timestamp()
        AND $8::timestamptz<=clock_timestamp() FOR UPDATE OF s,a`,[subject.stepId,subject.moduleRunId,subject.organizationId,subject.studyId,subject.attemptId,subject.leaseOwnerId,subject.leaseGeneration,subject.dataCutoffAt])).rows[0];
    if(!step||step.input_hash!==step.attempt_input_hash||digest(step.definition_json)!==step.input_hash)throw new MarketAgentRunConflictError();
    return {actor,study,step};
  }
  async #readActor(scope:MarketAuditReadScope):Promise<boolean>{return !!(await this.#q.query("SELECT u.id FROM users u JOIN market_analysis_module_runs r ON r.organization_id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2 AND u.status='active' AND r.id=$3 AND r.study_id=$4",[scope.actor.userId,scope.actor.organizationId,scope.moduleRunId,scope.studyId])).rowCount;}
  async #binding(row:Row,actor:MarketAuditReadScope['actor'],session?:{shapeExplanationCatalog?:Awaited<ReturnType<typeof loadMarketShapeExplanationCatalog>>;sources:Map<string,Awaited<ReturnType<PostgresMarketAnalysisSnapshotStore['findSource']>>>;signal?:AbortSignal;onOverviewSynthesisRestored?:(restored:OverviewSynthesisRestoration)=>void}):Promise<MarketSemanticSnapshotBinding>{
    session?.signal?.throwIfAborted();
    const snapshots=new PostgresMarketAnalysisSnapshotStore(this.#q),studyId=uuid.parse(row.study_id),moduleRunId=uuid.parse(row.module_run_id);
    const inputSnapshotId=text.parse(row.input_snapshot_id),saved=await snapshots.findInput({actor,studyId,id:inputSnapshotId});if(!saved)throw new MarketAgentRunConflictError();
    const sourceRefs=z.array(text).max(2_000).parse(row.source_refs_json),memberRefs=z.array(text).min(1).max(2_000).parse(row.member_refs_json);
    // Binding validation also runs inside the caller's single-connection transaction.
    const sources=[];for(const id of sourceRefs){session?.signal?.throwIfAborted();let source=session?.sources.get(id);if(source===undefined){source=await snapshots.findSource({actor,studyId,id});session?.sources.set(id,source);}session?.signal?.throwIfAborted();if(!source)throw new MarketAgentRunConflictError();sources.push(source);}
    const sourceCatalog=Object.fromEntries(saved.snapshot.records.map(record=>[record.id,(record.data as {semantic:MarketSemanticRecord}).semantic]));
    const shapeExplanationCatalog=row.task==='market-shape-structure-explanation'?(session?.shapeExplanationCatalog??await loadMarketShapeExplanationCatalog(this.#q,actor,moduleRunId)):undefined;
    const overviewSynthesisRestored=row.task==='market-overview-synthesis'?await loadMarketOverviewSynthesisEvidenceWithSourceReport(this.#q,actor,moduleRunId,inputSnapshotId,session?.signal):undefined;
    const synthesisEvidence=overviewSynthesisRestored?.evidence??(row.task==='market-shape-synthesis'?await loadMarketShapeSynthesisEvidence(this.#q,actor,moduleRunId,inputSnapshotId):{});
    session?.signal?.throwIfAborted();
    const projection=validateMarketSemanticInput(row.input_json,{...(shapeExplanationCatalog?{shapeExplanationCatalog}:{}),...synthesisEvidence,scope:saved.snapshot.scope,inputSnapshot:saved.snapshot,sourceEvidenceByRef:Object.fromEntries(sources.map(source=>[source!.id,source!.evidence])),
      selectionRevision:text.parse(row.selection_revision),batchKey:text.parse(row.batch_key),inputDigest:hash.parse(row.input_digest),expectedIds:memberRefs,sourceCatalog});
    if(projection.task!==row.task||projection.dataCutoffAt!==iso(row.data_cutoff_at))throw new MarketAgentRunConflictError();
    same(projection.sourceRefs,sourceRefs);
    const binding=freeze({id:uuid.parse(row.id),organizationId:uuid.parse(row.organization_id),studyId,moduleRunId,inputSnapshotId,inputDigest:projection.inputDigest,
      selectionRevision:projection.selectionRevision,batchKey:projection.batchKey,task:projection.task,inputProjection:projection as MarketJsonValue,memberRefs,sourceRefs,dataCutoffAt:projection.dataCutoffAt,createdAt:iso(row.created_at)});
    session?.signal?.throwIfAborted();
    if(overviewSynthesisRestored)session?.onOverviewSynthesisRestored?.(overviewSynthesisRestored);
    return binding;
  }
  async saveSnapshotBinding(value:unknown){return this.#execute(async()=>{
    bounded(value);const input=bindingSchema.parse(value);
    return this.#q.transaction(async()=>{
      const active=await this.#active(input.subject);if(!['prepare-model-batches','model-batch'].includes(String(active.step.kind)))throw new MarketAgentRunConflictError();
      const projection=input.inputProjection as Record<string,MarketJsonValue>,{inputDigest,...body}=projection;
      if(inputDigest!==digest(body)||projection.dataCutoffAt!==input.subject.dataCutoffAt)throw new MarketAgentRunConflictError();
      const now=(await this.#q.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
      const row:Row={id:input.id,organization_id:input.subject.organizationId,study_id:input.subject.studyId,module_run_id:input.subject.moduleRunId,input_snapshot_id:input.inputSnapshotId,
        input_digest:inputDigest,selection_revision:input.selectionRevision,batch_key:input.batchKey,task:projection.task,input_json:projection,source_refs_json:input.sourceRefs,member_refs_json:input.memberRefs,data_cutoff_at:input.subject.dataCutoffAt,created_at:now};
      await this.#binding(row,active.actor);
      const inserted=await this.#q.query<Row>(`INSERT INTO market_analysis_semantic_snapshot_bindings(id,organization_id,study_id,module_run_id,input_snapshot_id,input_digest,selection_revision,batch_key,task,input_json,source_refs_json,member_refs_json,data_cutoff_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13) ON CONFLICT DO NOTHING RETURNING *`,[input.id,input.subject.organizationId,input.subject.studyId,input.subject.moduleRunId,input.inputSnapshotId,inputDigest,input.selectionRevision,input.batchKey,projection.task,JSON.stringify(projection),JSON.stringify(input.sourceRefs),JSON.stringify(input.memberRefs),input.subject.dataCutoffAt]);
      const stored=inserted.rows[0]??(await this.#q.query<Row>('SELECT * FROM market_analysis_semantic_snapshot_bindings WHERE module_run_id=$1 AND batch_key=$2 AND input_digest=$3',[input.subject.moduleRunId,input.batchKey,inputDigest])).rows[0];
      if(!stored)throw new MarketAgentRunConflictError();
      const binding=await this.#binding(stored,active.actor);same(binding.inputProjection,projection);same(binding.memberRefs,input.memberRefs);same(binding.sourceRefs,input.sourceRefs);
      await this.#active(input.subject);return {binding,created:!!inserted.rows[0]};
    });
  });}
  async findSnapshotBinding(value:unknown){return this.#execute(async()=>{
    const input=readSchema.extend({bindingId:uuid}).parse(value);if(!await this.#readActor(input))return null;
    const row=(await this.#q.query<Row>('SELECT * FROM market_analysis_semantic_snapshot_bindings WHERE id=$1 AND organization_id=$2 AND study_id=$3 AND module_run_id=$4',[input.bindingId,input.actor.organizationId,input.studyId,input.moduleRunId])).rows[0];
    return row?this.#binding(row,input.actor):null;
  });}
  async findShapeWindowBindings(value:unknown){return this.#execute(async()=>{
    const input=readSchema.extend({bindingIds:z.array(uuid).min(1).max(2_000)}).parse(value);
    if(new Set(input.bindingIds).size!==input.bindingIds.length)throw new MarketAgentRunConflictError();
    return this.#q.transaction(async()=>{
      const lock=await this.#q.query(`SELECT r.id FROM market_analysis_module_runs r JOIN users u ON u.id=$3 AND u.organization_id=r.organization_id AND u.status='active'
        WHERE r.id=$1 AND r.organization_id=$2 AND r.study_id=$4 FOR SHARE OF r`,[input.moduleRunId,input.actor.organizationId,input.actor.userId,input.studyId]);
      if(lock.rowCount!==1||!await this.#readActor(input))throw new MarketAgentRunConflictError();
      const rows=(await this.#q.query<Row>(`SELECT * FROM market_analysis_semantic_snapshot_bindings WHERE organization_id=$1 AND study_id=$2 AND module_run_id=$3
        AND id=ANY($4::uuid[])`,[input.actor.organizationId,input.studyId,input.moduleRunId,input.bindingIds])).rows;
      if(rows.length!==input.bindingIds.length||rows.some(row=>row.task!=='market-shape-structure-explanation'))throw new MarketAgentRunConflictError();
      const byId=new Map(rows.map(row=>[uuid.parse(row.id),row]));if(byId.size!==rows.length||input.bindingIds.some(id=>!byId.has(id)))throw new MarketAgentRunConflictError();
      const session={shapeExplanationCatalog:await loadMarketShapeExplanationCatalog(this.#q,input.actor,input.moduleRunId),sources:new Map<string,Awaited<ReturnType<PostgresMarketAnalysisSnapshotStore['findSource']>>>()};
      const bindings=[];for(const id of input.bindingIds)bindings.push(await this.#binding(byId.get(id)!,input.actor,session));return bindings;
    });
  });}
  async findOverviewSynthesisBinding(value:unknown,signal?:AbortSignal):Promise<({binding:MarketSemanticSnapshotBinding}&OverviewSynthesisRestoration)|null>{return this.#execute(async()=>{
    signal?.throwIfAborted();const input=readSchema.extend({bindingId:uuid}).parse(value);
    return this.#q.transaction(async()=>{
      const lock=await this.#q.query(`SELECT r.id FROM market_analysis_module_runs r JOIN users u ON u.id=$3 AND u.organization_id=r.organization_id AND u.status='active'
        WHERE r.id=$1 AND r.organization_id=$2 AND r.study_id=$4 FOR SHARE OF r,u`,[input.moduleRunId,input.actor.organizationId,input.actor.userId,input.studyId]);
      signal?.throwIfAborted();if(lock.rowCount!==1||!await this.#readActor(input))return null;
      const row=(await this.#q.query<Row>('SELECT * FROM market_analysis_semantic_snapshot_bindings WHERE id=$1 AND organization_id=$2 AND study_id=$3 AND module_run_id=$4',[input.bindingId,input.actor.organizationId,input.studyId,input.moduleRunId])).rows[0];
      signal?.throwIfAborted();if(!row)return null;if(row.task!=='market-overview-synthesis')throw new MarketAgentRunConflictError();
      // Capture only this binding's successfully validated restoration, never caller evidence.
      const capture:{restored?:OverviewSynthesisRestoration}={};
      const binding=await this.#binding(row,input.actor,{sources:new Map(),signal,onOverviewSynthesisRestored:value=>{capture.restored=value;}});
      const restored=capture.restored;
      signal?.throwIfAborted();if(!restored)throw new MarketAgentRunConflictError();
      return freeze({binding,evidence:restored.evidence,sourceReport:restored.sourceReport});
    });
  });}
  async findOverviewWindowBindings(value:unknown,signal?:AbortSignal):Promise<{bindings:MarketSemanticSnapshotBinding[];sourceEvidenceByRef:Record<string,MarketSourceEvidence>}>{return this.#execute(async()=>{
    signal?.throwIfAborted();
    const input=readSchema.extend({bindingIds:z.array(uuid).min(1).max(2_000)}).parse(value);
    if(new Set(input.bindingIds).size!==input.bindingIds.length)throw new MarketAgentRunConflictError();
    return this.#q.transaction(async()=>{
      const lock=await this.#q.query(`SELECT r.id FROM market_analysis_module_runs r JOIN users u ON u.id=$3 AND u.organization_id=r.organization_id AND u.status='active'
        WHERE r.id=$1 AND r.organization_id=$2 AND r.study_id=$4 FOR SHARE OF r,u`,[input.moduleRunId,input.actor.organizationId,input.actor.userId,input.studyId]);
      if(lock.rowCount!==1||!await this.#readActor(input))throw new MarketAgentRunConflictError();
      const rows=(await this.#q.query<Row>(`SELECT * FROM market_analysis_semantic_snapshot_bindings WHERE organization_id=$1 AND study_id=$2 AND module_run_id=$3
        AND id=ANY($4::uuid[])`,[input.actor.organizationId,input.studyId,input.moduleRunId,input.bindingIds])).rows;
      if(rows.length!==input.bindingIds.length||rows.some(row=>row.task!=='market-overview-explanation'))throw new MarketAgentRunConflictError();
      const byId=new Map(rows.map(row=>[uuid.parse(row.id),row]));if(byId.size!==rows.length||input.bindingIds.some(id=>!byId.has(id)))throw new MarketAgentRunConflictError();
      // The immutable documents are shared only after findSource validates their hashes.
      // Both the actor and run stay locked for this transaction; each input still replays.
      const session={sources:new Map<string,Awaited<ReturnType<PostgresMarketAnalysisSnapshotStore['findSource']>>>(),signal};
      const bindings:MarketSemanticSnapshotBinding[]=[];
      for(const id of input.bindingIds){signal?.throwIfAborted();bindings.push(await this.#binding(byId.get(id)!,input.actor,session));signal?.throwIfAborted();}
      const sourceEvidenceByRef:Record<string,MarketSourceEvidence>={};
      for(const [id,source] of session.sources){if(!source)throw new MarketAgentRunConflictError();sourceEvidenceByRef[id]=source.evidence;}
      return freeze({bindings,sourceEvidenceByRef});
    });
  });}
  async beginAgentRun(value:unknown){return this.#execute(async()=>{
    bounded(value);const input=beginSchema.parse(value),{id,claimToken,claimTtlMs,...identity}=input;
    return this.#q.transaction(async()=>{
      const active=await this.#active(input.subject);if(active.step.kind!=='model-batch')throw new MarketAgentRunConflictError();
      const binding=await this.findSnapshotBinding({actor:active.actor,studyId:input.subject.studyId,moduleRunId:input.subject.moduleRunId,bindingId:input.bindingId});
      if(!binding||binding.task!==input.task||binding.dataCutoffAt!==input.subject.dataCutoffAt)throw new MarketAgentRunConflictError();
      const step=active.step.definition_json as {input:unknown;inputRefs:Array<{kind:string;id:string}>};same(step.input,{task:input.task,bindingId:binding.id,inputDigest:binding.inputDigest});
      if(!step.inputRefs.some(ref=>ref.kind==='input'&&ref.id===binding.inputSnapshotId))throw new MarketAgentRunConflictError();
      const skill=(await this.#q.query<Row>('SELECT * FROM skill_versions WHERE id=$1',[input.skillVersionId])).rows[0];
      if(!skill)throw new MarketAgentRunConflictError();same({id:skill.skill_id,version:skill.version,contentHash:skill.content_hash},input.skill);
      const manifest=skill.manifest_json as {inputSchema:string;outputSchema:string};if(manifest.inputSchema!==input.inputSchema||manifest.outputSchema!==input.outputSchema)throw new MarketAgentRunConflictError();
      const version=input.outputSchema.split('@')[1];if(!version)throw new MarketAgentRunConflictError();
      const inserted=await this.#q.query<Row>(`INSERT INTO market_agent_runs(id,organization_id,study_id,module_run_id,step_id,attempt_id,binding_id,skill_version_id,task,begin_identity_json,input_summary_json,execution_fingerprint,output_schema_digest,provider,model,output_schema_version,data_cutoff_at,execution_claim_token,execution_claim_owner_id,execution_claim_generation,execution_claim_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,clock_timestamp()+($21*interval '1 millisecond')) ON CONFLICT(attempt_id) DO NOTHING RETURNING *`,[id,input.subject.organizationId,input.subject.studyId,input.subject.moduleRunId,input.subject.stepId,input.subject.attemptId,input.bindingId,input.skillVersionId,input.task,JSON.stringify(identity),JSON.stringify(summarizeContent(binding.inputProjection)),input.executionFingerprint,input.outputSchemaDigest,input.provider,input.model,version,input.subject.dataCutoffAt,claimToken,input.subject.leaseOwnerId,input.subject.leaseGeneration,claimTtlMs]);
      const stored=inserted.rows[0]??(await this.#q.query<Row>('SELECT * FROM market_agent_runs WHERE attempt_id=$1 FOR UPDATE',[input.subject.attemptId])).rows[0];
      if(!stored)throw new MarketAgentRunConflictError();same(stored.begin_identity_json,identity);
      await this.#active(input.subject);
      const result=await this.#claim(stored,{...input.subject,agentRunId:uuid.parse(stored.id),claimToken},claimTtlMs);
      return {...result,created:!!inserted.rows[0]};
    });
  });}
  async #row(authority:MarketModelExecutionAuthority){const row=(await this.#q.query<Row>('SELECT * FROM market_agent_runs WHERE id=$1 FOR UPDATE',[authority.agentRunId])).rows[0];if(!row)throw new MarketAgentRunConflictError();nativeIdentity(authority,row);return row;}
  async #assert(authority:MarketModelExecutionAuthority){await this.#active(authority);const row=await this.#row(authority);
    const live=(await this.#q.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[row.execution_claim_expires_at])).rows[0].live;
    if(!live||row.validation_status!=='pending'||row.execution_claim_token!==authority.claimToken||row.execution_claim_owner_id!==authority.leaseOwnerId||row.execution_claim_generation!==authority.leaseGeneration)throw new MarketAgentRunConflictError();return row;
  }
  async assertAgentRunClaim(value:MarketModelExecutionAuthority){return this.#execute(async()=>{bounded(value);const authority=MarketModelExecutionAuthoritySchema.parse(value);await this.#q.transaction(async()=>{await this.#assert(authority);});});}
  async #claim(row:Row,authority:MarketModelExecutionAuthority,claimTtlMs:number){
    if(row.validation_status!=='pending')return {record:mapAudit(row),claimStatus:'terminal' as const};
    if(row.execution_claim_owner_id!==authority.leaseOwnerId||row.execution_claim_generation!==authority.leaseGeneration)throw new MarketAgentRunConflictError();
    const result=await this.#q.query<Row>(`UPDATE market_agent_runs SET execution_claim_token=$2,execution_claim_acquired_at=clock_timestamp(),execution_claim_expires_at=clock_timestamp()+($3*interval '1 millisecond') WHERE id=$1 AND (execution_claim_token=$2 OR execution_claim_expires_at<=clock_timestamp()) RETURNING *`,[row.id,authority.claimToken,claimTtlMs]);
    await this.#active(authority);return {record:mapAudit(result.rows[0]??row),claimStatus:result.rows[0]?'acquired' as const:'observing' as const};
  }
  async claimAgentRun(value:unknown){return this.#execute(async()=>{bounded(value);const input=z.object({authority:MarketModelExecutionAuthoritySchema,claimTtlMs:ttl}).strict().parse(value);return this.#q.transaction(async()=>{await this.#active(input.authority);return this.#claim(await this.#row(input.authority),input.authority,input.claimTtlMs);});});}
  async finalizeAgentRun(value:unknown){return this.#execute(async()=>{
    bounded(value);const input=z.object({authority:MarketModelExecutionAuthoritySchema,outcome:outcomeSchema}).strict().parse(value);
    return this.#q.transaction(async()=>{
      await this.#active(input.authority);const row=await this.#row(input.authority);
      if(row.validation_status!=='pending'){if(row.execution_claim_token!==input.authority.claimToken)throw new MarketAgentRunConflictError();same(row.outcome_json,input.outcome);return {record:mapAudit(row),transitioned:false};}
      await this.#assert(input.authority);const o=input.outcome;
      const result=await this.#q.query<Row>(`UPDATE market_agent_runs SET validation_status=$2,terminal_status=$3,output_json=$4::jsonb,error_json=$5::jsonb,terminal_metadata_json=$6::jsonb,attempts_json=$7::jsonb,outcome_json=$8::jsonb,outcome_hash=$9,input_tokens=$10,output_tokens=$11,estimated_cost_micros=$12,duration_ms=$13,attempt_count=$14,usage_completeness=$15,completed_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id,o.validationStatus,o.terminalStatus,JSON.stringify(o.output),JSON.stringify(o.error),JSON.stringify(o.terminalMetadata),JSON.stringify(o.attempts),JSON.stringify(o),digest(o),o.inputTokens,o.outputTokens,o.estimatedCostMicros,o.durationMs,o.attemptCount,o.usageCompleteness]);
      await this.#active(input.authority);
      const live=(await this.#q.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[row.execution_claim_expires_at])).rows[0].live;if(!live)throw new MarketAgentRunConflictError();
      return {record:mapAudit(result.rows[0]),transitioned:true};
    });
  });}
  async listAgentRuns(value:unknown){return this.#execute(async()=>{const scope=readSchema.parse(value);if(!await this.#readActor(scope))return [];return (await this.#q.query<Row>('SELECT * FROM market_agent_runs WHERE organization_id=$1 AND study_id=$2 AND module_run_id=$3 ORDER BY started_at,id',[scope.actor.organizationId,scope.studyId,scope.moduleRunId])).rows.map(mapAudit);});}
  async findAgentRun(value:unknown){return this.#execute(async()=>{const scope=readSchema.extend({agentRunId:uuid}).parse(value);if(!await this.#readActor(scope))return null;
    const row=(await this.#q.query<Row>('SELECT * FROM market_agent_runs WHERE id=$1 AND organization_id=$2 AND study_id=$3 AND module_run_id=$4',[scope.agentRunId,scope.actor.organizationId,scope.studyId,scope.moduleRunId])).rows[0];return row?mapAudit(row):null;});}
  async findSnapshotBindingByBatch(value:unknown){return this.#execute(async()=>{const scope=readSchema.extend({batchId:uuid,inputDigest:hash}).parse(value);if(!await this.#readActor(scope))return null;
    const rows=(await this.#q.query<Row>("SELECT * FROM market_analysis_semantic_snapshot_bindings WHERE organization_id=$1 AND study_id=$2 AND module_run_id=$3 AND input_json->>'batchId'=$4 AND input_digest=$5 LIMIT 2",[scope.actor.organizationId,scope.studyId,scope.moduleRunId,scope.batchId,scope.inputDigest])).rows;
    if(rows.length>1)throw new MarketAgentRunConflictError();return rows[0]?this.#binding(rows[0],scope.actor):null;});}
  async getAgentRunUsage(value:unknown){
    const records=await this.listAgentRuns(value),outcomes=records.map(record=>record.outcome);
    const sum=(field:'inputTokens'|'outputTokens'|'estimatedCostMicros'|'durationMs'|'attemptCount')=>{if(!outcomes.length||outcomes.some(o=>!o||o[field]===null))return null;const value=outcomes.reduce((total,o)=>total+BigInt(o![field]!),BigInt(0));if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new MarketAgentRunConflictError();return Number(value);};
    const completeness=outcomes.length&&outcomes.every(o=>o?.usageCompleteness==='complete')?'complete':outcomes.some(o=>o&&o.usageCompleteness!=='unavailable')?'partial':'unavailable';
    return freeze({source:'audit-terminal' as const,usageCompleteness:completeness as 'complete'|'partial'|'unavailable',inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),estimatedCostMicros:sum('estimatedCostMicros'),durationMs:sum('durationMs'),attemptCount:sum('attemptCount'),agentRunCount:records.length});
  }
}
