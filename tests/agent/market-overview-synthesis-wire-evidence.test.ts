import assert from 'node:assert/strict';
import test from 'node:test';
import {MarketOverviewSynthesisInputSchema,type MarketOverviewSynthesisInput,type MarketOverviewSynthesisStatement,type MarketOverviewSynthesisDimensionSection} from '../../shared/market-overview-reduction-contracts';
import {createMarketOverviewSynthesisModelWire} from '../../server/runtime/market-overview-synthesis-wire';
import {validateMarketOverviewFinalSynthesisOutput} from '../../server/domain/market-research/overview-synthesis';

function evidenceFixture():MarketOverviewSynthesisInput {
  const s=(fact:string,metric:string,gap:string):MarketOverviewSynthesisStatement=>({parts:[{kind:'text',text:'Returned sample evidence'},{kind:'fact-label',factId:fact},{kind:'metric',metricId:metric}],factIds:[fact],gapGroupIds:[gap]});
  const first=s('f0','m0','g0'),second=s('f1','m3','g1');
  const section=(dimensionId:string,data:MarketOverviewSynthesisStatement):MarketOverviewSynthesisDimensionSection=>({dimensionId,data,meaning:{...data,parts:[{kind:'text',text:'Comparison is limited by its source period'}]},conclusion:{...data,parts:[{kind:'text',text:'Verify the returned sample before deciding'}]},limitations:[{...data,parts:[{kind:'text',text:'The source period remains uncertain'}]}],verification:[data]});
  const metrics:MarketOverviewSynthesisInput['metrics']=[
    {metricId:'m0',state:'known',value:0,unit:{status:'known',unit:'count',rawUnit:'returned units (not products)'},period:{kind:'unknown',reason:'The response does not confirm the requested month'},sourceRefs:['s0'],formulaVersion:'source-units/v6',numeratorRef:null,denominatorRef:null,coverage:{status:'partial',expectedCount:3,availableCount:2}},
    {metricId:'m1',state:'known',value:10,unit:{status:'known',unit:'count',rawUnit:'independent group denominator'},period:{kind:'calendar-months',fromMonth:'2026-08',toMonth:'2026-08'},sourceRefs:['s0','s1'],formulaVersion:'group-total/v1',numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:2,availableCount:2}},
    {metricId:'m2',state:'known',value:0,unit:{status:'known',unit:'percent',rawUnit:'returned units share'},period:{kind:'unknown',reason:'The response does not confirm the requested month'},sourceRefs:['s1','s0'],formulaVersion:'sample-share/v1',numeratorRef:'m0',denominatorRef:'m1',coverage:{status:'partial',expectedCount:3,availableCount:2}},
    {metricId:'m3',state:'known',value:12.5,unit:{status:'known',unit:'currency',rawUnit:'confirmed USD per returned sample',currency:'USD'},period:{kind:'current',asOf:'2026-09-12T00:00:00.000Z'},sourceRefs:['s1'],formulaVersion:'response-revenue/v1',numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}},
  ];
  const demandSection=section('demand:sample',second);demandSection.limitations[0].gapGroupIds=['g1','g2'];
  return MarketOverviewSynthesisInputSchema.parse({version:'market-overview-synthesis-input/v1',basisId:'storage-basis',nodeId:'storage-final-node',inputDigest:'a'.repeat(64),mode:'final',dimensionId:'final',scopeStatement:'Each source and group has an independent denominator; requested months are not confirmed response periods',
    children:[{childId:'storage-child-price',leafSectionIds:['storage-price-window'],section:section('price:sample',first)},{childId:'storage-child-demand',leafSectionIds:['storage-demand-window'],section:demandSection}],directChildIds:['storage-child-price','storage-child-demand'],leafSectionIds:['storage-price-window','storage-demand-window'],
    evidenceFacts:[{factId:'f0',kind:'share',metricRefs:['m0','m2'],sourceRefs:['s0','s1'],statementTemplateId:'returned-price-group/v1'},{factId:'f1',kind:'value',metricRefs:['m3'],sourceRefs:['s1'],statementTemplateId:'independent-revenue/v1'}],metrics,
    labels:[{factId:'f0',label:'Original price band — $0 to $10'},{factId:'f1',label:'Original source label — 2026 sample'}],
    gapGroups:[{gapGroupId:'g0',dimensionId:'price:sample',reason:'period-incompatible',sourceRefs:['s0','s1'],fieldKind:'response-scope',scopeKey:'dist:2026-08:price:sample:response-scope',memberCount:7},{gapGroupId:'g1',dimensionId:'demand:sample',reason:'unit-unknown',sourceRefs:['s1'],fieldKind:'revenue',scopeKey:'prefix::demand:sample:middle:demand:sample:suffix:',memberCount:2},{gapGroupId:'g2',dimensionId:'demand:sample',reason:'not-collected',sourceRefs:[],fieldKind:'unknown-gap',scopeKey:'unknown exact gap scope',memberCount:1}]});
}

