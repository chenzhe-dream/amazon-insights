import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {MarketSemanticRecordSchema, type MarketSemanticRecord} from '../../shared/market-semantic-contracts';
import type {MarketOverviewAnalysis} from '../../shared/market-overview-analysis-contracts';
import type {MarketInputSnapshot} from '../../shared/market-analysis-contracts';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {restoreMarketOverviewSemanticWindow} from '../../server/domain/market-research/overview-semantic-windows';
import {buildMarketOverviewSynthesisBasis, type MarketOverviewSynthesisBasisInput} from '../../server/domain/market-research/overview-synthesis-basis';
import type {MarketOverviewWindowPlan} from '../../server/domain/market-research/overview-window-plan';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

type Overview = Extract<MarketSemanticRecord, {task:'market-overview-explanation'}>;
function semanticOf(snapshot: MarketInputSnapshot): Overview {
  const data = snapshot.records[0].data;
  assert.ok(data && typeof data === 'object' && !Array.isArray(data) && 'semantic' in data);
  const semantic = MarketSemanticRecordSchema.parse(data.semantic);
  assert.equal(semantic.task, 'market-overview-explanation');
  if (semantic.task !== 'market-overview-explanation') throw new TypeError('Expected overview');
  return semantic;
}
function fixture(version = 'market-overview-source-catalog/v6') {
  const scope = {organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US',nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'};
  const metric = (metricId: string, value: number) => ({metricId,state:'known',value,unit:{status:'known',unit:'count',rawUnit:'returned count'},period:{kind:'unknown',reason:'Response month unconfirmed'},sourceRefs:['source'],formulaVersion:'source/v1',numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}});
  const semantic = {task:'market-overview-explanation',metrics:[metric('a',0),metric('b',5),metric('c',10),metric('denominator',15),{...metric('share',0),unit:{status:'known',unit:'percent',rawUnit:'returned group share'},formulaVersion:'overview-response-group-share/v1',numeratorRef:'a',denominatorRef:'denominator'}],
    facts:['a','b','c'].map(id=>({factId:id,kind:'value',metricRefs:id==='a'?['a','share']:[id],sourceRefs:['source'],statementTemplateId:'source/v1'})),
    gaps:[{gapId:'price-gap',metricId:null,reason:'period-incompatible',sourceRefs:['source']},{gapId:'demand-gap',metricId:null,reason:'not-collected',sourceRefs:[]}],interpretationOptions:[],validationOptions:[],
    analysisBrief:{mode:'dimension',scopeStatement:'Only the returned sample; response month unconfirmed',dimensions:[{id:'price',label:'Price',factIds:['a','b'],gapIds:['price-gap']},{id:'competition',label:'Competition',factIds:['b','c'],gapIds:[]},{id:'demand',label:'Demand',factIds:[],gapIds:['demand-gap']}],factLabels:['a','b','c'].map(factId=>({factId,label:`Original ${factId}`}))}};
  const catalog = createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'test/v1',ruleVersion:version,collectedAt:'2026-09-12T00:00:00.000Z',expectedRecordIds:['overview'],records:[{id:'overview',scope,data:{semantic}}]});
  const selections = [[{kind:'fact' as const,id:'a'},{kind:'fact' as const,id:'b'},{kind:'gap' as const,id:'price-gap'}],[{kind:'fact' as const,id:'c'}],[{kind:'gap' as const,id:'demand-gap'}]];
  const restored = selections.map(selection=>restoreMarketOverviewSemanticWindow(catalog,selection));
  const plan: MarketOverviewWindowPlan = {schemaVersion:'overview-window-plan/v1',catalogAttemptId:randomUUID(),basisSnapshotId:catalog.snapshotId,numericInputSnapshotId:`market-input:${'1'.repeat(64)}`,configurationVersion:'test/v1',dataCutoffAt:catalog.collectedAt,selectionRevision:'selection',windows:restored.map(w=>({inputSnapshotId:w.snapshot.snapshotId,primaryFactIds:w.primaryFactIds,gapIds:w.gapIds})),rejected:[]};
  const windows: MarketOverviewSynthesisBasisInput['windows'] = restored.map(w=>({inputSnapshotId:w.snapshot.snapshotId,attemptId:randomUUID(),agentRunId:randomUUID(),analysis:analysisFor(semanticOf(w.snapshot))}));
  return {catalog,plan,windows};
}
function analysisFor(semantic: Overview): MarketOverviewAnalysis {
  const brief = semantic.analysisBrief!;
  const statement = (factIds: string[], gapIds: string[]): MarketOverviewAnalysis['summary']['statement'] => ({parts:factIds.length?factIds.map(factId=>({kind:'fact-label',factId})):[{kind:'text',text:'Evidence is unavailable'}],factIds,gapIds});
  return {dimensions:brief.dimensions.map(d=>({dimensionId:d.id,data:statement(d.factIds,d.gapIds),meaning:statement(d.factIds,d.gapIds),conclusion:statement(d.factIds,d.gapIds),limitations:d.gapIds.length?[statement([],d.gapIds)]:[],verification:[statement(d.factIds,d.gapIds)]})),summary:{decision:'insufficient-evidence',statement:statement([semantic.facts[0].factId],[])}};
}

