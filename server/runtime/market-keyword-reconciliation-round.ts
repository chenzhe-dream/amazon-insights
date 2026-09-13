import {z} from 'zod';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {MarketKeywordSemanticsInputSchema,MarketKeywordSemanticsOutputSchema} from '../../shared/market-semantic-contracts';
import {isMarketKeywordGlobalMode} from '../../shared/market-keyword-flow-contracts';
import {MarketExecutionConflictError,type MarketExecutionActor,type MarketModuleRunView} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {PostgresMarketAgentRunStore} from '../db/postgres/market-agent-run-store';
import {readMarketKeywordReconciliationSource} from '../services/market-keyword-reconciliation-source';
import {inspectMarketKeywordContinuation} from '../domain/market-research/keyword-flow';
import {planMarketKeywordReconciliation,type MarketKeywordReconciliationRound} from '../domain/market-research/keyword-reconciliation';
import {MarketKeywordReconciliationAnchorSchema,MarketKeywordReconciliationPageInputSchema,MarketKeywordReconciliationEvaluationInputSchema,
  marketKeywordReconciliationPage,MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE,MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION} from '../domain/market-research/keyword-reconciliation-pages';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from './model-request-accounting';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const success=(s:string)=>s==='succeeded'||s==='empty';
function invalid():never{throw new MarketExecutionConflictError();}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
const json=(v:unknown)=>MarketInputRecordSchema.shape.data.parse(v);
type Anchor=z.infer<typeof MarketKeywordReconciliationAnchorSchema>;
type Request={actor:MarketExecutionActor;moduleRunId:string;anchor:Anchor;priorEvaluationAttemptIds?:string[]};
type Plan=ReturnType<typeof planMarketKeywordReconciliation>;
type Loaded={view:MarketModuleRunView;basis:NonNullable<Awaited<ReturnType<typeof readMarketKeywordReconciliationSource>>>['basis'];rounds:MarketKeywordReconciliationRound[];plan:Plan};
type Frontier={stepId:string;attemptId:string|null;status:string;inputHash:string};
const definition=(s:MarketModuleRunView['steps'][number])=>({stepKey:s.stepKey,kind:s.kind,subject:s.subject,input:s.input,inputRefs:s.inputRefs});
function currentAttempt(view:MarketModuleRunView,step:MarketModuleRunView['steps'][number]){
 const a=view.attempts.find(a=>a.id===step.latestAttemptId&&a.stepId===step.id);
 if(!a||!(a.status===step.status||(step.status==='failed'&&a.status==='interrupted')))invalid();return a;
}

/** Replays only the anchored initial attempts and committed native audits. No
 * current provider/configuration lookup, raw response copy, or trend dependency. */
export async function readMarketKeywordReconciliationPlan(context:PostgresQueryContext,request:Request,signal:AbortSignal):Promise<Loaded>{
 signal.throwIfAborted();const anchor=MarketKeywordReconciliationAnchorSchema.parse(request.anchor);
 const source=await readMarketKeywordReconciliationSource(context,request.actor,request.moduleRunId);
 const view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor:request.actor,moduleRunId:request.moduleRunId});
 if(!source||!view||!isMarketKeywordGlobalMode(obj(view.run.params).analysisMode))invalid();
 same(source.run.facts!.pool.attemptId,anchor.poolAttemptId);
 const current=new Set(inspectMarketKeywordContinuation(view.run.status==='cancelled'?{...view,run:{...view.run,status:'partial'}}:view,new Date().toISOString()).currentStepKeys);
 const initial=view.steps.filter(s=>current.has(s.stepKey)&&s.inputRefs.some(r=>r.kind==='input'&&r.id===source.basis.snapshot.snapshotId));
 const preparations=initial.filter(s=>s.kind==='prepare-model-batches');if(preparations.length!==1||!success(preparations[0].status))invalid();
 same(currentAttempt(view,preparations[0]).id,anchor.preparationAttemptId);
 const models=initial.filter(s=>s.kind==='model-batch');
 if(models.some(s=>!success(s.status)&&s.status!=='failed'))invalid();
 same(models.map(s=>currentAttempt(view,s).id).sort(),anchor.modelAttemptIds);
 const rounds:MarketKeywordReconciliationRound[]=[];
 const loaded:Loaded={view,basis:source.basis,rounds,plan:planMarketKeywordReconciliation({...source.basis,rounds})};
 const ids=z.array(z.string().uuid()).max(64).parse(request.priorEvaluationAttemptIds??[]);if(new Set(ids).size!==ids.length)invalid();
 const snapshots=new PostgresMarketAnalysisSnapshotStore(context);
 for(const [index,id] of ids.entries()){
  signal.throwIfAborted();const step=view.steps.find(s=>s.latestAttemptId===id&&current.has(s.stepKey));if(!step||step.kind!=='reconcile'||!success(step.status))invalid();
  const input=MarketKeywordReconciliationEvaluationInputSchema.parse(step.input);
  same(input.anchor,anchor);same(input.priorEvaluationAttemptIds??[],ids.slice(0,index));
  const round=await readRound(context,{...request,priorEvaluationAttemptIds:ids.slice(0,index),lastPageAttemptId:input.lastPageAttemptId},loaded,signal);
  same(input.frontierHash,round.frontierHash);
  const artifact=createMarketKeywordReconciliationArtifact(loaded,input,round);
  same(currentAttempt(view,step).output,artifact.output);
  const saved=await snapshots.findInput({actor:request.actor,studyId:view.run.scope.researchId,id:artifact.snapshot.snapshotId});
  if(!saved)invalid();same(saved.snapshot,artifact.snapshot);
  rounds.push(round.receipt);loaded.plan=round.result;
 }
 return loaded;
}

