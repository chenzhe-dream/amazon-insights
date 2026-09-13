import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {buildMarketOverviewSourceCatalog} from '../../server/domain/market-research/overview-source-catalog';
import type {MarketSourceUnit} from '../../shared/market-source-contracts';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {planMarketOverviewSemanticWindows} from '../../server/domain/market-research/overview-semantic-windows';
import {buildMarketOverviewExpandedCatalog} from '../../server/domain/market-research/overview-expanded-catalog';

const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const cutoff='2026-09-12T00:00:00.000Z',parameters={headTopN:10 as const,newProductMonths:6 as const};
const count={status:'known',unit:'count',rawUnit:'count'} as const;
function source(month='2026-08',values:Record<string,unknown>={topProducts:100,totalUnits:1000},units:Record<string,MarketSourceUnit>={topProducts:count,totalUnits:count},statistics=false){
  const row={nodeIdPath:scope.nodeIdPath,nodeId:'456',month,marketplace:'US',currency:'USD',...values};
  const payload={code:'OK',data:statistics?row:{items:[row]}};
  const path=statistics?['data']:['data','items',0];
  return createMarketSourceEvidence({scope,provider:'sellerSprite',operation:statistics?'market_research_statistics':'market_research',requestIdentity:{nodeIdPath:scope.nodeIdPath,month,marketplace:'US',currency:'USD'},
    responseIdentityPaths:{nodeIdPath:[[...path,'nodeIdPath']],month:[[...path,'month']],marketplace:[[...path,'marketplace']],currency:[[...path,'currency']]},payload:payload as any,fetchedAt:cutoff,
    observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},units,coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}});
}
const build=(sources:ReturnType<typeof source>[])=>buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:cutoff,sources});

