import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { ConnectorError, type ConnectorRequest, type RemoteMcpConnector } from '../../server/connectors/connector-contract';

// Synthetic fixture follows the 2026-09-12 live SellerSprite response shape.
const now=new Date('2026-09-12T08:00:00.000Z');
const scope={organizationId:'org-a',researchId:'a9000000-0000-4000-8000-000000000001',marketplace:'US' as const,nodeIdPath:'228013:495224:3736561:1063294',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const row=(asin='B000000001',units:unknown=100)=>({asin,title:'Synthetic workshop lamp',brand:'Fixture',price:20,totalUnits:units,totalRevenue:2000,ranking:1,sellerName:'Fixture seller',sellerType:'FBA',shelfDate:'2025-01-10',rating:4.5,ratings:20});
function connector(payload:unknown,calls:ConnectorRequest[]=[]):RemoteMcpConnector {
  return {id:'sellerSprite',execute:async request=>{calls.push(request);return {data:payload as Record<string,unknown>,source:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt:'2026-09-12T07:00:00.000Z',attemptCount:1}};},probe:async()=>{throw new Error('not used');}};
}
const input=(payload:unknown)=>({scope,month:'2026-08',poolSize:100,newProductMonths:6,jobId:'job-products',connector:connector(payload),now:()=>now});

