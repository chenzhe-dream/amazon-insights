import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {MarketLinkedService} from '../services/market-linked-service';
import type {MarketExecutionActor} from '../db/market-module-execution-repository';
import {MarketModuleServiceError} from '../services/market-module-service';
import {MarketResearchServiceError} from '../services/market-research-service';
import {MarketResearchConflictError} from '../db/market-research-repository';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {ContractRouteError} from './analysis-runs';

export function registerMarketLinkedRoutes(app:FastifyInstance,service:MarketLinkedService|null){
 async function execute(req:FastifyRequest,action:(actor:MarketExecutionActor)=>Promise<unknown>){
  if(req.authPrincipal?.kind!=='user')throw new ContractRouteError(401,'AUTHENTICATION_REQUIRED','请先登录');
  if(!service)throw new ContractRouteError(503,'CONFIGURATION_ERROR','市场联动分析服务尚未就绪');
  try{return await action({organizationId:req.authPrincipal.organizationId,userId:req.authPrincipal.userId});}
  catch(error){
   if(error instanceof MarketResearchConflictError)throw new ContractRouteError(409,'CONFLICT','基础采集状态已变化或无法继续重试，请刷新状态');
   if(error instanceof z.ZodError)throw new ContractRouteError(400,'VALIDATION_ERROR','四模块联动需要有效类目和完整自然月范围');
   if(error instanceof MarketModuleServiceError||error instanceof MarketResearchServiceError)throw new ContractRouteError(error.statusCode,error.statusCode===403?'FORBIDDEN':error.statusCode===404?'NOT_FOUND':'VALIDATION_ERROR',error.message);
   throw error;
  }
 }
 const id=(req:FastifyRequest)=>z.object({id:MarketModuleIdSchema}).strict().parse(req.params).id;
 app.post('/v1/market-analysis/linked',req=>execute(req,actor=>service!.create(actor,req.body,req.headers['idempotency-key'])));
 app.get('/v1/market-analysis/linked/:id',req=>execute(req,actor=>service!.find(actor,id(req))));
 app.post('/v1/market-analysis/linked/:id/retry',req=>execute(req,actor=>service!.retry(actor,id(req),req.body)));
}
