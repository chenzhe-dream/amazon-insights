import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {projectMarketOverviewDistribution} from '../../server/services/market-overview-distribution-collector';
import {buildMarketOverviewExpandedCatalog} from '../../server/domain/market-research/overview-expanded-catalog';
import {buildMarketOverviewCompleteCatalog} from '../../server/domain/market-research/overview-complete-catalog';
import {planMarketOverviewSemanticWindows,restoreMarketOverviewSemanticWindow} from '../../server/domain/market-research/overview-semantic-windows';
import {MarketSemanticRecordSchema,MarketOverviewRequestRecordSchema} from '../../shared/market-semantic-contracts';
import {validateOverviewAnalysisBrief} from '../../server/domain/market-research/overview-analysis-validation';

const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,currency:'USD' as const,nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08'};
const cutoff='2026-09-12T00:00:00.000Z',parameters={headTopN:10 as const,newProductMonths:6 as const};
function source(operation:'market_brand_concentration'|'market_ebc_distribution'|'market_price_distribution',data:unknown[]){
  const r=projectMarketOverviewDistribution({scope,month:'2026-08',operation,...parameters,payload:{data} as any,fetchedAt:cutoff,now:new Date(cutoff)});assert.ok(r.evidence);return r.evidence;
}
const rows=(n:number)=>Array.from({length:n},(_,i)=>({label:'bucket-'+i,brand:'brand-'+i,asins:['B'+String(i).padStart(9,'0')],products:1,units:i,totalUnits:i,unitsRatio:999}));
const semanticOf=(c:ReturnType<typeof buildMarketOverviewCompleteCatalog>)=>MarketSemanticRecordSchema.parse((c.semanticSnapshot!.records[0].data as any).semantic);

test('full catalog retains every distribution row beyond request limits without changing v4 history',async()=>{
  const sources=[source('market_brand_concentration',rows(53))],input={scope,parameters,dataCutoffAt:cutoff,sources};
  const legacy=buildMarketOverviewExpandedCatalog(input);assert.equal(legacy.semanticSnapshot,null);
  const c=buildMarketOverviewCompleteCatalog(input),s=semanticOf(c);assert.equal(s.task,'market-overview-explanation');if(s.task!=='market-overview-explanation')return;
  assert.equal(c.version,'market-overview-source-catalog/v5');assert.ok(s.metrics.length>24);assert.equal(s.facts.length,53);assert.equal(s.analysisBrief!.factLabels.length,53);validateOverviewAnalysisBrief(s);
  assert.deepEqual(s.analysisBrief!.factLabels.map(f=>f.label),rows(53).map(r=>r.brand));
  assert.equal(MarketOverviewRequestRecordSchema.safeParse(s).success,false);assert.deepEqual(buildMarketOverviewExpandedCatalog(input),legacy);
  const windows=await planMarketOverviewSemanticWindows(c.semanticSnapshot!,async()=>true);assert.ok(windows.windows.length>1);assert.deepEqual(windows.rejected,[]);
  assert.deepEqual(windows.windows.flatMap(w=>w.primaryFactIds).sort(),s.facts.map(f=>f.factId).sort());assert.deepEqual(windows.windows.flatMap(w=>w.gapIds).sort(),s.gaps.map(g=>g.gapId).sort());
  for(const w of windows.windows){const local=MarketOverviewRequestRecordSchema.parse((w.snapshot.records[0].data as any).semantic);validateOverviewAnalysisBrief(local);
    assert.match(local.analysisBrief!.scopeStatement,/片段/);assert.ok(local.analysisBrief!.dimensions.some(d=>d.coverage&&d.coverage.totalFactCount>d.factIds.length));
    for(const f of local.facts.filter(f=>f.factId.startsWith('fact:dist:'))){const prefix=f.factId.slice(5);assert.ok(local.gaps.some(g=>g.metricId===prefix+':revenue'));assert.ok(local.gaps.some(g=>g.gapId.endsWith(':response-scope')));}
    assert.deepEqual(restoreMarketOverviewSemanticWindow(c.semanticSnapshot!,[...w.primaryFactIds.map(id=>({kind:'fact' as const,id})),...w.gapIds.map(id=>({kind:'gap' as const,id}))]),w);
  }
  const shares=s.metrics.filter(m=>m.formulaVersion==='overview-response-group-share/v1'&&m.metricId.endsWith(':unitsSharePct'));assert.equal(shares.length,53);assert.ok(Math.abs(shares.reduce((n,m)=>n+m.value,0)-100)<1e-8);
  assert.equal(s.metrics.find(m=>m.metricId.endsWith(':row-0:units'))!.value,0);
  assert.ok(s.metrics.every(m=>m.period.kind==='unknown'));assert.equal(s.facts.some(f=>f.kind==='trend'),false);
  assert.ok(s.gaps.some(g=>g.reason==='not-collected'));assert.ok(s.gaps.some(g=>g.reason==='unit-unknown'));
});

