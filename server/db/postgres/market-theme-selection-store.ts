import {marketSharedReadSql} from './market-shared-read-sql';
import { z } from 'zod';
import { MarketModuleIdSchema } from '../../../shared/market-module-contracts';
import { MarketThemeSelectionRequestSchema, MarketThemeSelectionRevisionSchema, MarketThemeSelectionRevisionIdSchema, MarketThemeSelectionResponseSchema } from '../../../shared/market-theme-selection-contracts';
import { PostgresQueryContext } from './query-context';
import { MarketExecutionConflictError, type MarketExecutionActor } from '../market-module-execution-repository';
import { loadThemeSelectionFacts, restoreThemeSelectionFacts, type ThemeSelectionFacts } from '../../services/market-theme-selection-facts';
import { deriveThemeSelection } from '../../domain/market-research/customer-theme-selection';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
type Identity={actor:MarketExecutionActor;moduleRunId:string;attemptId:string};
type Row={organization_id:string;study_id:string;run_id:string;base_attempt_id:string;revision_id:string;parent_revision_id:string|null;ordinal:number;stored_by:string;stored_at:Date|string;idempotency_key:string;request_json:unknown;request_hash:string;facts_json:unknown;facts_hash:string;revision_json:unknown};
const invalid=():never=>{throw new MarketExecutionConflictError();};
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
function revision(facts:ThemeSelectionFacts,request:z.infer<typeof MarketThemeSelectionRequestSchema>,authorId:string,createdAt:string,ordinal:number,algorithmVersion:'v1'|'v2'|'v3'){
 if(request.baseReportHash!==facts.base.report.reportHash)invalid();const restored=restoreThemeSelectionFacts(facts).restored;
 const result=deriveThemeSelection(restored,request.excludedAsins,facts.base.report.counts.reconciliationRequired,facts.base.report.counts.selectedCount<facts.base.report.counts.requestedCount,algorithmVersion!=='v1',algorithmVersion==='v3'),resultHash=digest(result);
 const value={parentRevisionId:request.expectedParentRevisionId,ordinal,authorId,createdAt,baseReportAttemptId:facts.base.attemptId,baseReportHash:request.baseReportHash,note:request.note,result,resultHash};
 return MarketThemeSelectionRevisionSchema.parse({...value,revisionId:`market-theme-selection-revision:${digest({version:`market-theme-selection-revision/${algorithmVersion}`,factsHash:digest(facts),...value})}`});
}
/** No runtime, connector, model or execution enqueue dependency. */
export class MarketThemeSelectionStore{
 constructor(private readonly context:PostgresQueryContext){}
 private async authorize(input:Identity,write=false){
  MarketModuleIdSchema.parse(input.moduleRunId);MarketModuleIdSchema.parse(input.attemptId);z.string().uuid().parse(input.actor.organizationId);z.string().uuid().parse(input.actor.userId);
  const active=write?await this.context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[input.actor.userId,input.actor.organizationId]):null;if(write&&!active?.rowCount)return null;
  const rows=await this.context.query<{study_id:string;status:string}>(`SELECT r.study_id,r.status FROM market_analysis_module_runs r WHERE r.id=$1 AND r.organization_id=$2 AND r.request_json->>'moduleKind'='customer-themes' AND ${write?"EXISTS(SELECT 1 FROM users u WHERE u.id=$3 AND u.organization_id=$2 AND u.status='active')":marketSharedReadSql('$3','r.organization_id',{run:'r.id'})} FOR ${write?'UPDATE':'SHARE'}`,[input.moduleRunId,input.actor.organizationId,input.actor.userId]);return rows.rows[0]??null;
 }
 private restore(input:Identity,row:Row){
  try{
   if(row.organization_id!==input.actor.organizationId||row.run_id!==input.moduleRunId||row.base_attempt_id!==input.attemptId)invalid();
   const request=MarketThemeSelectionRequestSchema.parse(row.request_json),facts=restoreThemeSelectionFacts(row.facts_json).facts;
   same(facts.base.report.scope.organizationId,row.organization_id);same(facts.base.report.scope.researchId,row.study_id);same(facts.base.report.moduleRunId,row.run_id);same(facts.base.attemptId,row.base_attempt_id);
   same(row.request_hash,digest({actor:{organizationId:row.organization_id,userId:row.stored_by},moduleRunId:row.run_id,attemptId:row.base_attempt_id,request}));same(row.facts_hash,digest(facts));same(row.request_json,request);
   const versions=facts.base.report.versions.planner==='market-theme-flow/rules-v3'?['v3'] as const:facts.base.report.semanticStatus==='skipped'?['v2','v1'] as const:['v1'] as const;
   const saved=versions.map(version=>revision(facts,request,row.stored_by,new Date(row.stored_at).toISOString(),row.ordinal,version)).find(candidate=>candidate.revisionId===row.revision_id)??invalid();
   same(saved,row.revision_json);same(saved.parentRevisionId,row.parent_revision_id);
   return {facts,revision:saved};
  }catch{return invalid();}
 }
 private async rows(input:Identity){return (await this.context.query<Row>('SELECT * FROM market_theme_selection_revisions WHERE organization_id=$1 AND run_id=$2 AND base_attempt_id=$3 ORDER BY ordinal',[input.actor.organizationId,input.moduleRunId,input.attemptId])).rows;}
 private view(input:Identity,facts:ThemeSelectionFacts,rows:Row[],selected:string|null){
  let parent:string|null=null;const revisions=rows.map((row,index)=>{const checked=this.restore(input,row);if(row.ordinal!==index+1||row.parent_revision_id!==parent)invalid();same(checked.facts,facts);parent=row.revision_id;return checked.revision;});
  const chosen=selected?revisions.find(r=>r.revisionId===selected):null;if(selected&&!chosen)invalid();
  return MarketThemeSelectionResponseSchema.parse({version:'market-theme-selection-view/v1',base:facts.base,samples:facts.samples,baseline:deriveThemeSelection(restoreThemeSelectionFacts(facts).restored,[],facts.base.report.counts.reconciliationRequired,facts.base.report.counts.selectedCount<facts.base.report.counts.requestedCount,facts.base.report.semanticStatus==='skipped',facts.base.report.versions.planner==='market-theme-flow/rules-v3'),latestRevisionId:parent,revision:chosen,history:revisions.map(({revisionId,ordinal,createdAt,resultHash})=>({revisionId,ordinal,createdAt,resultHash}))});
 }
 async read(input:Identity&{revisionId?:string}){
  if(input.revisionId)MarketThemeSelectionRevisionIdSchema.parse(input.revisionId);
  return this.context.transaction(async()=>{if(!await this.authorize(input))return null;const rows=await this.rows(input);
   if(input.revisionId&&!rows.some(r=>r.revision_id===input.revisionId))return null;
   const facts=rows.length?this.restore(input,rows[0]).facts:await loadThemeSelectionFacts(this.context,input);if(!facts)return null;
   return this.view(input,facts,rows,input.revisionId??rows.at(-1)?.revision_id??null);
  });
 }
 async save(input:Identity&{idempotencyKey:string;request:unknown}){
  const request=MarketThemeSelectionRequestSchema.parse(input.request),key=MarketModuleIdSchema.parse(input.idempotencyKey),requestHash=digest({actor:input.actor,moduleRunId:input.moduleRunId,attemptId:input.attemptId,request});
  try{return await this.context.transaction(async()=>{
   const run=await this.authorize(input,true);if(!run)throw new MarketExecutionConflictError();
   const prior=(await this.context.query<Row>('SELECT * FROM market_theme_selection_revisions WHERE organization_id=$1 AND idempotency_key=$2',[input.actor.organizationId,key])).rows[0];
   if(prior){if(prior.request_hash!==requestHash||prior.stored_by!==input.actor.userId)invalid();const checked=this.restore(input,prior);return {created:false,view:this.view(input,checked.facts,await this.rows(input),prior.revision_id)};}
   if(run.status==='cancelled')invalid();const rows=await this.rows(input),last=rows.at(-1);if((last?.revision_id??null)!==request.expectedParentRevisionId||rows.length>=1000)invalid();
   const facts=rows.length?this.restore(input,rows[0]).facts:await loadThemeSelectionFacts(this.context,input);if(!facts)throw new MarketExecutionConflictError();if(rows.length)this.view(input,facts,rows,last!.revision_id);
   const now=new Date().toISOString(),saved=revision(facts,request,input.actor.userId,now,rows.length+1,facts.base.report.versions.planner==='market-theme-flow/rules-v3'?'v3':facts.base.report.semanticStatus==='skipped'?'v2':'v1');
   const inserted=await this.context.query<Row>(`INSERT INTO market_theme_selection_revisions(organization_id,study_id,run_id,base_attempt_id,revision_id,parent_revision_id,ordinal,stored_by,stored_at,idempotency_key,request_json,request_hash,facts_json,facts_hash,revision_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15::jsonb) RETURNING *`,[input.actor.organizationId,run.study_id,input.moduleRunId,input.attemptId,saved.revisionId,saved.parentRevisionId,saved.ordinal,input.actor.userId,now,key,JSON.stringify(request),requestHash,JSON.stringify(facts),digest(facts),JSON.stringify(saved)]);
   return {created:true,view:this.view(input,facts,[...rows,inserted.rows[0]],saved.revisionId)};
  });}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23505')invalid();throw error;}
 }
}
