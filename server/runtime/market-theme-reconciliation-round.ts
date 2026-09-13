import { z } from 'zod';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import { planMarketThemeReconciliation, type MarketThemeReconciliationRound } from '../domain/market-research/customer-theme-reconciliation';
import { readMarketThemeRuleInputs } from './market-theme-rule-inputs';
import { marketThemeReconciliationPage, MarketThemeReconciliationPageInputSchema, MARKET_THEME_RECONCILIATION_PAGE_SIZE } from '../domain/market-research/customer-theme-reconciliation-pages';
import { createMarketThemeEvaluationArtifact, MarketThemeEvaluationInputSchema, type MarketThemeRoundRead, type MarketThemeRoundFrontier } from '../domain/market-research/customer-theme-reconciliation-artifact';
import { canonicalJsonSha256 as digest } from './model-request-accounting';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function invalid():never{throw new z.ZodError([{code:'custom',path:[],message:'Theme reconciliation round has an incomplete or conflicting persisted lineage'}]);}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const manifest=z.array(z.object({bindingId:z.string().uuid(),inputDigest:hash,memberRefs:z.array(z.string()).min(1).max(12),batchKey:z.string()}).strict()).max(2000);

/** Read a complete round's page chain and the current terminal attempts it
 * prepared. Running batches are a barrier, failed batches remain unavailable.
 * Never reads newest unrelated model output or lets a caller omit a success. */
