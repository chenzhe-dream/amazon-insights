import test from 'node:test';
import assert from 'node:assert/strict';
import {canReusePluginShapeImage,collectPluginShapeImage,replayPluginShapeImage} from '../../server/services/plugin-shape-image-reuse';

const scope={organizationId:'00000000-0000-4000-8000-000000000001',researchId:'00000000-0000-4000-8000-000000000002',marketplace:'US',currency:'USD',nodeIdPath:'1:123',fromMonth:'2026-07',toMonth:'2026-09'} as const;
const now=new Date('2026-10-16T05:00:00.000Z'),asin='B000000001';
const record={snapshotId:'plugin-source:'+'a'.repeat(64),jobId:'00000000-0000-4000-8000-000000000003',node:'456',marketplace:'US' as const,asin,collectedAt:'2026-10-16T04:00:00.000Z',basic:{asin,image:'https://m.media-amazon.com/images/I/example.jpg'},history:{asin,nodes:[]}};
const product={asin,price:25,grossProfitMargin:70};
const input={scope,asin,userId:'owner',product,now,source:record};

test('saved-only reuse keeps an older image without inventing price or margin',()=>{
 const result=collectPluginShapeImage({...input,now:new Date('2026-10-29T00:00:00Z'),reuseSaved:true,allowMissingDetail:true,product:{asin,price:null,grossProfitMargin:null}});
 assert.ok(result);assert.equal(result.evidence.fetchedAt,record.collectedAt);
 assert.deepEqual(replayPluginShapeImage(scope,result.evidence.payload,result.evidence.fetchedAt),result);
 assert.equal((result.evidence.payload as any).requiredPool.grossProfitMargin,null);
});

test('known missing detail requirements skip shared-image reads before querying the database',()=>{
 assert.equal(canReusePluginShapeImage(product,asin),true);
 assert.equal(canReusePluginShapeImage({...product,grossProfitMargin:0},asin),true);
 for(const value of [null,{}, {...product,grossProfitMargin:null},{...product,price:0},{...product,asin:'B000000002'}])assert.equal(canReusePluginShapeImage(value,asin),false);
});

test('plugin image reuse preserves provider, original timestamp, identity and replay hash',()=>{
 const result=collectPluginShapeImage(input);assert.ok(result);
 assert.equal(result.evidence.provider,'sellerSprite');assert.equal(result.evidence.operation,'plugin_product_basic');
 assert.equal(result.evidence.fetchedAt,record.collectedAt);assert.equal(result.imageUrl,record.basic.image);
 assert.deepEqual(replayPluginShapeImage(scope,result.evidence.payload,result.evidence.fetchedAt),result);
 assert.equal((result.evidence.payload as Record<string,unknown>).history,undefined,'do not inject ambiguous monthly data into image evidence');
});

test('missing profit/price, stale/future data, wrong site/ASIN and unsafe images require existing MCP path',()=>{
 const invalids=[{product:{...product,grossProfitMargin:null}},{product:{...product,price:null}},
  {scope:{...scope,marketplace:'DE',currency:'EUR'}},{source:{...record,asin:'B000000002'}},
  {source:{...record,basic:{...record.basic,asin:'B000000002'}}},
  {source:{...record,collectedAt:'2026-10-15T04:00:00.000Z'}},
  {source:{...record,collectedAt:'2026-10-17T04:00:00.000Z'}},
  {source:{...record,basic:{asin,image:'https://bad.example/image.jpg'}}},
  {notBefore:'2026-10-16T04:30:00.000Z'}];
 for(const change of invalids)assert.equal(collectPluginShapeImage({...input,...change} as never),null);
 assert.ok(collectPluginShapeImage({...input,product:{...product,grossProfitMargin:0}}),'zero margin is valid');
});

test('replay does not need a fresh shared source but rejects altered identity',()=>{
 const original=collectPluginShapeImage(input)!;
 assert.throws(()=>replayPluginShapeImage({...scope,marketplace:'DE',currency:'EUR'} as never,original.evidence.payload,record.collectedAt));
 assert.throws(()=>replayPluginShapeImage(scope,{...(original.evidence.payload as Record<string,unknown>),asin:'B000000002'},record.collectedAt));
});


test('offset timestamps reuse and replay without changing the original source timestamp',()=>{
 const source={...record,collectedAt:'2026-10-16T04:00:00+00:00'};
 const result=collectPluginShapeImage({...input,source});assert.ok(result);
 assert.equal(result.evidence.fetchedAt,'2026-10-16T04:00:00.000Z');
 assert.equal((result.evidence.payload as Record<string,unknown>).collectedAt,source.collectedAt);
 assert.deepEqual(replayPluginShapeImage(scope,result.evidence.payload,result.evidence.fetchedAt),result);
});

test('source from the prior month remains replayable across a completed-month boundary',()=>{
 const nextScope={...scope,toMonth:'2026-10'};
 const source={...record,collectedAt:'2026-10-31T23:00:00.000Z'};
 const result=collectPluginShapeImage({...input,scope:nextScope,source,now:new Date('2026-11-01T00:30:00.000Z')});assert.ok(result);
 assert.deepEqual(replayPluginShapeImage(nextScope,result.evidence.payload,result.evidence.fetchedAt),result);
});