test('complete basis retains multiple dimension leaves, original evidence, context and missing-only dimensions',()=>{
  const input = fixture(), basis = buildMarketOverviewSynthesisBasis(input), semantic = semanticOf(input.catalog);
  assert.equal(basis.version,'market-overview-synthesis-basis/v1');
  assert.deepEqual(basis.dimensions,semantic.analysisBrief!.dimensions);
  for (const field of ['facts','gaps','metrics'] as const) assert.deepEqual(basis[field],semantic[field]);
  assert.deepEqual(basis.factLabels,semantic.analysisBrief!.factLabels);
  assert.equal(basis.metrics.find(m=>m.metricId==='a')!.value,0);
  assert.equal(basis.metrics.find(m=>m.metricId==='share')!.denominatorRef,'denominator');
  assert.equal(basis.metrics.find(m=>m.metricId==='share')!.period.kind,'unknown');
  assert.equal(basis.leaves.length,5);
  assert.equal(new Set(basis.leaves.map(l=>l.leafId)).size,5);
  const first = basis.leaves.filter(l=>l.inputSnapshotId===input.windows[0].inputSnapshotId);
  assert.deepEqual(first.map(l=>l.dimensionId),['price','competition']);
  assert.deepEqual(first[1].primaryFactIds,['b']);
  const context = basis.leaves.find(l=>l.inputSnapshotId===input.windows[2].inputSnapshotId&&l.dimensionId==='price')!;
  assert.deepEqual(context.primaryFactIds,[]);
  assert.deepEqual(context.primaryGapIds,[]);
  assert.deepEqual(context.coveredFactIds,['a']);
  assert.deepEqual(context.coveredGapIds,['price-gap']);
  assert.deepEqual(basis.leaves.find(l=>l.dimensionId==='demand')!.primaryGapIds,['demand-gap']);
  assert.deepEqual(first[0].section,input.windows[0].analysis.dimensions[0]);
  assert.ok(Object.isFrozen(basis.metrics[0].period));
  assert.ok(Object.isFrozen(basis.leaves[0].section.data.parts));
  input.windows[0].analysis.dimensions[0].meaning.parts = [{kind:'text',text:'Changed later'}];
  assert.notDeepEqual(basis.leaves[0].section,input.windows[0].analysis.dimensions[0]);
});

test('provided window permutation is reproducible and both complete catalog versions are supported',()=>{
  for (const version of ['market-overview-source-catalog/v5','market-overview-source-catalog/v6']) {
    const input = fixture(version);
    assert.deepEqual(buildMarketOverviewSynthesisBasis(input),buildMarketOverviewSynthesisBasis({...input,windows:[...input.windows].reverse()}));
  }
});

