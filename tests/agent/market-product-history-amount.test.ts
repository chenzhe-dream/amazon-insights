import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketProductHistory,normalizeProductAmountHistory,referenceProductHistoryPeriods} from '../../server/services/market-product-history-collector';
import {ProductAmountHistoryPublicSchema} from '../../shared/market-product-history-contracts';
import {readMarketShapeAmountHistory} from '../../server/services/market-shape-history-reader';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';

const scope={organizationId:'org-a',researchId:'a9000000-0000-4000-8000-000000000001',marketplace:'US' as const,nodeIdPath:'1:2:3',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
const asin='B000000001', cutoff='2026-09-24T00:00:00.000Z';
const collect=(data:unknown)=>collectMarketProductHistory({scope,asin,jobId:'test-amount',metric:'SalesAmount',now:()=>new Date(cutoff),connector:{id:'sorftime',probe:async()=>{throw Error('unused')},execute:async request=>{
 assert.deepEqual(request.input,{asin,amz_site:'US',type:'SalesAmount'});
 return {data:data as Record<string,unknown>,source:{connectorId:'sorftime',operation:'product_trend',fetchedAt:cutoff,attemptCount:1}};
}}});

test('SalesAmount preserves decimal amounts, real zero, and currency evidence',async()=>{
 const result=await collect({asin,amz_site:'US',currency:'USD',data:['2026-06=1.25','2026-07=0','2026-08=20.50']});
 assert.equal(result.status,'ready');
 assert.deepEqual(result.points,[{month:'2026-06',amount:1.25,issues:[]},{month:'2026-07',amount:0,issues:[]},{month:'2026-08',amount:20.5,issues:[]}]);
 assert.deepEqual(result.evidence.units.amount,{status:'known',unit:'currency',currency:'USD',rawUnit:'product_trend SalesAmount'});
});

test('missing, invalid, negative, unsafe, and conflicting amounts stay unknown',()=>{
 const points=normalizeProductAmountHistory({data:'2026-01=,2026-02=-1,2026-03=1e309,2026-04=0,2026-05=1.2,2026-05=1.3,2026-06=9007199254740992'},'2026-08');
 assert.deepEqual(points.map(p=>p.amount),[null,null,null,0,null,null]);
 assert.deepEqual(points[4].issues,['conflicting-month']);
 assert.equal(referenceProductHistoryPeriods(points,'2026-08')[0].value,null);
});

test('SalesAmount fails closed on conflicting response currency and site scope',async()=>{
 assert.deepEqual((await collect({currency:'EUR',data:['2026-08=12.5']})).status,'failed');
 assert.deepEqual((await collect({amz_site:'DE',data:['2026-08=12.5']})).status,'failed');
 assert.deepEqual((await collect({data:{unexpected:'shape'}})).status,'failed');
});

test('reference periods use last three and six actual months, with unavailable values null',()=>{
 const points=[{month:'2024-12',amount:3},{month:'2025-01',amount:0},{month:'2025-05',amount:2.5},{month:'2026-03',amount:1},{month:'2026-06',amount:null},{month:'2026-08',amount:4}].map(p=>({...p,issues:p.amount===null?['invalid-value' as const]:[]}));
 const periods=referenceProductHistoryPeriods(points,'2026-08');
 assert.deepEqual(periods[0],{id:'last-3',fromMonth:'2026-03',toMonth:'2026-08',months:['2026-03','2026-06','2026-08'],value:null,missingMonths:['2026-06']});
 assert.equal(periods[1].value,null);
 assert.deepEqual(periods[2],{id:'year-2025',fromMonth:'2025-01',toMonth:'2025-05',months:['2025-01','2025-05'],value:2.5,missingMonths:[]});
 assert.equal(periods[3].value,3);
 assert.equal(referenceProductHistoryPeriods([],'2026-08')[0].value,null);
});

test('amount public contract allows 300 products while legacy volume remains bounded',()=>{
 const row={asin,status:'queued',points:[],periods:[],sourceRef:null,inputSnapshotId:null,fetchedAt:null,errorCode:null};
 const products=Array.from({length:300},(_,i)=>({...row,asin:`B${String(i).padStart(9,'0')}`}));
 assert.equal(ProductAmountHistoryPublicSchema.parse({provider:'sorftime',metric:'SalesAmount',currency:'USD',referenceMonth:'2026-08',products}).products.length,300);
 assert.equal(ProductAmountHistoryPublicSchema.safeParse({provider:'sorftime',metric:'SalesAmount',currency:'USD',referenceMonth:'2026-08',products:[...products,products[0]]}).success,false);
});

test('amount reader has no network or snapshot calls for pending steps',async()=>{
 let calls=0;
 const result=await readMarketShapeAmountHistory({view:{run:{scope,status:'running'},steps:[],attempts:[]},actor:{organizationId:'org-a',userId:'u'},current:new Set(),snapshots:{findInput:async()=>{calls++;throw Error('unexpected')},findSource:async()=>{calls++;throw Error('unexpected')}},asins:[asin],selectionInputSnapshotId:'market-input:'+'1'.repeat(64)} as unknown as Parameters<typeof readMarketShapeAmountHistory>[0]);
 assert.equal(calls,0);
 assert.equal(result.products[0].status,'queued');
 assert.equal(result.products[0].periods[0].amount,null);
});

test('default and explicit SalesVolume retain identical source evidence hashes',async()=>{
 const data={asin,amz_site:'US',data:['2026-07=0','2026-08=12']};
 const c:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('unused')},execute:async()=>({data,source:{connectorId:'sorftime',operation:'product_trend',fetchedAt:cutoff,attemptCount:1}})};
 const base={scope,asin,jobId:'legacy-hash',connector:c,now:()=>new Date(cutoff)};
 const prior=await collectMarketProductHistory(base),explicit=await collectMarketProductHistory({...base,metric:'SalesVolume'});
 assert.deepEqual(prior,explicit);
 if(prior.status==='failed'||explicit.status==='failed')throw Error('expected volume evidence');
 assert.equal(digest(prior.evidence),digest(explicit.evidence));
});

