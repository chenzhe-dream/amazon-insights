import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {collectMarketOverviewDistribution} from '../../server/services/market-overview-distribution-collector';
import {MarketOverviewFlowParamsSchema} from '../../server/domain/market-research/overview-flow';
import {readFileSync} from 'node:fs';
import {parseOverviewCategoryTrend,projectOverviewExternal,collectOverviewExternal} from '../../server/services/market-overview-external-collector';
import {projectOverviewProductDemand} from '../../server/runtime/market-overview-external-step';
const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,currency:'USD' as const,nodeIdPath:'123:456',fromMonth:'2026-08',toMonth:'2026-08'};
test('external collection has a new isolated flow version',()=>{assert.equal(MarketOverviewFlowParamsSchema.safeParse({flow:'market-overview-flow/rules-v4',headTopN:10,newProductMonths:6}).success,true);});
test('new original demand request omits newProduct and uses original top100 without changing old requests',async()=>{
 const requests:any[]=[],connector:any={id:'sellerSprite',execute:async(r:any)=>{requests.push(r.input.request);return {data:{code:'OK',data:{items:[]}},source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:'2026-09-20T00:00:00Z',attemptCount:1}};}};
 const base={scope,month:scope.toMonth,operation:'market_product_demand_trend' as const,headTopN:10 as const,newProductMonths:6 as const,jobId:randomUUID(),connector};
 await collectMarketOverviewDistribution({...base,originalDemand:true} as any);await collectMarketOverviewDistribution(base);
 assert.deepEqual(requests[0],{marketplace:'US',nodeIdPath:'123:456',month:'202608',topN:100});
 assert.deepEqual(requests[1],{marketplace:'US',nodeIdPath:'123:456',month:'202608',topN:10,newProduct:6});
});
test('live Sorftime and demand receipts parse at the report cutoff without inventing null values',()=>{
 const live=JSON.parse(readFileSync(new URL('./fixtures/overview-external-live.json',import.meta.url),'utf8'));
 const sales=parseOverviewCategoryTrend(live.sales,'2026-08'),prices=parseOverviewCategoryTrend(live.prices,'2026-08');assert.equal(sales.length,24);assert.equal(prices.length,24);assert.equal(sales.at(-1)!.month,'2026-08');
 const source:any={scope,operation:'market_product_demand_trend',requestIdentity:{month:'2026-08'},payload:live['demand-original']};
 const demand=projectOverviewProductDemand([source],'2026-08',[]);assert.equal(demand.points.length,13);assert.equal(demand.points[0].month,'2025-05-01');assert.equal(demand.status,'ready');
});
test('profit page matches exact requested ASIN only, keeps absent source fields unknown, and rejects conflicting page',()=>{
 const stage:any={phase:'overview-external',catalogAttemptId:randomUUID(),kind:'profits',batch:0,page:2,asins:['B000000001']};
 const raw={code:'OK',data:{page:2,pages:4,items:[{asin:'B000000099',price:999,profit:99,fba:9},{asin:'B000000001',price:20,profit:0.5,fba:null},{asin:'B000000001',price:21,profit:0.6,fba:5}]}};
 const result=projectOverviewExternal(stage,raw,'2026-08');assert.deepEqual(result.items,{'B000000001':{price:20,profit:0.5,fba:null}});assert.equal(result.pages,4);
 assert.throws(()=>projectOverviewExternal({...stage,page:1},raw,'2026-08'));
});
test('metric-only demand remains ready and conflicting duplicate months are not silently selected',()=>{
 const source:any={scope,operation:'market_product_demand_trend',requestIdentity:{month:'2026-08'},payload:{data:{asinCount:12,returnRatio:0.1,items:[]}}};
 assert.equal(projectOverviewProductDemand([source],'2026-08',[]).status,'ready');
 source.payload.data.items=[{date:'2026-08-01',glanceViews:4},{date:'2026-07-01',glanceViews:3},{date:'2026-07-01',glanceViews:3}];
 assert.deepEqual(projectOverviewProductDemand([source],'2026-08',[]).points,[{month:'2026-07-01',value:3},{month:'2026-08-01',value:4}]);
 source.payload.data.items.push({date:'2026-07-01',glanceViews:5});const partial=projectOverviewProductDemand([source],'2026-08',[]);assert.equal(partial.status,'partial');assert.equal(partial.errorCode,'conflicting-demand-month');assert.deepEqual(partial.points,[{month:'2026-08-01',value:4}]);
});
test('product demand numeric observations reject blank and boolean values while keeping real zero',()=>{
 const source:any={scope,operation:'market_product_demand_trend',requestIdentity:{month:'2026-08'},payload:{data:{asinCount:false,returnRatio:' ',items:[{date:'2026-06-01',glanceViews:false},{date:'2026-07-01',glanceViews:' '},{date:'2026-08-01',glanceViews:0}]}}};
 const result=projectOverviewProductDemand([source],'2026-08',[]);
 assert.equal(result.asinCount,null);assert.equal(result.returnRatio,null);assert.deepEqual(result.points,[{month:'2026-08-01',value:0}]);
});
test('category parser preserves original content envelope and Chinese month format',()=>{
 assert.deepEqual(parseOverviewCategoryTrend({content:'2026年07月=10,2026年08月=20'},'2026-08'),[{month:'2026-07',value:10},{month:'2026-08',value:20}]);
});
test('external collectors propagate cancellation and refuse mismatched currency instead of publishing',async()=>{
 const abort=new AbortController();abort.abort();let calls=0;
 const connector:any={id:'sorftime',execute:async(r:any)=>{calls++;return {data:{currency:'GBP',data:['2026-08=2']},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString()}};}};
 const args:any={scope,stage:{phase:'overview-external',catalogAttemptId:randomUUID(),kind:'sales'},connectors:{sorftime:connector,sellerSprite:connector},jobId:randomUUID(),signal:abort.signal};
 await assert.rejects(collectOverviewExternal(args));assert.equal(calls,0);const result=await collectOverviewExternal({...args,signal:new AbortController().signal});assert.equal(result.status,'failed');
});
test('source site and camelCase node aliases cannot bypass external scope validation',async()=>{
 for(const extra of [{site:'JP'},{nodeId:'999'},{data:{site:'JP',items:[]}}]){
  const connector:any={id:'sorftime',execute:async(r:any)=>({data:{data:['2026-08=2'],...extra},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString()}})};
  const result=await collectOverviewExternal({scope,stage:{phase:'overview-external',catalogAttemptId:randomUUID(),kind:'sales'},connectors:{sorftime:connector,sellerSprite:connector},jobId:randomUUID(),signal:new AbortController().signal});assert.equal(result.status,'failed');
 }
});
