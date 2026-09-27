import { z } from 'zod';
import {readThemeSavedImages} from './market-theme-saved-images';
import { MarketThemeReportEntrySchema } from '../../shared/market-module-contracts';
import { MarketInputSnapshotInputSchema } from '../../shared/market-analysis-contracts';
import { MarketThemeSampleMetadataSchema } from '../../shared/market-theme-selection-contracts';
import { MarketThemeReportService } from './market-theme-report-service';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { projectThemeSample } from '../domain/market-research/customer-theme-selection';
import { canonicalJsonSha256 as digest } from '../runtime/model-request-accounting';
import { createMarketInputSnapshot } from '../domain/market-research/snapshot';
import { restoreMarketThemeDetails } from '../domain/market-research/customer-theme-details';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new MarketExecutionConflictError();};
const factory=(s:ReturnType<typeof createMarketInputSnapshot>)=>({scope:s.scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records});
export const ThemeSelectionFactsSchema=z.object({base:MarketThemeReportEntrySchema,snapshot:MarketInputSnapshotInputSchema,priorEvaluations:z.array(MarketInputSnapshotInputSchema).max(100),samples:z.array(MarketThemeSampleMetadataSchema).max(20)}).strict();
export type ThemeSelectionFacts=z.infer<typeof ThemeSelectionFactsSchema>;
export function restoreThemeSelectionFacts(value:unknown){
 const facts=ThemeSelectionFactsSchema.parse(value),snapshot=createMarketInputSnapshot(facts.snapshot),prior=facts.priorEvaluations.map(p=>createMarketInputSnapshot(p));
 const {reportHash,...reportBody}=facts.base.report;same(reportHash,digest(reportBody));same(snapshot.snapshotId,facts.base.report.inputSnapshotId);same(snapshot.scope,facts.base.report.scope);
 const restored=restoreMarketThemeDetails(snapshot,facts.base.report.basis==='empty-selection',prior);same(restored.aggregation.scope.selectedAsins,facts.base.report.selectedAsins);same(facts.samples.map(s=>s.asin),facts.base.report.selectedAsins);
 return {facts,restored};
}
/** Caller holds a run transaction; no connector or model is reachable here. */
export async function loadThemeSelectionFacts(context:PostgresQueryContext,input:{actor:MarketExecutionActor;moduleRunId:string;attemptId:string}){
 const resolved=await new MarketThemeReportService(context).resolveReport(input);if(!resolved)return null;
 const {entry,view,snapshot,priorEvaluations}=resolved,store=new PostgresMarketAnalysisSnapshotStore(context),base={...entry,current:false};
 if(!entry.report.selectedAsins.length)return ThemeSelectionFactsSchema.parse({base,snapshot:factory(snapshot),priorEvaluations:priorEvaluations.map(factory),samples:[]});
 let ruleSnapshot=snapshot;
 if(entry.report.basis==='reconciliation-evaluation'){
  const initialId=obj(obj(snapshot.records.find(r=>r.id==='summary')?.data).input).initialRulesAttemptId;
  const attempt=view.attempts.find(a=>a.id===initialId&&['succeeded','empty'].includes(a.status));if(!attempt)throw new MarketExecutionConflictError();
  const saved=await store.findInput({actor:input.actor,studyId:view.run.scope.researchId,id:z.string().parse(obj(attempt.output).inputSnapshotId)});if(!saved)throw new MarketExecutionConflictError();ruleSnapshot=saved.snapshot;
 }
 const summary=obj(ruleSnapshot.records.find(r=>r.id==='summary')?.data),rawId=z.string().parse(summary.rawInputSnapshotId);
 const pool=view.attempts.filter(a=>['succeeded','empty'].includes(a.status)&&obj(a.output).rawInputSnapshotId===rawId&&obj(a.output).selectionInputSnapshotId!==undefined);
 if(pool.length!==1)throw new MarketExecutionConflictError();const manifest=obj(pool[0].output);
 const selection=await store.findInput({actor:input.actor,studyId:view.run.scope.researchId,id:z.string().parse(manifest.selectionInputSnapshotId)});if(!selection)throw new MarketExecutionConflictError();
 same(selection.snapshot.scope,entry.report.scope);same(manifest.selectedAsins,entry.report.selectedAsins);
 const bindings=z.array(z.object({asin:z.string(),inputSnapshotId:z.string().nullable(),sourceRef:z.string().nullable()}).passthrough()).parse(manifest.bindings);
 const images=await readThemeSavedImages({view,actor:input.actor,store,selectionId:selection.snapshot.snapshotId,cutoff:entry.report.dataCutoffAt,attemptIds:obj(summary.selection).imageAttemptIds});
 const samples=[];
 for(const asin of entry.report.selectedAsins){
  const record=selection.snapshot.records.find(r=>r.id===asin);if(!record)throw new MarketExecutionConflictError();const data=obj(record.data),p=obj(data.product),ref=z.string().parse(data.sourceRef);
  const source=await store.findSource({actor:input.actor,studyId:view.run.scope.researchId,id:ref});if(!source)throw new MarketExecutionConflictError();same(source.evidence.scope,entry.report.scope);
  const sorftime=view.run.versions.planner==='market-theme-flow/rules-v3';
  if(sorftime?(source.evidence.provider!=='sorftime'||source.evidence.operation!=='category_report'):(source.evidence.provider!=='sellerSprite'||source.evidence.operation!=='market_product_concentration'))throw new MarketExecutionConflictError();
  same(source.evidence.requestIdentity.marketplace,entry.report.scope.marketplace);if(Date.parse(source.evidence.fetchedAt)>Date.parse(entry.report.dataCutoffAt))throw new MarketExecutionConflictError();
  if(sorftime)same(source.evidence.requestIdentity.nodeId,entry.report.scope.nodeIdPath.split(':').at(-1));else{same(source.evidence.requestIdentity.month,data.month);same(data.month,entry.report.scope.toMonth);}
  const binding=bindings.find(b=>b.asin===asin);let summarySource:Parameters<typeof projectThemeSample>[0]['summarySource'];
  if(binding?.sourceRef&&binding.inputSnapshotId){const observed=await store.findSource({actor:input.actor,studyId:view.run.scope.researchId,id:binding.sourceRef});const inputSnapshot=await store.findInput({actor:input.actor,studyId:view.run.scope.researchId,id:binding.inputSnapshotId});
   if(!observed||!inputSnapshot)throw new MarketExecutionConflictError();same(observed.evidence.scope,entry.report.scope);same(inputSnapshot.snapshot.scope,entry.report.scope);same(observed.evidence.requestIdentity.asin,asin);same(observed.evidence.requestIdentity.marketplace,entry.report.scope.marketplace);if(observed.evidence.provider!=='sorftime'||observed.evidence.operation!=='product_customers_say'||inputSnapshot.snapshot.kind!=='customer-themes')throw new MarketExecutionConflictError();if(Date.parse(observed.evidence.fetchedAt)>Date.parse(entry.report.dataCutoffAt))throw new MarketExecutionConflictError();same(obj(inputSnapshot.snapshot.records.find(r=>r.id===asin)?.data).sourceRef,binding.sourceRef);
   summarySource={ref:binding.sourceRef,snapshotId:binding.inputSnapshotId,payload:observed.evidence.payload};}
  samples.push(projectThemeSample({asin,sourceIndex:z.number().int().nonnegative().parse(p.sourceIndex),product:p,productSource:{ref,snapshotId:selection.snapshot.snapshotId,payload:source.evidence.payload},summarySource,...(sorftime?{provider:'sorftime' as const,imageSource:images.get(asin)?.source,imageMissingReason:images.get(asin)?.missingReason}:{})}));
 }
 const facts=ThemeSelectionFactsSchema.parse({base,snapshot:factory(snapshot),priorEvaluations:priorEvaluations.map(factory),samples});restoreThemeSelectionFacts(facts);return facts;
}
