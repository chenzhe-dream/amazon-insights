import assert from 'node:assert/strict';
import test from 'node:test';
import {proxyAgentRequest} from '../../app/api/agent/[...path]/route';
import {createAgentServiceClient} from '../../app/lib/agent-service-client';

const runId='11111111-1111-4111-8111-111111111111',path=['v1','market-analysis','runs',runId,'shape-price','draft'];
const response={draft:{version:1,items:[{asin:'B000000001',included:false,label:'Floor'}],catalogLabels:['Floor'],updatedAt:'2026-09-27T00:00:00.000Z'}};
const env={AGENT_SERVICE_INTERNAL_URL:'http://agent.test',AGENT_SERVICE_PROXY_TOKEN:'test-token'};
test('draft GET and PUT cross the validated same-origin proxy with their scoped contract',async()=>{
  const calls:Array<{method:string;body:string|null}>=[];
  const client=createAgentServiceClient({env,fetchImplementation:async(_input,init)=>{calls.push({method:init?.method??'GET',body:init?.body?.toString()??null});return Response.json(response);}});
  const url=`http://web.test/api/agent/${path.join('/')}`;
  for(const method of ['GET','PUT'] as const){
    const input=method==='PUT'?{expectedVersion:0,items:response.draft.items,catalogLabels:response.draft.catalogLabels}:undefined;
    const request=new Request(url,{method,...(input?{headers:{'content-type':'application/json','idempotency-key':'22222222-2222-4222-8222-222222222222'},body:JSON.stringify(input)}:{})});
    const result=await proxyAgentRequest(request,{params:Promise.resolve({path})},client);
    assert.equal(result.status,200,await result.clone().text());assert.deepEqual(await result.json(),response);
  }
  assert.deepEqual(calls.map(call=>call.method),['GET','PUT']);
  const invalid=await proxyAgentRequest(new Request(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:0,items:[{asin:'bad',included:true,label:null}],catalogLabels:[]})}),{params:Promise.resolve({path})},client);
  assert.equal(invalid.status,400);
  assert.equal(calls.length,2,'invalid draft must not reach the service');
});
