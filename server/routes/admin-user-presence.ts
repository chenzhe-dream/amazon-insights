import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ActivityRequestSchema,
  ActivityResponseSchema,
} from "../../shared/agent-contracts";
import type { AuthenticatedPrincipal } from "../auth/authentication-service";
import type { UserPresenceAccess } from "../auth/user-presence-access";
import type { AdminUserPresenceRepository } from "../db/admin-user-presence-repository";
import { AdminUserPresenceService } from "../services/admin-user-presence-service";
import { ContractRouteError } from "./analysis-runs";
import type {UsageAnalyticsRepository} from "../db/usage-analytics-repository";
import {UsageStoreError} from "../db/postgres/usage-analytics-store";
import {PresenceQuerySchema} from '../../shared/admin-user-presence-query';

function userPrincipal(request: FastifyRequest): AuthenticatedPrincipal {
  if (request.authPrincipal?.kind === "user") return request.authPrincipal;
  throw new ContractRouteError(
    401,
    "AUTHENTICATION_REQUIRED",
    "Authentication is required",
  );
}

function repositoryOrThrow(
  repository: AdminUserPresenceRepository | null,
): AdminUserPresenceRepository {
  if (repository) return repository;
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "User presence is not configured",
  );
}

function parseActivityRequest(body: unknown): void {
  if (ActivityRequestSchema.safeParse(body).success) return;
  throw new ContractRouteError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
  );
}

export function registerAdminUserPresenceRoutes(
  app: FastifyInstance,
  repository: AdminUserPresenceRepository | null,
  clock: () => Date = () => new Date(),
  access: UserPresenceAccess | null = null,
  usage: UsageAnalyticsRepository | null = null,
) {
  app.get("/v1/admin/users", async (request) => {
    const principal = userPrincipal(request);
    let canView = false;
    if (access) {
      try {
        canView = await access.canView(principal);
      } catch {
        canView = false;
      }
    }
    if (!canView) {
      throw new ContractRouteError(
        403,
        "FORBIDDEN",
        "Request is not authorized",
      );
    }
    const asOf = clock();
    const asOfIso = asOf.toISOString();
    const hasQuery=Object.keys(request.query ?? {}).length>0;
    const parsed=hasQuery?PresenceQuerySchema.safeParse(request.query):null;
    if(parsed&&!parsed.success)throw new ContractRouteError(400,'VALIDATION_ERROR','用户列表筛选参数无效');
    const query=parsed?.success?parsed.data:undefined;
    const result = await repositoryOrThrow(repository).listOrganizationUsers({
      organizationId: principal.organizationId,
      asOf: asOfIso,
      ...(query?{query}:{}),
    });
    const response=new AdminUserPresenceService({ asOf: () => asOf }).list(result.users,Boolean(result.pagination));
    if(result.pagination)return {...response,pagination:result.pagination,summary:result.summary};
    if(!query)return response;
    // Compatibility for a legacy repository without a paged query implementation.
    const users=response.users.filter(u=>(query.source==='all'||(u.source??'local')===query.source)&&
      (u.account+' '+u.displayName).toLocaleLowerCase().includes(query.q.toLocaleLowerCase()));
    const summary={total:users.length,recentlyOnline:users.filter(u=>u.presenceStatus==='recently-online').length,neverLoggedIn:users.filter(u=>u.presenceStatus==='never-logged-in').length};
    const filtered=users.filter(u=>query.status==='all'||u.presenceStatus===query.status)
      .sort((a,b)=>(b.lastActivityAt??'').localeCompare(a.lastActivityAt??'')||a.account.localeCompare(b.account));
    const page=Math.min(query.page,Math.max(1,Math.ceil(filtered.length/query.pageSize)));
    return {...response,users:filtered.slice((page-1)*query.pageSize,page*query.pageSize),summary,pagination:{page,pageSize:query.pageSize,total:filtered.length}};
  });

  app.post("/v1/auth/activity", async (request) => {
    const principal = userPrincipal(request);
    parseActivityRequest(request.body === undefined ? {} : request.body);
    const body=ActivityRequestSchema.parse(request.body??{});
    if(body.usage){
      if(Buffer.byteLength(JSON.stringify(body))>48*1024)throw new ContractRouteError(400,"VALIDATION_ERROR","统计批次过大");
      if(!usage)throw new ContractRouteError(503,"CONFIGURATION_ERROR","使用统计暂不可用");
      try{
        const ack=await usage.ingest({organizationId:principal.organizationId,userId:principal.userId,sessionId:principal.sessionId},body.usage,clock().toISOString());
        if(ack)return ActivityResponseSchema.parse({ok:true,usage:{status:"recorded",...ack}});
        await repositoryOrThrow(repository).recordHeartbeat({organizationId:principal.organizationId,userId:principal.userId,sessionId:principal.sessionId,asOf:clock().toISOString()});
        return ActivityResponseSchema.parse({ok:true,usage:{status:"not_bound"}});
      }catch(error){
        if(error instanceof UsageStoreError)throw new ContractRouteError(error.statusCode,error.statusCode===401?"AUTHENTICATION_REQUIRED":"VALIDATION_ERROR",error.message);
        throw error;
      }
    }
    const result = await repositoryOrThrow(repository).recordHeartbeat({
      organizationId: principal.organizationId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      asOf: clock().toISOString(),
    });
    if (result === "inactive") {
      throw new ContractRouteError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
      );
    }
    if (result === "recorded" || result === "throttled") {
      return ActivityResponseSchema.parse({ ok: true });
    }
    throw new Error("Unexpected user presence heartbeat result");
  });
}
