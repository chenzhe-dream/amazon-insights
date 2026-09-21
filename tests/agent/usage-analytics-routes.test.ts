import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {classifyRoute} from "../../server/auth/authorization";
import {findHttpContract} from "../../shared/agent-contracts";
test("usage endpoints are proxy registered and require sessions",()=>{
  for(const path of ["/v1/admin/usage","/v1/admin/usage/people"]){assert.ok(findHttpContract("GET",path));assert.equal(classifyRoute("GET",path).kind,"session")}
});
test("usage search enforces existing access and server organization",async t=>{
  const m=await import("../../server/routes/usage-analytics").catch(()=>null);assert.ok(m);
  const app=Fastify();t.after(()=>app.close());let allow=false;
  app.decorateRequest("authPrincipal",null);
  app.addHook("preHandler",async req=>{req.authPrincipal={kind:"user",organizationId:"org",userId:"u",sessionId:"s",email:"u@test.example",role:"member"}});
  const repo={searchPeople:async(org:string)=>{assert.equal(org,"org");return{people:[],hasMore:false}},report:async()=>{throw new Error("unused")},ingest:async()=>null};
  m.registerUsageAnalyticsRoutes(app,repo,{canView:async()=>allow});
  assert.equal((await app.inject("/v1/admin/usage/people?q=x")).statusCode,403);
  allow=true;
  assert.equal((await app.inject("/v1/admin/usage/people?q=x")).statusCode,200);
  assert.equal((await app.inject("/v1/admin/usage/people?q=x&organizationId=evil")).statusCode,400);
  assert.equal((await app.inject("/v1/admin/usage?period=day&date=2026-02-30")).statusCode,400);
});
