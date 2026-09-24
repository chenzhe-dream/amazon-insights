import assert from 'node:assert/strict';
import test from 'node:test';
import {observation} from './helpers/market-shape-explanation-fixture';
import {readMarketProductMonth} from '../../server/domain/market-research/product-month-evidence';
import {projectMarketShapeSourceMetadata} from '../../server/domain/market-research/shape-source-metadata';

test('frozen Amazon thumbnail is projected without changing the source; unsafe URLs are rejected',async()=>{
 for(const url of ['https://images-na.ssl-images-amazon.com/images/I/example.jpg','javascript:alert(1)','https://untrusted.example/image.jpg']){
  const o=await observation('2026-08',p=>{p.data[0].imageUrl=url}),checked=await readMarketProductMonth(o,{[o.sourceRef]:o.source});
  const before=JSON.stringify(checked),m=projectMarketShapeSourceMetadata(checked,'B000000001',true);
  assert.equal(m.imageUrl?.value,url.startsWith('https://images-na.')?url:null);
  assert.deepEqual(m.imageUrl?.evidence.payloadPath,['data',0,'imageUrl']);
  assert.equal(JSON.stringify(checked),before);
 }
});
test('metadata uses frozen source values, carries exact evidence paths and never multiplies price by units',async()=>{
 const o=await observation('2026-08',p=>{p.data[0].totalRevenue=17;p.data[0].rating=0;p.data[0].ratings=0;p.data[0].shelfDate='2024-02-29';});
 const checked=await readMarketProductMonth(o,{[o.sourceRef]:o.source}),before=JSON.stringify(checked),m=projectMarketShapeSourceMetadata(checked,'B000000001',true);
 assert.equal(m.revenue.value,17);assert.equal(m.rating.value,0);assert.equal(m.ratingCount.value,0);assert.equal(m.listedAt.value,'2024-02-29');
 assert.deepEqual(m.sellerType.evidence,{sourceRef:o.sourceRef,inputSnapshotId:o.snapshot.snapshotId,payloadPath:['data',0,'sellerType']});
 assert.equal(JSON.stringify(checked),before);
});
test('invalid values and impossible or future listing dates remain unavailable; legacy admission is preserved',async()=>{
 const o=await observation('2026-08',p=>{delete p.currency;delete p.month;delete p.marketplace;delete p.nodeIdPath;p.data[0].rating=9;p.data[0].ratings=-1;p.data[0].shelfDate='2025-02-29';p.data[1].shelfDate='2026-09-01';delete p.data[0].sellerName;});
 const checked=await readMarketProductMonth(o,{[o.sourceRef]:o.source}),legacy=projectMarketShapeSourceMetadata(checked,'B000000001',false),current=projectMarketShapeSourceMetadata(checked,'B000000001',true);
 assert.equal(legacy.revenue.value,null);assert.ok(legacy.revenue.issues.includes('currency-unconfirmed'));
 assert.equal(current.revenue.value,0);assert.equal(current.rating.value,null);assert.deepEqual(current.rating.issues,['invalid']);
 assert.equal(current.ratingCount.value,null);assert.equal(current.listedAt.value,null);assert.deepEqual(current.listedAt.issues,['invalid']);assert.deepEqual(current.sellerName.issues,['missing']);
 assert.deepEqual(projectMarketShapeSourceMetadata(checked,'B000000002',true).listedAt.issues,['listed-after-reference-month']);
});
test('unbounded supplier seller text is rejected as a field rather than breaking the public report',async()=>{
 const o=await observation('2026-08',p=>{p.data[0].sellerName='x'.repeat(4001)}),checked=await readMarketProductMonth(o,{[o.sourceRef]:o.source});
 const metadata=projectMarketShapeSourceMetadata(checked,'B000000001',true);
 assert.equal(metadata.sellerName.value,null);assert.deepEqual(metadata.sellerName.issues,['invalid']);
});