test('expanded scalar catalog preserves request-bound observations without upgrading old history or inventing verified trends',async()=>{
  const sources=['2026-07','2026-08'].map(month=>createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'market_research',requestIdentity:{nodeIdPath:scope.nodeIdPath,marketplace:'US',month},responseIdentityPaths:{nodeIdPath:[['data','items',0,'nodeIdPath']]},
    payload:{code:'OK',data:{items:[{nodeIdPath:scope.nodeIdPath,topProducts:100,totalUnits:month==='2026-07'?1000:500}]}},fetchedAt:cutoff,observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},units:{topProducts:count,totalUnits:count},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'unknown',reason:'request-bound source'}}}));
  assert.equal(build(sources).months[1].metrics.totalUnits.value,null);
  const expanded=buildMarketOverviewExpandedCatalog({scope,parameters,dataCutoffAt:cutoff,sources});assert.equal(expanded.months[1].metrics.totalUnits.value,500);
  assert.equal(expanded.months[1].metrics.totalUnits.observations[0].scopeBasis,'request-bound');assert.equal(sources[1].responseIdentity.month.status,'unverified');
  const semantic=(expanded.semanticSnapshot!.records[0].data as any).semantic;assert.equal(semantic.metrics.some((m:any)=>m.metricId.endsWith('ChangePct')),false);assert.equal(semantic.metrics.find((m:any)=>m.metricId==='2026-08/totalUnits').period.kind,'unknown');assert.ok(expanded.trendGaps.some(g=>g.reason==='period-response-unverified'));
  const windows=await planMarketOverviewSemanticWindows(expanded.semanticSnapshot!,async snapshot=>{
    const batches=await planMarketSemanticBatches({task:'market-overview-explanation',moduleRunId:randomUUID(),snapshot,sources:Object.fromEntries(sources.map(s=>[`market-source:${digest(s)}`,s])),selectionRevision:'expanded-test/v1',configurationVersion:'synthetic/v1',dataCutoffAt:cutoff},async()=>true);
    assert.equal(batches.batches.length,1);return true;
  });assert.equal(windows.rejected.length,0);assert.equal(windows.windows.length,1);
});
test('source catalog preserves zeros, exact field lineage and immutable model facts',()=>{
  const value=build([source('2026-08',{topProducts:100,totalUnits:0,l6NewCount:0},{topProducts:count,totalUnits:count,l6NewCount:count})]);
  const semantic=(value.semanticSnapshot!.records[0].data as any).semantic;
  assert.equal(semantic.metrics.find((m:any)=>m.metricId==='2026-08/totalUnits').value,0);
  assert.equal(value.months[1].metrics.newCount.value,0);assert.equal(value.months[1].metrics.totalUnits.observations[0].field,'totalUnits');
  assert.equal(value.months[0].metrics.totalUnits.reason,'not-collected');
  assert.ok(Object.isFrozen(value.semanticSnapshot));
});
test('empty monthly evidence and failed endpoint receipts remain distinct from uncollected months',()=>{
  const empty=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'market_research',requestIdentity:{nodeIdPath:scope.nodeIdPath,month:'2026-08',marketplace:'US'},responseIdentityPaths:{},payload:{code:'OK',data:{items:[]}},fetchedAt:cutoff,
    observationPeriod:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},units:{},coverage:{receivedCount:0,expectedCount:0,truncation:{status:'unknown',reason:'Synthetic empty aggregate'}}});
  const value=build([empty]);assert.equal(value.semanticSnapshot,null);assert.equal(value.months[1].metrics.totalUnits.reason,'field-absent');assert.equal(value.months[1].sourceRefs.length,1);assert.equal(value.months[0].metrics.totalUnits.reason,'not-collected');
  const failure={month:'2026-07',operation:'market_research' as const,attemptId:randomUUID(),code:'timeout'};
  const failed=buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[empty],failures:[failure]});
  assert.equal(failed.months[0].metrics.totalUnits.reason,'collection-failed');assert.deepEqual((failed.numericSnapshot.records[0].data as any).failures,[failure]);
  assert.throws(()=>buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[source()],failures:[{...failure,month:'2026-08'}]}));
  assert.throws(()=>buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[],failures:[failure,failure]}));
});
test('unknown concentration units are gaps rather than guessed percentages',()=>{
  const value=build([source('2026-08',{top10ProductCrn:0.42},{})]);
  assert.equal(value.months[1].metrics.productConcentrationRaw.reason,'unit-unknown');assert.equal(value.semanticSnapshot,null);
});
test('disagreeing successful endpoints retain both observations and exclude the conflicted metric',()=>{
  const value=build([source(),source('2026-08',{totalUnits:900},{totalUnits:count},true)]);
  assert.equal(value.months[1].metrics.totalUnits.state,'conflict');assert.equal(value.months[1].metrics.totalUnits.observations.length,2);
  assert.equal((value.semanticSnapshot!.records[0].data as any).semantic.metrics.some((m:any)=>m.metricId.endsWith('/totalUnits')),false);
});
test('complete-month decline is retained; missing preceding month is never bridged',()=>{
  const value=build([source('2026-07'),source('2026-08',{topProducts:100,totalUnits:200})]);
  const metric=(value.semanticSnapshot!.records[0].data as any).semantic.metrics.find((m:any)=>m.metricId==='2026-08/totalUnitsChangePct');
  assert.equal(metric.value,-80);assert.equal(metric.denominatorRef,'2026-07/totalUnits');
  assert.equal((build([source()]).semanticSnapshot!.records[0].data as any).semantic.metrics.some((m:any)=>m.metricId.endsWith('ChangePct')),false);
});
test('zero baseline and changed sample size do not yield comparable growth',()=>{
  for(const prior of [source('2026-07',{topProducts:100,totalUnits:0}),source('2026-07',{topProducts:50,totalUnits:500})]){
    const semantic=(build([prior,source()]).semanticSnapshot!.records[0].data as any).semantic;
    assert.equal(semantic.metrics.some((m:any)=>m.metricId.endsWith('ChangePct')),false);
  }
});
test('source hash, scope, duplicate endpoint and unfinished observation months are rejected',()=>{
  assert.throws(()=>build([source(),source()]));
  assert.throws(()=>build([{...source(),payloadHash:'f'.repeat(64)}]));
  assert.throws(()=>buildMarketOverviewSourceCatalog({scope:{...scope,researchId:randomUUID()},parameters,dataCutoffAt:cutoff,sources:[source()]}));
  assert.throws(()=>buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:'2026-08-15T00:00:00.000Z',sources:[]}));
});
test('invalid numeric text, boolean values and unsafe counts never enter model metrics',()=>{
  for(const value of ['1,000',true,'',Number.MAX_SAFE_INTEGER+1])assert.equal(build([source('2026-08',{totalUnits:value},{totalUnits:count})]).semanticSnapshot,null);
});
test('parameter revisions change snapshot identity without manufacturing supply growth',()=>{
  const original=build([source()]);const revised=buildMarketOverviewSourceCatalog({scope,parameters:{...parameters,headTopN:20},dataCutoffAt:cutoff,sources:[source()]});
  assert.notEqual(original.numericSnapshot.snapshotId,revised.numericSnapshot.snapshotId);
  assert.equal((original.semanticSnapshot!.records[0].data as any).semantic.metrics.some((m:any)=>/supply/i.test(m.metricId)),false);
});
test('generated facts pass the existing input-bound A1 validator and remain stable across source order',async()=>{
  const sources=[source('2026-07'),source('2026-08',{topProducts:100,totalUnits:200})],value=build(sources);
  assert.deepEqual(build([...sources].reverse()),value);
  const planned=await planMarketSemanticBatches({task:'market-overview-explanation',moduleRunId:randomUUID(),snapshot:value.semanticSnapshot!,sources:Object.fromEntries(sources.map(s=>[`market-source:${digest(s)}`,s])),selectionRevision:'overview/v1',configurationVersion:'synthetic/v1',dataCutoffAt:cutoff},async()=>true);
  assert.equal(planned.batches.length,1);assert.deepEqual(planned.rejectedMembers,[]);
});
test('bounded windows cover every fact and gap with complete numerical dependencies',async()=>{
  const sources=[source('2026-07'),source('2026-08',{topProducts:100,totalUnits:200})],full=build(sources).semanticSnapshot!;
  const semantic=(full.records[0].data as any).semantic;
  const result=await planMarketOverviewSemanticWindows(full,async snapshot=>{const v=(snapshot.records[0].data as any).semantic;return v.facts.length<=2&&v.gaps.length<=3;});
  assert.deepEqual(result.rejected,[]);assert.ok(result.windows.length>1);
  assert.deepEqual(result.windows.flatMap(w=>w.primaryFactIds),semantic.facts.map((f:any)=>f.factId));
  assert.deepEqual(result.windows.flatMap(w=>w.gapIds),semantic.gaps.map((g:any)=>g.gapId));
  for(const w of result.windows){
    const planned=await planMarketSemanticBatches({task:'market-overview-explanation',moduleRunId:randomUUID(),snapshot:w.snapshot,sources:Object.fromEntries(sources.map(s=>[`market-source:${digest(s)}`,s])),selectionRevision:'overview/v1',configurationVersion:'synthetic/v1',dataCutoffAt:cutoff},async()=>true);
    assert.equal(planned.batches.length,1);
  }
  const rejected=await planMarketOverviewSemanticWindows(full,async()=>false);
  assert.equal(rejected.windows.length,0);assert.equal(rejected.rejected.length,semantic.facts.length+semantic.gaps.length);
  await assert.rejects(planMarketOverviewSemanticWindows(full,async()=>{throw new Error('meter unavailable');}),/meter unavailable/);
});