test('content sample, new products and overlapping summaries retain separate denominators',()=>{
  const labels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
  const data=labels.flatMap((label,i)=>[{label,products:i+1,units:10*(i+1)},{label:'新品'+label,products:1,units:5}]);data.push({label:'A+',products:3,units:30});
  const c=buildMarketOverviewCompleteCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[source('market_ebc_distribution',data)]}),s=semanticOf(c);if(s.task!=='market-overview-explanation')throw Error('wrong task');
  assert.equal(s.facts.length,9);assert.equal(s.analysisBrief!.factLabels.some(f=>f.label==='A+'),true);
  const denominators=s.metrics.filter(m=>m.metricId.endsWith(':total:units'));assert.deepEqual(denominators.map(m=>m.value).sort((a,b)=>a-b),[20,100]);
  const summary=s.facts.find(f=>s.analysisBrief!.factLabels.some(l=>l.factId===f.factId&&l.label==='A+'))!;assert.ok(summary.metricRefs.every(id=>!id.includes('SharePct')));
  assert.ok(s.gaps.some(g=>g.gapId.includes('summary')));
});

test('missing source fields are gaps and invalid group denominators never generate shares',()=>{
  const c=buildMarketOverviewCompleteCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[source('market_price_distribution',[{label:'low',products:1,asins:['B000000001'],units:0},{label:'high',products:1,asins:['B000000002']}])]}),s=semanticOf(c);if(s.task!=='market-overview-explanation')throw Error('wrong task');
  assert.equal(s.facts.length,2);assert.equal(s.metrics.filter(m=>m.metricId.endsWith(':unitsSharePct')).length,0);assert.ok(s.gaps.some(g=>g.gapId.endsWith(':row-1:units')));assert.ok(s.metrics.some(m=>m.value===0));
  assert.equal(s.metrics.some(m=>m.unit.unit==='currency'),false);
  const empty=buildMarketOverviewCompleteCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[]});assert.equal(empty.semanticSnapshot,null);
});


test('same-response shares reach the bound validator without permitting forged arithmetic or cross-group denominators',async()=>{
  const sources=[source('market_price_distribution',[{label:'low',products:1,asins:['B000000001'],units:5},{label:'high',products:1,asins:['B000000002'],units:15}])];
  const c=buildMarketOverviewCompleteCatalog({scope,parameters,dataCutoffAt:cutoff,sources});
  const windows=await planMarketOverviewSemanticWindows(c.semanticSnapshot!,async()=>true);assert.equal(windows.windows.length,1);assert.deepEqual(windows.rejected,[]);
  const prepare=async(snapshot:typeof c.semanticSnapshot)=>planMarketSemanticBatches({task:'market-overview-explanation',moduleRunId:randomUUID(),snapshot:snapshot!,sources:Object.fromEntries(sources.map(s=>['market-source:'+digest(s),s])),selectionRevision:'test/v1',configurationVersion:'test/v1',dataCutoffAt:cutoff},async()=>true);
  const planned=await prepare(windows.windows[0].snapshot);assert.equal(planned.batches.length,1);
  for(const mutation of ['wrong-value','different-group','unknown-formula','trend']){
    const original=windows.windows[0].snapshot,s=structuredClone((original.records[0].data as any).semantic);const m=s.metrics.find((m:any)=>m.metricId.endsWith(':unitsSharePct'));
    if(mutation==='wrong-value')m.value=99;
    if(mutation==='different-group')m.denominatorRef=s.metrics.find((m:any)=>m.metricId.endsWith(':total:products')).metricId;
    if(mutation==='unknown-formula')m.formulaVersion='guessed/v1';
    if(mutation==='trend')s.facts[0].kind='trend';
    const altered=createMarketInputSnapshot({scope:original.scope,kind:original.kind,sourceVersion:original.sourceVersion,ruleVersion:original.ruleVersion,collectedAt:original.collectedAt,expectedRecordIds:['overview'],records:[{id:'overview',scope,data:{semantic:s}}]});await assert.rejects(prepare(altered));
  }
});


