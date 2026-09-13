import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {MarketOverviewExplanationInputSchema} from '../../shared/market-semantic-contracts';
import {marketOverviewWire} from '../../server/runtime/market-overview-wire';

test('local IDs round-trip evidence without replacing numeric values, source labels or free prose',async()=>{
 const fixture=JSON.parse(await readFile('skills-src/market-explain-overview/fixtures/market-explain-overview-synthetic-v1.json','utf8'));
 const original=MarketOverviewExplanationInputSchema.parse({...fixture.input,analysisBrief:{mode:'dimension',referenceEncoding:'local-identifiers/v1',scopeStatement:'限定返回样本',dimensions:[{id:'dimension-original',label:'范围',factIds:fixture.input.facts.map((f:any)=>f.factId),gapIds:fixture.input.gaps.map((g:any)=>g.gapId)}],factLabels:fixture.input.facts.map((f:any)=>({factId:f.factId,label:'Keep '+f.factId+' 10% literal label'}))}});
 const before=JSON.stringify(original),wire=marketOverviewWire(original),encoded=MarketOverviewExplanationInputSchema.parse(wire.input);
 assert.equal(encoded.facts[0].factId,'f0');assert.deepEqual(wire.decode(encoded),original);assert.equal(JSON.stringify(original),before);assert.equal(encoded.inputDigest,original.inputDigest);assert.equal(encoded.batchId,original.batchId);
 assert.deepEqual(encoded.metrics.map(m=>m.value),original.metrics.map(m=>m.value));assert.deepEqual(encoded.analysisBrief!.factLabels.map(f=>f.label),original.analysisBrief!.factLabels.map(f=>f.label));
 const candidate={analysis:{dimensions:[{dimensionId:'d0',data:{factIds:['f0'],gapIds:[],parts:[{kind:'metric',metricId:encoded.metrics[0].metricId},{kind:'fact-label',factId:'f0'},{kind:'text',text:'literal f0 remains prose'}]}}]}};
 const decoded=wire.decode(candidate) as any;assert.equal(decoded.analysis.dimensions[0].dimensionId,'dimension-original');assert.equal(decoded.analysis.dimensions[0].data.factIds[0],original.facts[0].factId);assert.equal(decoded.analysis.dimensions[0].data.parts[2].text,'literal f0 remains prose');
 assert.throws(()=>wire.decode({factIds:['f99999']}));assert.throws(()=>wire.decode({factIds:[original.facts[0].factId]}));assert.throws(()=>wire.decode({metricId:42}));
 const legacy=MarketOverviewExplanationInputSchema.parse(fixture.input),passthrough=marketOverviewWire(legacy);assert.equal(passthrough.encoding,'canonical/v1');assert.equal(passthrough.input,legacy);assert.equal(passthrough.decode(candidate),candidate);
});


test('metric tables round-trip every value and metadata field while sharing repeated contexts',async()=>{
 const fixture=JSON.parse(await readFile('skills-src/market-explain-overview/fixtures/market-explain-overview-synthetic-v1.json','utf8'));
 const first=fixture.input.metrics[0],metrics=Array.from({length:48},(_,i)=>({...first,metricId:'metric-'+i,value:i/10,numeratorRef:null,denominatorRef:null}));
 metrics[2]={...metrics[2],numeratorRef:'metric-0',denominatorRef:'metric-1',formulaVersion:'synthetic-share/v1',unit:{status:'known',unit:'percent',rawUnit:'percent'}};
 metrics[3]={...metrics[3],period:{kind:'unknown',reason:'Unconfirmed source period'}};
 const facts=Array.from({length:12},(_,i)=>({...fixture.input.facts[0],factId:'fact-'+i,metricRefs:metrics.slice(i*4,i*4+4).map(m=>m.metricId),kind:'value'}));
 const original=MarketOverviewExplanationInputSchema.parse({...fixture.input,metrics,facts,gaps:[],interpretationOptions:[],validationOptions:[],analysisBrief:{mode:'dimension',referenceEncoding:'metric-table/v1',scopeStatement:'Returned sample',dimensions:[{id:'dimension',label:'结构',factIds:facts.map(f=>f.factId),gapIds:[]}],factLabels:facts.map(f=>({factId:f.factId,label:f.factId}))}});
 const wire=marketOverviewWire(original),table=wire.input as any;
 assert.deepEqual(table.metricColumns,['metricId','value','contextId','numeratorRef','denominatorRef']);assert.equal(table.metricContexts.length,3);assert.equal(table.metrics.length,48);assert.deepEqual(wire.decode(table),original);
 assert.ok(JSON.stringify(table).length<JSON.stringify(original).length/2);
 const bad=structuredClone(table);bad.metrics[0][2]='missing';assert.throws(()=>wire.decode(bad));
 const duplicate=structuredClone(table);duplicate.metricContexts.push(duplicate.metricContexts[0]);assert.throws(()=>wire.decode(duplicate));
 const unused=structuredClone(table);unused.metricContexts.push({...unused.metricContexts[0],contextId:'unused'});assert.throws(()=>wire.decode(unused));
 const legacy=structuredClone(original);legacy.analysisBrief!.referenceEncoding='local-identifiers/v1';assert.equal(MarketOverviewExplanationInputSchema.safeParse(legacy).success,false);
});
