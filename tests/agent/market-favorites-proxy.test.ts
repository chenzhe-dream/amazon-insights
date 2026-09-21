import test from "node:test";
import assert from "node:assert/strict";
import {proxyAgentRequest} from "../../app/api/agent/[...path]/route";
import {createAgentServiceClient} from "../../app/lib/agent-service-client";
test("formal web proxy routes shared favorite create and delete",async()=>{
 for(const method of ["GET","POST","DELETE"]){
  const path="/v1/market-research/favorites"+(method==="DELETE"?"/10000000-0000-4000-8000-000000000001":"");
  let calls=0;const response=await proxyAgentRequest(new Request("http://localhost/api/agent"+path,{method,...(method==="POST"?{headers:{"content-type":"application/json"},body:JSON.stringify({id:"10000000-0000-4000-8000-000000000001",title:"灯具",module:"overview",query:{marketNode:"123"}})}:{})}),{params:Promise.resolve({path:path.slice(1).split("/")})},async request=>{calls++;assert.equal(request.method,method);assert.equal(request.path,path);return {status:503,headers:new Headers(),body:{error:{code:"CONFIGURATION_ERROR",message:"test",requestId:"test"}}}});
  assert.equal(calls,1);assert.equal(response.status,503);
 }
});
test("favorite deletion preserves the real empty 204 response end to end",async()=>{
 const path="/v1/market-research/favorites/10000000-0000-4000-8000-000000000001";
 const client=createAgentServiceClient({env:{AGENT_SERVICE_INTERNAL_URL:"http://127.0.0.1:39999",AGENT_SERVICE_PROXY_TOKEN:"fixture-only"},fetchImplementation:async()=>new Response(null,{status:204})});
 const response=await proxyAgentRequest(new Request("http://localhost/api/agent"+path,{method:"DELETE"}),{params:Promise.resolve({path:path.slice(1).split("/")})},client);
 assert.equal(response.status,204);assert.equal(await response.text(),"");
});
