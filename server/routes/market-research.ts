import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { MarketResearchJobResponseSchema, MarketResearchListResponseSchema } from "../../shared/market-research-contracts";
import { MarketResearchConflictError, type MarketResearchActor } from "../db/market-research-repository";
import { MarketResearchServiceError, type MarketResearchService } from "../services/market-research-service";
import { ContractRouteError } from "./analysis-runs";

function actor(request:FastifyRequest):MarketResearchActor {
  const principal=request.authPrincipal;
  if(principal?.kind!=="user")throw new ContractRouteError(401,"AUTHENTICATION_REQUIRED","请先登录");
  return {userId:principal.userId,organizationId:principal.organizationId};
}
function jobId(request:FastifyRequest){
  const params=z.object({id:z.string().uuid()}).safeParse(request.params);
  if(!params.success)throw new ContractRouteError(400,"VALIDATION_ERROR","任务编号无效");
  return params.data.id;
}
async function execute<T>(service:MarketResearchService|null,request:FastifyRequest,operation:(service:MarketResearchService,principal:MarketResearchActor)=>Promise<T>):Promise<T>{
  const principal=actor(request);
  if(!service)throw new ContractRouteError(503,"CONFIGURATION_ERROR","市场调研需要 PostgreSQL 持久化服务");
  try{return await operation(service,principal);}catch(error){
    if(error instanceof MarketResearchConflictError)throw new ContractRouteError(409,"CONFLICT",error.message);
    if(error instanceof MarketResearchServiceError)throw new ContractRouteError(error.statusCode,error.statusCode===403?"FORBIDDEN":error.statusCode===404?"NOT_FOUND":error.statusCode===503?"CONFIGURATION_ERROR":"VALIDATION_ERROR",error.message);
    throw error;
  }
}
export function registerMarketResearchRoutes(app:FastifyInstance,service:MarketResearchService|null){
  app.post("/v1/market-research/jobs",async(request,reply)=>execute(service,request,async(current,principal)=>{
    const result=await current.create(principal,request.body,request.headers["idempotency-key"]);
    reply.code(result.created?201:200);return MarketResearchJobResponseSchema.parse({job:result.job});
  }));
  app.get("/v1/market-research/jobs",async request=>execute(service,request,async(current,principal)=>MarketResearchListResponseSchema.parse({jobs:await current.list(principal)})));
  app.get("/v1/market-research/jobs/:id",async request=>execute(service,request,async(current,principal)=>MarketResearchJobResponseSchema.parse({job:await current.find(principal,jobId(request))})));
  app.post("/v1/market-research/jobs/:id/retry",async request=>execute(service,request,async(current,principal)=>{
    if(!z.object({}).strict().safeParse(request.body).success)throw new ContractRouteError(400,"VALIDATION_ERROR","重试请求格式无效");
    return MarketResearchJobResponseSchema.parse({job:await current.retry(principal,jobId(request))});
  }));
}
