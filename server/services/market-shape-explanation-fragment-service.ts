import { z } from 'zod';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { createMarketInputSnapshot } from '../domain/market-research/snapshot';
import { collectMarketShapeExplanationFragments, validateMarketShapeExplanationFragment } from '../domain/market-research/shape-explanation-fragments';
import { decodeMarketShapeExplanationWindows } from '../domain/market-research/shape-explanation-wire';
import { loadMarketShapeExplanationCatalog } from './market-shape-explanation-input-service';
import { canonicalJsonSha256 as digest } from '../runtime/model-request-accounting';
import type {MarketShapeExplanationFragmentOutput,MarketShapeExplanationFragmentResult} from '../../shared/market-shape-explanation-fragment-contracts';

const task = 'market-shape-structure-explanation' as const;
const windowManifestSchema = z.discriminatedUnion('manifestVersion',[z.object({manifestVersion:z.literal('shape-explanation-windows/v1'),explanationCatalogId:z.string(),revisionId:z.string(),windows:z.array(z.unknown()).min(1)}).strict(),z.object({manifestVersion:z.literal('shape-explanation-windows/v2'),sourceRefs:z.array(z.string()).min(1),explanationCatalogId:z.string(),revisionId:z.string(),windows:z.array(z.unknown()).min(1)}).strict()]);
const batchManifestSchema = z.object({plannerVersion:z.string(),basisHash:z.string(),task:z.literal(task),inputSnapshotId:z.string(),expectedMemberIds:z.array(z.string()),missingMemberIds:z.array(z.string()),rejectedMembers:z.array(z.unknown()),batches:z.array(z.object({bindingId:z.string().uuid(),batchKey:z.string(),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),memberRefs:z.array(z.string())}).strict())}).strict();
const auditRefSchema = z.object({agentRunId:z.string().uuid(),bindingId:z.string().uuid(),task:z.literal(task),executionFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const fail=():never=>{throw new MarketExecutionConflictError();};
const one=<T>(values:T[]):T=>values.length===1?values[0]:fail();
const errorCode=(value:unknown):'timeout'|'invalid-output'|'budget'|'configuration'|'cancelled'|'internal'=>{
 const code=(value&&typeof value==='object'&&(value as any).code)||'';
 if(code==='timeout'||code==='AGENT_SERVICE_TIMEOUT')return 'timeout';
 if(code==='invalid-data'||code==='MODEL_OUTPUT_ERROR'||String(code).includes('VALIDATION'))return 'invalid-output';
 if(code==='governance'||String(code).includes('BUDGET'))return 'budget';
 if(code==='authentication'||String(code).includes('CONFIGURATION'))return 'configuration';
 if(code==='cancelled'||code==='CANCELLED')return 'cancelled';return 'internal';
};

export type MarketShapeExplanationWindowRecovery=
 | {windowId:string;status:'pending';retryStepId:null}
 | {windowId:string;status:'failed';errorCode:'timeout'|'invalid-output'|'budget'|'configuration'|'cancelled'|'internal';retryStepId:string|null}
 | {windowId:string;status:'succeeded';retryStepId:null;output:MarketShapeExplanationFragmentOutput};
export type MarketShapeExplanationFragmentRecovery={moduleRunId:string;explanationCatalogId:string;revisionId:string;
 status:'preparing'|'pending'|'partial'|'ready-for-synthesis'|'cancelled';retryStepId:string|null;errorCode?:ReturnType<typeof errorCode>;
 windows:MarketShapeExplanationWindowRecovery[];synthesisStatus:'not-started';fragments?:ReturnType<typeof collectMarketShapeExplanationFragments>};

/** Read-only recovery of native per-window A2 model results. A complete set of
 * fragments only makes synthesis eligible; it is never a final report. */
export async function readMarketShapeExplanationFragments(context:PostgresQueryContext,input:{actor:MarketExecutionActor;moduleRunId:string}):Promise<MarketShapeExplanationFragmentRecovery>{
 return context.transaction(async()=>{
  const lock=await context.query(`SELECT r.id FROM market_analysis_module_runs r JOIN users u ON u.id=$3 AND u.organization_id=r.organization_id AND u.status='active'
    WHERE r.id=$1 AND r.organization_id=$2 FOR SHARE OF r`,[input.moduleRunId,input.actor.organizationId,input.actor.userId]);if(lock.rowCount!==1)throw new MarketExecutionConflictError();
  const found=await new PostgresMarketModuleExecutionStore(context).findModuleRun(input);if(!found)throw new MarketExecutionConflictError();const view=found;
  const catalog=await loadMarketShapeExplanationCatalog(context,input.actor,input.moduleRunId);
  const anchor=one(view.steps.filter(s=>s.kind==='prepare-members'&&(s.input as any)?.phase==='prepare-shape-explanation'));
  const anchorAttempt=view.attempts.find(a=>a.id===anchor.latestAttemptId);
  if(!anchorAttempt||!['succeeded','empty'].includes(anchorAttempt.status)){
   const terminal=anchor.status==='failed'||anchor.status==='cancelled',cancelled=view.run.status==='cancelled';
   return Object.freeze({moduleRunId:view.run.id,explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,status:cancelled?'cancelled':terminal?'partial':'preparing',retryStepId:!cancelled&&anchor.status==='failed'?anchor.id:null,...(terminal?{errorCode:errorCode(anchorAttempt?.error)}:{}),windows:[],synthesisStatus:'not-started'});
  }
  if(anchorAttempt.status!=='succeeded')fail();
  const manifest=windowManifestSchema.parse(anchorAttempt.output);
  if(manifest.explanationCatalogId!==catalog.explanationCatalogId||manifest.revisionId!==catalog.revisionId)fail();
  if(manifest.manifestVersion==='shape-explanation-windows/v2'&&digest(manifest.sourceRefs)!==digest(catalog.source.sourceRefs))fail();
  const windows=manifest.windows as any[];decodeMarketShapeExplanationWindows(catalog,windows);
  const audits=new PostgresMarketAgentRunStore(context),results:MarketShapeExplanationFragmentResult[]=[];const statuses=new Map<string,MarketShapeExplanationWindowRecovery>();
  const successful:Array<{window:any;snapshot:any;batch:any;model:any;attempt:any;ref:z.infer<typeof auditRefSchema>}>=[];
  for(const window of windows){
   const snapshot=createMarketInputSnapshot({scope:view.run.scope,kind:'overview',sourceVersion:catalog.version,ruleVersion:'shape-explanation/v1',collectedAt:catalog.source.dataCutoffAt,expectedRecordIds:[window.windowId],records:[{id:window.windowId,scope:view.run.scope,data:{semantic:{task,window,sourceRefs:catalog.source.sourceRefs}}}]});
   const prepare=one(view.steps.filter(s=>s.kind==='prepare-model-batches'&&(s.input as any)?.inputSnapshotId===snapshot.snapshotId));
   const pa=view.attempts.find(a=>a.id===prepare.latestAttemptId);
   if(!pa||!['succeeded','empty','failed','cancelled'].includes(pa.status)){statuses.set(window.windowId,{windowId:window.windowId,status:'pending',retryStepId:null});continue;}
   if(pa.status==='failed'||pa.status==='cancelled'){const code=errorCode(pa.error);results.push({windowId:window.windowId,status:'failed',errorCode:code});statuses.set(window.windowId,{windowId:window.windowId,status:'failed',errorCode:code,retryStepId:view.run.status!=='cancelled'&&pa.status==='failed'?prepare.id:null});continue;}
   if(pa.status!=='succeeded')fail();
   const pm=batchManifestSchema.parse(pa.output);
   if(pm.inputSnapshotId!==snapshot.snapshotId||digest(pm.expectedMemberIds)!==digest([window.windowId])||pm.missingMemberIds.length||pm.rejectedMembers.length||pm.batches.length!==1||digest(pm.batches[0].memberRefs)!==digest([window.windowId]))fail();
   const batch=pm.batches[0],model=one(view.steps.filter(s=>s.kind==='model-batch'&&(s.input as any)?.bindingId===batch.bindingId&&(s.input as any)?.inputDigest===batch.inputDigest));
   const ma=view.attempts.find(a=>a.id===model.latestAttemptId);
   if(!ma||!['succeeded','empty','failed','cancelled'].includes(ma.status)){statuses.set(window.windowId,{windowId:window.windowId,status:'pending',retryStepId:null});continue;}
   if(ma.status==='failed'||ma.status==='cancelled'){const code=errorCode(ma.error);results.push({windowId:window.windowId,status:'failed',errorCode:code});statuses.set(window.windowId,{windowId:window.windowId,status:'failed',errorCode:code,retryStepId:view.run.status!=='cancelled'&&ma.status==='failed'?model.id:null});continue;}
   if(ma.status!=='succeeded')fail();
   successful.push({window,snapshot,batch,model,attempt:ma,ref:auditRefSchema.parse(ma.output)});
  }
  const auditRows=await audits.listAgentRuns({actor:input.actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id}),auditById=new Map(auditRows.map(audit=>[audit.id,audit]));
  const bindings=successful.length?await audits.findShapeWindowBindings({actor:input.actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id,bindingIds:successful.map(item=>item.ref.bindingId)}):[];
  for(let index=0;index<successful.length;index++){
   const {window,snapshot,batch,model,attempt:ma,ref}=successful[index],audit=auditById.get(ref.agentRunId),binding=bindings[index];
   if(!audit||!binding)throw new MarketExecutionConflictError();
   if(audit.attemptId!==ma.id||audit.stepId!==model.id||audit.bindingId!==ref.bindingId||audit.executionFingerprint!==ref.executionFingerprint||audit.validationStatus!=='passed'||audit.terminalStatus!=='succeeded'||!audit.outcome?.output||binding.inputSnapshotId!==snapshot.snapshotId||binding.selectionRevision!==catalog.revisionId||binding.inputDigest!==batch.inputDigest||digest(binding.memberRefs)!==digest([window.windowId]))fail();
   const semantic=audit.outcome!.output as any;
   if(semantic.task!==task||semantic.inputDigest!==binding.inputDigest||semantic.batchId!==(binding.inputProjection as any).batchId||!semantic.fragment)fail();
   const fragment=validateMarketShapeExplanationFragment(catalog,window,semantic.fragment);
   results.push({windowId:window.windowId,status:'succeeded',output:fragment});statuses.set(window.windowId,{windowId:window.windowId,status:'succeeded',retryStepId:null,output:fragment});
  }
  const collected=collectMarketShapeExplanationFragments(catalog,windows,results);
  return Object.freeze({moduleRunId:view.run.id,explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,status:view.run.status==='cancelled'?'cancelled':collected.status,retryStepId:null,windows:windows.map(window=>statuses.get(window.windowId)??fail()),fragments:collected,synthesisStatus:'not-started' as const});
 });
}
