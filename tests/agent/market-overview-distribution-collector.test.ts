import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {collectMarketOverviewDistribution} from '../../server/services/market-overview-distribution-collector';
import type {ConnectorRequest,RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {ConnectorError} from '../../server/connectors/connector-contract';
const at='2026-09-13T00:00:00.000Z',scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,currency:'USD' as const,nodeIdPath:'123:456',fromMonth:'2026-08',toMonth:'2026-08'};
const base={scope,month:'2026-08',operation:'market_price_distribution' as const,headTopN:10 as const,newProductMonths:6 as const,jobId:randomUUID(),now:()=>new Date(at)};
const payload=()=>({code:'OK',data:[{label:'0-15',asins:['B000000001'],products:1,units:10,revenue:20,unitsRatio:0.2}]});
function connector(work:(request:ConnectorRequest)=>unknown|Promise<unknown>):RemoteMcpConnector{return {id:'sellerSprite',probe:async()=>{throw new Error('unused');},execute:async r=>({data:await work(r) as any,source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:at,attemptCount:1}})};}
test('real array shape remains request-bound without fabricated echoes or guessed currencies',async()=>{
  let request:ConnectorRequest|undefined;const result=await collectMarketOverviewDistribution({...base,connector:connector(r=>{request=r;return payload();})});
  assert.equal(result.status,'partial');assert.ok(result.evidence);assert.equal(result.evidence.responseIdentity.month.status,'unverified');assert.equal(result.evidence.responseIdentity.nodeIdPath.status,'unverified');
  assert.deepEqual(result.evidence.payload,payload());assert.equal(result.evidence.units.unitsRatio.status,'unknown');assert.equal(result.evidence.units.revenue.status,'unknown');
  assert.equal(result.distribution!.groups[0].units,10);assert.equal(result.distribution!.rows[0].unitsSharePct,100);assert.equal(result.distribution!.rows[0].revenue,null);
  assert.deepEqual(request!.input,{request:{marketplace:'US',nodeIdPath:'123:456',month:'202608',newProduct:6,topN:10}});assert.equal(request!.governorScope?.organizationId,scope.organizationId);
});
test('distribution sample size is independent from head topN and concentration stays at the original fixed 100',async()=>{
  let priceRequest:ConnectorRequest|undefined,brandRequest:ConnectorRequest|undefined;
  const price=await collectMarketOverviewDistribution({...base,sampleSize:200,connector:connector(r=>{priceRequest=r;return payload();})} as any);
  await collectMarketOverviewDistribution({...base,operation:'market_brand_concentration',sampleSize:50,connector:connector(r=>{brandRequest=r;return payload();})} as any);
  const priceBody=priceRequest!.input.request as any,brandBody=brandRequest!.input.request as any;
  assert.equal(priceBody.topN,200);
  assert.equal(brandBody.topN,100);
  assert.equal(priceBody.newProduct,6);
  assert.equal(priceBody.marketplace,'US');
  assert.equal(price.parameters.sampleSize,200);
});
test('conflicting node/month/market/currency echoes are rejected at root or individual row',async()=>{
  for(const extra of [{month:'202607'},{nodeIdPath:'999:888'},{marketplace:'UK'},{currency:'GBP'},{nodeId:'777'}]){
    for(const nested of [false,true]){const body=payload();const response=nested?{...body,data:body.data.map(r=>({...r,...extra}))}:{...body,...extra};
      const result=await collectMarketOverviewDistribution({...base,connector:connector(()=>response)});assert.equal(result.status,'failed');assert.equal(result.evidence,null);assert.equal(result.issues[0].code,'scope-mismatch');}
  }
});
test('explicit correct currency and echoes support currency while missing echoes remain labeled',async()=>{
  const result=await collectMarketOverviewDistribution({...base,connector:connector(()=>({...payload(),currency:'USD',marketplace:'US',nodeIdPath:scope.nodeIdPath,month:'202608'}))});
  assert.equal(result.status,'ready');assert.equal(result.distribution!.rows[0].revenue,20);assert.equal(result.evidence!.responseIdentity.month.status,'verified');
});
test('empty demand response is preserved as no data, populated unknown series is not invented',async()=>{
  const response={code:'OK',data:{asinCount:null,returnRatio:null,searchToPurchaseRatio:null,avgReturnRatio:null,avgSearchToPurchaseRatio:null,items:[]}};
  const empty=await collectMarketOverviewDistribution({...base,operation:'market_product_demand_trend',connector:connector(()=>response)});assert.equal(empty.status,'empty');assert.ok(empty.evidence);assert.equal(empty.distribution,null);
  const pending=await collectMarketOverviewDistribution({...base,operation:'market_product_demand_trend',connector:connector(()=>({...response,data:{...response.data,items:[{unknown:1}]}}))});assert.equal(pending.status,'partial');assert.ok(pending.issues.some(i=>i.code==='demand-series-not-normalized'));
  const array=await collectMarketOverviewDistribution({...base,connector:connector(()=>({data:[]}))});assert.equal(array.status,'empty');assert.ok(array.evidence);
});
test('provenance, malformed response and upstream failure cannot become accepted distribution evidence',async()=>{
  for(const body of [{isError:true,...payload()},{code:'ERROR',data:[]},{data:{}},'bad']){const result=await collectMarketOverviewDistribution({...base,connector:connector(()=>body)});assert.equal(result.status,'failed');assert.equal(result.evidence,null);}
  const c=connector(()=>payload()),execute=c.execute;c.execute=async r=>({...await execute(r),source:{connectorId:'sorftime',operation:r.operation,fetchedAt:at,attemptCount:1}});
  assert.equal((await collectMarketOverviewDistribution({...base,connector:c})).status,'failed');
  const timeout=await collectMarketOverviewDistribution({...base,connector:connector(()=>{throw new ConnectorError('sellerSprite','timeout',true);})});assert.equal(timeout.issues[0].code,'timeout');assert.equal(timeout.issues[0].retryable,true);
});
test('cancellation and elapsed deadlines reject late or stalled response before evidence is returned',async()=>{
  const abort=new AbortController();abort.abort();let calls=0;const stopped=await collectMarketOverviewDistribution({...base,signal:abort.signal,connector:connector(()=>{calls++;return payload();})});assert.equal(calls,0);assert.equal(stopped.status,'failed');
  const late=await collectMarketOverviewDistribution({...base,timeoutMs:5,connector:connector(()=>{const t=performance.now();while(performance.now()-t<15){}return payload();})});assert.equal(late.issues[0].code,'timeout');
  const guard=setTimeout(()=>{},1000);try{const stalled=await collectMarketOverviewDistribution({...base,timeoutMs:25,connector:connector(()=>new Promise(()=>{}))});assert.equal(stalled.issues[0].code,'timeout');}finally{clearTimeout(guard);}
});
test('invalid operation, current month and invalid top parameter fail before dispatch',async()=>{
  let calls=0;const c=connector(()=>{calls++;return payload();});for(const patch of [{operation:'delete-everything'},{month:'2026-09'},{headTopN:100}])await assert.rejects(collectMarketOverviewDistribution({...base,...patch,connector:c} as any));assert.equal(calls,0);
});