export function validateMarketKeywordReconciliationPages(loaded:Loaded,request:Request,lastPageAttemptId:string,lastOffset:number){
 let pageId:string|undefined=lastPageAttemptId,offset=lastOffset;const seen=new Set<string>();
 while(pageId){
  if(seen.has(pageId))invalid();seen.add(pageId);
  const step=loaded.view.steps.find(s=>s.latestAttemptId===pageId);if(!step||step.kind!=='reconcile'||!success(step.status))invalid();
  const input=MarketKeywordReconciliationPageInputSchema.parse(step.input);same(input.anchor,request.anchor);same(input.priorEvaluationAttemptIds??[],request.priorEvaluationAttemptIds??[]);
  if(input.offset!==offset||input.previousPageAttemptId&&!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===input.previousPageAttemptId))invalid();
  same(currentAttempt(loaded.view,step).output,marketKeywordReconciliationPage(loaded.plan,offset).output);
  offset-=MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE;pageId=input.previousPageAttemptId;
 }
 if(offset!==-MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE)invalid();
}

async function readRound(context:PostgresQueryContext,request:Request&{lastPageAttemptId:string},loaded:Loaded,signal:AbortSignal){
 const {plan,view}=loaded;if(plan.status!=='needs-model'||!plan.windows.length)invalid();
 validateMarketKeywordReconciliationPages(loaded,request,request.lastPageAttemptId,Math.floor((plan.windows.length-1)/MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE)*MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE);
 const scope={actor:request.actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id};
 const snapshots=new PostgresMarketAnalysisSnapshotStore(context),audits=new PostgresMarketAgentRunStore(context);
 const batches:MarketKeywordReconciliationRound['batches'][number][]=[],frontier:Frontier[]=[],auditRefs:{agentRunId:string;attemptId:string;bindingId:string;executionFingerprint:string}[]=[];
 const seen=new Set<string>();
 const track=(s:typeof view.steps[number])=>{if(!success(s.status)&&s.status!=='failed')invalid();frontier.push({stepId:s.id,attemptId:s.latestAttemptId,status:s.status,inputHash:s.inputHash});return currentAttempt(view,s);};
 for(let offset=0;offset<plan.windows.length;offset+=MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE){
  const page=marketKeywordReconciliationPage(plan,offset);
  for(const [index,def] of page.children.entries()){
   signal.throwIfAborted();const window=page.output.windows[index];
   const prep=view.steps.find(s=>s.stepKey===def.stepKey);if(!prep)invalid();same(definition(prep),def);same(prep.inputHash,digest(def));
   const prepared=track(prep);if(prep.status==='failed')continue;
   const saved=await snapshots.findInput({...scope,id:window.inputSnapshotId});if(!saved)invalid();same(saved.snapshot,createMarketInputSnapshot(page.inputs[index]));
   const output=obj(prepared.output);same(output.task,'market-keyword-semantics');same(output.inputSnapshotId,window.inputSnapshotId);same(output.expectedMemberIds,saved.snapshot.expectedRecordIds);same(output.missingMemberIds,[]);
   const members=new Set<string>();
   const manifest=z.array(z.object({bindingId:z.string().uuid(),inputDigest:z.string(),memberRefs:z.array(z.string()).min(1).max(20),batchKey:z.string()}).strict()).max(2000).parse(output.batches);
   for(const entry of manifest){
    if(seen.has(entry.bindingId)||entry.memberRefs.some(id=>members.has(id)||!window.memberIds.includes(id)))invalid();seen.add(entry.bindingId);entry.memberRefs.forEach(id=>members.add(id));
    const modelDefs=view.steps.filter(s=>s.kind==='model-batch'&&obj(s.input).bindingId===entry.bindingId);if(modelDefs.length!==1)invalid();const model=modelDefs[0];
    const modelDefinition={stepKey:`model/${entry.batchKey}`,kind:'model-batch',subject:{task:'market-keyword-semantics'},input:{task:'market-keyword-semantics',bindingId:entry.bindingId,inputDigest:entry.inputDigest},inputRefs:[{kind:'input',id:window.inputSnapshotId}]};
    same(definition(model),modelDefinition);same(model.inputHash,digest(modelDefinition));
    const attempt=track(model);if(model.status==='failed')continue;
    const out=obj(attempt.output),audit=await audits.findAgentRun({...scope,agentRunId:z.string().uuid().parse(out.agentRunId)}),binding=await audits.findSnapshotBinding({...scope,bindingId:entry.bindingId});
    if(!audit||!binding||audit.task!=='market-keyword-semantics'||audit.terminalStatus!=='succeeded'||audit.validationStatus!=='passed'||audit.outcome?.terminalStatus!=='succeeded'||audit.outcome.validationStatus!=='passed'||!audit.outcome.output)invalid();
    same(audit.attemptId,attempt.id);same(audit.stepId,model.id);same(audit.bindingId,entry.bindingId);same(audit.executionFingerprint,out.executionFingerprint);same(out.bindingId,entry.bindingId);
    same(binding.inputSnapshotId,window.inputSnapshotId);same(binding.memberRefs,entry.memberRefs);same(binding.batchKey,entry.batchKey);same(binding.inputDigest,entry.inputDigest);same(binding.selectionRevision,window.selectionRevision);same(binding.dataCutoffAt,loaded.basis.snapshot.collectedAt);
    batches.push({input:MarketKeywordSemanticsInputSchema.parse(binding.inputProjection),output:MarketKeywordSemanticsOutputSchema.parse(audit.outcome.output)});
    auditRefs.push({agentRunId:audit.id,attemptId:attempt.id,bindingId:binding.id,executionFingerprint:audit.executionFingerprint});
   }
   const rejected=z.array(z.object({memberId:z.string(),reason:z.enum(['request-too-large','missing-source'])}).strict()).max(20).parse(output.rejectedMembers);
   const accounted=[...members,...rejected.map(r=>r.memberId)];if(new Set(accounted).size!==accounted.length)invalid();same(accounted.sort(),[...window.memberIds].sort());
  }
 }
 frontier.sort((a,b)=>a.stepId.localeCompare(b.stepId));auditRefs.sort((a,b)=>a.agentRunId.localeCompare(b.agentRunId));
 const receipt={planHash:plan.planHash,batches},result=planMarketKeywordReconciliation({...loaded.basis,rounds:[...loaded.rounds,receipt]});
 return {frontier,frontierHash:digest(frontier),auditRefs,receipt,result};
}
export async function readMarketKeywordReconciliationRound(context:PostgresQueryContext,request:Request&{lastPageAttemptId:string},signal:AbortSignal){
 const loaded=await readMarketKeywordReconciliationPlan(context,request,signal);return {loaded,round:await readRound(context,request,loaded,signal)};
}

