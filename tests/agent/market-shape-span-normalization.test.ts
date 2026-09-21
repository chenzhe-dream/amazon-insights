import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as normalizer from '../../server/domain/market-research/shape-span-normalization';
import { AgentRunTerminalMetadataSchema } from '../../shared/agent-contracts';
const input=JSON.parse(readFileSync('tests/fixtures/market-shape-legacy-batch-live-20260917.json','utf8')).input;
const source=input.products[0];
function firstSpan(r:ReturnType<typeof normalizer.normalizeLiveMarketShapeSpans>) { const d=r.output.products[0].decision; assert.equal(d.status,'supported'); if(d.status!=='supported')throw new Error('Expected supported'); return d.candidates[0].evidence[0]; }
function fixture(text='no shelf; lamp 😀') {
 const i=structuredClone(input); i.products[0].title.value.text=text;
 const o={schemaVersion:'1.0.0',task:i.task,batchId:i.batchId,inputDigest:i.inputDigest,products:[{productId:source.productId,decision:{status:'supported',requiresManualConfirmation:true,candidates:[{labelId:i.allowedLabels[0].labelId,evidence:[{refId:source.title.value.refId,start:0,end:4,quote:'lamp'}]}]}}]};
 return {i,o,span:o.products[0].decision.candidates[0].evidence[0]};
}
test('unique literal coordinates normalize immutably and durable provenance is bounded',()=>{
 const {i,o}=fixture();const before=JSON.stringify({i,o});const r=normalizer.normalizeLiveMarketShapeSpans(i,o);
 assert.equal(firstSpan(r).start,10);assert.equal(JSON.stringify({i,o}),before);
 assert.equal(r.provenance[0].ruleVersion,'market-shape-exact-span/v1');
 assert.deepEqual(r.provenance[0].path,['products',0,'decision','candidates',0,'evidence',0]);
 assert.equal(AgentRunTerminalMetadataSchema.safeParse({kind:'succeeded',marketShapeSpanNormalizations:r.provenance}).success,true);
 assert.equal(JSON.stringify(r.provenance).includes('quote'),false);
});
test('valid repeated literal retains exact original offset and no audit',()=>{const {i,o,span}=fixture('lamp lamp');span.start=5;span.end=9;assert.deepEqual(normalizer.normalizeLiveMarketShapeSpans(i,o),{output:o,provenance:[]});});

test('durable provenance indexes follow canonical ASIN order when model products arrive reversed',()=>{
 const {i,o}=fixture();i.products=i.products.slice(0,2);
 const second=i.products[1];second.title.value.text='a lamp';
 o.products.unshift({...structuredClone(o.products[0]),productId:second.productId});
 o.products[0].decision.candidates[0].evidence[0].refId=second.title.value.refId;
 const result=normalizer.normalizeLiveMarketShapeSpans(i,o);
 const canonical=i.products.map((p: {productId:string})=>result.output.products.find(p2=>p2.productId===p.productId)!);
 assert.deepEqual(result.provenance.map(p=>p.path[1]),[1,0]);
 for(const p of result.provenance){const product=canonical[p.path[1]];assert.equal(product.decision.status,'supported');if(product.decision.status!=='supported')throw new Error('Expected supported');assert.equal(product.decision.candidates[0].evidence[0].refId,p.refId);}
});
for(const [name,text,quote] of [['repeat','lamp lamp','lamp'],['case','LAMP','lamp'],['trim','lamp',' lamp'],['negative','no shelf','shelf absent'],['unicode','😀','\ud83d']] ) test(`reject ${name} without weakening evidence`,()=>{const {i,o,span}=fixture(text);span.quote=quote;span.start=1;span.end=4;assert.throws(()=>normalizer.normalizeLiveMarketShapeSpans(i,o));});
test('unknown and other owner refs never repair',()=>{for(const ref of ['missing',input.products[1].title.value.refId]){const {i,o,span}=fixture();span.refId=ref;assert.throws(()=>normalizer.normalizeLiveMarketShapeSpans(i,o));}});
test('full surrogate pair and negative source phrase are preserved literally',()=>{const {i,o,span}=fixture('😀 no shelf');span.quote='no shelf';const r=normalizer.normalizeLiveMarketShapeSpans(i,o);assert.equal(firstSpan(r).start,3);assert.equal(firstSpan(r).quote,'no shelf');});
test('saved real original title replays without model calls',()=>{const {i,o,span}=fixture(source.title.value.text);span.quote=source.title.value.text.slice(0,30);span.start=1;span.end=31;const r=normalizer.normalizeLiveMarketShapeSpans(i,o);assert.equal(firstSpan(r).start,0);});

test('a matching quote in a different original field cannot repair the cited title',()=>{
 const {i,o,span}=fixture('no match'); i.products[0].parameters={state:'known',value:[{...i.products[0].title.value,field:'parameter',refId:'parameter-a',text:'lamp'}]};
 assert.throws(()=>normalizer.normalizeLiveMarketShapeSpans(i,o));assert.equal(span.refId,source.title.value.refId);
});
test('normalization audit rejects unknown fields, arbitrary paths and excess records',()=>{
 const {i,o}=fixture();const {provenance}=normalizer.normalizeLiveMarketShapeSpans(i,o);
 for(const changes of [{quote:'secret'}, {path:['raw-source']}, {ruleVersion:'untrusted'}])assert.equal(AgentRunTerminalMetadataSchema.safeParse({kind:'succeeded',marketShapeSpanNormalizations:[{...provenance[0],...changes}]}).success,false);
 assert.equal(AgentRunTerminalMetadataSchema.safeParse({kind:'succeeded',marketShapeSpanNormalizations:Array(241).fill(provenance[0])}).success,false);
});
