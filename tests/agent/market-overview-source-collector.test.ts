import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {collectMarketOverviewSource} from '../../server/services/market-overview-source-collector';
import {ConnectorError,type ConnectorRequest,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {buildMarketOverviewSourceCatalog} from '../../server/domain/market-research/overview-source-catalog';
const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const at='2026-09-12T00:00:00.000Z',base={scope,month:'2026-08',operation:'market_research' as const,headTopN:10 as const,newProductMonths:6 as const,jobId:randomUUID(),now:()=>new Date(at)};
function payload(extra:Record<string,unknown>={}){return {code:'OK',data:{items:[{nodeIdPath:scope.nodeIdPath,nodeId:'456',month:'202608',currency:'USD',marketplace:'US',topProducts:100,totalUnits:0,totalRevenue:0,top10ProductCrn:0.42,...extra}]}};}
function connector(handler:(r:ConnectorRequest)=>unknown|Promise<unknown>):RemoteMcpConnector{return {id:'sellerSprite',probe:async()=>{throw new Error('unused');},execute:async request=>({data:await handler(request) as any,source:{connectorId:'sellerSprite',operation:request.operation,fetchedAt:at,attemptCount:1}})};}

test('real provider numeric node IDs remain raw while canonical identity is checked',async()=>{
  const body=payload({nodeId:456}),result=await collectMarketOverviewSource({...base,connector:connector(()=>body)});
  assert.ok(result.evidence);assert.deepEqual(result.evidence.payload,body);assert.equal(result.evidence.responseIdentity.nodeId.echoes[0].value,'456');
  for(const nodeId of [999,-456,456.1,Number.MAX_SAFE_INTEGER+1,true,null]){
    const rejected=await collectMarketOverviewSource({...base,connector:connector(()=>payload({nodeId}))});assert.equal(rejected.status,'failed');assert.equal(rejected.evidence,null);
  }
});
test('monthly endpoint requests have separate concentration/window parameters and source-bound zero metrics',async()=>{
  const calls:ConnectorRequest[]=[];const result=await collectMarketOverviewSource({...base,connector:connector(r=>{calls.push(r);return payload();})});
  assert.equal(result.status,'partial');assert.ok(result.evidence);assert.equal(result.evidence.units.totalRevenue.status,'known');assert.equal(result.evidence.units.top10ProductCrn.status,'unknown');
  assert.deepEqual(calls[0].input,{request:{marketplace:'US',nodeIdPath:scope.nodeIdPath,month:'202608',newProduct:6,topNum:10,page:1,size:10}});assert.equal(calls[0].governorScope?.organizationId,scope.organizationId);
  const catalog=buildMarketOverviewSourceCatalog({scope,parameters:{headTopN:10,newProductMonths:6},dataCutoffAt:at,sources:[result.evidence]});assert.equal(catalog.months[1].metrics.totalUnits.value,0);
});
test('statistics is an independent source; absent currency and identity stay unverified',async()=>{
  let request:ConnectorRequest|undefined;const result=await collectMarketOverviewSource({...base,operation:'market_research_statistics',connector:connector(r=>{request=r;return {data:{brands:5,avgPrice:20}};})});
  assert.ok(result.evidence);assert.equal(result.status,'partial');assert.equal(result.evidence.units.avgPrice.status,'unknown');assert.equal(result.evidence.responseIdentity.month.status,'unverified');
  assert.equal((request!.input.request as any).topN,10);assert.equal((request!.input.request as any).topNum,undefined);
});
test('scope conflicts, ambiguous matches and upstream error envelopes cannot become evidence',async()=>{
  for(const body of [payload({nodeId:'999'}),payload({month:'202607'}),{code:'OK',data:{items:[...payload().data.items,...payload().data.items]}},{isError:true,...payload()}]){
    const result=await collectMarketOverviewSource({...base,connector:connector(()=>body)});assert.equal(result.status,'failed');assert.equal(result.evidence,null);
  }
});
test('empty endpoint is preserved independently of a failed endpoint',async()=>{
  const empty=await collectMarketOverviewSource({...base,connector:connector(()=>({code:'OK',data:{items:[]}}))});assert.equal(empty.status,'empty');assert.ok(empty.evidence);
  const failed=await collectMarketOverviewSource({...base,operation:'market_research_statistics',connector:connector(()=>{throw new ConnectorError('sellerSprite','timeout',true);})});assert.equal(failed.status,'failed');assert.equal(failed.issues[0].code,'timeout');
});
test('cancellation and synchronous late returns are rejected before successful persistence',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const cancelled=await collectMarketOverviewSource({...base,signal:controller.signal,connector:connector(()=>{calls++;return payload();})});assert.equal(cancelled.status,'failed');assert.equal(calls,0);
  for(const throws of [false,true]){const late=await collectMarketOverviewSource({...base,timeoutMs:5,connector:connector(()=>{const start=performance.now();while(performance.now()-start<15){}if(throws)throw new Error('late');return payload();})});assert.equal(late.status,'failed');assert.equal(late.issues[0].code,'timeout');}
});
test('invalid scope months and unsupported parameters do not dispatch a source call',async()=>{
  let calls=0;const c=connector(()=>{calls++;return payload();});
  await assert.rejects(collectMarketOverviewSource({...base,month:'2026-09',connector:c}));
  await assert.rejects(collectMarketOverviewSource({...base,headTopN:100 as any,connector:c}));assert.equal(calls,0);
});
test('wrong provenance and future source timestamps are rejected without accepted evidence',async()=>{
  for(const override of [{connectorId:'sorftime'},{operation:'other-operation'},{attemptCount:0},{fetchedAt:'2099-01-01T00:00:00.000Z'}]){
    const c=connector(()=>payload()),execute=c.execute;c.execute=async request=>{const response=await execute(request);return {...response,source:{...response.source,...override}} as any;};
    const result=await collectMarketOverviewSource({...base,connector:c});assert.equal(result.status,'failed');assert.equal(result.evidence,null);
  }
});
test('a stalled connector cannot keep collection pending past its timeout or caller cancellation',async()=>{
  for(const cancel of [false,true]){
    const controller=new AbortController();let called=false,observed:AbortSignal|undefined;
    // Keep the event loop live independently of the collector's unref timer.
    const guard=setTimeout(()=>{},1000);const c=connector(request=>{called=true;observed=request.signal;return new Promise(()=>{});});
    const started=performance.now();const pending=collectMarketOverviewSource({...base,signal:controller.signal,timeoutMs:25,connector:c});
    const cancelTimer=cancel?setTimeout(()=>controller.abort(),5):undefined;
    try{const result=await pending;assert.equal(result.status,'failed');assert.equal(result.evidence,null);assert.equal(result.issues[0].code,cancel?'interrupted':'timeout');assert.ok(called);assert.ok(observed?.aborted);assert.ok(performance.now()-started<750);}
    finally{clearTimeout(guard);if(cancelTimer)clearTimeout(cancelTimer);}
  }
});
