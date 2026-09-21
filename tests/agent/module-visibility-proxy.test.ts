import assert from 'node:assert/strict';
import test from 'node:test';
import {proxyAgentRequest} from '../../app/api/agent/[...path]/route';
test('formal Web proxy forwards visibility PUT with the real userId segment',async()=>{
 const id='ee45b324-9052-4554-8ef6-fccf856a21a3';let calls=0;
 const response=await proxyAgentRequest(new Request('http://localhost/api/agent/v1/admin/module-visibility/'+id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({visibleModules:[],version:0})}),{params:Promise.resolve({path:['v1','admin','module-visibility',id]})},async request=>{
  calls++;assert.equal(request.method,'PUT');assert.equal(request.path,'/v1/admin/module-visibility/'+id);
  return {status:409,headers:new Headers(),body:{error:{code:'CONFLICT',message:'version mismatch',requestId:'visibility-proxy-test'}}};
 });
 assert.equal(response.status,409);assert.equal(calls,1);
});

for(const method of ['GET','PUT'] as const)test('formal Web proxy forwards static defaults '+method,async()=>{
 let calls=0;
 const response=await proxyAgentRequest(new Request('http://localhost/api/agent/v1/admin/module-visibility/defaults',{method,...(method==='PUT'?{headers:{'content-type':'application/json'},body:JSON.stringify({visibleModules:[],version:0})}:{})}),{params:Promise.resolve({path:['v1','admin','module-visibility','defaults']})},async request=>{
  calls++;assert.equal(request.method,method);assert.equal(request.path,'/v1/admin/module-visibility/defaults');
  return {status:200,headers:new Headers(),body:{visibleModules:[],version:1}};
 });
 assert.equal(response.status,200,await response.clone().text());assert.equal(calls,1);
});
