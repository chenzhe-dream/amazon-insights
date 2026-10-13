import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {findHttpContract} from '../../shared/agent-contracts';
import {classifyRoute,type RequestPrincipal} from '../../server/auth/authorization';
import {registerMarketLinkedRoutes} from '../../server/routes/market-linked';
import type {MarketLinkedService} from '../../server/services/market-linked-service';
import {MarketResearchConflictError} from '../../server/db/market-research-repository';
const id='10000000-0000-4000-8000-000000000001';
test('linked routes are session-only proxy contracts and reject anonymous requests',async t=>{
 const paths=[['POST','/v1/market-analysis/linked'],['GET',`/v1/market-analysis/linked/${id}`],['POST',`/v1/market-analysis/linked/${id}/retry`]];
 for(const [method,path] of paths){assert.ok(findHttpContract(method,path));assert.equal(classifyRoute(method,path).kind,'session');}
 const app=Fastify();t.after(()=>app.close());let principal:RequestPrincipal|null=null;app.decorateRequest('authPrincipal',null);app.addHook('preHandler',async req=>{req.authPrincipal=principal;});
 let called=0;const service={find:async()=>{called++;throw new MarketResearchConflictError();}} as unknown as MarketLinkedService;registerMarketLinkedRoutes(app,service);
 assert.equal((await app.inject({method:'GET',url:paths[1][1]})).statusCode,401);assert.equal(called,0);
 principal={kind:'user',organizationId:'org',userId:'user',email:'test@example.test',role:'member',sessionId:'test'};
 assert.equal((await app.inject({method:'GET',url:paths[1][1]})).statusCode,409);assert.equal(called,1);
 assert.equal((await app.inject({method:'GET',url:'/v1/market-analysis/linked/not-a-uuid'})).statusCode,400);
});
