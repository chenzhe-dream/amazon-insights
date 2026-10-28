import {createHash} from 'node:crypto';
import {z} from 'zod';
import {MarketLinkedRequestSchema,MarketLinkedRetrySchema,MarketLinkedResponseSchema,linkedModules,linkedModuleParams,type MarketLinkedBatch,type LinkedModule} from '../../shared/market-linked-contracts';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {marketSiteCurrency} from '../../shared/market-sites';
import {assertMarketProductQueryWindow} from '../../shared/market-product-source-policy';
import {canonicalJsonSha256} from '../runtime/model-request-accounting';
import type {PostgresQueryContext} from '../db/postgres/query-context';
import type {MarketExecutionActor} from '../db/market-module-execution-repository';
import {MarketModuleServiceError,type MarketModuleService} from './market-module-service';
import type {MarketResearchService} from './market-research-service';
import {findLinkedBasicHistory,findLinkedModuleHistory,marketModuleQueryLock} from './market-linked-history';

type Row={id:string;organization_id:string;created_by:string;request_hash:string;state_json:unknown};
// Versioned, deterministic UUID command identities survive restarts and ACK loss.
function command(id:string,part:string){const hash=createHash('sha256').update(`market-linked/v1:${id}:${part}`).digest('hex');return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
export class MarketLinkedService{
 private timer:ReturnType<typeof setInterval>|null=null;
 private running:Promise<void>|null=null;
 constructor(private deps:{context:PostgresQueryContext;research:MarketResearchService;modules:MarketModuleService;now?:()=>Date;onError?:()=>void}){}
 private async authorize(actor:MarketExecutionActor){const user=await this.deps.context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active'",[actor.userId,actor.organizationId]);if(!user.rowCount)throw new MarketModuleServiceError(403,'没有该组织的市场调研权限');}
 private parse(row:Row){return MarketLinkedResponseSchema.parse({batch:row.state_json});}
 async find(actor:MarketExecutionActor,id:string){await this.authorize(actor);MarketModuleIdSchema.parse(id);const row=await this.deps.context.query<Row>('SELECT * FROM market_linked_batches WHERE id=$1 AND organization_id=$2 AND created_by=$3',[id,actor.organizationId,actor.userId]);if(!row.rows[0])throw new MarketModuleServiceError(404,'未找到该联动分析批次');return this.parse(row.rows[0]);}
 async create(actor:MarketExecutionActor,body:unknown,key:unknown){
  const request=MarketLinkedRequestSchema.parse(body),id=MarketModuleIdSchema.parse(key),hash=canonicalJsonSha256(request);
  return this.deps.context.transaction(async()=>{
   await this.authorize(actor);
   // Serialize only this command, before creating its base job. All operations here are local DB work.
   await this.deps.context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`market-linked:${id}`]);
   const previous=await this.deps.context.query<Row>('SELECT * FROM market_linked_batches WHERE id=$1',[id]);
   if(previous.rows[0]){const row=previous.rows[0];if(row.organization_id!==actor.organizationId||row.created_by!==actor.userId||row.request_hash!==hash)throw new MarketModuleServiceError(400,'联动请求标识与范围不一致，请重新提交');return this.parse(row);}
   try{assertMarketProductQueryWindow({fromMonth:request.fromMonth,toMonth:request.scope.month},this.deps.now?.()??new Date());}catch(error){if(error instanceof RangeError)throw new MarketModuleServiceError(400,error.message);throw error;}
   const identity=canonicalJsonSha256({organizationId:actor.organizationId,...request,scope:{...request.scope,nodeQuery:request.scope.nodeQuery.split(':').at(-1)}});
   await this.deps.context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`linked-scope:${identity}`]);
   const candidates=request.forceRefresh?[]:await findLinkedBasicHistory(this.deps.context,actor,request);
   let saved:Awaited<ReturnType<MarketResearchService['find']>>|null=null;
   for(const candidate of candidates){
    try{const found=await this.deps.research.find(actor,candidate.id);if(found.report){saved=found;break;}}
    catch(error){if(!(error instanceof z.ZodError)&&!(error instanceof Error&&error.message==='Stored market research data failed integrity validation'))throw error;}
   }
   const job=saved??(await this.deps.research.create(actor,request.scope,command(id,'basic'))).job;
   if(request.forceRefresh)await this.deps.context.query('INSERT INTO sorftime_source_refresh_scopes(job_id,not_before) VALUES($1,$2) ON CONFLICT(job_id) DO NOTHING',[job.id,(this.deps.now?.()??new Date()).toISOString()]);
   const batch:MarketLinkedBatch={id,request,basicJobId:job.id,basicRetryable:false,status:'pending',message:'正在获取类目基础数据和名称，完成后自动启动四个模块。',categoryName:null,resolvedNodeIdPath:null,modules:{overview:{status:'pending',runId:null,message:null},shapes:{status:'pending',runId:null,message:null},keywords:{status:'pending',runId:null,message:null},themes:{status:'pending',runId:null,message:null}}};
   await this.deps.context.query('INSERT INTO market_linked_batches(id,organization_id,created_by,request_json,request_hash,basic_job_id,state_json) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)',[id,actor.organizationId,actor.userId,JSON.stringify(request),hash,job.id,JSON.stringify(batch)]);
   await this.advanceBatch({id,organization_id:actor.organizationId,created_by:actor.userId,request_hash:hash,state_json:batch});
   return this.find(actor,id);
  });
 }
 async retry(actor:MarketExecutionActor,id:string,body:unknown){
  const request=MarketLinkedRetrySchema.parse(body);MarketModuleIdSchema.parse(id);
  return this.deps.context.transaction(async()=>{
   await this.authorize(actor);await this.deps.context.query('SELECT id FROM market_linked_batches WHERE id=$1 AND organization_id=$2 AND created_by=$3 FOR UPDATE',[id,actor.organizationId,actor.userId]);
   const {batch}=await this.find(actor,id);
   if(request.basic){const job=await this.deps.research.find(actor,batch.basicJobId);if(job.status==='failed'){if(!job.error?.retryable||job.attempts>=3)throw new MarketModuleServiceError(400,'该基础采集无法继续重试，请先处理错误原因，再重新筛选市场创建新批次');await this.deps.research.retry(actor,job.id);}batch.basicRetryable=false;for(const module of ['overview','keywords'] as const){if(batch.modules[module].status==='blocked')batch.modules[module]={status:'pending',runId:null,message:null};}}
   for(const module of request.modules){if(['failed','blocked'].includes(batch.modules[module].status))batch.modules[module]={status:'pending',runId:null,message:null};}
   batch.status='pending';batch.message='正在恢复未启动的模块，已启动的任务保持不变。';await this.save(batch,true);return {batch};
  });
 }
 private async save(batch:MarketLinkedBatch,pending:boolean){await this.deps.context.query('UPDATE market_linked_batches SET state_json=$2::jsonb,pending=$3,updated_at=clock_timestamp() WHERE id=$1',[batch.id,JSON.stringify(batch),pending]);}
 start(){if(this.timer)return;const poll=()=>void this.tick().catch(()=>this.deps.onError?.());this.timer=setInterval(poll,2000);this.timer.unref();poll();}
 async stop(){if(this.timer)clearInterval(this.timer);this.timer=null;await this.running;}
 tick(){if(this.running)return this.running;this.running=this.advance().finally(()=>{this.running=null;});return this.running;}
 private async advance(){
  await this.deps.context.transaction(async()=>{
   // A transaction lock fences multiple processes; crash rolls back module commands and receipt together.
   const rows=await this.deps.context.query<Row>('SELECT b.* FROM market_linked_batches b WHERE b.pending ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1');
   if(rows.rows[0])await this.advanceBatch(rows.rows[0]);
  });
 }
 private async advanceBatch(row:Row){
   const {batch}=this.parse(row),actor={organizationId:row.organization_id,userId:row.created_by};
   try{await this.authorize(actor);}catch{batch.status='failed';batch.message='原任务用户当前没有分析权限，请联系管理员。';await this.save(batch,false);return;}
   const job=await this.deps.research.find(actor,batch.basicJobId),scope=batch.request.scope;
   const basicWaiting=['queued','running'].includes(job.status);
   batch.basicStatus=job.status;batch.basicRetryable=job.status==='failed'&&!!job.error?.retryable&&job.attempts<3;
   batch.basicMessage=basicWaiting?'正在等待卖家精灵基础类目数据；独立模块继续执行。':job.error?.message??null;
   const report=job.report;
   const validReport=!!report&&(report.nodeIdPath===scope.nodeQuery||!scope.nodeQuery.includes(':')&&report.nodeId===scope.nodeQuery)
    &&canonicalJsonSha256({...report.scope,nodeQuery:report.nodeId})===canonicalJsonSha256({...scope,nodeQuery:scope.nodeQuery.split(':').at(-1)});
   if(report&&!validReport)batch.basicMessage='基础数据的类目或站点与联动范围不一致，总览保留待补。';
   if(validReport){batch.resolvedNodeIdPath=report.nodeIdPath;if(this.validName(report.categoryName)){batch.categoryName=report.categoryName;batch.categoryNameSource='sellersprite';}}
   // No provider calls in this transaction. Sorftime collectors validate the leaf
   // and their returned source identity; they do not depend on a base report.
   const studyScope={marketplace:scope.marketplace,nodeIdPath:batch.resolvedNodeIdPath??scope.nodeQuery,fromMonth:batch.request.fromMonth,toMonth:scope.month,currency:marketSiteCurrency(scope.marketplace)};
   const startModule=async(module:LinkedModule)=>{
    if(batch.modules[module].status!=='pending')return;
    await this.deps.context.query('SAVEPOINT linked_module_start');
    try{
     const params=linkedModuleParams(module,batch.categoryName,scope.newProductMonths,scope.headTopN);
     const lock=marketModuleQueryLock(actor.organizationId,module,studyScope,params);
     await this.deps.context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
     const previous=batch.request.forceRefresh?null:await findLinkedModuleHistory(this.deps.context,this.deps.modules,actor,batch.request,module,studyScope.nodeIdPath,batch.categoryName);
     if(previous){
      batch.modules[module]={status:'started',runId:previous.id,message:previous.status==='partial'?'已恢复已保存的部分报告，缺口保留。':['queued','running'].includes(previous.status)?'已复用正在执行的同条件任务。':'已恢复已保存报告。'};
      await this.deps.context.query('RELEASE SAVEPOINT linked_module_start');return;
     }
     const result=module==='shapes'?await this.deps.modules.queryShapes(actor,{scope:studyScope,params,forceRefresh:batch.request.forceRefresh},command(batch.id,module)):await (async()=>{
      const {study}=await this.deps.modules.createStudy(actor,studyScope,command(batch.id,`study-${module}`),module==='overview'?{verifiedNodePath:true}:{nodeResolution:'sorftime-leaf'});
      const start=module==='overview'?'startOverview':module==='keywords'?'startKeywords':'startThemes';
      return this.deps.modules[start](actor,study.id,params,command(batch.id,module));
     })();
     if(batch.request.forceRefresh)await this.deps.context.query('INSERT INTO sorftime_source_refresh_scopes(job_id,not_before) VALUES($1,$2) ON CONFLICT(job_id) DO NOTHING',[result.run.id,(this.deps.now?.()??new Date()).toISOString()]);
     batch.modules[module]={status:'started',runId:result.run.id,message:null};
     await this.deps.context.query('RELEASE SAVEPOINT linked_module_start');
    }catch(error){
     await this.deps.context.query('ROLLBACK TO SAVEPOINT linked_module_start');await this.deps.context.query('RELEASE SAVEPOINT linked_module_start');
     batch.modules[module]={status:'failed',runId:null,message:module==='keywords'&&(!batch.categoryName||!/[\p{L}]/u.test(batch.categoryName))?'未取得类目名称，不能以类目数字查询关键词。':error instanceof MarketModuleServiceError?error.message:'模块启动失败，请恢复该模块或在对应模块中单独分析。'};
    }
   };
   await startModule('shapes');await startModule('themes');
   // Use the validated module reader, never a raw category string from another
   // site/batch. Keep waiting only while this source can still return a name.
   let nameWaiting=false;
   if(!batch.categoryName&&batch.modules.shapes.runId){
    const {run}=await this.deps.modules.findShapes(actor,batch.modules.shapes.runId);
    const sameScope=run.scope.marketplace===scope.marketplace&&run.scope.currency===studyScope.currency
     &&run.scope.nodeIdPath.split(':').at(-1)===scope.nodeQuery.split(':').at(-1)
     &&(!scope.nodeQuery.includes(':')||run.scope.nodeIdPath===scope.nodeQuery||run.scope.nodeIdPath===scope.nodeQuery.split(':').at(-1))
     &&run.scope.fromMonth===batch.request.fromMonth&&run.scope.toMonth===scope.month;
    nameWaiting=sameScope&&['queued','running'].includes(run.status);
    if(sameScope&&this.validName(run.source?.sorftimePool?.categoryName)){batch.categoryName=run.source!.sorftimePool!.categoryName;batch.categoryNameSource='sorftime';nameWaiting=false;}
   }
   if(batch.modules.overview.status==='pending'||batch.modules.overview.status==='blocked'){
    if(validReport){batch.modules.overview={status:'pending',runId:null,message:null};await startModule('overview');}
    else batch.modules.overview={status:basicWaiting?'pending':'blocked',runId:null,message:basicWaiting?'等待卖家精灵基础数据及类目路径。':`${batch.basicMessage??'基础类目数据未取得'}；市场总览待补，其他模块继续。`};
   }
   if(batch.modules.keywords.status==='pending'||batch.modules.keywords.status==='blocked'){
    if(batch.categoryName){batch.modules.keywords={status:'pending',runId:null,message:null};await startModule('keywords');}
    else batch.modules.keywords={status:basicWaiting||nameWaiting?'pending':'blocked',runId:null,message:basicWaiting||nameWaiting?'等待可信类目名称；名称返回后自动启动。':'未取得可信类目名称，关键词待补；不能以类目数字代替关键词。'};
   }
   const waiting=basicWaiting||batch.modules.keywords.status==='pending';
   const started=linkedModules.filter(module=>batch.modules[module].status==='started').length;
   batch.status=waiting?'pending':started===4?'started':started?'partial':'failed';
   batch.message=waiting?`已启动 ${started}/4 个模块；正在等待剩余前置数据，已启动任务继续执行。`:started===4?'四个模块已启动或恢复，可切换查看各自采集和分析进度。':`已启动 ${started}/4 个模块；其余模块缺失数据保留待补，已启动任务继续执行。`;
   await this.save(batch,waiting);
 }
 private validName(value:string|null|undefined):value is string{return !!value?.trim()&&/[\p{L}]/u.test(value)&&!/^Node\s*[\d:]+$/i.test(value);}
}
