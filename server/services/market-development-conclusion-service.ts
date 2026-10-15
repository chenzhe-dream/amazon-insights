import {z} from 'zod';
import {ConclusionBasisSchema,ConclusionResponseSchema,ConclusionScopeSchema,type ConclusionBasis,type ConclusionEvidence} from '../../shared/market-development-conclusion';
import {MarketLinkedResponseSchema} from '../../shared/market-linked-contracts';
import {MarketThemeSelectionStore} from '../db/postgres/market-theme-selection-store';
import {PostgresMarketProjectFavoritesStore} from '../db/postgres/market-project-favorites-store';
import type {PostgresQueryContext} from '../db/postgres/query-context';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import {MarketModuleServiceError,type MarketModuleService} from './market-module-service';
import {canonicalJsonSha256 as hash} from '../runtime/model-request-accounting';
import {buildDevelopmentConclusion,reviewDevelopmentEvidence} from '../domain/market-research/development-conclusion';
import {toShapeReferenceReport} from '../../app/lib/market-shape-reference-adapter';
import {buildReferenceSynthesisPresentation} from '../../app/market-shape-reference/conclusions/synthesis-presentation';
import type {MarketShapeReferenceRevisionData} from '../../shared/market-shape-reference-revision-contracts';
const scope=(v:{marketplace:string;nodeIdPath:string;fromMonth:string;toMonth:string})=>ConclusionScopeSchema.parse({marketplace:v.marketplace,nodeIdPath:v.nodeIdPath,fromMonth:v.fromMonth,toMonth:v.toMonth});
type Frozen={evidence:ConclusionEvidence;payload:unknown};
type Saved={content_hash:string;saved_at:Date|string;conclusion_json:unknown;inputs_json:unknown};
/** All inputs come from authorized immutable report readers. No connector or model dependencies. */
export class MarketDevelopmentConclusionService{
 constructor(private context:PostgresQueryContext,private modules:MarketModuleService){}
 private async authorize(actor:MarketExecutionActor,basis:ConclusionBasis){
  const user=await this.context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active'",[actor.userId,actor.organizationId]);
  if(!user.rowCount)throw new MarketModuleServiceError(403,'没有读取调研结论的权限');
  if(basis.kind==='linked'){
   const result=await this.context.query<{state_json:unknown}>('SELECT state_json FROM market_linked_batches WHERE id=$1 AND organization_id=$2 AND created_by=$3',[basis.batchId,actor.organizationId,actor.userId]);
   if(!result.rows[0])throw new MarketModuleServiceError(404,'未找到该联动批次');
   return MarketLinkedResponseSchema.parse({batch:result.rows[0].state_json}).batch;
  }
  // Reading a saved conclusion must retain the report's authorization boundary.
  const reader=await new PostgresMarketProjectFavoritesStore(this.context).resolveReadActor(actor,'run',basis.runId);
  const run=await this.modules.findRun(reader,basis.runId);
  if(![run.run.currentReport,run.run.latestSavedReport,...run.run.history].some(e=>e?.attemptId===basis.attemptId))throw new MarketModuleServiceError(404,'未找到该评论报告版本');
  return null;
 }
 private async review(actor:MarketExecutionActor,basis:Extract<ConclusionBasis,{kind:'reviews'}>,latest=false):Promise<Frozen>{
  const reader=await new PostgresMarketProjectFavoritesStore(this.context).resolveReadActor(actor,'run',basis.runId);
  const view=await new MarketThemeSelectionStore(this.context).read({actor:reader,moduleRunId:basis.runId,attemptId:basis.attemptId,...(basis.revisionId?{revisionId:basis.revisionId}:{})});
  if(!view)throw new MarketModuleServiceError(404,'评论样本版本不可用');
  const revision=latest||basis.revisionId?view.revision:null,result=revision?.result??view.baseline;
  const evidence=reviewDevelopmentEvidence({scope:scope(view.base.report.scope),runId:basis.runId,identity:`${basis.attemptId}/${revision?.revisionId??view.base.report.reportHash}`,selectedCount:result.selectedAsins.length,successfulCount:result.asins.filter(a=>a.status==='success').length,requestedCount:view.base.report.counts.requestedCount,
   groups:result.groups.map(g=>{const e=result.evidence.find(e=>e.index===g.index);return {label:g.labelZh??g.sourceLabel?.text??'未命名主题',mention:g.totals.mention,positive:g.totals.positive,negative:g.totals.negative,share:g.topicShare.valuePct,asins:e?.topAsins.map(a=>a.asin)??[],refs:[`${view.base.report.reportHash}/group/${g.index}`,...(e?.members.map(m=>m.sourceThemeId)??[])]};}),
   gaps:[...result.asins.filter(a=>a.status!=='success').map(a=>`${a.asin}：${a.reason??a.status}`),...(result.previewOmittedGroupCount?[`本结论展示主要主题，另有 ${result.previewOmittedGroupCount} 组保留在明细中，不视为不存在`]:[]),...(result.baseSelectionShortfall?['基础样本未达到请求数量']:[]),...(result.excludedAsins.length?[`人工移出 ${result.excludedAsins.length} 个商品，结论仅对应当前所选样本`]:[]),...(result.reconciliationRequired?['主题归并仍待校对']:[]),...(result.unknownCount||result.unavailableCount?['部分主题未完成分类或解释']:[]),...(view.base.report.counts.quarantinedThemeCount?['异常主题已隔离，不参与结论']:[])]});
  return {evidence,payload:{attemptId:basis.attemptId,report:view.base.report,revisionId:revision?.revisionId??null,result}};
 }
 private async module(actor:MarketExecutionActor,module:ConclusionEvidence['module'],id:string):Promise<Frozen>{
  if(module==='themes'){
   const {run}=await this.modules.findRun(actor,id),entry=run.currentReport??run.latestSavedReport;
   if(!entry)return this.missing(module,id,`任务状态 ${run.status}，尚无已保存报告`);
   const result=await this.review(actor,{kind:'reviews',runId:id,attemptId:entry.attemptId,revisionId:null},true);
   if(!run.currentReport){result.evidence.status='partial';result.evidence.gaps.push(`当前任务 ${run.status}；保留旧报告 ${entry.attemptId}`);}
   return result;
  }
  if(module==='overview'){
   const {run}=await this.modules.findOverview(actor,id),entry=run.currentReport??run.latestSavedReport;
   if(!entry)return this.missing(module,id,`任务状态 ${run.status}，尚无已保存报告`);
   const details=await this.modules.overviewDetails(actor,id,entry.attemptId),s=details.numbers.originalSynthesis??details.numbers.chapterSynthesis;
   const gaps=[...(s?.inputGaps??['该历史报告未提供完整六维结论']),...(!run.currentReport?[`当前任务 ${run.status}，使用已保存报告 ${entry.attemptId}`]:[])];
   return {evidence:{module,runId:id,identity:`${entry.attemptId}/${entry.report.reportHash}`,scope:scope(run.scope),status:gaps.length?'partial':'ready',facts:s?.chapters?.map(c=>c.performance)??[],findings:s?[s.summary.finalVerdict,...Object.values(s.summary.sections)]:[],gaps:gaps.slice(0,200),refs:entry.report.sourceRefs.slice(0,300)},payload:details};
  }
  if(module==='keywords'){
   const {run}=await this.modules.findKeywords(actor,id);
   const latest=run.history.at(-1),manual=latest?await this.modules.keywordRevision(actor,id,latest.revisionId):null;
   const estimate=manual?.revision.originalEstimate??run.originalEstimate;
   if(!estimate)return this.missing(module,id,`任务状态 ${run.status}，尚无有效关键词结论`);
   const gaps=[...estimate.notes,...(estimate.report.sampleWarning?[estimate.report.sampleWarning]:[]),...(estimate.report.businessOutputs?.flatMap(o=>o.missing)??[]),...(!['succeeded','partial'].includes(run.status)?[`任务状态 ${run.status}；当前仅保留已存关键词证据`]:[])];
   return {evidence:{module,runId:id,identity:estimate.estimateId,scope:scope(run.scope),status:estimate.report.status==='ok'&&run.status==='succeeded'?'ready':'partial',facts:[`有效关键词 ${estimate.report.scope.sampleCount}/${estimate.totalKeywordCount}，趋势补全 ${estimate.report.scope.trendEnrichedCount}；搜索量口径为来源页面，未确认月份不得当作参考月。`],findings:[estimate.report.synthesis.headline,...Object.values(estimate.report.dimensions).map(d=>d.conclusion)],gaps:[...new Set(gaps)].slice(0,200),refs:[estimate.factsId,...(estimate.classificationId?[estimate.classificationId]:[])]},payload:estimate};
  }
  const {run}=await this.modules.findShapes(actor,id);
  let data:MarketShapeReferenceRevisionData|null=null,selected:string[]|undefined,assignments:Record<string,string>={},identity:string|null=null;
  if(run.referenceRevision){const saved=await this.modules.shapeRevision(actor,id,run.referenceRevision.revisionId);if('data' in saved.revision){data=saved.revision.data;selected=saved.revision.selectedAsins;assignments=Object.fromEntries(saved.revision.assignments.map(a=>[a.asin,a.label??'']));identity=saved.revision.revisionId;}}
  else if(run.source?.sorftimePool&&run.source.productHistory&&run.source.productAmountHistory&&run.categoryDashboard){
   data={calculationVersion:'shape-all-links/3',scope:run.scope,pool:run.source.sorftimePool,productHistory:run.source.productHistory,productAmountHistory:run.source.productAmountHistory,categoryDashboard:run.categoryDashboard};identity=hash(data);
  }
  if(!data)return this.missing(module,id,`任务状态 ${run.status}，尚无可复核的形态价格带报告`);
  const summary=buildReferenceSynthesisPresentation(toShapeReferenceReport(data),assignments,selected);
  return {evidence:{module,runId:id,identity,scope:scope(data.scope),status:summary.score===null?'partial':'ready',facts:[summary.sampleScope,summary.summary,...summary.moduleSections.map(s=>`${s.title}：${s.text}`)],findings:[summary.finalVerdict,...summary.opportunities],gaps:[...summary.risks,...(!run.referenceRevision?['当前使用来源基准，未合入未冻结的工作草稿；人工标注需保存报告版本后参与统一结论']:[])].slice(0,200),refs:[identity!]},payload:{data,assignments,selectedAsins:selected??data.pool.products.map(p=>p.asin),summary}};
 }
 private missing(module:ConclusionEvidence['module'],runId:string|null,reason:string):Frozen{return {evidence:{module,runId,identity:null,scope:null,status:'missing',facts:[],findings:[],gaps:[reason],refs:[]},payload:null};}
 async read(actor:MarketExecutionActor,rawBasis:unknown,snapshot?:string){
  const basis=ConclusionBasisSchema.parse(rawBasis),batch=await this.authorize(actor,basis);
  const rows=await this.context.query<Saved>('SELECT content_hash,saved_at,conclusion_json,inputs_json FROM market_development_conclusions WHERE organization_id=$1 AND created_by=$2 AND basis_hash=$3 ORDER BY saved_at DESC LIMIT 100',[actor.organizationId,actor.userId,hash(basis)]);
  const history=rows.rows.map(r=>({contentHash:r.content_hash,savedAt:new Date(r.saved_at).toISOString()}));
  if(snapshot){
   z.string().regex(/^[a-f0-9]{64}$/).parse(snapshot);
   const found=rows.rows.find(r=>r.content_hash===snapshot)??(await this.context.query<Saved>('SELECT content_hash,saved_at,conclusion_json,inputs_json FROM market_development_conclusions WHERE organization_id=$1 AND created_by=$2 AND basis_hash=$3 AND content_hash=$4',[actor.organizationId,actor.userId,hash(basis),snapshot])).rows[0];
   if(!found)throw new MarketModuleServiceError(404,'未找到该冻结结论');
   if(hash({basis,conclusion:found.conclusion_json,inputs:found.inputs_json})!==snapshot)throw new MarketExecutionConflictError();
   return {response:ConclusionResponseSchema.parse({basis,contentHash:snapshot,conclusion:found.conclusion_json,savedAt:new Date(found.saved_at).toISOString(),history}),inputs:found.inputs_json};
  }
  const inputs:Frozen[]=[];
  if(basis.kind==='reviews')inputs.push(await this.review(actor,basis));
  else for(const module of ['overview','shapes','keywords','themes'] as const){
   const state=batch!.modules[module];
   if(!state.runId){inputs.push(this.missing(module,null,state.message??`模块 ${state.status}，尚无报告`));continue;}
   // A broken module must not hide the valid conclusions of the other three.
   try{inputs.push(await this.module(actor,module,state.runId));}
   catch(error){if(error instanceof MarketModuleServiceError&&error.statusCode===403)throw error;inputs.push(this.missing(module,state.runId,error instanceof MarketModuleServiceError?error.message:'已保存报告校验失败，当前模块未纳入结论，请核对其历史版本'));}
  }
  const target=basis.kind==='reviews'?inputs[0].evidence.scope!:scope({marketplace:batch!.request.scope.marketplace,nodeIdPath:batch!.resolvedNodeIdPath??batch!.request.scope.nodeQuery,fromMonth:batch!.request.fromMonth,toMonth:batch!.request.scope.month});
  const conclusion=buildDevelopmentConclusion(basis.kind,target,inputs.map(i=>i.evidence)),contentHash=hash({basis,conclusion,inputs});
  return {response:ConclusionResponseSchema.parse({basis,contentHash,conclusion,savedAt:history.find(h=>h.contentHash===contentHash)?.savedAt??null,history}),inputs};
 }
 async save(actor:MarketExecutionActor,basis:ConclusionBasis,expectedHash:string){
  return this.context.transaction(async()=>{
   const value=await this.read(actor,basis);
   if(value.response.contentHash!==expectedHash)throw new MarketExecutionConflictError();
   await this.context.query('INSERT INTO market_development_conclusions(organization_id,created_by,basis_hash,content_hash,basis_json,conclusion_json,inputs_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) ON CONFLICT DO NOTHING',[actor.organizationId,actor.userId,hash(basis),expectedHash,JSON.stringify(basis),JSON.stringify(value.response.conclusion),JSON.stringify(value.inputs)]);
   return (await this.read(actor,basis,expectedHash)).response;
  });
 }
}
