import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketShapeProductImage,readMarketShapeImages} from '../../server/services/market-shape-product-image';
import {MarketShapeProductImagesPublicSchema} from '../../shared/market-shape-product-image-contracts';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';

const scope={organizationId:'org-a',researchId:'a9000000-0000-4000-8000-000000000001',marketplace:'US' as const,nodeIdPath:'1:2:3',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
const asin='B000000001',cutoff='2026-09-24T00:00:00.000Z',url='https://m.media-amazon.com/images/I/fixture.jpg';
const collect=(data:unknown)=>collectMarketShapeProductImage({scope,asin,jobId:'image-test',now:()=>new Date(cutoff),connector:{id:'sorftime',probe:async()=>{throw Error('unused')},execute:async request=>{
 assert.equal(request.operation,'product_detail');assert.deepEqual(request.input,{asin,amz_site:'US'});
 return {data:data as Record<string,unknown>,source:{connectorId:'sorftime',operation:'product_detail',fetchedAt:cutoff,attemptCount:1}};
}}});

test('product_detail extracts first Amazon HTTPS main image and retains raw evidence',async()=>{
 const raw={asin,amz_site:'US',data:{asin,amz_site:'US',main_image:JSON.stringify([url,'https://m.media-amazon.com/images/I/second.jpg'])}};
 const result=await collect(raw);
 assert.equal(result.status,'ready');
 assert.equal(result.imageUrl,url);assert.deepEqual(result.evidence.payload,raw);
 assert.equal(result.evidence.responseIdentity.asin.status,'verified');
 assert.equal(result.evidence.responseIdentity.marketplace.status,'verified');
});

test('missing and unsafe image URLs yield explicit empty evidence',async()=>{
 for(const value of [undefined,'http://m.media-amazon.com/images/I/x.jpg','https://evil.example/x.jpg','https://m.media-amazon.com.evil.example/x.jpg','https://m.media-amazon.com:8443/x.jpg','https://user:pass@m.media-amazon.com/x.jpg']){
  const result=await collect({asin,amz_site:'US',data:{main_image:value??null}});
  assert.equal(result.status,'empty');assert.equal(result.imageUrl,null);
 }
});

test('response identity and error conflicts fail closed',async()=>{
 assert.equal((await collect({asin:'B000000002',data:{main_image:url}})).status,'failed');
 assert.equal((await collect({amz_site:'DE',data:{main_image:url}})).status,'failed');
 assert.equal((await collect({asin,amz_site:'US',data:{asin:'B000000002',main_image:url}})).status,'failed');
 assert.equal((await collect({error:'rate limit',data:{main_image:url}})).status,'failed');
});

test('image public contract supports 300 entries and rejects a 301st',()=>{
 const rows=Array.from({length:300},(_,i)=>({asin:`B${String(i).padStart(9,'0')}`,status:'queued',imageUrl:null,sourceRef:null,inputSnapshotId:null,fetchedAt:null,errorCode:null}));
 assert.equal(MarketShapeProductImagesPublicSchema.parse({provider:'sorftime',products:rows}).products.length,300);
 assert.equal(MarketShapeProductImagesPublicSchema.safeParse({provider:'sorftime',products:[...rows,rows[0]]}).success,false);
});

test('pending image reader has no snapshot or network calls',async()=>{
 let calls=0;
 const result=await readMarketShapeImages({view:{run:{scope,status:'running'},steps:[],attempts:[]},actor:{organizationId:'org-a',userId:'u'},current:new Set(),snapshots:{findInput:async()=>{calls++;throw Error('unexpected')},findSource:async()=>{calls++;throw Error('unexpected')}},asins:[asin],selectionInputSnapshotId:'market-input:'+'1'.repeat(64)} as unknown as Parameters<typeof readMarketShapeImages>[0]);
 assert.equal(calls,0);assert.equal(result.products[0].status,'queued');assert.equal(result.products[0].imageUrl,null);
});

test('image reader replays immutable product_detail evidence and source input',async()=>{
 const collected=await collect({asin,amz_site:'US',data:{main_image:[url]}});if(collected.status==='failed')throw Error('expected evidence');
 const sourceRef=`market-source:${digest(collected.evidence)}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:cutoff,expectedRecordIds:[asin],records:[{id:asin,scope,data:{collection:'product-image',asin,imageUrl:collected.imageUrl,sourceRef}}]},new Date(cutoff));
 let reads=0;
 const view={run:{id:scope.researchId,scope,status:'succeeded'},steps:[{stepKey:'image-step',kind:'collect-product-image',status:'succeeded',input:{asin,selectionInputSnapshotId:'market-input:'+'1'.repeat(64)},latestAttemptId:'attempt-1'}],attempts:[{id:'attempt-1',status:'succeeded',output:{sourceRef,inputSnapshotId:snapshot.snapshotId}}]};
 const result=await readMarketShapeImages({view,actor:{organizationId:'org-a',userId:'u'},current:new Set(['image-step']),snapshots:{findInput:async()=>{reads++;return {snapshot}},findSource:async()=>{reads++;return {id:sourceRef,evidence:collected.evidence}}},asins:[asin],selectionInputSnapshotId:'market-input:'+'1'.repeat(64)} as unknown as Parameters<typeof readMarketShapeImages>[0]);
 assert.equal(reads,2);assert.equal(result.products[0].imageUrl,url);assert.equal(result.products[0].sourceRef,sourceRef);
});
