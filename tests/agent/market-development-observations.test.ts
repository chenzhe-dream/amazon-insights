import test from 'node:test';
import assert from 'node:assert/strict';
import {extractDevelopmentObservations as extract} from '../../server/domain/market-research/development-observations';
import {buildDevelopmentConclusion} from '../../server/domain/market-research/development-conclusion';
import type {ConclusionEvidence} from '../../shared/market-development-conclusion';

for(const [category,site,currency,term,title] of [['13280971','US','USD','foldable','Foldable scooter'],['1063294','JP','JPY','dimmable','Dimmable floor lamp'],['900000001','DE','EUR','waterproof','Waterproof hiking bag']])test(`virtual four saved-module inputs to conclusion: ${title}`,()=>{
 const scope={marketplace:site,nodeIdPath:category,fromMonth:'2026-08',toMonth:'2026-08'};
 const payloads={overview:{numbers:{months:[{month:'2026-08',metrics:{totalUnits:{state:'known',value:1250,unit:{unit:'count'}}}}]}},keywords:{report:{dimensions:{w4:{rows:[{label:term,keywords:[title.toLowerCase()],monthlySearches:3000}]}}}},shapes:{selectedAsins:['A'],assignments:{A:term},data:{scope:{...scope,currency},pool:{fetchedAt:'2026-10-15',products:[{asin:'A',title,price:40}]}}},themes:{result:{selectedAsins:['A'],evidence:[{members:[{asin:'A',sourceThemeId:'source-A',keyword:{text:term},content:{text:`Buyers praise the ${term} design`},positive:10,negative:0}]}]}}};
 const inputs=Object.entries(payloads).map(([module,payload])=>({module,runId:null,identity:`saved-${module}`,scope,status:'ready',facts:['virtual fixture'],findings:[],gaps:[],refs:[],observations:extract(module,payload,`saved-${module}`)})) as ConclusionEvidence[];
 const r=buildDevelopmentConclusion('linked',scope,inputs),candidate=r.decision!.candidates[0];
 assert.equal(candidate.status,'supported');assert.equal(new Set(candidate.evidence.map(e=>e.module)).size,4);assert.match(candidate.price,new RegExp(currency));
 inputs[3].observations!.reviews=[];
 const incomplete=buildDevelopmentConclusion('linked',scope,inputs);assert.equal(incomplete.decision!.candidates[0].status,'needs-evidence');assert.ok(incomplete.decision!.marketContext.length);assert.ok(incomplete.decision!.candidates[0].evidence.some(e=>e.module==='shapes'));
});

test('saved keyword classification retains exact row provenance and unknown volume',()=>{
 const o=extract('keywords',{report:{dimensions:{w4:{rows:[{label:'empty'}, {label:'portable',keywords:['portable bag'],monthlySearches:-1}]}}}},'revision-2');
 assert.equal(o.demands?.[0].ref,'revision-2#report.dimensions.w4.rows[1]');assert.equal(o.demands?.[0].volume,null);
});
test('manual selection and labels govern products and review evidence; truncated source stays explicit',()=>{
 const o=extract('shapes',{selectedAsins:['A'],assignments:{A:'折叠'},data:{scope:{currency:'EUR'},pool:{products:[{asin:'A',title:'manual',price:42},{asin:'B',price:50}]}}},'shape-revision');
 assert.deepEqual(o.products?.map(p=>p.asin),['A']);assert.equal(o.products?.[0].shape,'折叠');assert.equal(o.products?.[0].currency,'EUR');
 const r=extract('themes',{result:{selectedAsins:['A'],evidence:[{members:[{asin:'A',sourceThemeId:'source-A',content:{text:'portable',truncated:true},negative:1},{asin:'B',sourceThemeId:'source-B',content:{text:'portable'}}]}]}},'review-revision');
 assert.equal(r.reviews?.length,1);assert.match(r.reviews![0].text,/截断/);assert.equal(r.reviews![0].ref,'source-A');
});
test('six-month sales require six unique valid months, never duplicates or missing-month zero fill',()=>{
 const points=['03','04','05','06','07','08'].map(m=>({month:`2026-${m}`,units:10}));
 const payload={data:{scope:{toMonth:'2026-08'},pool:{products:[{asin:'A',listedAt:'2026-04-01'}]},productHistory:{products:[{asin:'A',points}]}}};
 assert.equal(extract('shapes',payload,'s').metrics?.find(m=>m.key==='new-share')?.value,100);
 points.push({...points[0]});assert.equal(extract('shapes',payload,'s').metrics?.some(m=>m.key==='new-share'),false);
 points.splice(0,2);assert.equal(extract('shapes',payload,'s').metrics?.some(m=>m.key==='new-share'),false);
});
test('overview counts retain unit/window and missing values do not become zero',()=>{
 const o=extract('overview',{numbers:{months:[{month:'2026-08',metrics:{sampleProducts:{state:'known',value:100},newCount:{state:'known',value:18},totalUnits:{state:'missing',value:0}}}]}},'overview');
 assert.equal(o.metrics?.find(m=>m.key==='new-share')?.value,18);assert.equal(o.metrics?.some(m=>m.key==='totalUnits'),false);
 assert.equal(o.metrics?.find(m=>m.key==='new-share')?.period,'2026-08');
});
