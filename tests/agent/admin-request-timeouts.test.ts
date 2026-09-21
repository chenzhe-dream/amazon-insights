import assert from 'node:assert/strict';
import test from 'node:test';
import {agentRequestTimeoutMs,createAgentServiceClient} from '../../app/lib/agent-service-client';
import {buildAgentApp} from '../../server/app';
import type {AuthenticationService} from '../../server/auth/authentication-service';
import {Writable} from 'node:stream';
import Fastify from 'fastify';
import {get} from 'node:http';
import {registerAdminRequestDiagnostics} from '../../server/admin-request-diagnostics';
test('personnel and configuration wait sixty seconds with explicit overrides preserved',()=>{
 for(const route of ['/v1/auth/session','/v1/admin/users','/v1/admin/usage','/v1/admin/usage/people','/v1/admin/module-visibility','/v1/admin/module-visibility/defaults','/v1/admin/module-visibility/:userId']){
  assert.equal(agentRequestTimeoutMs(route),60_000,route);
  assert.equal(agentRequestTimeoutMs(route,5),5);
 }
 assert.equal(agentRequestTimeoutMs('/v1/auth/login'),10_000);
 assert.equal(agentRequestTimeoutMs('/v1/admin/concurrency'),10_000);
 assert.equal(agentRequestTimeoutMs('/v1/runs/:runId/traffic-details/refresh'),55_000);
});
test('management service handler outlives the old default and emits safe timings',async t=>{
 const lines:string[]=[];
 const app=buildAgentApp({env:{AGENT_SERVICE_PROXY_TOKEN:'private-token',AGENT_SERVICE_TRUSTED_ORIGINS:'http://web.test',AGENT_SERVICE_REQUEST_DEADLINE_MS:'5'},logger:{stream:new Writable({write(chunk,_encoding,done){lines.push(String(chunk));done();}})},authService:{authenticate:async()=>{await new Promise(r=>setTimeout(r,25));return null;}} as unknown as AuthenticationService});
 t.after(()=>app.close());
 const response=await app.inject({method:'GET',url:'/v1/auth/session?private=hidden',headers:{origin:'http://web.test','x-agent-proxy-token':'private-token','x-request-id':'timing-safe-id',cookie:'agent_session=private-cookie'}});
 assert.equal(response.statusCode,200);
 const records=lines.flatMap(line=>line.trim().split('\n').map(x=>JSON.parse(x))).filter(x=>x.event==='admin-service-timing');
 assert.equal(records.length,1);assert.equal(records[0].route,'/v1/auth/session');assert.equal(records[0].requestId,'timing-safe-id');assert.ok(records[0].totalMs>=20);
 assert.doesNotMatch(JSON.stringify(records),/private-token|private-cookie|hidden/);
});
test('proxy timeout logs the stalled phase without credentials or search values',async()=>{
 const records:unknown[]=[];
 const client=createAgentServiceClient({env:{AGENT_SERVICE_INTERNAL_URL:'http://internal.test',AGENT_SERVICE_PROXY_TOKEN:'private-token'},timeoutMs:5,onTiming:record=>records.push(record),fetchImplementation:async(_url,init)=>new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('private-token'))))});
 const response=await client({method:'GET',path:'/v1/auth/session',headers:{cookie:'secret'},requestId:'timing-id'});
 assert.equal(response.status,504);assert.equal(records.length,1);
 assert.equal((records[0] as {phase:string}).phase,'awaiting-headers');assert.doesNotMatch(JSON.stringify(records),/private-token|internal.test|secret/);
});
test('client disconnect is logged even when no completed response exists',async t=>{
 const records:Record<string,unknown>[]=[];
 let started!:()=>void,release!:()=>void,logged!:()=>void;
 const entered=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve}),closed=new Promise<void>(resolve=>{logged=resolve});
 const app=Fastify({logger:{stream:new Writable({write(chunk,_encoding,done){
  for(const line of String(chunk).trim().split('\n')){const record=JSON.parse(line);if(record.event==='admin-service-timing'){records.push(record);logged();}}done();
 }})}});
 registerAdminRequestDiagnostics(app);
 app.get('/v1/admin/module-visibility/:userId',async()=>{started();await gate;return {ok:true};});
 t.after(async()=>{release();await app.close();});
 const url=await app.listen({host:'127.0.0.1',port:0});
 const request=get(url+'/v1/admin/module-visibility/private-person-id?secret=hidden');request.on('error',()=>{});
 await entered;request.destroy();
 const timer=setTimeout(()=>logged(),1000);
 try{await closed;}finally{clearTimeout(timer);release();}
 assert.equal(records.length,1);assert.equal(records[0].outcome,'connection-closed');assert.equal(records[0].responseReadyMs,null);
 assert.doesNotMatch(JSON.stringify(records),/private-person-id|secret|hidden/);
});
