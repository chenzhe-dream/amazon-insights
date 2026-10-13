import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerMarketModuleRoutes} from '../../server/routes/market-modules';
import type {MarketModuleService} from '../../server/services/market-module-service';
import {MarketOverviewEvidenceError} from '../../server/domain/market-research/overview-catalog-compatibility';

test('saved evidence conflict is distinct from invalid user input',async t=>{
  const app=Fastify();t.after(()=>app.close());app.decorateRequest('authPrincipal',null);
  app.addHook('preHandler',async req=>{req.authPrincipal={kind:'user',organizationId:'22222222-2222-4222-8222-222222222222',userId:'11111111-1111-4111-8111-111111111111',role:'member',email:'test@example.test',sessionId:'33333333-3333-4333-8333-333333333333'};});
  let calls=0;
  registerMarketModuleRoutes(app,{findOverview:async()=>{calls++;throw new MarketOverviewEvidenceError();}} as unknown as MarketModuleService);
  const old=await app.inject({url:'/v1/market-analysis/runs/44444444-4444-4444-8444-444444444444/overview'});
  assert.equal(old.statusCode,409);assert.match(old.json().message,/历史报告兼容性/);assert.doesNotMatch(old.json().message,/参数或任务编号无效/);
  const invalid=await app.inject({url:'/v1/market-analysis/runs/not-an-id/overview'});
  assert.equal(invalid.statusCode,400);assert.match(invalid.json().message,/参数或任务编号无效/);assert.equal(calls,1);
});
