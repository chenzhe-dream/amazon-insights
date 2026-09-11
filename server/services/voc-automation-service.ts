import { createHash } from 'node:crypto';
import { VocAutomationRequestSchema, VocAutomationStatusSchema, type VocAutomationRequest, type VocAutomationStatus } from '../../shared/voc-automation-contracts';
import type { GetRunResponse } from '../../shared/agent-contracts';
import type { RuntimeAgentRepository } from '../db/repository';
import type { VocAutomationRecord } from '../db/voc-automation-repository';
import { AnalysisRunService, AnalysisLifecycleError } from './analysis-run-service';

type Scope = { organizationId: string; projectId: string; actorId: string };
type Lifecycle = Pick<AnalysisRunService, 'getVocInputs' | 'getRun' | 'createRun'>;
type Options = { repository: RuntimeAgentRepository; now?: () => string; lifecycleFactory?: (repository: RuntimeAgentRepository, scope: Scope) => Lifecycle; onError?: (error: unknown) => void };
const active = (run: GetRunResponse) => [run.run.status, ...run.stages.map(s => s.status)].some(status => status === 'running' || status === 'queued');
const sameAsins = (a: readonly string[], b: readonly string[]) => [...a].sort().join(',') === [...b].sort().join(',');

/** Durable intent is reconciled under a project lock; creating the run and adopting it commit together. */
export class VocAutomationService {
 private timer: ReturnType<typeof setInterval> | null = null;
 private pending: Promise<void> | null = null;
 private readonly now: () => string;
 constructor(private readonly options: Options) { this.now = options.now ?? (() => new Date().toISOString()); }
 private lifecycle(repository: RuntimeAgentRepository, scope: Scope): Lifecycle {
  return this.options.lifecycleFactory?.(repository, scope) ?? new AnalysisRunService({repository, executionContext:{actorId:scope.actorId,organizationId:scope.organizationId}, dependencyStateProvider:repository});
 }
 private async authorize(repository: RuntimeAgentRepository, scope: Scope, baseSyncRunId?: string, asins?: readonly string[]) {
  const user = await repository.findUserById(scope.actorId), project = await repository.findProjectById(scope.projectId);
  if (!user || user.status !== 'active' || user.organizationId !== scope.organizationId || !project || project.organizationId !== scope.organizationId) throw new AnalysisLifecycleError(404,'Project scope is unavailable');
  if (project.marketplace !== 'US' || asins?.some(asin => !project.asins.includes(asin))) throw new AnalysisLifecycleError(409,'分析范围不属于当前美国站项目');
  if (baseSyncRunId) {
   const base = await repository.findAnalysisRun(baseSyncRunId);
   if (!base || base.projectId !== project.id || base.idempotencyScope !== `sync:${scope.organizationId}:${scope.projectId}`) throw new AnalysisLifecycleError(409,'请先完成当前项目的数据同步');
  }
 }
 async register(scope: Scope, request: VocAutomationRequest): Promise<VocAutomationStatus> {
  const input = VocAutomationRequestSchema.parse(request);
  await this.options.repository.transaction(async raw => {
   const repository = raw as RuntimeAgentRepository;
   await this.authorize(repository,scope,input.baseSyncRunId,input.selectedAsins);
   await repository.vocAutomations.lock(scope.organizationId,scope.projectId);
   const previous = await repository.vocAutomations.get(scope.organizationId,scope.projectId);
   const sameScope = previous?.baseSyncRunId === input.baseSyncRunId && sameAsins(previous.selectedAsins,input.selectedAsins);
   const lifecycle = this.lifecycle(repository,scope);
   if (previous?.runId && (!sameScope || (input.retryKey && input.retryKey !== previous.retryKey))) {
    const run = await lifecycle.getRun(previous.runId);
    if (active(run)) throw new AnalysisLifecycleError(409,'当前分析仍在运行，请完成后再更改范围或重试');
   }
   let record: VocAutomationRecord = sameScope ? {...previous!,actorId:scope.actorId} : {...scope,baseSyncRunId:input.baseSyncRunId,selectedAsins:[...input.selectedAsins].sort(),retryKey:null,fingerprint:null,runId:null,updatedAt:this.now()};
   if (input.retryKey && input.retryKey !== record.retryKey) {
    if (!record.runId || this.runState(await lifecycle.getRun(record.runId)).state !== 'failed') throw new AnalysisLifecycleError(409,'只有失败的分析可以重试');
    record = {...record,retryKey:input.retryKey,runId:null,updatedAt:this.now()};
   }
   await repository.vocAutomations.save(record);
  });
  return this.reconcileScope(scope);
 }
 async read(scope: Scope): Promise<VocAutomationStatus> {
  await this.authorize(this.options.repository,scope);
  const record = await this.options.repository.vocAutomations.get(scope.organizationId,scope.projectId);
  if (!record) throw new AnalysisLifecycleError(404,'尚未登记自动分析范围');
  return this.status(this.options.repository,record,scope);
 }
 async afterImport(scope: Scope, baseSyncRunId: string): Promise<void> {
  await this.options.repository.transaction(async raw => {
   const repository = raw as RuntimeAgentRepository;
   await this.authorize(repository,scope,baseSyncRunId);
   await repository.vocAutomations.lock(scope.organizationId,scope.projectId);
   const previous = await repository.vocAutomations.get(scope.organizationId,scope.projectId);
   const project = await repository.findProjectById(scope.projectId);
   // Preserve an explicitly selected scope. First import registers the complete project.
   if (!previous) await repository.vocAutomations.save({...scope,baseSyncRunId,selectedAsins:[...project!.asins].sort(),retryKey:null,fingerprint:null,runId:null,updatedAt:this.now()});
  });
  await this.reconcileScope(scope);
 }
 private async reconcileScope(scope: Scope): Promise<VocAutomationStatus> {
  return this.options.repository.transaction(async raw => {
   const repository=raw as RuntimeAgentRepository;
   await repository.vocAutomations.lock(scope.organizationId,scope.projectId);
   const record=await repository.vocAutomations.get(scope.organizationId,scope.projectId);
   if (!record) throw new AnalysisLifecycleError(404,'尚未登记自动分析范围');
   return this.reconcile(repository,record);
  });
 }
 private runState(run: GetRunResponse): Pick<VocAutomationStatus,'state'|'message'|'startedAt'|'updatedAt'> {
  const voc = run.stages.find(s=>s.stage==='voc-positioning'), definition = run.stages.find(s=>s.stage==='product-definition');
  const failed = run.stages.find(s=>['failed','cancelled','budget-exceeded'].includes(s.status));
  const timing = {startedAt:voc?.startedAt ?? null,updatedAt:[run.run.updatedAt,...run.stages.map(s=>s.updatedAt).filter(Boolean)].sort().at(-1)!};
  if (failed || ['failed','cancelled'].includes(run.run.status)) return {...timing,state:'failed',message:failed?.lastError?.message ?? '分析未完成，请重试'};
  if (definition?.status==='succeeded') return {...timing,state:'succeeded',message:'VOC 分析与新品定义已完成'};
  if (voc?.status==='running') return {...timing,state:'voc-running',message:'正在分析手工 VOC'};
  if (definition?.status==='running' || (voc?.status==='succeeded' && definition?.status==='queued')) return {...timing,state:'definition-running',message:'VOC 分析已完成，正在生成新品定义'};
  if (active(run)) return {...timing,state:'queued',message:'分析任务已创建，等待执行'};
  return {...timing,state:'failed',message:'分析未能继续，请重试'};
 }
 private async status(repository: RuntimeAgentRepository, record: VocAutomationRecord, actor: Scope = {...record}): Promise<VocAutomationStatus> {
  const lifecycle = this.lifecycle(repository,actor);
  const base = {projectId:record.projectId,baseSyncRunId:record.baseSyncRunId,selectedAsins:record.selectedAsins,runId:record.runId,updatedAt:record.updatedAt,startedAt:null};
  const run = record.runId ? await lifecycle.getRun(record.runId) : null;
  if (run && active(run)) return VocAutomationStatusSchema.parse({...base,...this.runState(run)});
  if (await this.normalizing(repository,record)) return VocAutomationStatusSchema.parse({...base,runId:null,state:'waiting-voc',message:'正在校验新录入的手工 VOC，完成后自动分析'});
  if (run) return VocAutomationStatusSchema.parse({...base,...this.runState(run)});
  const {manual} = await lifecycle.getVocInputs(record.projectId,record.baseSyncRunId,record.selectedAsins);
  const count = manual.coverage.filter(row=>row.primary==='manual' && row.manual).length;
  const ready = count===record.selectedAsins.length;
  return VocAutomationStatusSchema.parse({...base,state:!ready?'waiting-voc':manual.keywords.state!=='ready'?'waiting-keywords':'queued',message:!ready?`手工 VOC 已完成 ${count}/${record.selectedAsins.length}，全部保存后自动分析`:manual.keywords.state!=='ready'?'手工 VOC 已就绪，等待关键词数据':'输入已就绪，等待后台创建分析任务'});
 }
 private async normalizing(repository: RuntimeAgentRepository, record: VocAutomationRecord): Promise<boolean> {
  const statuses = await repository.manualAlexaVoc.listNormalizationStatuses({actorOrganizationId:record.organizationId,projectId:record.projectId,runId:record.baseSyncRunId,marketplace:'US',asins:record.selectedAsins});
  return statuses.some(status=>status.status==='pending');
 }
 private async reconcile(repository: RuntimeAgentRepository, record: VocAutomationRecord): Promise<VocAutomationStatus> {
  const scope: Scope = record;
  await this.authorize(repository,scope,record.baseSyncRunId,record.selectedAsins);
  const lifecycle = this.lifecycle(repository,scope);
  if (record.runId && active(await lifecycle.getRun(record.runId))) return this.status(repository,record);
  if (await this.normalizing(repository,record)) return this.status(repository,record);
  const {manual} = await lifecycle.getVocInputs(record.projectId,record.baseSyncRunId,record.selectedAsins);
  if (record.fingerprint===manual.fingerprint && record.runId) return this.status(repository,record);
  if (record.fingerprint && record.fingerprint!==manual.fingerprint) {
   record={...record,retryKey:null,runId:null,fingerprint:manual.fingerprint,updatedAt:this.now()};
   await repository.vocAutomations.save(record);
  }
  if (manual.coverage.length!==record.selectedAsins.length || manual.coverage.some(row=>row.primary!=='manual'||!row.manual) || manual.keywords.state!=='ready') {
   return this.status(repository,record);
  }
  // Adopt an earlier matching result, including failures; only an explicit retry bypasses reuse.
  if (!record.retryKey) {
   const runs = (await repository.listAnalysisRuns(record.projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
   for (const candidate of runs) {
    const run = await lifecycle.getRun(candidate.id);
    if (run.evidenceSelection?.fingerprint!==manual.fingerprint || run.evidenceSelection.sourcePolicy!=='manual-only') continue;
    record={...record,runId:run.run.id,fingerprint:manual.fingerprint,updatedAt:this.now()};
    await repository.vocAutomations.save(record);return this.status(repository,record);
   }
  }
  const key = createHash('sha256').update(JSON.stringify([record.organizationId,record.projectId,manual.fingerprint,record.retryKey])).digest('hex');
  const run = await lifecycle.createRun(record.projectId,{mode:'existing-data',idempotencyKey:`voc-auto-v2:${key}`,evidenceSelection:{baseSyncRunId:record.baseSyncRunId,selectedAsins:record.selectedAsins,sourcePolicy:'manual-only',expectedInputFingerprint:manual.fingerprint}});
  record={...record,runId:run.run.id,fingerprint:manual.fingerprint,updatedAt:this.now()};
  await repository.vocAutomations.save(record);return this.status(repository,record);
 }
 async tick(): Promise<void> {
  if (this.pending) return this.pending;
  this.pending = (async()=>{
   for (const candidate of await this.options.repository.vocAutomations.list()) {
    try {
     await this.options.repository.transaction(async raw=>{
      const repository=raw as RuntimeAgentRepository;
      await repository.vocAutomations.lock(candidate.organizationId,candidate.projectId);
      const current=await repository.vocAutomations.get(candidate.organizationId,candidate.projectId);
      if (current) await this.reconcile(repository,current);
     });
    } catch(error) { this.options.onError?.(error); }
   }
  })();
  try {await this.pending;} finally {this.pending=null;}
 }
 start() { if(this.timer)return;void this.tick().catch(error=>this.options.onError?.(error));this.timer=setInterval(()=>{void this.tick().catch(error=>this.options.onError?.(error));},2000);this.timer.unref?.(); }
 async stop() {if(this.timer)clearInterval(this.timer);this.timer=null;await this.pending;}
}
