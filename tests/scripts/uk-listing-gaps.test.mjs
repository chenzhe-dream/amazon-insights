import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {collectListingProductData} from '../../scripts/lib/sorftime-listing-parse.mjs';
import * as images from '../../scripts/lib/image-remark-listing-input.mjs';
const asin='B0FJ4T6V2C';
const content={doc:{asin:'Product ASIN'},data:{asin:'#'+asin,main_image:null,description:null,property:null,feature:null,product_info:null,a_plus_images:null}};
test('missing Sorftime detail does not prevent checking independent product content',async()=>{
 const detail={data:JSON.parse(fs.readFileSync(new URL('../fixtures/sorftime-uk-missing-detail.json',import.meta.url),'utf8'))};
 detail.data.asin='#'+asin;
 const calls=[];
 const result=await collectListingProductData({asin,marketplace:'UK',key:'test',callTool:async(_key,op)=>{calls.push(op);return op==='product_detail'?detail:content;}});
 assert.deepEqual(calls,['product_detail','product_content']);assert.deepEqual(result.galleryImages,[]);assert.equal(result.hasAplus,null);assert.equal(result.operation,'product_content');
});
test('only exact content absence is empty; inconsistent identities and malformed content still reject',async()=>{
 for(const changed of [{...content,data:{...content.data,asin:'#B000000001'}},{...content,data:{...content.data,main_image:['https://img.test/a.jpg']}},{...content,data:{...content.data,property:''}},{...content,marketplace:'US'}]) {
  await assert.rejects(collectListingProductData({asin,marketplace:'UK',detailEvidence:{data:{hasAplus:null}},callTool:async()=>changed}));
 }
});
test('a missing gallery inherits listing connector failures rather than becoming upstream empty',()=>{
 const job={asinProgress:{a:{listing:{status:'connector-failed'}},b:{listing:{status:'timeout'}},c:{listing:{status:'upstream-empty'}},d:{listing:{status:'ready'},image_remarks:{status:'timeout'}}}};
 assert.deepEqual(images.missingGalleryStatuses(job,['a','b','c','d']),{a:'connector-failed',b:'timeout',c:'upstream-empty',d:'timeout'});
});