test('one governed monthly request returns source members without inventing identity echoes',async()=>{
  const calls:ConnectorRequest[]=[];
  const result=await collectMarketProductPool({...input(null),connector:connector({code:'OK',data:[row()]},calls)});
  assert.equal(result.status,'ready');
  assert.deepEqual(calls[0].input,{request:{marketplace:'US',nodeIdPath:scope.nodeIdPath,month:'202608',topN:100,newProduct:6}});
  assert.deepEqual(calls[0].governorScope,{organizationId:'org-a',jobId:'job-products'});
  assert.equal(calls.length,1);
  assert.equal(result.products[0].units,100);
  assert.equal(result.products[0].price,20);
  assert.equal(result.products[0].sourceIndex,0);
  assert.equal(result.evidence?.responseIdentity.month.status,'unverified');
  assert.deepEqual(result.evidence?.observationPeriod,{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'});
  assert.equal(result.sampling.rankBasis,'provider-head-listings');
  assert.equal(result.sampling.bsrTopVerified,false);
  assert.equal(result.sampling.exhaustive,false);
});

test('returns all source rows in source order and preserves zero vs unknown metrics',async()=>{
  const result=await collectMarketProductPool(input({code:'OK',data:[row('B000000002',0),{...row(),price:null,totalUnits:null,totalRevenue:null}]}));
  assert.equal(result.status,'partial');
  assert.deepEqual(result.products.map(p=>p.asin),['B000000002','B000000001']);
  assert.equal(result.products[0].units,0);
  assert.equal(result.products[1].units,null);
  assert.equal(result.products[1].price,null);
  assert.ok(result.issues.some(i=>i.code==='missing-metric'&&i.asin==='B000000001'));
});

test('strict decimal source numbers normalize and malformed values remain explicit gaps',async()=>{
  const result=await collectMarketProductPool(input({code:'OK',data:[{...row(),price:'19.99',totalUnits:'25',totalRevenue:'499.75',rating:9,ratings:-1,ranking:'bad'}]}));
  assert.equal(result.status,'partial');
  assert.equal(result.products[0].price,19.99);
  assert.equal(result.products[0].units,25);
  assert.equal(result.products[0].rating,null);
  assert.equal(result.products[0].ratingCount,null);
  assert.equal(result.products[0].sourceRank,null);
  for(const invalid of ['',false,'0x10','1,000','NaN',-1,1.5]) {
    const value=await collectMarketProductPool(input({code:'OK',data:[row('B000000001',invalid)]}));
    assert.equal(value.products[0].units,null,String(invalid));
  }
});

test('mismatching envelope or row query identity fails while preserving bounded raw input',async()=>{
  for(const payload of [
    {code:'OK',marketplace:'UK',data:[row()]},
    {code:'OK',data:[{...row(),month:'202607'}]},
    {code:'OK',data:[{...row(),currency:'EUR'}]},
    {code:'OK',data:[{...row(),nodeId:'999'}]},
  ]) {
    const result=await collectMarketProductPool(input(payload));
    assert.equal(result.status,'failed');
    assert.equal(result.issues[0].code,'scope-mismatch');
    assert.deepEqual(result.products,[]);
    assert.deepEqual(result.rawPayload,payload);
    assert.equal(result.evidence,null);
  }
});

test('query echoes are checked in every member and normalized to the same month',async()=>{
  const result=await collectMarketProductPool(input({code:'OK',month:'202608',data:[{...row(),month:'2026-08',marketplace:'US',nodeIdPath:scope.nodeIdPath}]}));
  assert.equal(result.status,'ready');
  assert.equal(result.evidence?.responseIdentity.month.status,'verified');
  assert.equal(result.evidence?.responseIdentity.month.echoes.length,2);
});

test('duplicate and invalid ASINs reject the pool rather than silently choosing one record',async()=>{
  for(const rows of [[row(),row('b000000001')],[row('BAD')]]) {
    const result=await collectMarketProductPool(input({code:'OK',data:rows}));
    assert.equal(result.status,'failed');
    assert.equal(result.issues[0].code,'malformed-response');
    assert.deepEqual(result.products,[]);
  }
});

test('empty, malformed and rejected upstream responses have different outcomes',async()=>{
  assert.equal((await collectMarketProductPool(input({code:'OK',data:[]}))).status,'empty');
  for(const payload of [{code:'OK',data:{}},{code:'OK',data:null},[row()]]) {
    const result=await collectMarketProductPool(input(payload));
    assert.equal(result.status,'failed');
    assert.equal(result.issues[0].code,'malformed-response');
  }
  const rejected=await collectMarketProductPool(input({code:'DENIED',message:'credential must not leak'}));
  assert.equal(rejected.issues[0].code,'upstream-permanent');
  assert.doesNotMatch(rejected.issues[0].message,/credential/);
});

test('returned pool size cannot silently exceed the explicitly requested bounded pool',async()=>{
  const result=await collectMarketProductPool({...input({code:'OK',data:[row(),row('B000000002')]}),poolSize:1});
  assert.equal(result.status,'failed');
  assert.equal(result.issues[0].code,'malformed-response');
});

test('bad scope and unfinished month are rejected before any upstream request',async()=>{
  const calls:ConnectorRequest[]=[];
  for(const overrides of [{month:'2026-09'},{month:'2026-06'},{poolSize:0},{poolSize:101},{newProductMonths:0},{jobId:''},{timeoutMs:0},{scope:{...scope,marketplace:'UK'}}]) {
    await assert.rejects(()=>collectMarketProductPool({...input(null),connector:connector(null,calls),...overrides} as Parameters<typeof collectMarketProductPool>[0]));
  }
  assert.equal(calls.length,0);
});

test('cancellation and connector failures do not dispatch retries or expose raw errors',async()=>{
  const calls:ConnectorRequest[]=[];
  const controller=new AbortController();controller.abort();
  const cancelled=await collectMarketProductPool({...input(null),connector:connector(null,calls),signal:controller.signal});
  assert.equal(cancelled.issues[0].code,'interrupted');
  assert.equal(calls.length,0);
  const failing=connector(null,calls);failing.execute=async()=>{throw new ConnectorError('sellerSprite','timeout',true);};
  const result=await collectMarketProductPool({...input(null),connector:failing});
  assert.equal(result.issues[0].code,'timeout');
  assert.equal(result.issues[0].retryable,true);
});

test('plain payload guard refuses executable input and no getter executes',async()=>{
  let calls=0;
  const payload={code:'OK',data:[row()]};
  Object.defineProperty(payload,'hidden',{get(){calls++;return 'bad';}});
  const result=await collectMarketProductPool(input(payload));
  assert.equal(result.status,'failed');
  assert.equal(result.rawPayload,null);
  assert.equal(calls,0);
});

test('captured source is detached so later connector mutation cannot change the report',async()=>{
  const payload={code:'OK',data:[row()]};
  const result=await collectMarketProductPool(input(payload));
  payload.data[0].title='changed';
  assert.equal(result.products[0].title,'Synthetic workshop lamp');
  assert.deepEqual((result.rawPayload as {data:unknown[]}).data[0],row());
});

test('normal response timestamps are checked after the request finishes',async()=>{
  const live=connector(null);
  live.execute=async()=>{
    await new Promise(resolve=>setTimeout(resolve,15));
    return {data:{code:'OK',data:[row()]},source:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt:new Date().toISOString(),attemptCount:1}};
  };
  assert.equal((await collectMarketProductPool({...input(null),connector:live,now:undefined})).status,'ready');
});

test('deadline settles even when the connector ignores its abort signal',async()=>{
  const hung=connector(null); let calls=0; let activeSignal:AbortSignal|undefined;
  hung.execute=async request=>{calls++;activeSignal=request.signal;return new Promise(()=>{});};
  const result=await Promise.race([
    collectMarketProductPool({...input(null),connector:hung,timeoutMs:5}),
    new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('collector did not meet deadline')),150)),
  ]);
  assert.equal(result.status,'failed'); assert.equal(result.issues[0].code,'timeout');
  assert.equal(calls,1); assert.equal(activeSignal?.aborted,true);
});