// Independent reader of the published column descriptions. IDs deliberately
// already use the documented row aliases; only storage lineage is omitted.
function readEvidenceTables(input:ReturnType<typeof createMarketOverviewSynthesisModelWire>['input']) {
  const at=<T>(values:readonly T[],index:number):T=>{assert.ok(Number.isInteger(index)&&index>=0&&index<values.length,`Invalid table index ${index}`);return values[index];};
  const name=(parts:readonly number[])=>parts.map(i=>at(input.names,i)).join(':');
  const sourceSet=(index:number)=>at(input.sourceSets,index).map(i=>`s${i}`);
  const statement=(index:number):MarketOverviewSynthesisStatement=>{
    const [parts,facts,gaps]=at(input.statements,index);
    return {parts:parts.map(([kind,value])=>kind==='t'?{kind:'text',text:at(input.texts,value)}:kind==='m'?{kind:'metric',metricId:`m${value}`}:{kind:'fact-label',factId:`f${value}`}),factIds:facts.map(i=>`f${i}`),gapGroupIds:gaps.map(i=>`g${i}`)};
  };
  const children=input.children.map(([dimension,data,meaning,conclusion,limitations,verification])=>({dimensionId:name(at(input.dimensions,dimension)),data:statement(data),meaning:statement(meaning),conclusion:statement(conclusion),limitations:limitations.map(statement),verification:verification.map(statement)}));
  const metrics=input.metrics.map(([value,context,numerator,denominator],i)=>{
    const [unit,period,sources,formula,coverage]=at(input.contexts,context),[unitKind,rawUnit,currency]=at(input.units,unit);
    return {metricId:`m${i}`,state:'known',value,unit:{status:'known',unit:unitKind,rawUnit,...(currency===undefined?{}:{currency})},period:at(input.periods,period),sourceRefs:sourceSet(sources),formulaVersion:name(at(input.formulas,formula)),coverage:at(input.coverage,coverage),numeratorRef:numerator===null||numerator===undefined?null:`m${numerator}`,denominatorRef:denominator===null||denominator===undefined?null:`m${denominator}`};
  });
  const facts=input.facts.map(([kind,metrics,sources,template],i)=>({factId:`f${i}`,kind:at(input.kinds,kind),metricRefs:metrics.map(m=>`m${m}`),sourceRefs:sourceSet(sources),statementTemplateId:name(at(input.templates,template))}));
  const gaps=input.gaps.map(([dimension,reason,sources,field,scope,count],i)=>({gapGroupId:`g${i}`,dimensionId:name(at(input.dimensions,dimension)),reason:at(input.reasons,reason),sourceRefs:sourceSet(sources),fieldKind:name(at(input.fields,field)),scopeKey:name(at(input.scopes,scope)),memberCount:count}));
  return {mode:input.mode,dimensionId:input.dimensionId,scopeStatement:input.scopeStatement,children,metrics,evidenceFacts:facts,gapGroups:gaps,labels:input.labels.map(([factId,label])=>({factId:`f${factId}`,label}))};
}