/** The audited model outputs and snapshots already persist every decision and
 * quote. Save a small deterministic receipt instead of copying them into one
 * unbounded JSON document. Reads reconstruct and verify the complete result. */
export function createMarketKeywordReconciliationArtifact(loaded:Loaded,inputValue:unknown,round:Awaited<ReturnType<typeof readRound>>){
 const input=MarketKeywordReconciliationEvaluationInputSchema.parse(inputValue);same(input.frontierHash,round.frontierHash);
 const summary={version:MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION,input,completedRound:loaded.plan.round,baseHash:loaded.plan.baseHash,
  initialResultHash:loaded.plan.initialResultHash,beforePlanHash:loaded.plan.planHash,planHash:round.result.planHash,status:round.result.status,
  resultHash:round.result.result?.resultHash??null,frontierHash:round.frontierHash,auditsHash:digest(round.auditRefs),auditCount:round.auditRefs.length,nextWindowCount:round.result.windows.length};
 const {scope,sourceVersion,collectedAt}=loaded.basis.snapshot;
 const factory={scope,kind:'keywords' as const,sourceVersion,ruleVersion:MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION,collectedAt,expectedRecordIds:['summary'],records:[{id:'summary',scope,data:json(summary)}]};
 const snapshot=createMarketInputSnapshot(factory);
 return {factory,snapshot,output:{version:summary.version,inputSnapshotId:snapshot.snapshotId,completedRound:summary.completedRound,anchorHash:digest(input.anchor),frontierHash:summary.frontierHash,status:summary.status,planHash:summary.planHash,resultHash:summary.resultHash}};
}
