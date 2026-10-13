import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeShapeCategorySource,collectShapeCategory} from '../../server/services/market-shape-category-collector';
import {normalizeProductHistory,normalizeProductAmountHistory,collectMarketProductHistory} from '../../server/services/market-product-history-collector';
import {parseSorftimeMarginObservation} from '../../shared/market-shape-margin-observation';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`../fixtures/market-shape-${name}-20261013.json`,import.meta.url),'utf8'));
const scope={organizationId:'22222222-2222-4222-8222-222222222222',researchId:'71000000-0000-4000-8000-000000000001',marketplace:'US',currency:'USD',nodeIdPath:'228013:495224:3736561:1063294',fromMonth:'2026-09',toMonth:'2026-09'} as const;
const connector=(data:unknown):RemoteMcpConnector=>({id:'sorftime',probe:async()=>{throw Error('offline')},execute:async r=>({data:data as Record<string,unknown>,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:'2026-10-13T08:00:00.000Z',attemptCount:1}})});
test('saved real category stats accept documented fields without inventing Top80 prices',async()=>{
 const raw=fixture('category-report');const stats=normalizeShapeCategorySource('report',raw,'2026-09').stats!;
 assert.equal(stats.top100Units,300447);assert.equal(stats.top100Amount,14464018.08);assert.equal(stats.top3ProductPct,31.74);
 assert.equal(stats.top3BrandPct,raw.data.top3_brand_sales_volume_share);assert.equal(stats.returnRatePct,raw.data.return_rate);
 assert.equal(stats.averagePrice,null);assert.equal(stats.medianPrice,null);
 assert.equal(normalizeShapeCategorySource('report',raw,'2026-09','EUR').stats?.top100Amount,null);
 assert.equal((await collectShapeCategory({scope,metric:'report',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:connector(raw)})).status,'partial');
 assert.equal((await collectShapeCategory({scope:{...scope,nodeIdPath:'999'},metric:'report',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:connector(raw)})).status,'failed');
});
test('saved real detail profit_rate preserves same ASIN and numeric range safeguards',()=>{
 const raw=fixture('product-detail');assert.deepEqual(parseSorftimeMarginObservation(raw,'B093WBKC9N'),{grossProfitMargin:64.99,price:33.79});
 assert.equal(parseSorftimeMarginObservation(raw,'B099WTN2TR'),null);
 assert.equal(parseSorftimeMarginObservation({data:{...raw.data,gross_profit_rate:12}},raw.data.asin),null);
});
test('one saved real monthly product trend replays without new supplier calls',async()=>{
 const raw=fixture('product-trend');const points=normalizeProductHistory(raw,'2026-09');assert.equal(points.length,24);assert.deepEqual(points.at(-1),{month:'2026-09',units:18402,issues:[]});
 const result=await collectMarketProductHistory({scope,asin:'B099WTN2TR',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:connector(raw)});assert.equal(result.status,'ready');
 assert.equal((await collectMarketProductHistory({scope,asin:'B000000001',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:connector(raw)})).status,'failed');
 assert.equal((await collectMarketProductHistory({scope,asin:'B099WTN2TR',metric:'SalesAmount',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:connector(raw)})).status,'failed');
});
test('new monthly arrays reject malformed or ambiguous records and preserve zero and missing months',()=>{
 const data=(values:unknown[])=>({data:{asin:'B099WTN2TR',type:'SalesAmount',data:values}});
 assert.deepEqual(normalizeProductAmountHistory(data(['202607',12.5,'202608',0,'202609',-1]),'2026-09'),[{month:'2026-07',amount:12.5,issues:[]},{month:'2026-08',amount:0,issues:[]},{month:'2026-09',amount:null,issues:['invalid-value']}]);
 for(const values of [['202609'],['202613',1],['202609',{}]])assert.throws(()=>normalizeProductAmountHistory(data(values),'2026-09'));
 assert.equal(normalizeProductAmountHistory(data(['202609',1,'202609',2]),'2026-09')[0].amount,null);
});
test('modern trend accepts documented USD amounts and rejects nested identity or foreign currency ambiguity',async()=>{
 const data={data:{asin:'B099WTN2TR',type:'SalesAmount',data:['202609',12.5]}};
 const collect=(raw:unknown,foreign=false)=>collectMarketProductHistory({scope:foreign?{...scope,marketplace:'DE',currency:'EUR'}:scope,asin:'B099WTN2TR',metric:'SalesAmount',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:connector(raw)});
 assert.equal((await collect(data)).status,'ready');
 assert.equal((await collect(data,true)).status,'failed');
 for(const identity of [{currency:'EUR'},{amz_site:'DE'}])assert.equal((await collect({data:{...data.data,...identity}})).status,'failed');
 assert.equal((await collect({asin:'B000000001',...data})).status,'failed');
});
test('current supplier type parameter selects real decimal amount data instead of silently defaulting to volume',async()=>{
 let calls=0;
 const transport:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('offline')},execute:async request=>{
  calls++;assert.equal(request.input.type,'SalesAmount');assert.equal(Object.hasOwn(request.input,'product_trend_type'),false);
  // Saved probes proved that the old parameter is ignored and returns SalesVolume.
  return {data:fixture(request.input.type==='SalesAmount'?'product-amount':'product-trend'),source:{connectorId:'sorftime',operation:'product_trend',fetchedAt:'2026-10-13T08:00:00.000Z',attemptCount:1}};
 }};
 const result=await collectMarketProductHistory({scope,asin:'B099WTN2TR',metric:'SalesAmount',jobId:'offline',now:()=>new Date('2026-10-13T12:00:00.000Z'),connector:transport});
 assert.equal(calls,1);assert.equal(result.status,'ready');
 assert.equal(result.points.length,24);assert.deepEqual(result.points.at(-1),{month:'2026-09',amount:1195945.98,issues:[]});
 const unit=result.evidence.units.amount;assert.equal(unit.status,'known');if(unit.status==='known')assert.equal(unit.currency,'USD');
});

