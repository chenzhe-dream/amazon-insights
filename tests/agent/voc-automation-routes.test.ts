import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerVocAutomationRoutes } from '../../server/routes/voc-automation';
import type { AgentServiceClient } from '../../app/lib/agent-service-client';
import { proxyAgentRequest } from '../../app/api/agent/[...path]/route';
const projectId=randomUUID(),baseSyncRunId=randomUUID(),organizationId=randomUUID(),actorId=randomUUID();
const status={projectId,baseSyncRunId,selectedAsins:['B08Z36X6B4'],state:'waiting-voc',runId:null,message:'等待手工 VOC',updatedAt:new Date().toISOString(),startedAt:null};
test('automation GET/POST pass production proxy and reject invalid scope before backend',async()=>{
 let calls=0;
 const client:AgentServiceClient=async(input)=>{calls++;assert.equal(input.path,`/v1/projects/${projectId}/voc-automation`);assert.equal(new Headers(input.headers).get('cookie'),'session=fixture');return {status:200,headers:new Headers({'content-type':'application/json'}),body:status};};
 for(const method of ['GET','POST']){
 const response=await proxyAgentRequest(new Request(`https://web.example/api/agent/v1/projects/${projectId}/voc-automation`,{method,headers:{cookie:'session=fixture','content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({baseSyncRunId,selectedAsins:status.selectedAsins})}:{})}),{params:Promise.resolve({path:['v1','projects',projectId,'voc-automation']})},client);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),status);
 }
 const bad=await proxyAgentRequest(new Request(`https://web.example/api/agent/v1/projects/${projectId}/voc-automation`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseSyncRunId,selectedAsins:['invalid']})}),{params:Promise.resolve({path:['v1','projects',projectId,'voc-automation']})},client);
 assert.equal(bad.status,400);assert.equal(calls,2);
});
test('route binds principal scope and GET never registers; anonymous denied',async t=>{
 const app=Fastify();t.after(()=>app.close());let authenticated=true,registers=0,reads=0;
 app.addHook('preHandler',async request=>{request.authPrincipal=authenticated?{kind:'user',organizationId,userId:actorId,role:'member',sessionId:randomUUID(),email:'fixture@example.invalid'}:null;});
 registerVocAutomationRoutes(app,{register:async(scope:unknown)=>{assert.deepEqual(scope,{projectId,organizationId,actorId});registers++;return status;},read:async()=>{reads++;return status;}} as never);
 const url=`/v1/projects/${projectId}/voc-automation`;
 assert.equal((await app.inject({method:'POST',url,payload:{baseSyncRunId,selectedAsins:status.selectedAsins}})).statusCode,200);
 assert.equal((await app.inject({method:'GET',url})).statusCode,200);assert.equal(registers,1);assert.equal(reads,1);
 authenticated=false;assert.equal((await app.inject({method:'GET',url})).statusCode,403);
});
