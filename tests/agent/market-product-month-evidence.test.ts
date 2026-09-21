import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketProductPool} from '../../server/services/market-product-pool-collector';
import {readMarketProductMonth} from '../../server/domain/market-research/product-month-evidence';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';

const scope={organizationId:'org-a',researchId:'a9000000-0000-4000-8000-000000000001',marketplace:'US' as const,nodeIdPath:'1:2:3',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const cutoff='2026-09-12T00:00:00.000Z';
const rows=Array.from({length:100},(_,i)=>({asin:`B${String(i+1).padStart(9,'0')}`,title:'Fixture pen',price:1,totalUnits:1,totalRevenue:1,ranking:i+1,rating:4,ratings:1}));
async function fixture(selectedAsins?:string[],legacyReason?:string){
 const result=await collectMarketProductPool({scope,month:'2026-08',poolSize:selectedAsins?.length??10,selectedAsins,newProductMonths:6,jobId:'replay-test',now:()=>new Date(cutoff),connector:{id:'sellerSprite',probe:async()=>{throw Error('unused');},execute:async()=>({data:{code:'OK',data:rows},source:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt:cutoff,attemptCount:1}})}});
 assert.ok(result.evidence);
 const source=legacyReason?{...result.evidence,coverage:{...result.evidence.coverage,truncation:{status:'unknown' as const,reason:legacyReason}}}:structuredClone(result.evidence);
 const sourceRef=`market-source:${digest(source)}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:cutoff,expectedRecordIds:selectedAsins??result.products.map(p=>p.asin),records:result.products.map(product=>({id:product.asin,scope,data:{collection:'product-month',month:'2026-08',product,sourceRef}}))});
 return {month:'2026-08',source,sourceRef,snapshot};
}
test('raw one hundred rows replay only the ten frozen snapshot members with unchanged source identity',async()=>{
 const o=await fixture(),before=digest(o);
 const read=await readMarketProductMonth(o,{[o.sourceRef]:o.source});
 assert.equal(read.products.length,10);assert.deepEqual(read.products.map(p=>p.sourceIndex),Array.from({length:10},(_,i)=>i));
 assert.equal(read.source,o.source);assert.equal(digest(o),before);
});
test('fixed subset with extra raw members replays original positions and retains missing member',async()=>{
 const o=await fixture(['B000000003','B000000098','B000000999']);
 const read=await readMarketProductMonth(o,{[o.sourceRef]:o.source});
 assert.deepEqual(read.products.map(p=>[p.asin,p.sourceIndex]),[['B000000003',2],['B000000098',97]]);
 assert.deepEqual(read.observation.snapshot.coverage.missingRecordIds,['B000000999']);
});
test('historical coverage descriptions are accepted without rewriting frozen evidence',async()=>{
 for(const reason of ['接口返回头部样本，未证明全类目覆盖','固定成员查询不代表全类目覆盖；缺失成员的当月数据未知']){
  const o=await fixture(undefined,reason),before=digest(o.source);
  assert.equal((await readMarketProductMonth(o,{[o.sourceRef]:o.source})).products.length,10);
  assert.equal(digest(o.source),before);
 }
});
test('source tampering, incorrect scope, unsupported coverage and forged source indexes remain rejected',async()=>{
 const o=await fixture();
 const changes:((s:MarketSourceEvidence)=>MarketSourceEvidence)[]=[s=>({...s,coverage:{...s.coverage,truncation:{status:'unknown',reason:'forged'}}}),s=>({...s,requestIdentity:{...s.requestIdentity,month:'2026-07'}}),s=>({...s,coverage:{...s.coverage,receivedCount:10}})];
 for(const change of changes){
  const source=change(o.source);
  await assert.rejects(()=>readMarketProductMonth(o,{[o.sourceRef]:source}));
 }
 const unsupported=await fixture(undefined,'forged');
 await assert.rejects(()=>readMarketProductMonth(unsupported,{[unsupported.sourceRef]:unsupported.source}));
 const records=structuredClone(o.snapshot.records) as Array<{id:string;scope:typeof scope;data:{product:{sourceIndex:number}}}>;
 records[0].data.product.sourceIndex=99;
 const s=o.snapshot;
 const snapshot=createMarketInputSnapshot({scope:s.scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records});
 await assert.rejects(()=>readMarketProductMonth({...o,snapshot},{[o.sourceRef]:o.source}));
});
