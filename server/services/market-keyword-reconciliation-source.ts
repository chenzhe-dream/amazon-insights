import {MarketSemanticRecordSchema,MarketKeywordSemanticsInputSchema} from '../../shared/market-semantic-contracts';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {PostgresMarketAgentRunStore} from '../db/postgres/market-agent-run-store';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import {readMarketKeywordRun} from './market-keyword-read-service';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';

/** Reuse the source/audit replay performed by the public facts reader. No live
 * provider or current model configuration is required to reconstruct this basis.
 * A new trend receipt does not change the semantic basis or discard model work. */
export async function readMarketKeywordReconciliationSource(context:PostgresQueryContext,actor:MarketExecutionActor,moduleRunId:string){
 return context.transaction(async()=>{
  const response=await readMarketKeywordRun(context,actor,moduleRunId);
  if(!response?.run.facts)return null;
  const facts=response.run.facts,scope={actor,studyId:response.run.scope.researchId,moduleRunId};
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),audits=new PostgresMarketAgentRunStore(context);
  const saved=await snapshots.findInput({...scope,id:facts.pool.semanticInputSnapshotId});
  if(!saved||digest(saved.snapshot.scope)!==digest(response.run.scope))throw new MarketExecutionConflictError();
  const sourceIds=new Set<string>();
  for(const record of saved.snapshot.records){
   const semantic=MarketSemanticRecordSchema.parse((record.data as Record<string,unknown>).semantic);
   if(semantic.task!=='market-keyword-semantics')throw new MarketExecutionConflictError();
   sourceIds.add(semantic.keyword.text.sourceRef);
  }
  const sources:Record<string,MarketSourceEvidence>={};
  for(const id of sourceIds){const source=await snapshots.findSource({...scope,id});if(!source)throw new MarketExecutionConflictError();sources[id]=source.evidence;}
  const initialBatches=[];
  for(const batch of facts.semantics.batches){
   const binding=await audits.findSnapshotBinding({...scope,bindingId:batch.bindingId});
   if(!binding||binding.inputSnapshotId!==saved.snapshot.snapshotId||binding.inputDigest!==batch.inputDigest)throw new MarketExecutionConflictError();
   initialBatches.push({input:MarketKeywordSemanticsInputSchema.parse(binding.inputProjection),output:batch.output});
  }
  initialBatches.sort((a,b)=>a.input.batchId<b.input.batchId?-1:a.input.batchId>b.input.batchId?1:0);
  const basis={snapshot:saved.snapshot,sources,initialBatches};
  return {run:response.run,basis,basisHash:digest({snapshotId:saved.snapshot.snapshotId,batches:initialBatches})};
 });
}
