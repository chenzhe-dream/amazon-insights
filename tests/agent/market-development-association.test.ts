import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDevelopmentConclusion} from '../../server/domain/market-research/development-conclusion';
import {DevelopmentConclusionSchema,type ConclusionEvidence} from '../../shared/market-development-conclusion';

const scope={marketplace:'US',nodeIdPath:'1:13280971',fromMonth:'2026-08',toMonth:'2026-08'};
function fixture(term='foldable',category='13280971',marketplace='US') {
 const s={...scope,nodeIdPath:`1:${category}`,marketplace};
 const base=(module:string,observations:unknown)=>({module,runId:null,identity:module+'-v1',scope:s,status:'ready',facts:['已保存样本'],findings:[],gaps:[],refs:[module],observations});
 return {scope:s,evidence:[base('overview',{metrics:[{key:'sample-products',label:'样本数',value:100,unit:'count',period:'2026-08',denominator:'全样本',sample:'overview-v1',ref:'overview#count'}]}),base('keywords',{demands:[{label:term,dimension:'feature',keywords:[`${term} product`],volume:1200,period:'来源月未注明',ref:'keyword#1'}]}),base('shapes',{products:[{asin:'B000000001',title:`${term} product`,shape:null,price:35,currency:'USD',period:'采集时价格',ref:'shape#B000000001'}]}),base('themes',{reviews:[{asin:'B000000001',topic:term,text:`The ${term} design works well`,positive:20,negative:2,period:'2026-10-14',ref:'review#1'}]})] as unknown as ConclusionEvidence[]};
}
for(const [term,category,site] of [['foldable','13280971','US'],['waterproof','3405881','DE'],['dimmable','1063294','JP']])test(`links independent category ${category} without node-specific rules`,()=>{
 const f=fixture(term,category,site),r=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;
 assert.equal(r.version,'market-development/20261015.2');assert.equal(r.decision.candidates[0].status,'supported');
 const c=r.decision.candidates[0];assert.deepEqual(c.asins,['B000000001']);assert.ok(c.evidence.some((e:any)=>e.ref==='review#1'));assert.match(c.price,/35/);assert.ok(c.missing.some((v:string)=>v.includes('成本')));assert.equal(r.decision.rules.length>3,true);
 assert.ok(c.evidence.some((e:any)=>e.module==='overview'&&e.ref==='overview#count'));assert.match(r.decision.marketContext[0].description,/不代表候选销量/);
});

test('compound demand requires all attributes; unknown concepts use exact matching without category shortcuts',()=>{
 const f=fixture('foldable children');f.evidence[2].observations!.products![0].title='foldable adult product';
 assert.equal(buildDevelopmentConclusion('linked',f.scope,f.evidence).decision!.candidates[0].status,'needs-evidence');
 const unknown=fixture('ceramic');assert.equal(buildDevelopmentConclusion('linked',unknown.scope,unknown.evidence).decision!.candidates[0].status,'supported');
});
test('all candidate directions remain available when classification exceeds thirty labels',()=>{
 const f=fixture();const demand=f.evidence[1].observations!.demands![0];
 f.evidence[1].observations!.demands=Array.from({length:40},(_,i)=>({...demand,label:`custom material ${i}`}));
 const r=buildDevelopmentConclusion('linked',f.scope,f.evidence);assert.equal(r.decision!.candidates.length,40);assert.equal(r.actions.length,41);
});
test('negation on an unrelated attribute cannot reject supported demand',()=>{
 const f=fixture();f.evidence[2].observations!.products![0].title='Kids foldable scooter with non-slip deck';
 assert.equal(buildDevelopmentConclusion('linked',f.scope,f.evidence).decision!.candidates[0].status,'supported');
});
test('missing or different-ASIN review affects only its candidate and does not manufacture a chain',()=>{
 const f=fixture();(f.evidence[3] as any).observations.reviews[0].asin='B000000002';const r=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;
 assert.equal(r.decision.candidates[0].status,'needs-evidence');assert.ok(r.decision.candidates[0].missing.some((v:string)=>v.includes('同一ASIN')));
});
test('explicit opposing product claims and rare severe review change decision instead of repeating fixed text',()=>{
 const f=fixture();const before=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;
 (f.evidence[2] as any).observations.products[0].title='non-foldable product';
 (f.evidence[3] as any).observations.reviews.push({asin:'B000000001',topic:'injury',text:'The lock broke and caused injury',positive:0,negative:1,period:'2026-10-14',ref:'rare-risk'});
 const after=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;
 assert.notEqual(after.headline,before.headline);assert.ok(after.decision.risks.some((v:any)=>v.ref==='rare-risk'));assert.equal(after.decision.candidates[0].status,'hold');
});
test('different denominators are explained while same-basis unequal observations are conflicts',()=>{
 const f=fixture();const m={key:'new-share',label:'新品份额',value:18,unit:'%',period:'2026-08',denominator:'链接数',sample:'sample-a',ref:'overview#new'};
 (f.evidence[0] as any).observations.metrics=[m];(f.evidence[2] as any).observations.metrics=[{...m,value:1.1,denominator:'销量',period:'2026-03至2026-08',sample:'sample-b',ref:'shape#new'}];
 let r=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;assert.equal(r.decision.conflicts[0].kind,'basis');
 (f.evidence[2] as any).observations.metrics=[{...m,value:1.1,ref:'shape#new'}];r=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;assert.equal(r.decision.conflicts[0].kind,'conflict');
});
test('available related review and price qualify local gaps without asserting unmet demand proven',()=>{
 const f=fixture();f.evidence[1].gaps=['缺少差评、未满足需求或评论主题证据','缺少价格分布或商品价格证据'];
 const r=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;
 assert.ok(r.decision.reconciliations.some((v:string)=>v.includes('价格')));assert.ok(r.decision.reconciliations.some((v:string)=>v.includes('评论')));
 assert.ok(r.gaps.every((v:string)=>!v.includes('类目关键词洞察：缺少价格')));assert.ok(r.decision.candidates[0].missing.some((v:string)=>v.includes('未满足')));
});
test('scope mismatch removes structured observations as well as text',()=>{
 const f=fixture();f.evidence[3].scope={...f.scope,marketplace:'UK'};const r=buildDevelopmentConclusion('linked',f.scope,f.evidence) as any;
 assert.equal(r.decision.candidates[0].status,'needs-evidence');assert.ok(!JSON.stringify(r.decision.candidates[0].evidence).includes('review#1'));
});
test('v1 snapshots parse unchanged without adding new defaults',()=>{
 const old={version:'market-development/20261015.1',kind:'linked',scope,status:'partial',headline:'旧文字',evidence:[],sections:[],actions:[],gaps:[]};assert.deepEqual(DevelopmentConclusionSchema.parse(old),old);
});