test('an abort racing a successful return cannot publish a ready pool',async()=>{
  const controller=new AbortController(); const source=connector(null);
  source.execute=async()=>{controller.abort();return {data:{code:'OK',data:[row()]},source:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt:now.toISOString(),attemptCount:1}};};
  const result=await collectMarketProductPool({...input(null),connector:source,signal:controller.signal});
  assert.equal(result.status,'failed'); assert.equal(result.issues[0].code,'interrupted');
});

test('snake case category path conflicts are rejected at envelope and member levels',async()=>{
  for(const payload of [{code:'OK',node_id_path:'228013:999',data:[row()]},{code:'OK',data:[{...row(),node_id_path:'228013:999'}]}]) {
    const result=await collectMarketProductPool(input(payload));
    assert.equal(result.status,'failed'); assert.equal(result.issues[0].code,'scope-mismatch');
  }
});

test('one member currency does not establish the unit of every product',async()=>{
  const partial=await collectMarketProductPool(input({code:'OK',data:[{...row(),currency:'USD'},row('B000000002')]}));
  assert.equal(partial.evidence?.units.price.status,'unknown');
  for(const payload of [{code:'OK',currency:'USD',data:[row(),row('B000000002')]},{code:'OK',data:[{...row(),currency:'USD'},{...row('B000000002'),currency:'USD'}]}]) {
    assert.equal((await collectMarketProductPool(input(payload))).evidence?.units.price.status,'known');
  }
});

test('connector wrapper data and metadata accessors never execute',async()=>{
  for(const key of ['data','source']) {
    let count=0; const source=connector(null);
    source.execute=async()=>{
      const result={data:{code:'OK',data:[row()]},source:{connectorId:'sellerSprite' as const,operation:'market_product_concentration',fetchedAt:now.toISOString(),attemptCount:1}};
      Object.defineProperty(result,key,{get(){count++;return key==='data'?{code:'OK',data:[row()]}:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt:now.toISOString(),attemptCount:1};}});
      return result;
    };
    assert.equal((await collectMarketProductPool({...input(null),connector:source})).status,'failed');
    assert.equal(count,0);
  }
});

