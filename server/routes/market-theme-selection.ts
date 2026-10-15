import {ProjectFavoriteError} from '../db/postgres/market-project-favorites-store';
import type {MarketExecutionActor} from '../db/market-module-execution-repository';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MarketModuleIdSchema } from '../../shared/market-module-contracts';
import { MarketThemeSelectionRevisionIdSchema } from '../../shared/market-theme-selection-contracts';
import { MarketThemeSelectionStore } from '../db/postgres/market-theme-selection-store';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { MarketAnalysisStorageError } from '../db/postgres/market-analysis-snapshot-store';
import { ContractRouteError } from './analysis-runs';
const params=z.object({id:MarketModuleIdSchema,attemptId:MarketModuleIdSchema,revisionId:MarketThemeSelectionRevisionIdSchema.optional()}).strict();
export function registerMarketThemeSelectionRoutes(app:FastifyInstance,context:PostgresQueryContext|null,resolveSharedRead?:(actor:MarketExecutionActor,kind:'run'|'study',id:string)=>Promise<MarketExecutionActor>){
 const store=context?new MarketThemeSelectionStore(context):null;
 async function execute(req:FastifyRequest,save=false){
  if(req.authPrincipal?.kind!=='user')throw new ContractRouteError(401,'AUTHENTICATION_REQUIRED','请先登录');
  if(!store)throw new ContractRouteError(503,'CONFIGURATION_ERROR','样本修订需要 PostgreSQL 持久化服务');
  try{const p=params.parse(req.params),original={organizationId:req.authPrincipal.organizationId,userId:req.authPrincipal.userId},identity={actor:!save&&resolveSharedRead?await resolveSharedRead(original,'run',p.id):original,moduleRunId:p.id,attemptId:p.attemptId};
   if(save)return await store.save({...identity,request:req.body,idempotencyKey:MarketModuleIdSchema.parse(req.headers['idempotency-key'])});
   const view=await store.read({...identity,...(p.revisionId?{revisionId:p.revisionId}:{})});if(!view)throw new ContractRouteError(404,'NOT_FOUND','该样本版本不可用');return {created:false,view};
  }catch(error){
      if(error instanceof ProjectFavoriteError)throw new ContractRouteError(error.statusCode,error.statusCode===403?'FORBIDDEN':'VALIDATION_ERROR',error.message);if(error instanceof z.ZodError)throw new ContractRouteError(400,'VALIDATION_ERROR','样本修订参数无效');if(error instanceof MarketExecutionConflictError||error instanceof MarketAnalysisStorageError||error instanceof TypeError)throw new ContractRouteError(409,'CONFLICT','样本基准或修订已变化，请重新读取后再操作');throw error;}
 }
 const path='/v1/market-analysis/runs/:id/reports/:attemptId/theme-selection';
 app.get(path,async req=>(await execute(req)).view);
 app.post(path,async(req,reply)=>{const result=await execute(req,true);reply.code(result.created?201:200);return result.view;});
 app.get(`${path}/:revisionId`,async req=>(await execute(req)).view);
}
