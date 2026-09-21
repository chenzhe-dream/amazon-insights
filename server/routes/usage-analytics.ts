import type {FastifyInstance,FastifyRequest} from "fastify";
import {z} from "zod";
import type {UsageAnalyticsRepository} from "../db/usage-analytics-repository";
import type {UserPresenceAccess} from "../auth/user-presence-access";
import {UsageQuerySchema} from "../../shared/usage-analytics-contracts";
import {usageRange,beijingDate} from "../services/usage-analytics-service";
import {ContractRouteError} from "./analysis-runs";
export function registerUsageAnalyticsRoutes(app:FastifyInstance,repository:UsageAnalyticsRepository|null,access:UserPresenceAccess|null){
  async function principal(request:FastifyRequest){
    const p=request.authPrincipal;
    if(p?.kind!=="user")throw new ContractRouteError(401,"AUTHENTICATION_REQUIRED","请先登录");
    if(!access||!await access.canView(p))throw new ContractRouteError(403,"FORBIDDEN","无权查看使用统计");
    if(!repository)throw new ContractRouteError(503,"CONFIGURATION_ERROR","使用统计需要 PostgreSQL 存储");
    return p;
  }
  app.get("/v1/admin/usage/people",async request=>{
    const p=await principal(request);
    const parsed=z.strictObject({q:z.string().trim().max(100).default(""),limit:z.coerce.number().int().min(1).max(20).default(20)}).safeParse(request.query);
    if(!parsed.success)throw new ContractRouteError(400,"VALIDATION_ERROR","搜索参数无效");
    return repository!.searchPeople(p.organizationId,parsed.data.q,parsed.data.limit);
  });
  app.get("/v1/admin/usage",async request=>{
    const p=await principal(request),parsed=UsageQuerySchema.safeParse(request.query);
    if(!parsed.success)throw new ContractRouteError(400,"VALIDATION_ERROR","统计参数无效");
    try{usageRange(parsed.data);if(parsed.data.date>beijingDate(Date.now()))throw new Error()}
    catch{throw new ContractRouteError(400,"VALIDATION_ERROR","请选择有效的历史日期或今天")}
    return repository!.report(p.organizationId,parsed.data,new Date().toISOString());
  });
}