test('complete evidence is not truncated to native request limits and its content hash binds provenance',()=>{
  const input = fixture(), semantic = semanticOf(input.catalog);
  for (let index = 0; index < 40; index++) {
    const id = `extra-${index}`;
    semantic.metrics.push({...semantic.metrics[0],metricId:id,value:index});
    semantic.facts.push({...semantic.facts[1],factId:id,metricRefs:[id]});
    semantic.analysisBrief!.dimensions[0].factIds.push(id);
    semantic.analysisBrief!.factLabels.push({factId:id,label:`Original row ${index}`});
  }
  const {scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds} = input.catalog;
  const catalog = createMarketInputSnapshot({scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records:[{id:'overview',scope,data:{semantic}}]});
  const selected = [
    ...semantic.facts.map(fact=>[{kind:'fact' as const,id:fact.factId}]),
    ...semantic.gaps.map(gap=>[{kind:'gap' as const,id:gap.gapId}]),
  ];
  const restored = selected.map(atoms=>restoreMarketOverviewSemanticWindow(catalog,atoms));
  const plan = {...input.plan,basisSnapshotId:catalog.snapshotId,windows:restored.map(window=>({inputSnapshotId:window.snapshot.snapshotId,primaryFactIds:window.primaryFactIds,gapIds:window.gapIds}))};
  const windows = restored.map(window=>({inputSnapshotId:window.snapshot.snapshotId,attemptId:randomUUID(),agentRunId:randomUUID(),analysis:analysisFor(semanticOf(window.snapshot))}));
  const basis = buildMarketOverviewSynthesisBasis({catalog,plan,windows});
  assert.equal(basis.facts.length,43);
  assert.equal(basis.metrics.length,45);
  assert.equal(basis.factLabels.length,43);
  assert.equal(basis.dimensions[0].factIds.length,42);
  assert.deepEqual(basis.gaps,semantic.gaps);
  const {basisId,contentHash,...content} = basis;
  assert.equal(contentHash,digest(content));
  assert.equal(basisId,`market-overview-synthesis-basis:${contentHash}`);
  windows[0].agentRunId=randomUUID();
  assert.notEqual(buildMarketOverviewSynthesisBasis({catalog,plan,windows}).contentHash,contentHash);
});

test('incomplete, duplicated, foreign and tampered plan/window identities fail closed',()=>{
  const mutations: Array<(input: ReturnType<typeof fixture>)=>void> = [
    i=>{i.windows.pop();}, i=>{i.windows.push(i.windows[0]);}, i=>{i.windows[1].attemptId=i.windows[0].attemptId;}, i=>{i.windows[1].agentRunId=i.windows[0].agentRunId;},
    i=>{i.windows[0].attemptId='';}, i=>{i.windows[0].agentRunId='';}, i=>{i.windows[0].inputSnapshotId=`market-input:${'2'.repeat(64)}`;},
    i=>{i.plan.windows[0].primaryFactIds.pop();}, i=>{i.plan.windows[0].primaryFactIds.push('a');}, i=>{i.plan.windows[1].primaryFactIds.push('a');},
    i=>{i.plan.windows[0].gapIds=[];}, i=>{i.plan.windows[0].primaryFactIds.push('foreign');}, i=>{i.plan.windows.push(i.plan.windows[0]);},
    i=>{i.plan.rejected.push({kind:'fact',id:'a',reason:'request-too-large'});}, i=>{i.plan.basisSnapshotId=`market-input:${'2'.repeat(64)}`;}, i=>{i.plan.dataCutoffAt='2026-09-11T00:00:00.000Z';},
    i=>{i.plan.windows[0].inputSnapshotId=`market-input:${'3'.repeat(64)}`;}, i=>{i.catalog={...i.catalog,contentHash:'0'.repeat(64)};}, i=>{i.catalog={...i.catalog,ruleVersion:'legacy/v1'};},
  ];
  mutations.forEach((mutate,index)=>{const input=fixture();mutate(input);assert.throws(()=>buildMarketOverviewSynthesisBasis(input),`mutation ${index}`);});
});

test('actual window analysis rejects foreign dimensions, unbound citations, invented numbers and missing sections',()=>{
  const mutations: Array<(analysis: MarketOverviewAnalysis)=>void> = [
    a=>{a.dimensions[0].dimensionId='foreign';}, a=>{a.dimensions.push(a.dimensions[0]);}, a=>{a.dimensions.pop();},
    a=>{a.dimensions[0].data.factIds=['c'];}, a=>{a.dimensions[0].meaning.parts=[{kind:'metric',metricId:'c'}];},
    a=>{a.dimensions[0].conclusion.parts=[{kind:'text',text:'A 99% share'}];}, a=>{a.dimensions[0].conclusion.parts=[{kind:'text',text:'占百分之九十'}];},
    a=>{a.dimensions[0].limitations=[];},
  ];
  mutations.forEach((mutate,index)=>{const input=fixture();mutate(input.windows[0].analysis);assert.throws(()=>buildMarketOverviewSynthesisBasis(input),`analysis mutation ${index}`);});
});
