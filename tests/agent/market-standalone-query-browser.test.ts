import test from 'node:test';
import assert from 'node:assert/strict';
import {queryKeywordRun} from '../../app/lib/market-keyword-browser';
import {queryThemeRun} from '../../app/lib/market-theme-browser';
import {keywordPageRun,keywordUserId} from './helpers/market-keyword-page-fixture';
import {themeRuleRun} from './helpers/market-theme-page-fixture';
import {assertStandaloneQueryBinding} from '../../shared/market-standalone-query-contracts';
import {createAgentServiceClient} from '../../app/lib/agent-service-client';
import {proxyAgentRequest} from '../../app/api/agent/[...path]/route';

test('both independent query transports forward refresh intent through authenticated proxy and check binding',async()=>{
 const old=globalThis.fetch;
 try{
  for(const module of ['keywords','customer-themes'] as const){
   const sample=module==='keywords'?keywordPageRun():themeRuleRun();
   const {organizationId,researchId,...scope}=sample.run.scope,body={scope,params:sample.run.params,forceRefresh:true};
   const query=module==='keywords'?queryKeywordRun:queryThemeRun;
   globalThis.fetch=async(path,init)=>{
    assert.equal(String(path),`/api/agent/v1/market-analysis/${module}/query`);
    assert.deepEqual(JSON.parse(init!.body as string),body);assert.equal(init!.credentials,'same-origin');
    assert.equal(new Headers(init!.headers).get('idempotency-key'),keywordUserId);
    return Response.json(sample);
   };
   assert.equal((await query(body,keywordUserId)).id,sample.run.id);
   const invalid={...body,scope:{...scope,nodeIdPath:'99:98'}};
   globalThis.fetch=async()=>Response.json(sample);
   await assert.rejects(query(invalid,keywordUserId),/研究范围或参数不一致/);
   const path=`v1/market-analysis/${module}/query`;
   const client=createAgentServiceClient({env:{AGENT_SERVICE_INTERNAL_URL:'http://agent.test',AGENT_SERVICE_PROXY_TOKEN:'test-token'},fetchImplementation:async()=>Response.json(sample)});
   const res=await proxyAgentRequest(new Request(`http://web.test/api/agent/${path}`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':keywordUserId},body:JSON.stringify(body)}),{params:Promise.resolve({path:path.split('/')})},client);
   assert.equal(res.status,200,await res.clone().text());assert.deepEqual(await res.json(),sample);
  }
 }finally{globalThis.fetch=old;}
});

test('query binding allows leaf aliases and canonical object order but rejects other countries/months/parameters',()=>{
 const {organizationId,researchId,...scope}=keywordPageRun().run.scope;
 const base={scope,params:{a:1,b:2}};
 assert.doesNotThrow(()=>assertStandaloneQueryBinding(base,{scope:{...scope,nodeIdPath:scope.nodeIdPath.split(':').at(-1)!},params:{b:2,a:1}}));
 for(const changed of [{scope:{...scope,toMonth:'2025-01'},params:base.params},{scope:{...scope,marketplace:'DE' as const,currency:'EUR' as const},params:base.params},{scope,params:{a:2,b:2}}])assert.throws(()=>assertStandaloneQueryBinding(base,changed));
});
