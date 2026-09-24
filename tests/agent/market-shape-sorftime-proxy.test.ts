import assert from 'node:assert/strict';
import test from 'node:test';
import {createAgentServiceClient,agentRequestTimeoutMs} from '../../app/lib/agent-service-client';
import {proxyAgentRequest} from '../../app/api/agent/[...path]/route';
import {shapeSorftimePageRun,shapeSorftimePageRevision} from './helpers/market-shape-sorftime-page-fixture';
const env={AGENT_SERVICE_INTERNAL_URL:'http://agent.test',AGENT_SERVICE_PROXY_TOKEN:'test-token'},mib=1048576;
test('shape snapshot reads and saves have bounded report timeout without changing unrelated routes or overrides',()=>{
 for(const path of ['/v1/market-analysis/studies/:id/shape-price','/v1/market-analysis/runs/:id/shape-price','/v1/market-analysis/runs/:id/shape-price/revisions','/v1/market-analysis/runs/:id/shape-price/revisions/:revisionId']){
  assert.equal(agentRequestTimeoutMs(path),60000);assert.equal(agentRequestTimeoutMs(path,1234),1234);
 }
 assert.equal(agentRequestTimeoutMs('/v1/capabilities'),10000);
});
async function proxy(path:string,payload:unknown,body?:unknown,maxResponseBytes?:number){return proxyAgentRequest(new Request(`http://web.test/api/agent/${path}`,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json','idempotency-key':'71000000-0000-4000-8000-000000000002'}}:{})}),{params:Promise.resolve({path:path.split('/')})},createAgentServiceClient({env,fetchImplementation:async()=>Response.json(payload),maxResponseBytes}));}
test('300 products with 120 persisted volume/amount months pass bounded production proxy and v4 revision contracts',async()=>{
 const data=shapeSorftimePageRun(300,120),revision=shapeSorftimePageRevision(300,120);for(const payload of [data,{revision}]){const bytes=Buffer.byteLength(JSON.stringify(payload));assert.ok(bytes>mib);assert.ok(bytes<8*mib)}
 const runPath=`v1/market-analysis/runs/${data.run.id}/shape-price`,request={expectedParentRevisionId:null,selectedAsins:revision.selectedAsins,assignments:revision.assignments,note:revision.note};
 for(const [path,payload,body] of [[runPath,data,undefined],[`${runPath}/revisions`,{revision},request],[`${runPath}/revisions/${revision.revisionId}`,{revision},undefined]] as const){const response=await proxy(path,payload,body);assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),payload)}
 assert.equal((await proxy(runPath,data,undefined,64)).status,502);
 assert.equal((await proxy(runPath,{data:'x'.repeat(9*mib)})).status,502);
});
