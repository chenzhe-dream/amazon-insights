import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {evaluatePluginShapeHistory,replayPluginShapeHistory} from '../../server/services/plugin-shape-history-reuse';
import {productHistoryPeriods} from '../../server/services/market-product-history-collector';

function fixture(){
 const asin='B000000001';
 return {scope:{organizationId:'audit-org',researchId:randomUUID(),marketplace:'UK' as const,currency:'GBP' as const,nodeIdPath:'12:34',fromMonth:'2026-09',toMonth:'2026-09'},asin,metric:'SalesVolume' as 'SalesVolume'|'SalesAmount',reuseSaved:true,now:new Date('2026-10-29T00:00:00Z'),source:{snapshotId:'plugin-source:'+'a'.repeat(64),jobId:randomUUID(),node:'34',marketplace:'UK' as const,asin,collectedAt:'2026-10-16T01:00:00Z',basic:{asin,currency:'GBP'},history:{asin,nodes:['sale','amount'].map(type=>({type,data:Array.from({length:6},(_,i)=>[`2026-${String(i+4).padStart(2,'0')}`,i===0?0:10] as [string,number|null])}))}}};
}
test('recent windows survive absent annual history, retain original values and replay exactly',()=>{
 const input=fixture(),before=JSON.stringify(input),result=evaluatePluginShapeHistory(input);
 assert.ok(result.reuse,'Valid recent observations must not be discarded for absent 2024');
 assert.equal(result.selection.selectedProvider,'sellerSprite');
 assert.equal(result.reuse.status,'partial');
 assert.equal(result.reuse.points.length,6);
 const periods=productHistoryPeriods(result.reuse.points as any,input.scope.toMonth);
 assert.equal(periods[0].units,30);assert.equal(periods[1].units,50);
 assert.equal(periods[2].units,null);assert.equal(periods[2].missingMonths.length,12);
 assert.equal(periods[3].units,null);assert.equal(periods[3].missingMonths.length,12);
 assert.deepEqual(replayPluginShapeHistory(input.scope,result.reuse.evidence),result.reuse);
 assert.equal(JSON.stringify(input),before);
});
test('missing recent month affects only its windows and is not replaced by an older month or zero',()=>{
 const input=fixture();input.source.history.nodes[0].data=input.source.history.nodes[0].data.filter(p=>p[0]!=='2026-04');
 const result=evaluatePluginShapeHistory(input);assert.ok(result.reuse);
 const periods=productHistoryPeriods(result.reuse.points as any,input.scope.toMonth);
 assert.equal(periods[0].units,30);assert.equal(periods[1].units,null);assert.deepEqual(periods[1].missingMonths,['2026-04']);
 assert.equal(result.reuse.points.some(p=>p.month==='2026-04'),false);
});
test('conflicting month is quarantined while independent valid windows remain usable',()=>{
 const input=fixture();input.source.history.nodes[0].data.push(['2026-04',999]);
 const result=evaluatePluginShapeHistory(input);assert.ok(result.reuse);
 const points=result.reuse.points as any[];
 assert.equal(points.find(p=>p.month==='2026-04').units,null);
 assert.equal(productHistoryPeriods(points,input.scope.toMonth)[0].units,30);
 assert.equal(productHistoryPeriods(points,input.scope.toMonth)[1].units,null);
});
test('currency identity is still required for money and all-unknown observations cannot be reused',()=>{
 const input=fixture();input.source.basic.currency='USD';
 assert.equal(evaluatePluginShapeHistory({...input,metric:'SalesAmount'}).reuse,null);
 const blank=fixture();blank.source.history.nodes[0].data=blank.source.history.nodes[0].data.map(([m])=>[m,null]);
 assert.equal(evaluatePluginShapeHistory(blank).reuse,null);
});
