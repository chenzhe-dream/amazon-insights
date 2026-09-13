import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {planMarketOverviewSemanticWindows,restoreMarketOverviewSemanticWindow} from '../../server/domain/market-research/overview-semantic-windows';
import {validateOverviewAnalysisBrief} from '../../server/domain/market-research/overview-analysis-validation';
import type {MarketInputSnapshot} from '../../shared/market-analysis-contracts';

const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
const semanticOf=(s:MarketInputSnapshot)=>(s.records[0].data as any).semantic;
function fixture(mode:'dimension'|'synthesis'='dimension',missing=false,shared=false){
  const dims=['price','competition'];
  const semantic={task:'market-overview-explanation',
    metrics:dims.map(id=>({metricId:id,state:'known',value:20,unit:{status:'known',unit:'count',rawUnit:'count'},period:{kind:'unknown',reason:'response month unconfirmed'},sourceRefs:['source'],formulaVersion:'source/v1',numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}})),
    facts:dims.map(id=>({factId:id,kind:'value',metricRefs:[id],sourceRefs:['source'],statementTemplateId:'source/v1'})),
    gaps:[...dims,...(missing?['demand']:[])].map(id=>({gapId:id+'-gap',metricId:null,reason:'field-absent',sourceRefs:['source']})),interpretationOptions:[],validationOptions:[],
    analysisBrief:{mode,scopeStatement:'仅解释来源返回样本，响应月份未确认',dimensions:[...dims.map(id=>({id,label:id,factIds:[id],gapIds:[id+'-gap',...(shared&&id==='competition'?['price-gap']:[])]})),...(missing?[{id:'demand',label:'需求',factIds:[],gapIds:['demand-gap']}]:[])],factLabels:dims.map(id=>({factId:id,label:id}))}};
  return createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'test/v1',ruleVersion:'analysis/v1',collectedAt:'2026-09-12T00:00:00.000Z',expectedRecordIds:['overview'],records:[{id:'overview',scope,data:{semantic}}]});
}

test('dimension windows retain whole evidence groups, narrow the brief and restore identical snapshots',async()=>{
  const full=fixture();
  const plan=await planMarketOverviewSemanticWindows(full,async snapshot=>{const s=semanticOf(snapshot);validateOverviewAnalysisBrief(s);return s.facts.length===1;});
  assert.deepEqual(plan.rejected,[]);assert.equal(plan.windows.length,2);assert.equal(plan.version,'market-overview-semantic-windows/v2');
  for(const w of plan.windows){const s=semanticOf(w.snapshot),d=s.analysisBrief.dimensions[0];assert.equal(s.analysisBrief.dimensions.length,1);assert.deepEqual(w.primaryFactIds,d.factIds);assert.deepEqual(w.gapIds,d.gapIds);assert.deepEqual(s.analysisBrief.factLabels.map((f:any)=>f.factId),d.factIds);
    const restored=restoreMarketOverviewSemanticWindow(full,[...w.primaryFactIds.map(id=>({kind:'fact' as const,id})),...w.gapIds.map(id=>({kind:'gap' as const,id}))]);assert.deepEqual(restored,w);
  }
  assert.throws(()=>restoreMarketOverviewSemanticWindow(full,[{kind:'fact',id:'price'}]),/complete|dimension/i);
});

test('synthesis is indivisible and fails admission instead of synthesizing partial dimensions',async()=>{
  const full=fixture('synthesis');let calls=0;
  const plan=await planMarketOverviewSemanticWindows(full,async snapshot=>{calls++;assert.deepEqual(semanticOf(snapshot).analysisBrief.dimensions.map((d:any)=>d.id),['price','competition']);return false;});
  assert.equal(calls,1);assert.equal(plan.windows.length,0);assert.equal(plan.rejected.length,4);
  const accepted=await planMarketOverviewSemanticWindows(full,async()=>true);assert.equal(accepted.windows.length,1);assert.equal(accepted.rejected.length,0);
});

test('missing-only dimensions keep evidence context and shared gaps cannot be detached',async()=>{
  const full=fixture('dimension',true);
  const plan=await planMarketOverviewSemanticWindows(full,async snapshot=>{const s=semanticOf(snapshot);validateOverviewAnalysisBrief(s);return s.facts.length===1;});
  assert.deepEqual(plan.rejected,[]);assert.equal(plan.windows.length,2);assert.deepEqual(plan.windows.flatMap(w=>w.gapIds).sort(),['competition-gap','demand-gap','price-gap']);
  const demand=plan.windows.find(w=>w.gapIds.includes('demand-gap'))!;assert.ok(demand.primaryFactIds.length);assert.equal(semanticOf(demand.snapshot).analysisBrief.dimensions.some((d:any)=>d.id==='demand'),true);
  const linked=await planMarketOverviewSemanticWindows(fixture('dimension',false,true),async s=>semanticOf(s).facts.length===1);assert.equal(linked.windows.length,0);assert.equal(linked.rejected.length,4);
});