test('review: unrelated statistics failure cannot relabel missing research concentration',()=>{
  const catalog=buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[source()],
    failures:[{month:'2026-08',operation:'market_research_statistics',attemptId:randomUUID(),code:'timeout'}]});
  assert.equal(catalog.months[1].metrics.productConcentrationRaw.reason,'field-absent');
  assert.equal(catalog.months[1].metrics.brandConcentrationRaw.reason,'field-absent');
  assert.equal(catalog.months[1].metrics.sellerConcentrationRaw.reason,'field-absent');
  assert.equal(catalog.months[1].metrics.totalUnits.value,1000);
  assert.equal(catalog.months[1].failures.length,1);
});

test('review: statistics-only success does not imply the concentration endpoint was collected',()=>{
  const catalog=build([source('2026-08',{products:100,totalUnits:0},{products:count,totalUnits:count},true)]);
  assert.equal(catalog.months[1].metrics.productConcentrationRaw.reason,'not-collected');
  assert.equal(catalog.months[1].metrics.totalUnits.value,0);
  const failed=buildMarketOverviewSourceCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[],
    failures:[{month:'2026-08',operation:'market_research',attemptId:randomUUID(),code:'timeout'}]});
  assert.equal(failed.months[1].metrics.productConcentrationRaw.reason,'collection-failed');
});

test('gap attribution correction has a new version and preserves the frozen v2 interpretation',()=>{
  const input={scope,parameters,dataCutoffAt:cutoff,sources:[source()],failures:[{month:'2026-08',operation:'market_research_statistics' as const,attemptId:randomUUID(),code:'timeout'}]};
  const legacy=buildMarketOverviewSourceCatalog({...input,version:'market-overview-source-catalog/v2'});
  const current=buildMarketOverviewSourceCatalog(input);
  assert.equal(legacy.version,'market-overview-source-catalog/v2');
  assert.equal(current.version,'market-overview-source-catalog/v3');
  assert.equal(legacy.months[1].metrics.productConcentrationRaw.reason,'collection-failed');
  assert.equal(current.months[1].metrics.productConcentrationRaw.reason,'field-absent');
  assert.notEqual(legacy.numericSnapshot.snapshotId,current.numericSnapshot.snapshotId);
  assert.equal(digest(legacy),digest(buildMarketOverviewSourceCatalog({...input,version:'market-overview-source-catalog/v2'})));
  assert.throws(()=>buildMarketOverviewSourceCatalog({...input,version:'future-unknown' as any}));
});
