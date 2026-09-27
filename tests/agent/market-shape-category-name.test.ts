import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveShapeCategoryName} from '../../server/services/market-shape-category-name';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {resolveShapeNodeInput} from '../../app/lib/market-shape-browser';
import {findHttpContract} from '../../shared/agent-contracts';
import {classifyRoute} from '../../server/auth/authorization';
import Fastify from 'fastify';
import {registerMarketModuleRoutes} from '../../server/routes/market-modules';
import type {MarketModuleService} from '../../server/services/market-module-service';

const rows=[{category_name:'Floor Lamps',node_id:13280971},{category_name:'Floor Lamp Shades',node_id:999}];
function connector(result:unknown=rows){
 const calls:unknown[]=[];
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('unused')},execute:async request=>{calls.push(request);return {data:{data:result},source:{connectorId:'sorftime',operation:request.operation,fetchedAt:'2026-09-27T00:00:00.000Z',attemptCount:1}}}};
 return {sorftime,calls};
}
const base={marketplace:'US' as const,organizationId:'org-a',jobId:'70000000-0000-4000-8000-000000000001'};
test('English category resolves only an exact unique Sorftime node under organization governance',async()=>{
 const {sorftime,calls}=connector();
 assert.equal(await resolveShapeCategoryName({...base,name:' floor lamps ',connector:sorftime}),'13280971');
 assert.deepEqual(calls.map(({operation,input,governorScope}:any)=>({operation,input,governorScope})),[{operation:'category_name_search',input:{category_name:'floor lamps',amz_site:'US'},governorScope:{organizationId:'org-a',jobId:base.jobId}}]);
});
test('no exact category, duplicate exact nodes, and malformed rows cannot choose a category',async()=>{
 for(const data of [rows.slice(1),[rows[0],{category_name:'FLOOR LAMPS',node_id:999}], [{category_name:'Floor Lamps',node_id:'wrong'}]]){
  const {sorftime}=connector(data);await assert.rejects(resolveShapeCategoryName({...base,name:'Floor Lamps',connector:sorftime}),error=>error instanceof Error&&['empty','ambiguous'].includes(error.message));
 }
});
test('canonical numeric category bypasses name lookup and lookup route requires a session',async()=>{
 assert.equal(await resolveShapeNodeInput('US',' 1:2:13280971 '),'1:2:13280971');
 const path='/v1/market-analysis/shape-price/resolve-category';
 assert.ok(findHttpContract('POST',path));
 assert.equal(classifyRoute('POST',path).kind,'session');
});
test('UK category lookup sends Sorftime GB site without changing the public marketplace',async()=>{
 const {sorftime,calls}=connector([{category_name:'Floor Lamps',node_id:'13280971'}]);
 assert.equal(await resolveShapeCategoryName({...base,marketplace:'UK',name:'Floor Lamps',connector:sorftime}),'13280971');
 assert.equal((calls[0] as any).input.amz_site,'GB');
});
test('category lookup route denies anonymous requests and binds a signed-in organization',async t=>{
 const app=Fastify(),actors:unknown[]=[];
 app.decorateRequest('authPrincipal',null);
 let signedIn=false;
 app.addHook('preHandler',async request=>{request.authPrincipal=signedIn?{kind:'user',userId:'user-a',organizationId:'org-a',email:'a@example.test',role:'member',sessionId:'session-a'}:null;});
 registerMarketModuleRoutes(app,{resolveShapeCategory:async(actor:unknown,body:unknown)=>{actors.push({actor,body});return {nodeId:'13280971'};}} as MarketModuleService);
 t.after(()=>app.close());
 const path='/v1/market-analysis/shape-price/resolve-category',payload={marketplace:'US',name:'Floor Lamps'};
 const denied=await app.inject({method:'POST',url:path,payload});assert.equal(denied.statusCode,401);assert.equal(actors.length,0);
 signedIn=true;const allowed=await app.inject({method:'POST',url:path,payload});assert.equal(allowed.statusCode,200,allowed.body);assert.deepEqual(allowed.json(),{nodeId:'13280971'});assert.deepEqual(actors,[{actor:{organizationId:'org-a',userId:'user-a'},body:payload}]);
});
