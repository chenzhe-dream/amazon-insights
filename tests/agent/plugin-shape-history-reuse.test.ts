import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MarketAnalysisScopeSchema} from '../../shared/market-analysis-contracts';
import {evaluatePluginShapeHistory,replayPluginShapeHistory} from '../../server/services/plugin-shape-history-reuse';
const months=Array.from({length:33},(_,i)=>new Date(Date.UTC(2024,i,1)).toISOString().slice(0,7));
function fixture(site:'US'|'CA'|'UK'|'DE'='US'){
 const currency=({US:'USD',CA:'CAD',UK:'GBP',DE:'EUR'} as Record<string,string>)[site],asin='B000000001',now=new Date('2026-10-19T02:00:00.000Z');
 const scope=MarketAnalysisScopeSchema.parse({organizationId:randomUUID(),researchId:randomUUID(),marketplace:site,currency,nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-09'});
 return {scope,asin,policy:'plugin-complete-series/v1' as const,metric:'SalesVolume' as 'SalesVolume'|'SalesAmount',now,source:{snapshotId:'plugin-source:'+'a'.repeat(64),jobId:randomUUID(),node:'34',marketplace:site,asin,collectedAt:'2026-10-19T01:00:00.000Z',basic:{asin,currency},history:{asin,nodes:['sale','amount','childSale','childAmount'].map(type=>({type,data:months.map((month,i)=>[month,i])}))}}};
}
test('four sites and metrics reuse complete native series without inventing money or child fields',()=>{
 for(const site of ['US','CA','UK','DE'] as const)for(const metric of ['SalesVolume','SalesAmount'] as const){
  const input={...fixture(site),metric},before=JSON.stringify(input),result=evaluatePluginShapeHistory(input);
  assert.ok(result.reuse);assert.equal(result.selection.selectedProvider,'sellerSprite');assert.equal(result.selection.requiredFrom,'2024-01');
  assert.equal(result.reuse.points.length,33);assert.equal(Object.values(result.reuse.points[0]).includes(0),true);
  assert.equal(result.reuse.evidence.provider,'sellerSprite');assert.deepEqual(replayPluginShapeHistory(input.scope,result.reuse.evidence),result.reuse);assert.equal(JSON.stringify(input),before);
 }
});
test('one missing amount does not discard complete units; annual gaps cannot be hidden by a recent complete quarter',()=>{
 const input=fixture();input.source.history.nodes[1].data[5][1]=null as never;
 assert.ok(evaluatePluginShapeHistory(input).reuse);
 const amount=evaluatePluginShapeHistory({...input,metric:'SalesAmount'});assert.equal(amount.reuse,null);assert.equal(amount.selection.selectedProvider,'sorftime');assert.deepEqual(amount.selection.missingMonths,['2024-06']);
 input.source.history.nodes[0].data=input.source.history.nodes[0].data.slice(-6);
 assert.equal(evaluatePluginShapeHistory(input).selection.reason,'incomplete');
});
test('identity, stale, refresh, wrong currency and conflicting observations reject reuse',()=>{
 for(const change of [{source:{...fixture().source,node:'99'}},{source:{...fixture().source,marketplace:'CA' as const}},{source:{...fixture().source,collectedAt:'2026-10-18T01:00:00.000Z'}},{notBefore:'2026-10-19T01:30:00.000Z'}])assert.equal(evaluatePluginShapeHistory({...fixture(),...change}).reuse,null);
 const input=fixture('DE');input.source.basic.currency='USD';assert.equal(evaluatePluginShapeHistory({...input,metric:'SalesAmount'}).reuse,null);
 const conflict=fixture();conflict.source.history.nodes[0].data.push(['2026-09',999]);assert.equal(evaluatePluginShapeHistory(conflict).reuse,null);
 const childOnly=fixture();childOnly.source.history.nodes=childOnly.source.history.nodes.filter(n=>n.type==='childSale');assert.equal(evaluatePluginShapeHistory(childOnly).reuse,null);
 const future=fixture();future.scope.toMonth='2026-10';assert.equal(evaluatePluginShapeHistory(future).reuse,null);
});


test('native history outside the supported window cannot be silently truncated and marked complete',()=>{
 for(const metric of ['SalesVolume','SalesAmount'] as const){
  const input={...fixture(),metric};
  const node=input.source.history.nodes.find(n=>n.type===(metric==='SalesVolume'?'sale':'amount'))!;
  node.data=Array.from({length:121},(_,i)=>[new Date(Date.UTC(2016,8+i,1)).toISOString().slice(0,7),i]);
  const result=evaluatePluginShapeHistory(input);
  assert.equal(result.reuse,null);assert.equal(result.selection.reason,'history-range-exceeded');
  assert.equal(result.selection.requiredFrom,'2016-09');
  node.data=node.data.slice(1);
  const bounded=evaluatePluginShapeHistory(input);assert.ok(bounded.reuse);assert.equal(bounded.reuse.points.length,120);
  assert.deepEqual(replayPluginShapeHistory(input.scope,bounded.reuse.evidence),bounded.reuse);
 }
});

test('fallback distinguishes conflicting months, invalid values, currency absence and currency mismatch',()=>{
 const conflict=fixture();conflict.source.history.nodes[0].data.push(['2026-09',999]);
 const c=evaluatePluginShapeHistory(conflict);assert.equal(c.selection.reason,'conflicting-history');assert.deepEqual(c.selection.conflictMonths,['2026-09']);
 const invalid=fixture();invalid.source.history.nodes[0].data[0][1]=-1;
 const i=evaluatePluginShapeHistory(invalid);assert.equal(i.selection.reason,'invalid-history');assert.deepEqual(i.selection.invalidMonths,['2024-01']);
 const absent=fixture('CA');delete (absent.source.basic as {currency?:string}).currency;
 assert.equal(evaluatePluginShapeHistory({...absent,metric:'SalesAmount'}).selection.reason,'currency-missing');
 assert.ok(evaluatePluginShapeHistory(absent).reuse,'currency absence must not discard units');
 const wrong=fixture('DE');wrong.source.basic.currency='USD';
 assert.equal(evaluatePluginShapeHistory({...wrong,metric:'SalesAmount'}).selection.reason,'currency-mismatch');
});
