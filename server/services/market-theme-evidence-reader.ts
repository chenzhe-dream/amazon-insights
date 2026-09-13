import { z } from 'zod';
import type { MarketExecutionActor, MarketModuleRunView } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import type { MarketInputSnapshot } from '../../shared/market-analysis-contracts';
import { MarketThemeEvidenceSchema } from '../../shared/market-theme-evidence-contracts';
import { MarketCustomerThemeMappingInputSchema, MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import { restoreMarketThemeDetails, MarketThemeDetailQueryError } from '../domain/market-research/customer-theme-details';
import { validateMarketCustomerThemeMapping } from '../domain/market-research/semantic-validation';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { canonicalJsonSha256 as digest } from '../runtime/model-request-accounting';
import { MARKET_THEME_EVALUATION_VERSION } from '../domain/market-research/customer-theme-reconciliation-artifact';
import { restoreMarketThemeEvaluation } from '../domain/market-research/customer-theme-evaluation-reader';
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new MarketExecutionConflictError();};
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);

/** Caller holds the report run's shared lock. Resolve only the report's historical
 * batch/audit, never the newest model attempt and never a client-supplied audit ID. */
export async function readMarketThemeEvidence(context:PostgresQueryContext,actor:MarketExecutionActor,view:MarketModuleRunView,snapshot:MarketInputSnapshot,sourceThemeId:string,emptySelection=false,priorEvaluations:readonly MarketInputSnapshot[]=[]){
  const reconciled=snapshot.ruleVersion===MARKET_THEME_EVALUATION_VERSION?restoreMarketThemeEvaluation(snapshot,priorEvaluations):null;
  if(reconciled&&emptySelection)throw new MarketExecutionConflictError();
  const restored=reconciled??restoreMarketThemeDetails(snapshot,emptySelection,priorEvaluations);
  const member=restored.aggregation.perAsin.flatMap(a=>a.themes).find(t=>t.sourceThemeId===sourceThemeId);
  const decision=restored.decisions.find(d=>d.sourceThemeId===sourceThemeId);if(!member||!decision)throw new MarketThemeDetailQueryError();
  const source={sourceThemeId,asin:member.asin,sourceRecordId:member.sourceRecordId,sourceUpdatedAt:member.sourceUpdatedAt,keyword:member.keyword,content:member.content,sourceKind:'customers-say-summary' as const,decision};
  if(decision.status==='unavailable'){if(decision.batchId!==null)throw new MarketExecutionConflictError();return MarketThemeEvidenceSchema.parse({...source,analysis:null});}
  if(reconciled&&decision.status==='unknown'&&decision.batchId===null)return MarketThemeEvidenceSchema.parse({...source,analysis:null});
  const summary=obj(snapshot.records.find(r=>r.id==='summary')?.data);
  const modelDecision=reconciled?.modelDecisions.find(d=>d.sourceThemeId===sourceThemeId),round=modelDecision?.round==null?null:reconciled!.evidence[modelDecision.round];
  if(reconciled&&!round)throw new MarketExecutionConflictError();
  const batches=round?round.batches:z.array(z.object({batchId:id,batchKey:z.string(),inputDigest:hash,outputDigest:hash}).strict()).max(2000).parse(summary.batches);
  const matches=batches.filter(b=>b.batchId===decision.batchId);if(matches.length!==1)throw new MarketExecutionConflictError();const batch=matches[0];
  const audits=new PostgresMarketAgentRunStore(context),snapshots=new PostgresMarketAnalysisSnapshotStore(context),scope={actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id};
  const binding=await audits.findSnapshotBindingByBatch({...scope,batchId:batch.batchId,inputDigest:batch.inputDigest});if(!binding)throw new MarketExecutionConflictError();
  if(round){same(binding.inputSnapshotId,(batch as {inputSnapshotId:string}).inputSnapshotId);same(modelDecision!.inputDigest,batch.inputDigest);same(modelDecision!.outputDigest,batch.outputDigest);}
  else{same(binding.batchKey,(batch as {batchKey:string}).batchKey);same(binding.inputSnapshotId,summary.semanticInputSnapshotId);same(binding.selectionRevision,summary.selectionRevision);}
  same(binding.dataCutoffAt,snapshot.collectedAt);
  const refs=(round?round.audits:z.array(z.object({agentRunId:id,attemptId:id,bindingId:id,executionFingerprint:hash}).strict()).max(2000).parse(summary.auditRefs)).filter(r=>r.bindingId===binding.id);
  if(refs.length!==1)throw new MarketExecutionConflictError();const ref=refs[0],audit=await audits.findAgentRun({...scope,agentRunId:ref.agentRunId});
  if(!audit||audit.task!=='market-customer-theme-mapping'||audit.terminalStatus!=='succeeded'||audit.validationStatus!=='passed'||!audit.outcome?.output)throw new MarketExecutionConflictError();
  same(audit.attemptId,ref.attemptId);same(audit.bindingId,ref.bindingId);same(audit.executionFingerprint,ref.executionFingerprint);same(digest(audit.outcome.output),batch.outputDigest);
  const attempt=view.attempts.find(a=>a.id===ref.attemptId),step=view.steps.find(s=>s.id===attempt?.stepId);
  if(!attempt||!step||step.kind!=='model-batch'||attempt.status!=='succeeded')throw new MarketExecutionConflictError();
  same(audit.stepId,step.id);same(obj(attempt.output).agentRunId,audit.id);same(obj(attempt.output).bindingId,binding.id);same(obj(attempt.output).executionFingerprint,audit.executionFingerprint);
  same(obj(step.input).bindingId,binding.id);same(obj(step.input).inputDigest,binding.inputDigest);
  const semantic=await snapshots.findInput({actor,studyId:scope.studyId,id:binding.inputSnapshotId});if(!semantic)throw new MarketExecutionConflictError();same(semantic.snapshot.scope,view.run.scope);
  const sources=[];for(const sourceRef of binding.sourceRefs){const item=await snapshots.findSource({actor,studyId:scope.studyId,id:sourceRef});if(!item)throw new MarketExecutionConflictError();sources.push(item);}
  const input=MarketCustomerThemeMappingInputSchema.parse(binding.inputProjection);
  if(round)same(input.mappingMode,'catalog-only');
  const output=validateMarketCustomerThemeMapping(input,audit.outcome.output,{scope:view.run.scope,inputSnapshot:semantic.snapshot,sourceEvidenceByRef:Object.fromEntries(sources.map(s=>[s.id,s.evidence])),
    selectionRevision:binding.selectionRevision,batchKey:binding.batchKey,inputDigest:binding.inputDigest,expectedIds:binding.memberRefs,sourceCatalog:Object.fromEntries(semantic.snapshot.records.map(r=>[r.id,MarketSemanticRecordSchema.parse(obj(r.data).semantic)]))});
  const theme=input.themes.find(t=>t.sourceThemeId===sourceThemeId),result=output.themes.find(t=>t.sourceThemeId===sourceThemeId)?.decision;if(!theme||!result)throw new MarketExecutionConflictError();
  same(theme.asin,member.asin);same(result.status,decision.status);
  for(const field of ['keyword','content'] as const){const observed=theme[field];if(observed.state==='known')same(observed.value.text,member[field]);}
  if(result.status==='unknown')same(result.reason,decision.reason);
  else{const label=restored.labels.find(l=>l.groupId===decision.groupId);if(!label)throw new MarketExecutionConflictError();
    if(result.target.kind==='existing'){same(result.target.groupId,decision.groupId);
      if(round){const group=input.groupCatalog.find(g=>g.groupId===decision.groupId);if(!group)throw new MarketExecutionConflictError();same(group.labelZh,label.labelZh);same(group.definition,label.definition);}
      else same(label.origin,'catalog');}
    else{const proposalId=result.target.proposalId;same(label.origin,'batch-proposal');same(label.batchId,input.batchId);same(label.proposalId,proposalId);const proposal=output.proposals.find(p=>p.proposalId===proposalId);if(!proposal)throw new MarketExecutionConflictError();same(label.labelZh,proposal.labelZh);same(label.definition,proposal.definition);}}
  const fields=[theme.keyword,theme.content].flatMap(f=>f.state==='known'?[f.value]:[]);
  const evidence=result.evidence.map(span=>{const field=fields.find(f=>f.refId===span.refId);if(!field)throw new MarketExecutionConflictError();return {...span,field:field.field,sourceRef:field.sourceRef};});
  return MarketThemeEvidenceSchema.parse({...source,analysis:{agentRunId:audit.id,modelAttemptId:audit.attemptId,bindingId:binding.id,batchId:input.batchId,outputDigest:batch.outputDigest,executionFingerprint:audit.executionFingerprint,
    status:result.status,reason:result.status==='unknown'?result.reason:null,labelZh:result.status==='mapped'?result.labelZh:null,explanationZh:result.status==='mapped'?result.explanationZh:null,evidence}});
}
