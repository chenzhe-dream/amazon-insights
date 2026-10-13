import {createHash} from 'node:crypto';
import {MarketLinkedRequestSchema,MarketLinkedRetrySchema,MarketLinkedResponseSchema,linkedModules,linkedModuleParams,type MarketLinkedBatch} from '../../shared/market-linked-contracts';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {marketSiteCurrency} from '../../shared/market-sites';
import {assertMarketProductQueryWindow} from '../../shared/market-product-source-policy';
import {canonicalJsonSha256} from '../runtime/model-request-accounting';
import type {PostgresQueryContext} from '../db/postgres/query-context';
import type {MarketExecutionActor} from '../db/market-module-execution-repository';
import {MarketModuleServiceError,type MarketModuleService} from './market-module-service';
import type {MarketResearchService} from './market-research-service';

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
   const {job}=await this.deps.research.create(actor,request.scope,command(id,'basic'));
   const batch:MarketLinkedBatch={id,request,basicJobId:job.id,basicRetryable:false,status:'pending',message:'正在获取类目基础数据和名称，完成后自动启动四个模块。',categoryName:null,resolvedNodeIdPath:null,modules:{overview:{status:'pending',runId:null,message:null},shapes:{status:'pending',runId:null,message:null},keywords:{status:'pending',runId:null,message:null},themes:{status:'pending',runId:null,message:null}}};
   await this.deps.context.query('INSERT INTO market_linked_batches(id,organization_id,created_by,request_json,request_hash,basic_job_id,state_json) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)',[id,actor.organizationId,actor.userId,JSON.stringify(request),hash,job.id,JSON.stringify(batch)]);
   return {batch};
  });
 }
 async retry(actor:MarketExecutionActor,id:string,body:unknown){
  const request=MarketLinkedRetrySchema.parse(body);MarketModuleIdSchema.parse(id);
  return this.deps.context.transaction(async()=>{
   await this.authorize(actor);await this.deps.context.query('SELECT id FROM market_linked_batches WHERE id=$1 AND organization_id=$2 AND created_by=$3 FOR UPDATE',[id,actor.organizationId,actor.userId]);
   const {batch}=await this.find(actor,id);
   if(request.basic){const job=await this.deps.research.find(actor,batch.basicJobId);if(job.status==='failed'){if(!job.error?.retryable||job.attempts>=3)throw new MarketModuleServiceError(400,'该基础采集无法继续重试，请先处理错误原因，再重新筛选市场创建新批次');await this.deps.research.retry(actor,job.id);}batch.basicRetryable=false;}
   for(const module of request.modules){if(batch.modules[module].status==='failed')batch.modules[module]={status:'pending',runId:null,message:null};}
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
   const rows=await this.deps.context.query<Row>('SELECT b.* FROM market_linked_batches b JOIN market_research_jobs j ON j.id=b.basic_job_id WHERE b.pending AND j.status NOT IN (\'queued\',\'running\') ORDER BY b.created_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1');
   if(!rows.rows[0])return;const row=rows.rows[0],{batch}=this.parse(row),actor={organizationId:row.organization_id,userId:row.created_by};
   try{await this.authorize(actor);}catch{batch.status='failed';batch.message='原任务用户当前没有分析权限，请联系管理员。';await this.save(batch,false);return;}
   const job=await this.deps.research.find(actor,batch.basicJobId);
   if(!job.report){batch.status='failed';batch.basicRetryable=!!job.error?.retryable&&job.attempts<3;batch.message=(job.error?.message??'类目基础数据未取得，四个模块尚未启动。')+(batch.basicRetryable?' 可以重试基础采集并继续联动。':' 请先处理错误原因，再重新筛选市场创建新批次。');await this.save(batch,false);return;}
   const report=job.report,scope=batch.request.scope;
   const sameNode=report.nodeIdPath===scope.nodeQuery||!scope.nodeQuery.includes(':')&&report.nodeId===scope.nodeQuery;
   if(!sameNode||report.scope.marketplace!==scope.marketplace||report.scope.month!==scope.month||canonicalJsonSha256(report.scope)!==canonicalJsonSha256(scope)){
    batch.status='failed';batch.message='基础数据的类目或站点与联动范围不一致，已停止启动。';await this.save(batch,false);return;
   }
   batch.categoryName=report.categoryName||null;
   batch.resolvedNodeIdPath=report.nodeIdPath;
   // The verified complete node path avoids network resolution while this lock is held.
   const studyScope={marketplace:scope.marketplace,nodeIdPath:report.nodeIdPath,fromMonth:batch.request.fromMonth,toMonth:scope.month,currency:marketSiteCurrency(scope.marketplace)};
   for(const module of linkedModules){
    if(batch.modules[module].status!=='pending')continue;
    await this.deps.context.query('SAVEPOINT linked_module_start');
    try{
     const params=linkedModuleParams(module,batch.categoryName,scope.newProductMonths,scope.headTopN);
     const {study}=await this.deps.modules.createStudy(actor,studyScope,command(batch.id,`study-${module}`),{verifiedNodePath:true});
     const start=module==='overview'?'startOverview':module==='shapes'?'startShapes':module==='keywords'?'startKeywords':'startThemes';
     const result=await this.deps.modules[start](actor,study.id,params,command(batch.id,module));
     batch.modules[module]={status:'started',runId:result.run.id,message:null};
     await this.deps.context.query('RELEASE SAVEPOINT linked_module_start');
    }catch(error){
     await this.deps.context.query('ROLLBACK TO SAVEPOINT linked_module_start');await this.deps.context.query('RELEASE SAVEPOINT linked_module_start');
     batch.modules[module]={status:'failed',runId:null,message:module==='keywords'&&(!batch.categoryName||!/[\p{L}]/u.test(batch.categoryName))?'未取得类目名称，不能以类目数字查询关键词。':error instanceof MarketModuleServiceError?error.message:'模块启动失败，请恢复该模块或在对应模块中单独分析。'};
    }
   }
   batch.status=linkedModules.every(module=>batch.modules[module].status==='started')?'started':'failed';
   batch.message=batch.status==='started'?'四个分析任务已启动，可切换模块查看各自进度和结果。':'部分模块未启动，已启动任务继续执行；可以单独恢复失败模块。';
   await this.save(batch,false);
  });
 }
}