test('compact tables retain the complete cross-dimension evidence graph and each child statement',()=>{
  const original=evidenceFixture(),wire=createMarketOverviewSynthesisModelWire(original),decoded=readEvidenceTables(wire.input);
  assert.deepEqual(decoded,{mode:original.mode,dimensionId:original.dimensionId,scopeStatement:original.scopeStatement,children:original.children.map(c=>c.section),metrics:original.metrics,evidenceFacts:original.evidenceFacts,gapGroups:original.gapGroups,labels:original.labels});
  assert.equal(decoded.metrics[0].value,0);assert.deepEqual(decoded.metrics[2].period,{kind:'unknown',reason:'The response does not confirm the requested month'});assert.equal(decoded.metrics[2].denominatorRef,'m1');
  assert.equal(decoded.metrics[0].unit.rawUnit,'returned units (not products)');assert.deepEqual(decoded.metrics[2].sourceRefs,['s1','s0']);assert.deepEqual(decoded.gapGroups[2].sourceRefs,[]);
  assert.ok(!JSON.stringify(wire.input).includes('storage-'));assert.ok(JSON.stringify(wire.input).length<JSON.stringify(original).length);
});

function finalResponse(){
  return {mode:'final',summary:{decision:'mixed-signals',statement:{p:[{k:'t',v:'Consider the evidence within each source scope'},{k:'f',v:0},{k:'m',v:2}],f:[0],g:[]}},
    conflicts:[{p:[{k:'t',v:'Independent source scopes prevent a direct comparison'},{k:'f',v:1}],f:[0,1],g:[0]}],
    limitations:[{p:[{k:'t',v:'Period, currency and collection gaps require verification'}],f:[],g:[0,1,2]}],
    verification:[{p:[{k:'t',v:'Confirm the original source before comparing groups'},{k:'m',v:3}],f:[1],g:[1,2]}]};
}

test('final wire decodes cross-dimension conflicts and all material limitations to canonical citations',()=>{
  const original=evidenceFixture(),wire=createMarketOverviewSynthesisModelWire(original),decoded=validateMarketOverviewFinalSynthesisOutput(original,wire.decode(finalResponse()));
  assert.equal(decoded.mode,'final');assert.deepEqual(decoded.summary.statement,{parts:[{kind:'text',text:'Consider the evidence within each source scope'},{kind:'fact-label',factId:'f0'},{kind:'metric',metricId:'m2'}],factIds:['f0'],gapGroupIds:[]});
  assert.deepEqual(decoded.conflicts[0].factIds,['f0','f1']);assert.deepEqual(decoded.limitations[0].gapGroupIds,['g0','g1','g2']);assert.deepEqual(decoded.verification[0].parts.at(-1),{kind:'metric',metricId:'m3'});
  assert.throws(()=>wire.decode({...finalResponse(),dimensionSection:original.children[0].section}));
});

test('out-of-range, negative, fractional and wrong-kind provider aliases cannot become canonical evidence',()=>{
  const wire=createMarketOverviewSynthesisModelWire(evidenceFixture());
  const cases=[
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.f=[2];},
    (r:ReturnType<typeof finalResponse>)=>{r.limitations[0].g=[3];},
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.p=[{k:'m',v:4}];},
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.p=[{k:'f',v:2}];},
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.f=[-1];},
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.f=[0.5];},
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.p=[{k:'m',v:'unknown'}];},
    (r:ReturnType<typeof finalResponse>)=>{r.summary.statement.p=[{k:'t',v:0}];},
  ];
  for(const mutate of cases){const result=finalResponse();mutate(result);assert.throws(()=>wire.decode(result));}
});