export type MarketThemeReconciliationBasisRequest={actor:MarketExecutionActor;moduleRunId:string;initialRulesAttemptId:string;priorEvaluationAttemptIds?:string[]};
type RoundRequest=MarketThemeReconciliationBasisRequest&{lastPageAttemptId:string};
type Loaded=Awaited<ReturnType<typeof readMarketThemeRuleInputs>>;
type Plan=ReturnType<typeof planMarketThemeReconciliation>;
async function readLock<T>(context:PostgresQueryContext,request:MarketThemeReconciliationBasisRequest,signal:AbortSignal,run:()=>Promise<T>):Promise<T>{
  return context.transaction(async()=>{signal.throwIfAborted();await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[request.moduleRunId,request.actor.organizationId]);return run();});
}
export async function readMarketThemeReconciliationRound(context:PostgresQueryContext,request:RoundRequest,signal:AbortSignal):Promise<MarketThemeRoundRead>{
  return readLock(context,request,signal,async()=>{const basis=await readBasis(context,request,signal);return readRoundForPlan(context,request,signal,basis.loaded,basis.plan,basis.rounds);});
}
export async function readMarketThemeReconciliationPlan(context:PostgresQueryContext,request:MarketThemeReconciliationBasisRequest,signal:AbortSignal):Promise<Plan>{
  return readLock(context,request,signal,async()=>(await readBasis(context,request,signal)).plan);
}
async function readBasis(context:PostgresQueryContext,request:MarketThemeReconciliationBasisRequest,signal:AbortSignal):Promise<{loaded:Loaded;plan:Plan;rounds:MarketThemeReconciliationRound[]}>{
  const ids=z.array(z.string().uuid()).max(8).parse(request.priorEvaluationAttemptIds??[]);if(new Set(ids).size!==ids.length)invalid();
  const loaded=await readMarketThemeRuleInputs(context,{actor:request.actor,moduleRunId:request.moduleRunId,rulesAttemptId:request.initialRulesAttemptId},signal);
  const {view,poolInput}=loaded,rounds:MarketThemeReconciliationRound[]=[];
  let plan=planMarketThemeReconciliation({poolInput,batches:loaded.batches,rounds});
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context);
  for(const [index,id] of ids.entries()){
    signal.throwIfAborted();const attempt=view.attempts.find(a=>a.id===id),step=view.steps.find(s=>s.latestAttemptId===id);
    if(!attempt||!step||step.kind!=='reconcile'||attempt.stepId!==step.id||attempt.status!=='succeeded'||step.status!=='succeeded')invalid();
    const input=MarketThemeEvaluationInputSchema.parse(step.input);same(input.initialRulesAttemptId,request.initialRulesAttemptId);same(input.priorEvaluationAttemptIds??[],ids.slice(0,index));
    for(const dependency of [input.initialRulesAttemptId,input.lastPageAttemptId,...ids.slice(0,index)])if(!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===dependency))invalid();
    const round=await readRoundForPlan(context,{...request,lastPageAttemptId:input.lastPageAttemptId,priorEvaluationAttemptIds:ids.slice(0,index)},signal,loaded,plan,rounds);
    if(round.status!=='settled')invalid();
    const artifact=createMarketThemeEvaluationArtifact(view.run.scope,loaded.pool.semanticSnapshot.sourceVersion,loaded.pool.semanticSnapshot.collectedAt,input,round);
    same(attempt.output,artifact.output);
    const saved=await snapshots.findInput({actor:request.actor,studyId:view.run.scope.researchId,id:artifact.snapshot.snapshotId});if(!saved)invalid();same(saved.snapshot,artifact.snapshot);
    rounds.push(round.receipt);plan=round.result;
  }
  return {loaded,plan,rounds};
}
async function readRoundForPlan(context:PostgresQueryContext,request:RoundRequest,signal:AbortSignal,loaded:Loaded,plan:Plan,priorRounds:MarketThemeReconciliationRound[]):Promise<MarketThemeRoundRead>{
  const {view,poolInput,pool}=loaded;
  if(plan.status!=='needs-model'||!plan.windows.length)invalid();
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),audits=new PostgresMarketAgentRunStore(context);
  const scope={actor:request.actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id};
  let pageId:string|undefined=request.lastPageAttemptId;
  let expectedOffset=Math.floor((plan.windows.length-1)/MARKET_THEME_RECONCILIATION_PAGE_SIZE)*MARKET_THEME_RECONCILIATION_PAGE_SIZE;
  const visited=new Set<string>();
  while(pageId){
    signal.throwIfAborted();if(visited.has(pageId))invalid();visited.add(pageId);
    const attempt=view.attempts.find(a=>a.id===pageId),step=view.steps.find(s=>s.latestAttemptId===pageId);
    if(!attempt||!step||step.kind!=='reconcile'||step.status!=='succeeded'||attempt.status!=='succeeded'||attempt.stepId!==step.id)invalid();
    const input=MarketThemeReconciliationPageInputSchema.parse(step.input);
    if(input.initialRulesAttemptId!==request.initialRulesAttemptId||input.offset!==expectedOffset||!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===request.initialRulesAttemptId))invalid();
    same(input.priorEvaluationAttemptIds??[],request.priorEvaluationAttemptIds??[]);
    for(const id of request.priorEvaluationAttemptIds??[])if(!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===id))invalid();
    same(attempt.output,marketThemeReconciliationPage(plan,expectedOffset).output);
    if(input.previousPageAttemptId&&!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===input.previousPageAttemptId))invalid();
    expectedOffset-=MARKET_THEME_RECONCILIATION_PAGE_SIZE;pageId=input.previousPageAttemptId;
  }
  if(expectedOffset!==-MARKET_THEME_RECONCILIATION_PAGE_SIZE)invalid();
  const batches:MarketThemeReconciliationRound['batches'][number][]=[],auditRefs:{agentRunId:string;attemptId:string;bindingId:string;executionFingerprint:string}[]=[];
  const pendingStepIds:string[]=[],seenBindings=new Set<string>(),frontier:MarketThemeRoundFrontier[]=[];
  const track=(s:typeof view.steps[number])=>frontier.push({stepId:s.id,attemptId:s.latestAttemptId,status:s.status,inputHash:s.inputHash});
  for(let offset=0;offset<plan.windows.length;offset+=MARKET_THEME_RECONCILIATION_PAGE_SIZE){
    for(const [index,definition] of marketThemeReconciliationPage(plan,offset).children.entries()){
      signal.throwIfAborted();const window=plan.windows[offset+index];
      const preparation=view.steps.find(s=>s.stepKey===definition.stepKey);if(!preparation)invalid();
      same({stepKey:preparation.stepKey,kind:preparation.kind,subject:preparation.subject,input:preparation.input,inputRefs:preparation.inputRefs},definition);
      track(preparation);
      if(preparation.status==='queued'||preparation.status==='running'){pendingStepIds.push(preparation.id);continue;}
      const prepared=view.attempts.find(a=>a.id===preparation.latestAttemptId&&a.stepId===preparation.id);
      if(!prepared||!(prepared.status===preparation.status||(prepared.status==='interrupted'&&preparation.status==='failed')))invalid();
      if(preparation.status==='failed')continue;
      if(!['succeeded','empty'].includes(preparation.status))invalid();
      const declared=manifest.parse(obj(prepared.output).batches),members=new Set<string>();
      const saved=await snapshots.findInput({...scope,id:window.snapshot.snapshotId});if(!saved)invalid();same(saved.snapshot,window.snapshot);
      same(obj(prepared.output).inputSnapshotId,window.snapshot.snapshotId);same(obj(prepared.output).task,'market-customer-theme-mapping');
      same(obj(prepared.output).expectedMemberIds,window.snapshot.expectedRecordIds);
      for(const entry of declared){
        if(seenBindings.has(entry.bindingId)||entry.memberRefs.some(id=>members.has(id)||!window.memberIds.includes(id)))invalid();seenBindings.add(entry.bindingId);entry.memberRefs.forEach(id=>members.add(id));
        const models=view.steps.filter(s=>s.kind==='model-batch'&&obj(s.input).bindingId===entry.bindingId&&obj(s.input).inputDigest===entry.inputDigest);if(models.length!==1)invalid();
        const model=models[0];track(model);
        if(model.status==='queued'||model.status==='running'){pendingStepIds.push(model.id);continue;}
        const attempt=view.attempts.find(a=>a.id===model.latestAttemptId&&a.stepId===model.id);
        if(!attempt||!(attempt.status===model.status||(attempt.status==='interrupted'&&model.status==='failed')))invalid();
        if(model.status==='failed')continue;if(model.status!=='succeeded')invalid();
        const out=obj(attempt.output),audit=await audits.findAgentRun({...scope,agentRunId:z.string().uuid().parse(out.agentRunId)});
        const binding=await audits.findSnapshotBinding({...scope,bindingId:entry.bindingId});
        if(!audit||!binding||audit.task!=='market-customer-theme-mapping'||audit.terminalStatus!=='succeeded'||audit.validationStatus!=='passed'||audit.outcome?.terminalStatus!=='succeeded'||audit.outcome.validationStatus!=='passed'||!audit.outcome.output)invalid();
        same(audit.attemptId,attempt.id);same(audit.stepId,model.id);same(audit.bindingId,entry.bindingId);same(audit.executionFingerprint,out.executionFingerprint);same(out.bindingId,entry.bindingId);
        same(binding.inputSnapshotId,window.snapshot.snapshotId);same(binding.memberRefs,entry.memberRefs);same(binding.batchKey,entry.batchKey);same(binding.inputDigest,entry.inputDigest);
        same(binding.selectionRevision,window.selectionRevision);same(binding.dataCutoffAt,pool.semanticSnapshot.collectedAt);
        batches.push({input:binding.inputProjection,output:audit.outcome.output,binding:{scope:view.run.scope,inputSnapshot:window.snapshot,sourceEvidenceByRef:poolInput.sources,
          selectionRevision:binding.selectionRevision,batchKey:binding.batchKey,inputDigest:binding.inputDigest,expectedIds:binding.memberRefs,
          sourceCatalog:Object.fromEntries(window.snapshot.records.map(r=>[r.id,MarketSemanticRecordSchema.parse(obj(r.data).semantic)]))}});
        auditRefs.push({agentRunId:audit.id,attemptId:attempt.id,bindingId:binding.id,executionFingerprint:audit.executionFingerprint});
      }
      const rejected=z.array(z.object({memberId:z.string(),reason:z.enum(['request-too-large','missing-source'])}).strict()).max(12).parse(obj(prepared.output).rejectedMembers);
      same(obj(prepared.output).missingMemberIds,[]);
      const accounted=[...members,...rejected.map(r=>r.memberId)];
      if(new Set(accounted).size!==accounted.length)invalid();same(accounted.sort(),[...window.memberIds].sort());
    }
  }
  auditRefs.sort((a,b)=>a.agentRunId.localeCompare(b.agentRunId));
  frontier.sort((a,b)=>a.stepId.localeCompare(b.stepId));const frontierHash=digest(frontier);
  if(pendingStepIds.length)return {plan,frontier,frontierHash,status:'waiting' as const,pendingStepIds:pendingStepIds.sort(),receipt:null,result:null,auditRefs};
  const receipt={planHash:plan.planHash,batches};
  const result=planMarketThemeReconciliation({poolInput,batches:loaded.batches,rounds:[...priorRounds,receipt],topN:loaded.input.topN});
  signal.throwIfAborted();return {plan,frontier,frontierHash,status:'settled' as const,pendingStepIds:[],receipt,result,auditRefs};
}