test('unconfirmed scalar scope remains a limitation of its own business dimension',()=>{
 const evidence=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'market_research',requestIdentity:{marketplace:'US',month:'2026-08',nodeIdPath:scope.nodeIdPath},responseIdentityPaths:{nodeIdPath:[['data','items',0,'nodeIdPath']]},payload:{code:'OK',data:{items:[{nodeIdPath:scope.nodeIdPath,brands:5}]}},fetchedAt:cutoff,observationPeriod:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},units:{brands:{status:'known',unit:'count',rawUnit:'count'}},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'unknown',reason:'month unconfirmed'}}});
 const c=buildMarketOverviewCompleteCatalog({scope,parameters,dataCutoffAt:cutoff,sources:[evidence]}),s=semanticOf(c);if(s.task!=='market-overview-explanation')throw Error('wrong task');
 const participants=s.analysisBrief!.dimensions.find(d=>d.id==='participants')!;assert.ok(participants.factIds.includes('fact:2026-08/brands'));assert.ok(participants.gapIds.includes('gap:2026-08/brands/response-scope'));
});


test('v6 metric table windows preserve complete atoms and immutable v5 restoration',async()=>{
 const input={scope,parameters,dataCutoffAt:cutoff,sources:[source('market_brand_concentration',rows(53))]};
 const old=buildMarketOverviewCompleteCatalog(input), oldPlan=await planMarketOverviewSemanticWindows(old.semanticSnapshot!,async()=>true);
 const current=buildMarketOverviewCompleteCatalog(input,{metricTable:true}),s=semanticOf(current);
 if(s.task!=='market-overview-explanation')throw new Error('Expected overview');
 assert.equal(current.version,'market-overview-source-catalog/v6');
 assert.deepEqual(semanticOf(old),s);
 const plan=await planMarketOverviewSemanticWindows(current.semanticSnapshot!,async()=>true);
 assert.equal(plan.version,'market-overview-semantic-windows/v4');assert.deepEqual(plan.rejected,[]);
 assert.ok(plan.windows.length<oldPlan.windows.length);
 assert.deepEqual(plan.windows.flatMap(w=>w.primaryFactIds).sort(),s.facts.map(f=>f.factId).sort());
 assert.deepEqual(plan.windows.flatMap(w=>w.gapIds).sort(),s.gaps.map(g=>g.gapId).sort());
 for(const w of plan.windows){
  const local=MarketOverviewRequestRecordSchema.parse((w.snapshot.records[0].data as any).semantic);
  assert.equal(local.analysisBrief!.referenceEncoding,'metric-table/v1');
  assert.deepEqual(restoreMarketOverviewSemanticWindow(current.semanticSnapshot!,[...w.primaryFactIds.map(id=>({kind:'fact' as const,id})),...w.gapIds.map(id=>({kind:'gap' as const,id}))]),w);
 }
 assert.deepEqual(await planMarketOverviewSemanticWindows(old.semanticSnapshot!,async()=>true),oldPlan);
});
