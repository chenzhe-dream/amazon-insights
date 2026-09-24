import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketProductHistory, normalizeProductHistory, productHistoryPeriods} from '../../server/services/market-product-history-collector';
import {ConnectorError, type RemoteMcpConnector} from '../../server/connectors/connector-contract';

const scope={organizationId:'org-a',researchId:'a9000000-0000-4000-8000-000000000001',marketplace:'US' as const,nodeIdPath:'1:2:3',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
const cutoff='2026-09-24T00:00:00.000Z',asin='B000000001';
const connector=(data:unknown):RemoteMcpConnector=>({id:'sorftime',probe:async()=>{throw Error('unused')},execute:async request=>{
 assert.equal(request.operation,'product_trend');assert.deepEqual(request.input,{asin,amz_site:'US',product_trend_type:'SalesVolume'});
 assert.deepEqual(request.governorScope,{organizationId:scope.organizationId,jobId:'test-history'});
 return {data:data as Record<string,unknown>,source:{connectorId:'sorftime',operation:'product_trend',fetchedAt:cutoff,attemptCount:1}};
}});
const collect=(data:unknown)=>collectMarketProductHistory({scope,asin,jobId:'test-history',connector:connector(data),now:()=>new Date(cutoff)});

test('historical months outside a single-month research scope are stored without changing its scope',async()=>{
 const result=await collect({data:['2026年06月=10','2026-07=0','2026-08=20','2026-09=999']});
 assert.equal(result.status,'ready');
 assert.deepEqual(result.points.map(p=>[p.month,p.units]),[['2026-06',10],['2026-07',0],['2026-08',20]]);
 assert.deepEqual(result.evidence.scope,scope);assert.equal(result.evidence.provider,'sorftime');
 const periods=productHistoryPeriods(result.points,scope.toMonth);
 assert.equal(periods[0].units,30);assert.equal(periods[1].units,null);
 assert.deepEqual(periods[1].missingMonths,['2026-03','2026-04','2026-05']);
});
test('missing, invalid and conflicting months cannot become zero or partial period totals',()=>{
 const points=normalizeProductHistory({data:'2026-06=10,2026-07=,2026-08=20,2026-08=21'},'2026-08');
 assert.deepEqual(points.map(p=>p.units),[10,null,null]);
 assert.equal(productHistoryPeriods(points,'2026-08')[0].units,null);
 assert.throws(()=>normalizeProductHistory({data:{message:'invalid token'}},'2026-08'));
 assert.throws(()=>normalizeProductHistory({data:['2026-13=10']},'2026-08'));
});
test('explicit empty response is distinct from malformed response and wrong source identity',async()=>{
 assert.equal((await collect({data:[]})).status,'empty');
 assert.equal((await collect({asin:'B000000002',data:['2026-08=10']})).status,'failed');
 assert.equal((await collect({amz_site:'DE',data:['2026-08=10']})).status,'failed');
 assert.equal((await collect({error:'rate limit'})).status,'failed');
});
test('transport failure preserves retryability and cancellation makes no request',async()=>{
 const c=connector({data:[]});c.execute=async()=>{throw new ConnectorError('sorftime','rate-limit',true)};
 const result=await collectMarketProductHistory({scope,asin,jobId:'x',connector:c,now:()=>new Date(cutoff)});
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.failure.retryable,true);
 const controller=new AbortController();controller.abort();let calls=0;c.execute=async()=>{calls++;throw Error('not called')};
 assert.equal((await collectMarketProductHistory({scope,asin,jobId:'x',connector:c,signal:controller.signal,now:()=>new Date(cutoff)})).status,'failed');assert.equal(calls,0);
});