test('amount reader replays immutable source and input snapshot without remote access',async()=>{
 const collected=await collect({asin,amz_site:'US',currency:'USD',data:['2026-07=0','2026-08=12.25']});
 if(collected.status==='failed')throw Error('expected amount evidence');
 const sourceRef=`market-source:${digest(collected.evidence)}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:cutoff,expectedRecordIds:[asin],records:[{id:asin,scope,data:{collection:'product-amount-history',asin,metric:'SalesAmount',points:collected.points,sourceRef}}]},new Date(cutoff));
 let reads=0;
 const view={run:{id:scope.researchId,scope,status:'succeeded'},steps:[{stepKey:'amount-step',kind:'collect-product-amount-history',status:'succeeded',input:{asin,selectionInputSnapshotId:'market-input:'+'1'.repeat(64)},latestAttemptId:'attempt-1'}],attempts:[{id:'attempt-1',status:'succeeded',output:{sourceRef,inputSnapshotId:snapshot.snapshotId}}]};
 const result=await readMarketShapeAmountHistory({view,actor:{organizationId:'org-a',userId:'u'},current:new Set(['amount-step']),snapshots:{findInput:async()=>{reads++;return {snapshot}},findSource:async()=>{reads++;return {id:sourceRef,evidence:collected.evidence}}},asins:[asin],selectionInputSnapshotId:'market-input:'+'1'.repeat(64)} as unknown as Parameters<typeof readMarketShapeAmountHistory>[0]);
 assert.equal(reads,2);
 assert.equal(result.products[0].status,'ready');
 assert.equal(result.products[0].periods[0].amount,12.25);
 assert.deepEqual(result.products[0].periods[0].months,['2026-07','2026-08']);
});