test('source decimal text cannot round fractional counts or underflow positive values into observed zero',async()=>{
  for(const invalid of ['1.00000000000000001','9007199254740990.5']) {
    assert.equal((await collectMarketProductPool(input({code:'OK',data:[row('B000000001',invalid)]}))).products[0].units,null);
  }
  const tiny=`0.${'0'.repeat(330)}1`;
  const result=await collectMarketProductPool(input({code:'OK',data:[{...row(),price:tiny,ranking:0}]}));
  assert.equal(result.products[0].price,null); assert.equal(result.products[0].sourceRank,null);
  const rounded=await collectMarketProductPool(input({code:'OK',data:[{...row(),price:'9007199254740991.1',rating:'5.00000000000000001'}]}));
  assert.equal(rounded.products[0].price,null); assert.equal(rounded.products[0].rating,null);
});

test('a synchronous connector blocking beyond the deadline cannot return successful evidence',async()=>{
  const source=connector(null);
  source.execute=async()=>{
    const start=performance.now(); while(performance.now()-start<25) { /* Deliberately stall the event loop. */ }
    return {data:{code:'OK',data:[row()]},source:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt:now.toISOString(),attemptCount:1}};
  };
  const result=await collectMarketProductPool({...input(null),connector:source,timeoutMs:5});
  assert.equal(result.status,'failed'); assert.equal(result.issues[0].code,'timeout');
});

test('a synchronous rejection cannot override an elapsed deadline or parent cancellation',async()=>{
  for(const cancel of [false,true]) {
    const source=connector(null); const controller=new AbortController(); let child:AbortSignal|undefined;
    source.execute=async request=>{
      child=request.signal;
      const start=performance.now(); while(performance.now()-start<25) { /* Stall before rejecting. */ }
      if(cancel)controller.abort();
      throw new ConnectorError('sellerSprite','authentication',false);
    };
    const result=await collectMarketProductPool({...input(null),connector:source,signal:controller.signal,timeoutMs:5});
    assert.equal(result.status,'failed'); assert.equal(result.issues[0].code,cancel?'interrupted':'timeout');
    assert.equal(child?.aborted,true); assert.equal(result.evidence,null);
  }
});

test('fixed member collection sends the selected pool and preserves absent member gaps',async()=>{
  const calls:ConnectorRequest[]=[];
  const result=await collectMarketProductPool({...input(null),poolSize:2,selectedAsins:['b000000002','B000000001'],connector:connector({code:'OK',data:[row()]},calls)});
  assert.deepEqual((calls[0].input.request as Record<string,unknown>).asins,['B000000001','B000000002']);
  assert.equal(result.status,'partial');
  assert.equal(result.sampling.rankBasis,'fixed-selected-members');
  assert.deepEqual(result.sampling.selectedAsins,['B000000001','B000000002']);
  assert.deepEqual(result.sampling.missingAsins,['B000000002']);
  assert.equal(result.evidence?.coverage.expectedCount,2);
  assert.equal(result.products[0].units,100);
  assert.equal(result.issues.find(i=>i.asin==='B000000002')?.code,'missing-member');
});

test('fixed pool never accepts an unselected returned ASIN as a replacement',async()=>{
  const raw={code:'OK',data:[row('B000000003')]};
  const result=await collectMarketProductPool({...input(raw),poolSize:2,selectedAsins:['B000000001','B000000002']});
  assert.equal(result.status,'failed'); assert.equal(result.issues[0].code,'scope-mismatch');
  assert.equal(result.evidence,null); assert.deepEqual(result.rawPayload,raw);
});

test('fixed pool arguments must be a unique nonempty complete requested set before dispatch',async()=>{
  const calls:ConnectorRequest[]=[];
  for(const selectedAsins of [[],['B000000001','b000000001'],['BAD'],['B000000001']]) {
    await assert.rejects(()=>collectMarketProductPool({...input(null),poolSize:2,selectedAsins,connector:connector(null,calls)}));
  }
  assert.equal(calls.length,0);
});

test('an observed empty response preserves every fixed member as an unresolved gap',async()=>{
  const result=await collectMarketProductPool({...input({code:'OK',data:[]}),poolSize:1,selectedAsins:['B000000001']});
  assert.equal(result.status,'empty'); assert.deepEqual(result.sampling.missingAsins,['B000000001']);
  assert.equal(result.evidence?.coverage.expectedCount,1);
  assert.equal(result.products.length,0);
});
