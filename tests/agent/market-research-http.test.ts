import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerMarketResearchRoutes } from "../../server/routes/market-research";
import { MarketResearchService } from "../../server/services/market-research-service";
import { classifyRoute, type RequestPrincipal } from "../../server/auth/authorization";
import { findHttpContract } from "../../shared/agent-contracts";
import type { MarketResearchRepository } from "../../server/db/market-research-repository";
import type { MarketResearchJob } from "../../shared/market-research-contracts";

const id="20000000-0000-4000-8000-000000000001";
const now="2026-09-12T00:00:00.000Z";
const scope={marketplace:"US",nodeQuery:"123:456",month:"2026-08",headTopN:10,newProductMonths:6} as const;
const job:MarketResearchJob={id,scope,status:"queued",attempts:0,createdAt:now,updatedAt:now,report:null,error:null};
const principal:RequestPrincipal={kind:"user",userId:"user-a",organizationId:"org-a",email:"fixture@example.test",role:"member",sessionId:"fixture"};
test("all market endpoints are registered in the browser proxy and require sessions",()=>{
  for(const [method,path] of [["POST","/v1/market-research/jobs"],["GET","/v1/market-research/jobs"],["GET",`/v1/market-research/jobs/${id}`],["POST",`/v1/market-research/jobs/${id}/retry`]]){
    assert.ok(findHttpContract(method,path));assert.equal(classifyRoute(method,path).kind,"session");
  }
});
test("HTTP creation binds the session actor, validates input, and exposes saved job history",async t=>{
  const app=Fastify();let session:RequestPrincipal|null=principal;let creates=0;
  app.decorateRequest("authPrincipal",null);app.addHook("preHandler",async request=>{request.authPrincipal=session;});
  const repo:MarketResearchRepository={create:async(input)=>{creates++;assert.equal(input.organizationId,"org-a");assert.equal(input.userId,"user-a");return {job,created:true};},list:async()=>[job],find:async()=>job,retry:async()=>job,claim:async()=>null,renew:async()=>false,finish:async()=>false};
  const service=new MarketResearchService({repository:repo,findUser:async()=>({organizationId:"org-a",status:"active"}),now:()=>new Date(now)});
  registerMarketResearchRoutes(app,service);t.after(()=>app.close());
  const created=await app.inject({method:"POST",url:"/v1/market-research/jobs",headers:{"idempotency-key":id},payload:scope});
  assert.equal(created.statusCode,201);assert.equal(created.json().job.id,id);
  const invalid=await app.inject({method:"POST",url:"/v1/market-research/jobs",headers:{"idempotency-key":id},payload:{...scope,organizationId:"evil"}});
  assert.equal(invalid.statusCode,400);assert.equal(creates,1);
  const history=await app.inject({method:"GET",url:"/v1/market-research/jobs"});assert.equal(history.json().jobs.length,1);
  const badRetry=await app.inject({method:"POST",url:`/v1/market-research/jobs/${id}/retry`,payload:{scope}});assert.equal(badRetry.statusCode,400);
  session=null;
  const denied=await app.inject({method:"GET",url:"/v1/market-research/jobs"});assert.equal(denied.statusCode,401);
});
test("an unavailable persistent store produces an actionable configuration response",async t=>{
  const app=Fastify();app.decorateRequest("authPrincipal",null);app.addHook("preHandler",async request=>{request.authPrincipal=principal;});
  registerMarketResearchRoutes(app,null);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:"/v1/market-research/jobs"});assert.equal(response.statusCode,503);assert.match(response.body,/PostgreSQL/);
});
